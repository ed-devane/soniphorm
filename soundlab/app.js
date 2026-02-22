class App {
    constructor() {
        this.audio = new AudioEngine();
        this.slots = new SlotManager();
        this.waveform = null;

        // Current buffer in memory (selected slot's audio)
        this.channels = null;
        this.bufferSampleRate = 48000;

        // Clipboard
        this.clipboard = null;

        // Undo/redo
        this.undoStack = [];
        this.redoStack = [];
        this.maxUndo = 5;

        // State
        this.recordingSlotIndex = -1;
        this.animFrameId = null;
        this._recChunks = null;    // Array of Float32Array chunks for live recording
        this._recTotalLen = 0;    // Total sample count across all chunks

        // Macros: 4 per slot, stored on slot objects as slot._macros
        // Each macro: { value: 0-1, mapping: null | { fx, param, min, max, unit, label } }
        this._pendingMapParam = null; // { fx, param definition } for mapping context menu

        // Sequencer
        this.sequencer = null;
        this._seqMode = false;
        this._seqAnimFrame = null;
        // (stutter is now a real-time toggle on sequencer)
        this._seqPreMutatePattern = null; // saved pattern for mutate revert
        this._seqBankIndex = 0;
        this._seqPreviewBankIndex = null; // non-null when browsing a different pattern
        this._seqQueuedBankIndex = null; // non-null when confirmed but waiting for loop end
        this._seqBanks = null; // array of 16 pattern JSONs, lazily initialized
        this._seqRecording = false;
        this._seqShowTransportInSample = false;
        this._seqLooperUndoStack = []; // array of pattern snapshots for looper undo
        this._seqRecordingNotes = new Map(); // key -> {step, slotIndex, pitch, entryRef}

        // Sampler
        this.sampler = null;
        this._sampleMode = false;
        this._sampleSelectedPad = 0; // currently selected pad for config
        this._keysDown = new Set(); // track held keys for gate mode

        // Noise gate
        this._gateEnabled = false;

        // Input device selection
        this._selectedInputDeviceId = null;

        // Chromatic keyboard state
        this._chromaticMode = false;
        this._chromaticBaseOctave = 3;
        this._chromaticOctaveSpan = 3;

        // Envelope editor state (dual canvases)
        this._envNodesAmp = [];    // computed node positions for amp canvas
        this._envNodesPitch = [];  // computed node positions for pitch canvas
        this._envDragging = -1;    // index of node being dragged, -1 = none
        this._envDragTarget = null; // 'amp' or 'pitch' — which canvas is being dragged
    }

    async init() {
        // Build UI immediately (no async dependencies)
        this.buildSlotGrid();
        this.bindToolbar();
        this.bindDialogs();
        this.updateToolbarState();
        this.updateTransportInfo();
        this.restoreMacroUI();

        // Waveform
        try {
            const canvas = document.getElementById('waveform');
            this.waveform = new WaveformRenderer(canvas);
            this.waveform.onSelectionChange = (sel) => {
                this.updateToolbarState();
                // If looping, restart with new selection
                if (this.audio.isPlaying && this.audio.isLooping) {
                    this._restartLoop();
                }
                // Update sampler region/loop live
                if (this._sampleMode) {
                    const pad = this.sampler.pads[this._sampleSelectedPad];
                    if (pad.mode === 'loop' && sel) {
                        this.waveform.setLoopMarkers(sel.start, sel.end);
                        this.waveform.clearSelection();
                        this._updateSamplerLoopFromMarkers(sel);
                    } else {
                        this._updateSamplerRegionFromSelection();
                    }
                }
            };
            this.waveform.onLoopChange = (loop) => {
                if (this._sampleMode) this._updateSamplerLoopFromMarkers(loop);
            };
            this.waveform.onLoopClear = () => {
                if (this._sampleMode) {
                    const pad = this.sampler.pads[this._sampleSelectedPad];
                    pad.loopStart = -1;
                    pad.loopEnd = -1;
                    this.waveform.clearLoopMarkers();
                    this.sampler.updateLoopRegion(this._sampleSelectedPad, -1, -1);
                    this._saveSamplerConfig();
                }
            };
            this.waveform.onCursorSet = (sample) => {
                this.waveform.setCursor(sample);
                this.waveform.render();
                this.updateToolbarState();
            };
            window.addEventListener('resize', () => {
                this.waveform.resize();
                this.waveform.render();
            });
        } catch (e) {
            console.error('Waveform init failed:', e);
        }

        // Load persisted slot data from IndexedDB
        try {
            await this.slots.init();
            this.slots.onChange = () => this.renderSlotGrid();
            this.renderSlotGrid();
        } catch (e) {
            console.error('IndexedDB init failed:', e);
        }

        // Init sequencer & sampler
        this._initSequencer();
        this._initSampler();

        // Register service worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }

        // PWA install prompt
        this._deferredInstallPrompt = null;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this._deferredInstallPrompt = e;
            document.getElementById('install-btn').hidden = false;
        });
        document.getElementById('install-btn').addEventListener('click', () => this._promptInstall());
        window.addEventListener('appinstalled', () => {
            document.getElementById('install-btn').hidden = true;
            this._deferredInstallPrompt = null;
        });

        // Init audio context on first interaction
        document.addEventListener('click', () => this.ensureAudioInit(), { once: true });
        document.addEventListener('touchstart', () => this.ensureAudioInit(), { once: true });
    }

    async _promptInstall() {
        if (!this._deferredInstallPrompt) return;
        this._deferredInstallPrompt.prompt();
        const result = await this._deferredInstallPrompt.userChoice;
        if (result.outcome === 'accepted') {
            document.getElementById('install-btn').hidden = true;
        }
        this._deferredInstallPrompt = null;
    }

    async ensureAudioInit() {
        try {
            await this.audio.init();
            if (this.audio.audioContext) {
                this.slots.setAudioContext(this.audio.audioContext);
                // Wire sampler/sequencer to effects bus
                const bus = this.audio.getEffectsBus();
                if (bus) {
                    if (this.sampler) this.sampler.outputNode = bus;
                    if (this.sequencer) this.sequencer.outputNode = bus;
                }
            }
        } catch (e) { console.warn('Audio init:', e); }
    }

    // === Slot Grid ===

    buildSlotGrid() {
        const grid = document.getElementById('slot-grid');
        grid.innerHTML = '';

        // In seq mode, use sequencer step count; otherwise 16 sample slots
        const count = this._seqMode ? this.sequencer.pattern.length : 16;

        // Extended sequences: keep 4-column layout, scroll vertically
        grid.style.gridTemplateColumns = '';
        grid.style.gridTemplateRows = '';
        if (this._seqMode && count > 16) {
            grid.classList.add('seq-extended');
        } else {
            grid.classList.remove('seq-extended');
        }

        for (let i = 0; i < count; i++) {
            const slot = i < 16 ? this.slots.slots[i] : null;
            const el = document.createElement('div');
            el.className = 'slot';
            el.dataset.index = i;
            if (slot) {
                el.dataset.bank = slot.bank;
            } else {
                el.dataset.bank = Math.floor(i / 4) % 4;
            }

            if (slot) {
                el.innerHTML = `
                    <span class="slot-number">${String(i + 1).padStart(2, '0')}</span>
                    <span class="slot-name ${slot.hasAudio ? '' : 'empty'}">${slot.hasAudio ? slot.name || 'untitled' : 'empty'}</span>
                    <div class="slot-mini"><canvas></canvas></div>
                `;
            } else {
                // Extended seq steps (>16) — step-only cells
                el.innerHTML = `
                    <span class="slot-number">${String(i + 1).padStart(2, '0')}</span>
                    <span class="slot-name empty">--</span>
                `;
            }

            el.addEventListener('click', (e) => {
                this.onSlotTap(i, e);
            });
            if (i < 16) {
                el.addEventListener('contextmenu', (e) => this.onSlotContext(i, e));
                el.addEventListener('dblclick', async (e) => {
                    if (this._sampleMode && this.slots.slots[i].hasAudio) {
                        this.sampler.stopAll();
                        this.slots.selectSlot(i);
                        const data = await this.slots.getSlotAudio(i);
                        if (data) {
                            this.channels = data.channels;
                            this.bufferSampleRate = data.sampleRate;
                        }
                        await this.switchMode('rec');
                        if (this.channels) {
                            this.waveform.setAudio(this.channels, this.bufferSampleRate);
                            document.getElementById('waveform-empty').hidden = true;
                        }
                        this.updateTransportInfo();
                        this.updateToolbarState();
                    }
                });
            }

            // Sample mode: trigger on press, release on lift
            let usedTouch = false;

            if (i < 16) {
                el.addEventListener('mousedown', (e) => {
                    if (usedTouch) return;
                    if (this._sampleMode && e.button === 0) this.samplePadTap(i);
                });
                el.addEventListener('mouseup', () => {
                    if (usedTouch) return;
                    if (this._sampleMode) this.samplePadRelease(i);
                });
                el.addEventListener('mouseleave', () => {
                    if (usedTouch) return;
                    if (this._sampleMode) this.samplePadRelease(i);
                });

                // Touch events
                el.addEventListener('touchstart', (e) => {
                    usedTouch = true;
                    if (this._sampleMode) {
                        e.preventDefault();
                        this.samplePadTap(i);
                    }
                });
                el.addEventListener('touchend', (e) => {
                    if (this._sampleMode) {
                        e.preventDefault();
                        this.samplePadRelease(i);
                    }
                    setTimeout(() => { usedTouch = false; }, 400);
                });
                el.addEventListener('touchcancel', () => {
                    if (this._sampleMode) this.samplePadRelease(i);
                    setTimeout(() => { usedTouch = false; }, 400);
                });
            }

            grid.appendChild(el);
        }
        if (!this._seqMode) this.renderSlotGrid();
    }

    renderSlotGrid() {
        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');
        slotEls.forEach((el, i) => {
            const slot = this.slots.slots[i];
            const nameEl = el.querySelector('.slot-name');
            nameEl.textContent = slot.hasAudio ? (slot.name || 'untitled') : 'empty';
            nameEl.className = `slot-name ${slot.hasAudio ? '' : 'empty'}`;

            // Restore normal mode classes
            el.className = 'slot';
            el.dataset.bank = slot.bank;

            // Clean up seq/sample-mode elements
            const iconsEl = el.querySelector('.step-mode-icons');
            if (iconsEl) iconsEl.remove();
            const keyEl = el.querySelector('.pad-key-label');
            if (keyEl) keyEl.remove();
            const modeEl = el.querySelector('.pad-mode-label');
            if (modeEl) modeEl.remove();

            // Restore slot number
            const numEl = el.querySelector('.slot-number');
            numEl.textContent = String(i + 1).padStart(2, '0');

            const isSelected = i === this.slots.selectedIndex;
            el.classList.toggle('selected', isSelected);
            el.classList.toggle('recording', i === this.recordingSlotIndex);

            // Draw mini waveform
            const miniCanvas = el.querySelector('.slot-mini canvas');
            if (slot.hasAudio && slot.peaks) {
                const color = isSelected ? 'rgba(255,255,255,0.8)' : 'rgba(14,165,233,0.6)';
                WaveformRenderer.drawMiniFromPeaks(miniCanvas, slot.peaks, color);
            } else if (!slot.hasAudio) {
                const ctx = miniCanvas.getContext('2d');
                miniCanvas.width = miniCanvas.clientWidth;
                miniCanvas.height = miniCanvas.clientHeight;
                ctx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
            }
        });
    }

    async onSlotTap(index) {
        // In sequencer mode, tap opens step config
        if (this._seqMode) {
            this.seqStepTap(index);
            return;
        }
        // In sampler mode, trigger is handled by mousedown/touchstart
        if (this._sampleMode) {
            return;
        }
        await this.ensureAudioInit();
        const slot = this.slots.slots[index];

        // If we're recording into this slot, stop recording
        if (this.recordingSlotIndex === index) {
            await this.stopRecording();
            return;
        }

        // If we're recording into a different slot, ignore
        if (this.recordingSlotIndex >= 0) return;

        // If a selection exists and this is an empty slot, offer to copy
        if (!slot.hasAudio && this.channels && this.waveform.getSelection()) {
            const sel = this.waveform.getSelection();
            if (sel && confirm(`Copy selection to slot ${index + 1}?`)) {
                const copied = this.channels.map(ch => ch.slice(sel.start, sel.end));
                await this.slots.saveSlotAudio(index, copied, this.bufferSampleRate);

                this.renderSlotGrid();
                return;
            }
        }

        // If this slot is already selected and empty, start recording
        if (index === this.slots.selectedIndex && !slot.hasAudio) {
            await this.startRecording(index);
            return;
        }

        // If already selected and has audio, toggle play/stop
        if (index === this.slots.selectedIndex && slot.hasAudio && this.channels) {
            if (this.audio.isPlaying) {
                this.stopAudio();
            } else {
                this.playAudio(true); // from start
            }
            return;
        }

        // Select the slot
        this.audio.stop();
        this.cancelAnimationLoop();
        document.getElementById('play-btn').classList.remove('playing');
        this.slots.selectSlot(index);
        this.undoStack = [];
        this.redoStack = [];

        // Restore per-slot loop state
        const loopState = !!slot._loop;
        this.audio.setLoop(loopState);
        document.getElementById('loop-btn').classList.toggle('loop-on', loopState);

        if (slot.hasAudio) {
            const data = await this.slots.getSlotAudio(index);
            if (data) {
                this.channels = data.channels;
                this.bufferSampleRate = data.sampleRate;
                this.waveform.setAudio(this.channels, this.bufferSampleRate);
                document.getElementById('waveform-empty').hidden = true;
            }
        } else {
            this.channels = null;
            this.waveform.clear();
            document.getElementById('waveform-empty').hidden = false;
        }

        this.renderSlotGrid();
        this.updateTransportInfo();
        this.updateToolbarState();
        this.restoreMacroUI();
        this._applySlotLiveEffects();
        this._updateLiveEffectFromMacros();
    }

    async startRecording(index) {
        try {
            await this.audio.startRecording(this._selectedInputDeviceId);
        } catch (e) {
            alert('Could not access microphone. Check permissions.');
            return;
        }
        this.recordingSlotIndex = index;
        this._recChunks = [];
        this._recTotalLen = 0;
        this._requestWakeLock();
        document.getElementById('rec-btn').classList.add('recording');
        document.getElementById('waveform-empty').hidden = true;
        this.renderSlotGrid();

        // Live waveform: collect chunks (flattened per animation frame, not per chunk)
        this.audio.onRecordChunk = (chunk) => {
            this._recChunks.push(chunk);
            this._recTotalLen += chunk.length;
        };

        // Animate recording time + live waveform
        const startTime = performance.now();
        const sampleRate = this.audio.sampleRate || 48000;
        const animate = () => {
            if (this.recordingSlotIndex < 0) return;
            const elapsed = (performance.now() - startTime) / 1000;
            document.getElementById('info-duration').textContent = this.formatTime(elapsed);

            // Flatten chunks for waveform display (O(n) per frame, not O(n²) per chunk)
            if (this._recChunks && this._recChunks.length > 0 && this.waveform) {
                const flat = new Float32Array(this._recTotalLen);
                let off = 0;
                for (const c of this._recChunks) {
                    flat.set(c, off);
                    off += c.length;
                }
                this.waveform.updateAudio([flat], sampleRate);
                // Auto-scroll to end so the latest audio is visible
                const totalSamples = this._recTotalLen;
                const visibleSamples = this.waveform.getVisibleSamples();
                if (totalSamples > visibleSamples) {
                    this.waveform.setScrollOffset(totalSamples - visibleSamples);
                }
                this.waveform.render();
            }

            // Gate visual feedback: dim REC button when gate is closed
            if (this._gateEnabled) {
                document.getElementById('rec-btn').classList.toggle('gate-closed', !this.audio.isGateOpen());
            }

            this.animFrameId = requestAnimationFrame(animate);
        };
        animate();
    }

    async stopRecording() {
        this.audio.onRecordChunk = null;
        this._recChunks = null;
        this._recTotalLen = 0;
        const result = this.audio.stopRecording();
        const index = this.recordingSlotIndex;
        this.recordingSlotIndex = -1;
        this._releaseWakeLock();
        this.cancelAnimationLoop();
        document.getElementById('rec-btn').classList.remove('recording');
        document.getElementById('rec-btn').classList.remove('gate-closed');

        if (!result || result.channels[0].length === 0) {
            this.renderSlotGrid();
            return;
        }

        this.channels = result.channels;
        this.bufferSampleRate = result.sampleRate;

        // Save to slot
        await this.slots.saveSlotAudio(index, this.channels, this.bufferSampleRate);


        // Show waveform
        this.waveform.setAudio(this.channels, this.bufferSampleRate);
        document.getElementById('waveform-empty').hidden = true;

        // Prompt for name
        this.showRenameDialog(index);

        this.renderSlotGrid();
        this.updateTransportInfo();
        this.updateToolbarState();
    }

    // === Context Menu ===

    onSlotContext(index, e) {
        e.preventDefault?.();
        // In sequencer mode, long-press selects step (same as tap)
        if (this._seqMode) {
            this.seqStepTap(index);
            return;
        }
        // In sampler mode, long-press selects pad for config (transport updates)
        if (this._sampleMode) {
            this._sampleSelectedPad = index;
            this._updateSampleTransport();
            this.renderSampleGrid();
            return;
        }
        const slot = this.slots.slots[index];
        if (!slot.hasAudio) return;

        const menu = document.getElementById('context-menu');
        const x = e.clientX || e.pageX;
        const y = e.clientY || e.pageY;
        menu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
        menu.hidden = false;
        menu._slotIndex = index;

        const close = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.hidden = true;
                document.removeEventListener('click', close);
            }
        };
        setTimeout(() => document.addEventListener('click', close), 10);
    }

    // === Dialogs ===

    bindDialogs() {
        // Rename dialog
        const dialog = document.getElementById('rename-dialog');
        const input = document.getElementById('rename-input');
        document.getElementById('rename-ok').addEventListener('click', () => {
            const name = input.value.trim() || 'untitled';
            this.slots.renameSlot(dialog._slotIndex, name);
            dialog.hidden = true;
            this.renderSlotGrid();
        });
        document.getElementById('rename-cancel').addEventListener('click', () => {
            dialog.hidden = true;
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('rename-ok').click();
        });

        // Context menu actions
        document.getElementById('context-menu').addEventListener('click', async (e) => {
            const action = e.target.dataset.action;
            const menu = document.getElementById('context-menu');
            const index = menu._slotIndex;
            menu.hidden = true;
            if (!action || index == null) return;

            switch (action) {
                case 'rename':
                    this.showRenameDialog(index);
                    break;
                case 'duplicate': {
                    const empty = this.slots.findEmptySlot();
                    if (empty < 0) { alert('No empty slots'); return; }
                    const data = await this.slots.getSlotAudio(index);
                    if (data) {
                        await this.slots.saveSlotAudio(empty, data.channels, data.sampleRate);
                        this.slots.renameSlot(empty, this.slots.slots[index].name + ' copy');
                        this.renderSlotGrid();
                    }
                    break;
                }
                case 'save':
                    await this.saveSlotToDevice(index);
                    break;
                case 'clear':
                    if (confirm(`Clear slot ${index + 1}?`)) {
                        await this.slots.clearSlot(index);
                        if (index === this.slots.selectedIndex) {
                            this.channels = null;
                            this.waveform.clear();
                            document.getElementById('waveform-empty').hidden = false;
                            this.updateTransportInfo();
                        }
                        this.renderSlotGrid();
                        this.updateToolbarState();
                    }
                    break;
            }
        });
    }

    showRenameDialog(index) {
        const dialog = document.getElementById('rename-dialog');
        const input = document.getElementById('rename-input');
        dialog._slotIndex = index;
        input.value = this.slots.slots[index].name || '';
        dialog.hidden = false;
        setTimeout(() => input.focus(), 50);
    }

    // === Toolbar ===

    bindToolbar() {
        const $ = (id) => document.getElementById(id);

        $('rec-btn').addEventListener('click', async () => {
            await this.ensureAudioInit();
            if (this.recordingSlotIndex >= 0) {
                await this.stopRecording();
            } else if (this.slots.selectedIndex >= 0) {
                const slot = this.slots.getSelectedSlot();
                if (slot && !slot.hasAudio) {
                    await this.startRecording(this.slots.selectedIndex);
                } else {
                    // Find an empty slot
                    const empty = this.slots.findEmptySlot();
                    if (empty >= 0) {
                        this.slots.selectSlot(empty);
                        this.channels = null;
                        this.waveform.clear();
                        this.renderSlotGrid();
                        await this.startRecording(empty);
                    } else {
                        alert('No empty slots available');
                    }
                }
            }
        });

        $('play-btn').addEventListener('click', () => this.playAudio());
        $('stop-btn').addEventListener('click', () => this.stopAudio());
        $('loop-btn').addEventListener('click', () => this.toggleLoop());

        // Noise gate
        $('gate-btn').addEventListener('click', () => this.toggleGate());
        $('gate-threshold').addEventListener('input', () => {
            const dB = parseInt($('gate-threshold').value);
            $('gate-db').textContent = dB + 'dB';
            const linear = Math.pow(10, dB / 20);
            this.audio.setGateThreshold(linear);
        });

        // Input device selection (in main menu)
        $('input-device-select').addEventListener('change', (e) => {
            this._selectedInputDeviceId = e.target.value || null;
        });

        // Edit operations
        $('trim-btn').addEventListener('click', () => this.applyEdit('trim'));
        $('cut-btn').addEventListener('click', () => this.applyEdit('cut'));
        $('copy-btn').addEventListener('click', () => this.copySelection());
        $('paste-btn').addEventListener('click', () => this.applyEdit('paste'));
        $('silence-btn').addEventListener('click', () => this.applyEdit('silence'));
        $('fadein-btn').addEventListener('click', () => this.applyEdit('fadeIn'));
        $('fadeout-btn').addEventListener('click', () => this.applyEdit('fadeOut'));
        $('reverse-btn').addEventListener('click', () => this.applyEdit('reverse'));
        $('norm-btn').addEventListener('click', () => this.applyEdit('normalise'));

        // File operations
        $('save-btn').addEventListener('click', () => this.saveCurrentToDevice());
        $('load-btn').addEventListener('click', () => $('file-input').click());
        $('file-input').addEventListener('change', (e) => this.loadFile(e));

        // FX buttons
        document.querySelectorAll('.fx-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const fxName = btn.dataset.fx;
                if (fxName && Effects.registry[fxName]) {
                    this.openFxDialog(fxName);
                }
            });
        });

        // Bounce & batch export
        $('bounce-btn').addEventListener('click', () => this.bounceToSlot());
        $('export-all-btn').addEventListener('click', () => this.exportAllSlots());

        // Cross-slot
        $('cross-btn').addEventListener('click', () => this.openCrossDialog());
        $('cross-preview').addEventListener('click', () => this.previewCross());
        $('cross-apply').addEventListener('click', () => this.applyCross());
        $('cross-cancel').addEventListener('click', () => {
            document.getElementById('cross-dialog').hidden = true;
            this.audio.stop();
        });

        // Layer & Bounce
        $('layer-btn').addEventListener('click', () => this.openLayerDialog());
        $('layer-preview').addEventListener('click', () => this.previewLayer());
        $('layer-bounce').addEventListener('click', () => this.bounceLayer());
        $('layer-cancel').addEventListener('click', () => {
            document.getElementById('layer-dialog').hidden = true;
            this.audio.stop();
        });

        // FX dialog buttons
        $('fx-preview').addEventListener('click', () => this.previewFx());
        $('fx-apply').addEventListener('click', () => this.applyFx());
        $('fx-cancel').addEventListener('click', () => this.closeFxDialog());

        // Macros
        for (let m = 0; m < 4; m++) {
            $(`macro-${m}`).addEventListener('input', () => this.onMacroChange(m));
        }
        // Mobile macro expand/collapse
        if (window.matchMedia('(max-width: 600px)').matches) {
            const allSlots = document.querySelectorAll('.macro-slot');
            const expandSlot = (activeSlot) => {
                allSlots.forEach(s => {
                    if (s === activeSlot) {
                        s.classList.add('expanded');
                        s.classList.remove('collapsed');
                    } else {
                        s.classList.add('collapsed');
                        s.classList.remove('expanded');
                    }
                });
            };
            const resetSlots = () => {
                allSlots.forEach(s => s.classList.remove('expanded', 'collapsed'));
            };
            allSlots.forEach(slot => {
                const slider = slot.querySelector('.macro-slider');
                // Use touchstart + pointerdown for reliable mobile triggering
                slider.addEventListener('touchstart', () => expandSlot(slot));
                slider.addEventListener('pointerdown', () => expandSlot(slot));
                slider.addEventListener('touchend', () => setTimeout(resetSlots, 300));
                slider.addEventListener('pointerup', () => setTimeout(resetSlots, 300));
            });
        }
        // Macro mapping menu
        document.getElementById('macro-map-menu').addEventListener('click', (e) => {
            const macroIdx = e.target.dataset.macro;
            document.getElementById('macro-map-menu').hidden = true;
            if (macroIdx === undefined) return;
            this._applyMacroMapping(macroIdx);
        });

        // Main menu
        $('menu-btn').addEventListener('click', () => this._toggleMainMenu());
        document.getElementById('main-menu').addEventListener('click', async (e) => {
            const action = e.target.dataset.action;
            if (!action) return; // clicked the select dropdown, don't close
            if (action === 'input') {
                const select = $('input-device-select');
                if (!select.hidden) {
                    select.hidden = true;
                    return;
                }
                const devices = await this.audio.enumerateInputDevices();
                select.innerHTML = '<option value="">Default Mic</option>';
                for (const d of devices) {
                    const opt = document.createElement('option');
                    opt.value = d.deviceId;
                    opt.textContent = d.label;
                    select.appendChild(opt);
                }
                if (this._selectedInputDeviceId) {
                    select.value = this._selectedInputDeviceId;
                }
                select.hidden = false;
                return;
            }
            document.getElementById('main-menu').hidden = true;
            if (action === 'export-all') this.exportAllSlots();
            if (action === 'delete-all') this.deleteAll();
            if (action === 'install') this._promptInstall();
        });

        // Mode toggle: REC / SAMPLE / SEQ
        $('mode-rec').addEventListener('click', () => this.switchMode('rec'));
        $('mode-sample').addEventListener('click', () => this.switchMode('sample'));
        $('mode-seq').addEventListener('click', () => this.switchMode('seq'));

        // Sampler transport — mode buttons
        $('pad-mode-oneshot').addEventListener('click', () => this.setPadMode('oneshot'));
        $('pad-mode-loop').addEventListener('click', () => this.setPadMode('loop'));
        $('pad-mode-rev').addEventListener('click', () => this._togglePadReverse());
        $('pad-mode-keys').addEventListener('click', () => this._toggleChromaticMode());

        // Sample tabs
        document.querySelectorAll('.sample-tab').forEach(tab => {
            tab.addEventListener('click', () => this._switchSampleTab(tab.dataset.tab));
        });

        // ENV panel: mini sliders for pitch/volume
        $('pad-pitch').addEventListener('input', () => this._updatePadEnv());
        $('pad-volume').addEventListener('input', () => this._updatePadEnv());

        // ENV panel: canvas envelope editor
        this._initEnvEditor();

        // FILT panel
        $('pad-filter-toggle').addEventListener('click', () => this._togglePadFilter());
        $('pad-filter-type').addEventListener('change', () => this._updatePadFilter());
        $('pad-filter-freq').addEventListener('input', () => this._updatePadFilter());
        $('pad-filter-q').addEventListener('input', () => this._updatePadFilter());

        // LFO panel
        $('pad-lfo-toggle').addEventListener('click', () => this._togglePadLfo());
        $('pad-lfo-target').addEventListener('change', () => this._updatePadLfo());
        $('pad-lfo-rate').addEventListener('input', () => this._updatePadLfo());
        $('pad-lfo-depth').addEventListener('input', () => this._updatePadLfo());
        $('pad-lfo-shape').addEventListener('change', () => this._updatePadLfo());

        // MORPH panel
        $('morph-target').addEventListener('change', () => this._updateMorphConfig());
        $('morph-type').addEventListener('change', () => this._updateMorphConfig());
        $('morph-amount').addEventListener('input', () => {
            document.getElementById('morph-amount-val').textContent = document.getElementById('morph-amount').value + '%';
            this._updateMorphConfig();
        });
        $('seq-play-btn').addEventListener('click', () => this.seqPlayStop());
        $('seq-rec-btn').addEventListener('click', () => this.seqToggleRecord());
        $('seq-undo-btn').addEventListener('click', () => this.seqLooperUndo());
        $('bpm-down').addEventListener('click', () => this.seqAdjustBpm(-1));
        $('bpm-up').addEventListener('click', () => this.seqAdjustBpm(1));
        $('bpm-display').addEventListener('click', () => this.seqEditBpm());
        $('tap-tempo-btn').addEventListener('click', () => this.seqTapTempo());
        $('seq-random-btn').addEventListener('click', () => this.seqRandomise());
        $('seq-stutter-btn').addEventListener('click', () => this.seqStutter());
        $('seq-stutter-amount').addEventListener('input', (e) => {
            this.sequencer.stutterAmount = parseInt(e.target.value) / 100;
        });
        $('seq-mutate-btn').addEventListener('click', () => this.seqToggleMutate());
        $('seq-mutate-amount').addEventListener('input', (e) => {
            this.sequencer.mutateAmount = parseInt(e.target.value) / 100;
        });
        $('seq-bounce-btn').addEventListener('click', () => this.seqBounce());
        $('seq-clear-btn').addEventListener('click', () => this.seqClear());
        $('seq-step-count').addEventListener('change', (e) => {
            const n = parseInt(e.target.value);
            this.sequencer.setStepCount(n);
            this.buildSlotGrid();
            this.renderSeqGrid();
            this._saveSeqPattern();
        });

        // Step mode menu (mode/direction buttons only; per-slot pitch is in the picker)
        document.getElementById('step-mode-menu').addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.mode) this._setStepMode(btn.dataset.mode);
            if (btn.dataset.dir) this._setStepDirection(btn.dataset.dir);
        });

        // Undo/redo
        $('undo-btn').addEventListener('click', () => this.undo());
        $('redo-btn').addEventListener('click', () => this.redo());

        // Zoom
        $('zoom-in').addEventListener('click', () => {
            if (this._seqMode) {
                this._seqPreviewBank(1);
                return;
            }
            if (this._sampleMode && this._chromaticMode) {
                this._chromaticOctaveSpan = Math.min(7, this._chromaticOctaveSpan + 1);
                this._renderPianoKeyboard();
                return;
            }
            this.waveform.setZoom(this.waveform.getZoom() * 1.5);
            this.waveform.render();
        });
        $('zoom-out').addEventListener('click', () => {
            if (this._seqMode) {
                this._seqPreviewBank(-1);
                return;
            }
            if (this._sampleMode && this._chromaticMode) {
                this._chromaticOctaveSpan = Math.max(1, this._chromaticOctaveSpan - 1);
                this._renderPianoKeyboard();
                return;
            }
            this.waveform.setZoom(this.waveform.getZoom() / 1.5);
            this.waveform.render();
        });
        $('zoom-fit').addEventListener('click', () => {
            if (this._seqMode) {
                this._seqConfirmBank();
                return;
            }
            this.waveform.setZoom(1);
            this.waveform.setScrollOffset(0);
            this.waveform.render();
        });
    }

    // === Playback ===

    playAudio(fromStart = false) {
        if (!this.channels) return;
        const sel = this.waveform.getSelection();
        const cursor = this.waveform.getCursor();
        const start = sel ? sel.start : (fromStart ? 0 : cursor);
        const end = sel ? sel.end : this.channels[0].length;

        this.audio.play(this.channels, this.bufferSampleRate, start, end, () => {
            this.cancelAnimationLoop();
            document.getElementById('play-btn').classList.remove('playing');
            this.waveform.setCursor(start);
            this.waveform.render();
        });

        document.getElementById('play-btn').classList.add('playing');
        this.startCursorAnimation();
    }

    stopAudio() {
        this.audio.stop();
        this.cancelAnimationLoop();
        document.getElementById('play-btn').classList.remove('playing');
    }

    toggleLoop() {
        const looping = !this.audio.isLooping;
        this.audio.setLoop(looping);
        document.getElementById('loop-btn').classList.toggle('loop-on', looping);

        // Store per-slot
        const slot = this.slots.getSelectedSlot();
        if (slot) slot._loop = looping;

        // If turning on loop while playing, restart to enable loop
        if (looping && this.audio.isPlaying) {
            this._restartLoop();
        }
    }

    toggleGate() {
        this._gateEnabled = !this._gateEnabled;
        this.audio.setGateEnabled(this._gateEnabled);
        document.getElementById('gate-btn').classList.toggle('gate-on', this._gateEnabled);
        document.getElementById('gate-threshold').hidden = !this._gateEnabled;
        document.getElementById('gate-db').hidden = !this._gateEnabled;

        // Send initial threshold when enabling
        if (this._gateEnabled) {
            const dB = parseInt(document.getElementById('gate-threshold').value);
            const linear = Math.pow(10, dB / 20);
            this.audio.setGateThreshold(linear);
        }
    }

    _restartLoop() {
        if (!this.channels) return;
        const sel = this.waveform.getSelection();
        const start = sel ? sel.start : 0;
        const end = sel ? sel.end : this.channels[0].length;

        this.audio.play(this.channels, this.bufferSampleRate, start, end, () => {
            this.cancelAnimationLoop();
            document.getElementById('play-btn').classList.remove('playing');
            this.waveform.setCursor(start);
            this.waveform.render();
        });
        this.cancelAnimationLoop();
        this.startCursorAnimation();
    }

    startCursorAnimation() {
        const animate = () => {
            if (!this.audio.isPlaying) return;
            const sample = this.audio.getPlaybackSample();
            this.waveform.setCursor(sample);
            this.waveform.render();
            this.animFrameId = requestAnimationFrame(animate);
        };
        animate();
    }

    cancelAnimationLoop() {
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
    }

    // === Editing ===

    pushUndo() {
        if (!this.channels) return;
        this.undoStack.push(this.channels.map(ch => new Float32Array(ch)));
        if (this.undoStack.length > this.maxUndo) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.updateUndoCount();
    }

    undo() {
        if (this.undoStack.length === 0) return;
        this.redoStack.push(this.channels.map(ch => new Float32Array(ch)));
        this.channels = this.undoStack.pop();
        this.refreshWaveform();
        this.updateUndoCount();
        if (this.undoStack.length === 0) {
            // Flash warning
            document.getElementById('undo-count').textContent = 'last undo!';
            setTimeout(() => this.updateUndoCount(), 2000);
        }
    }

    redo() {
        if (this.redoStack.length === 0) return;
        this.undoStack.push(this.channels.map(ch => new Float32Array(ch)));
        this.channels = this.redoStack.pop();
        this.refreshWaveform();
        this.updateUndoCount();
    }

    updateUndoCount() {
        const el = document.getElementById('undo-count');
        const n = this.undoStack.length;
        el.textContent = n > 0 ? `${n}/${this.maxUndo}` : '';
        document.getElementById('undo-btn').disabled = n === 0;
        document.getElementById('redo-btn').disabled = this.redoStack.length === 0;
    }

    applyEdit(operation) {
        if (!this.channels) return;
        const sel = this.waveform.getSelection();
        const total = this.channels[0].length;
        const start = sel ? sel.start : 0;
        const end = sel ? sel.end : total;

        if (start === end) return;

        this.pushUndo();
        let result;

        switch (operation) {
            case 'trim':
                result = AudioEngine.trim(this.channels, start, end);
                break;
            case 'cut':
                result = AudioEngine.cut(this.channels, start, end);
                break;
            case 'silence':
                result = AudioEngine.silence(this.channels, start, end);
                break;
            case 'fadeIn':
                result = AudioEngine.fadeIn(this.channels, start, end);
                break;
            case 'fadeOut':
                result = AudioEngine.fadeOut(this.channels, start, end);
                break;
            case 'reverse':
                result = AudioEngine.reverse(this.channels, start, end);
                break;
            case 'normalise':
                result = AudioEngine.normalise(this.channels, start, end);
                break;
            case 'paste':
                if (!this.clipboard) return;
                const pastePos = sel ? sel.start : this.waveform.getCursor();
                result = AudioEngine.paste(this.channels, this.clipboard, pastePos);
                break;
            default:
                return;
        }

        this.channels = result;
        this.saveCurrentSlot();
        this.refreshWaveform();

        // Clear selection for operations that change length
        if (['trim', 'cut', 'paste'].includes(operation)) {
            this.waveform.clearSelection();
        }
    }

    copySelection() {
        if (!this.channels) return;
        const sel = this.waveform.getSelection();
        if (!sel) return;
        this.clipboard = this.channels.map(ch => ch.slice(sel.start, sel.end));
    }

    refreshWaveform() {
        this.waveform.setAudio(this.channels, this.bufferSampleRate);
        this.updateTransportInfo();
        this.updateToolbarState();

        // If looping, restart playback with updated audio
        if (this.audio.isLooping && this.audio.isPlaying) {
            this._restartLoop();
        }
    }

    async saveCurrentSlot() {
        const idx = this.slots.selectedIndex;
        if (idx < 0 || !this.channels) return;
        await this.slots.saveSlotAudio(idx, this.channels, this.bufferSampleRate);
        this.renderSlotGrid();
    }

    // === File I/O ===

    async saveCurrentToDevice() {
        if (!this.channels) return;
        const idx = this.slots.selectedIndex;
        const name = idx >= 0 ? this.slots.slots[idx].name : 'recording';
        await this.saveSlotToDevice(idx >= 0 ? idx : 0);
    }

    async saveSlotToDevice(index) {
        let channels, sampleRate;
        if (index === this.slots.selectedIndex && this.channels) {
            channels = this.channels;
            sampleRate = this.bufferSampleRate;
        } else {
            const data = await this.slots.getSlotAudio(index);
            if (!data) return;
            channels = data.channels;
            sampleRate = data.sampleRate;
        }

        const blob = AudioEngine.encodeWAV(channels, sampleRate);
        const name = this.slots.slots[index].name || 'recording';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `soniphorm-${name}-${timestamp}.wav`;

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    async loadFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';

        await this.ensureAudioInit();

        let targetIndex = this.slots.selectedIndex;
        if (targetIndex < 0 || this.slots.slots[targetIndex].hasAudio) {
            targetIndex = this.slots.findEmptySlot();
        }
        if (targetIndex < 0) {
            alert('No empty slots available');
            return;
        }

        try {
            const decoded = await AudioEngine.decodeBlob(file, this.audio.audioContext);
            this.slots.selectSlot(targetIndex);
            this.channels = decoded.channels;
            this.bufferSampleRate = decoded.sampleRate;
            this.undoStack = [];
            this.redoStack = [];

            const name = file.name.replace(/\.[^.]+$/, '').slice(0, 32);
            await this.slots.saveSlotAudio(targetIndex, this.channels, this.bufferSampleRate);
            this.slots.renameSlot(targetIndex, name);

            this.waveform.setAudio(this.channels, this.bufferSampleRate);
            document.getElementById('waveform-empty').hidden = true;

            this.renderSlotGrid();
            this.updateTransportInfo();
            this.updateToolbarState();
        } catch (err) {
            alert('Could not decode audio file');
            console.error(err);
        }
    }

    // === Effects ===

    /** Load the active audio channels — pad buffer from IDB in sample mode, else rec view. */
    async _getActiveChannels() {
        if (this._sampleMode) {
            const slot = this.slots.slots[this._sampleSelectedPad];
            if (!slot || !slot.hasAudio) return null;
            const data = await this.slots.getSlotAudio(this._sampleSelectedPad);
            return data ? data.channels : null;
        }
        return this.channels;
    }

    /** Get sample rate for active audio. */
    _getActiveSampleRate() {
        if (this._sampleMode) {
            const slot = this.slots.slots[this._sampleSelectedPad];
            return (slot && slot.sampleRate) || (this.audio.audioContext && this.audio.audioContext.sampleRate) || 44100;
        }
        return this.bufferSampleRate;
    }

    openFxDialog(fxName) {
        if (this._sampleMode) {
            const slot = this.slots.slots[this._sampleSelectedPad];
            if (!slot || !slot.hasAudio) return;
        } else if (!this.channels) return;
        const fx = Effects.registry[fxName];
        if (!fx) return;

        this._currentFx = fxName;
        document.getElementById('fx-title').textContent = fx.label;

        // Build parameter controls
        const container = document.getElementById('fx-params');
        container.innerHTML = '';

        fx.params.forEach(p => {
            const div = document.createElement('div');
            div.className = 'fx-param';

            if (p.type === 'select') {
                div.innerHTML = `
                    <div class="fx-param-header">
                        <span class="fx-param-label">${p.label}</span>
                    </div>
                    <select data-key="${p.key}">
                        ${p.options.map(o => `<option value="${o}" ${o === p.default ? 'selected' : ''}>${o}</option>`).join('')}
                    </select>
                `;
            } else if (p.scale === 'log') {
                // Logarithmic slider: 0–1000 internal, mapped to log range
                const logMin = Math.log(p.min);
                const logMax = Math.log(p.max);
                const logDefault = Math.round(((Math.log(p.default) - logMin) / (logMax - logMin)) * 1000);
                const unit = p.unit || '';
                div.innerHTML = `
                    <div class="fx-param-header">
                        <span class="fx-param-label">${p.label}</span>
                        <span class="fx-param-value" data-value-for="${p.key}">${p.default}${unit}</span>
                    </div>
                    <input type="range" data-key="${p.key}" data-scale="log" data-log-min="${p.min}" data-log-max="${p.max}" min="0" max="1000" step="1" value="${logDefault}">
                `;
                setTimeout(() => {
                    const input = div.querySelector('input[type="range"]');
                    input.addEventListener('input', () => {
                        const t = input.value / 1000;
                        const val = Math.round(Math.exp(logMin + t * (logMax - logMin)));
                        div.querySelector('.fx-param-value').textContent = val + unit;
                    });
                }, 0);
            } else {
                const unit = p.unit || '';
                div.innerHTML = `
                    <div class="fx-param-header">
                        <span class="fx-param-label">${p.label}</span>
                        <span class="fx-param-value" data-value-for="${p.key}">${p.default}${unit}</span>
                    </div>
                    <input type="range" data-key="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}">
                `;
                // Live value display
                setTimeout(() => {
                    const input = div.querySelector('input[type="range"]');
                    input.addEventListener('input', () => {
                        div.querySelector('.fx-param-value').textContent = input.value + unit;
                    });
                }, 0);
            }
            // Add right-click / long-press for macro mapping (on range inputs only)
            if (p.type !== 'select') {
                const rangeInput = div.querySelector('input[type="range"]');
                if (rangeInput) {
                    rangeInput.addEventListener('contextmenu', (e) => {
                        this.showMacroMapMenu(e, fxName, p);
                    });
                    // Long press for mobile
                    let pressTimer = null;
                    rangeInput.addEventListener('touchstart', (e) => {
                        pressTimer = setTimeout(() => {
                            this.showMacroMapMenu(e.touches[0], fxName, p);
                        }, 600);
                    });
                    rangeInput.addEventListener('touchend', () => clearTimeout(pressTimer));
                    rangeInput.addEventListener('touchmove', () => clearTimeout(pressTimer));
                }
            }

            container.appendChild(div);
        });

        // For reverb/delay, pre-populate from existing live effect settings
        const slot = this.slots.slots[this.slots.selectedIndex];
        const slotFx = slot && slot._liveEffects;
        if ((fxName === 'reverb' || fxName === 'delay') && slotFx && slotFx[fxName]) {
            const saved = slotFx[fxName];
            fx.params.forEach(p => {
                if (saved[p.key] !== undefined) {
                    const paramEl = document.querySelector(`#fx-params [data-key="${p.key}"]`);
                    if (paramEl) {
                        if (paramEl.dataset.scale === 'log') {
                            const logMin = Math.log(p.min);
                            const logMax = Math.log(p.max);
                            const logVal = Math.log(saved[p.key]);
                            paramEl.value = Math.round(((logVal - logMin) / (logMax - logMin)) * 1000);
                        } else {
                            paramEl.value = saved[p.key];
                        }
                        paramEl.dispatchEvent(new Event('input'));
                    }
                }
            });
            // Update Apply button to say "Set Live"
            document.getElementById('fx-apply').textContent = 'Set Live';
        } else if (fxName === 'reverb' || fxName === 'delay') {
            document.getElementById('fx-apply').textContent = 'Set Live';
        } else {
            document.getElementById('fx-apply').textContent = 'Apply';
        }

        // If macros are mapped to this effect's params, set slider values from macros
        const macros = this._getSlotMacros();
        if (macros) {
            for (let m = 0; m < 4; m++) {
                const mapping = macros[m].mapping;
                if (mapping && mapping.fx === fxName) {
                    const paramEl = document.querySelector(`#fx-params [data-key="${mapping.paramKey}"]`);
                    if (paramEl) {
                        const realVal = mapping.min + macros[m].value * (mapping.max - mapping.min);
                        if (paramEl.dataset.scale === 'log') {
                            const logMin = Math.log(mapping.min);
                            const logMax = Math.log(mapping.max);
                            const logVal = Math.log(realVal);
                            paramEl.value = Math.round(((logVal - logMin) / (logMax - logMin)) * 1000);
                        } else {
                            paramEl.value = realVal;
                        }
                        paramEl.dispatchEvent(new Event('input'));
                    }
                }
            }
        }

        document.getElementById('fx-dialog').hidden = false;
    }

    closeFxDialog() {
        document.getElementById('fx-dialog').hidden = true;
        this._currentFx = null;
        document.getElementById('macro-map-menu').hidden = true;
    }

    _gatherFxParams() {
        const params = {};
        document.querySelectorAll('#fx-params [data-key]').forEach(el => {
            const key = el.dataset.key;
            if (el.tagName === 'SELECT') {
                params[key] = el.value;
            } else if (el.dataset.scale === 'log') {
                const t = parseFloat(el.value) / 1000;
                const logMin = Math.log(parseFloat(el.dataset.logMin));
                const logMax = Math.log(parseFloat(el.dataset.logMax));
                params[key] = Math.round(Math.exp(logMin + t * (logMax - logMin)));
            } else {
                params[key] = parseFloat(el.value);
            }
        });
        return params;
    }

    _getFxRegion(ch) {
        const channels = ch || this.channels;
        const sel = this.waveform.getSelection();
        const start = sel ? sel.start : 0;
        const end = sel ? sel.end : (channels ? channels[0].length : 0);
        return { start, end };
    }

    async previewFx() {
        const ch = await this._getActiveChannels();
        const sr = this._getActiveSampleRate();
        if (!ch || !this._currentFx) return;
        const fx = Effects.registry[this._currentFx];
        const params = this._gatherFxParams();
        const { start, end } = this._getFxRegion(ch);

        // Process a short preview section (max 3 seconds)
        const maxSamples = sr * 3;
        const previewEnd = Math.min(end, start + maxSamples);

        const previewBtn = document.getElementById('fx-preview');
        previewBtn.textContent = '...';
        previewBtn.disabled = true;

        try {
            const result = await fx.process(ch, sr, start, previewEnd, params);
            // Play the processed preview
            this.audio.stop();
            this.audio.play(result, sr, start, previewEnd, () => {
                document.getElementById('play-btn').classList.remove('playing');
            });
        } catch (e) {
            console.error('FX preview error:', e);
        } finally {
            previewBtn.textContent = 'Preview';
            previewBtn.disabled = false;
        }
    }

    async applyFx() {
        const ch = await this._getActiveChannels();
        const sr = this._getActiveSampleRate();
        if (!ch || !this._currentFx) return;
        const fxName = this._currentFx;
        const fx = Effects.registry[fxName];
        const params = this._gatherFxParams();

        // Reverb and delay: apply as live (non-destructive) per-slot effects
        if (fxName === 'reverb' || fxName === 'delay') {
            const slotIdx = this._sampleMode ? this._sampleSelectedPad : this.slots.selectedIndex;
            const slot = this.slots.slots[slotIdx];
            if (!slot._liveEffects) slot._liveEffects = {};
            slot._liveEffects[fxName] = Object.assign({}, params);
            this._applySlotLiveEffects();
            this.closeFxDialog();
            return;
        }

        const { start, end } = this._getFxRegion(ch);

        const applyBtn = document.getElementById('fx-apply');
        applyBtn.textContent = 'Processing...';
        applyBtn.disabled = true;
        document.getElementById('fx-preview').disabled = true;
        document.getElementById('fx-cancel').disabled = true;

        try {
            if (this._sampleMode) {
                // Apply destructively to the selected pad's slot
                const slotIdx = this._sampleSelectedPad;
                const result = await fx.process(ch, sr, start, end, params);
                await this.slots.saveSlotAudio(slotIdx, result, sr);
                // Rebuild sampler buffer cache
                await this._seqPreloadBuffers();
                this.renderSampleGrid();
                this.closeFxDialog();
            } else {
                this.pushUndo();
                const result = await fx.process(ch, sr, start, end, params);
                this.channels = result;
                this.saveCurrentSlot();
                this.refreshWaveform();
                this.closeFxDialog();
            }
        } catch (e) {
            console.error('FX apply error:', e);
            if (!this._sampleMode) this.undo();
            alert('Effect processing failed');
        } finally {
            applyBtn.textContent = 'Apply';
            applyBtn.disabled = false;
            document.getElementById('fx-preview').disabled = false;
            document.getElementById('fx-cancel').disabled = false;
        }
    }

    _applySlotLiveEffects() {
        const slot = this.slots.slots[this.slots.selectedIndex];
        const fx = slot && slot._liveEffects;

        if (fx && fx.reverb) {
            const p = fx.reverb;
            this.audio.enableLiveReverb(
                p.decay !== undefined ? p.decay : 2,
                p.mix !== undefined ? p.mix / 100 : 0.4
            );
        } else if (this.audio._liveReverb) {
            this.audio.disableLiveReverb();
        }

        if (fx && fx.delay) {
            const p = fx.delay;
            this.audio.enableLiveDelay(
                p.time !== undefined ? p.time / 1000 : 0.3,
                p.feedback !== undefined ? p.feedback / 100 : 0.4,
                p.mix !== undefined ? p.mix / 100 : 0.5
            );
        } else if (this.audio._liveDelay) {
            this.audio.disableLiveDelay();
        }
    }

    async bounceToSlot() {
        // In sample mode with morph, bounce the morphed buffer
        if (this._sampleMode) {
            const padIdx = this._sampleSelectedPad;
            const pad = this.sampler.pads[padIdx];
            if (pad.mode === 'morph') {
                const morphBuf = this.sampler._getMorphBuffer(padIdx);
                if (!morphBuf) { alert('No morph buffer to bounce'); return; }
                const emptySlot = this.slots.findEmptySlot();
                if (emptySlot < 0) { alert('No empty slots available'); return; }
                const channels = [];
                for (let ch = 0; ch < morphBuf.numberOfChannels; ch++) {
                    channels.push(new Float32Array(morphBuf.getChannelData(ch)));
                }
                await this.slots.saveSlotAudio(emptySlot, channels, morphBuf.sampleRate);
                const srcName = this.slots.slots[padIdx]?.name || 'morph';
                await this.slots.renameSlot(emptySlot, srcName + '-mrp');
                this.renderSlotGrid();
                if (this._sampleMode) this.renderSampleGrid();
                // Refresh slot buffer cache for the new slot
                await this._seqPreloadBuffers();
                return;
            }
        }

        if (!this.channels) return;
        const sel = this.waveform.getSelection();
        const start = sel ? sel.start : 0;
        const end = sel ? sel.end : this.channels[0].length;

        const emptySlot = this.slots.findEmptySlot();
        if (emptySlot < 0) {
            alert('No empty slots available');
            return;
        }

        const bounced = this.channels.map(ch => ch.slice(start, end));
        await this.slots.saveSlotAudio(emptySlot, bounced, this.bufferSampleRate);

        const srcName = this.slots.slots[this.slots.selectedIndex]?.name || 'bounce';
        await this.slots.renameSlot(emptySlot, srcName + '-b');

        this.renderSlotGrid();
    }

    // === Macros ===

    _getSlotMacros() {
        const slot = this.slots.getSelectedSlot();
        if (!slot) return null;
        if (!slot._macros) {
            slot._macros = [];
            for (let i = 0; i < 4; i++) {
                slot._macros.push({ value: 0.5, mapping: null });
            }
        }
        return slot._macros;
    }

    restoreMacroUI() {
        const macros = this._getSlotMacros();
        for (let m = 0; m < 4; m++) {
            const slider = document.getElementById(`macro-${m}`);
            const label = document.getElementById(`macro-label-${m}`);
            const valueEl = document.getElementById(`macro-value-${m}`);
            const slotEl = slider.closest('.macro-slot');

            if (macros) {
                slider.value = macros[m].value * 1000;
                const mapping = macros[m].mapping;
                if (mapping) {
                    label.textContent = mapping.label.slice(0, 3).toUpperCase();
                    label.classList.add('mapped');
                    slotEl.classList.add('mapped');
                    const realVal = this._macroToReal(macros[m].value, mapping);
                    valueEl.textContent = this._formatMacroValue(realVal, mapping);
                } else {
                    label.textContent = `M${m + 1}`;
                    label.classList.remove('mapped');
                    slotEl.classList.remove('mapped');
                    valueEl.textContent = macros[m].value.toFixed(2);
                }
            } else {
                slider.value = 500;
                label.textContent = `M${m + 1}`;
                label.classList.remove('mapped');
                slotEl.classList.remove('mapped');
                valueEl.textContent = '0.50';
            }
        }
    }

    _formatMacroValue(val, mapping) {
        if (mapping.step >= 1) {
            return Math.round(val) + (mapping.unit || '');
        }
        return val.toFixed(mapping.step < 0.1 ? 2 : 1) + (mapping.unit || '');
    }

    _macroToReal(normalized, mapping) {
        if (mapping.scale === 'log') {
            const logMin = Math.log(mapping.min);
            const logMax = Math.log(mapping.max);
            return Math.exp(logMin + normalized * (logMax - logMin));
        }
        return mapping.min + normalized * (mapping.max - mapping.min);
    }

    onMacroChange(macroIdx) {
        const macros = this._getSlotMacros();
        if (!macros) return;

        const slider = document.getElementById(`macro-${macroIdx}`);
        const normalized = parseInt(slider.value) / 1000;
        macros[macroIdx].value = normalized;

        const mapping = macros[macroIdx].mapping;
        const valueEl = document.getElementById(`macro-value-${macroIdx}`);

        if (mapping) {
            const realVal = this._macroToReal(normalized, mapping);
            valueEl.textContent = this._formatMacroValue(realVal, mapping);

            // Update FX dialog slider if open
            if (this._currentFx === mapping.fx) {
                const paramEl = document.querySelector(`#fx-params [data-key="${mapping.paramKey}"]`);
                if (paramEl) {
                    if (paramEl.dataset.scale === 'log') {
                        const logMin = Math.log(mapping.min);
                        const logMax = Math.log(mapping.max);
                        paramEl.value = Math.round(normalized * 1000);
                    } else {
                        paramEl.value = realVal;
                    }
                    paramEl.dispatchEvent(new Event('input'));
                }
            }

            // Update real-time audio nodes
            this._updateLiveEffectFromMacros();
        } else {
            valueEl.textContent = normalized.toFixed(2);
        }
    }

    _updateLiveEffectFromMacros() {
        const macros = this._getSlotMacros();
        if (!macros) return;

        // Collect all mapped params by effect
        const mapped = {};
        for (let m = 0; m < 4; m++) {
            const mapping = macros[m].mapping;
            if (!mapping) continue;
            if (!mapped[mapping.fx]) mapped[mapping.fx] = {};
            mapped[mapping.fx][mapping.paramKey] = this._macroToReal(macros[m].value, mapping);
        }

        // Filter — real-time via BiquadFilterNode
        if (mapped.filter) {
            const p = mapped.filter;
            this.audio.enableLiveFilter(
                p.type || 'lowpass',
                p.frequency !== undefined ? p.frequency : 1000,
                p.q !== undefined ? p.q : 1
            );
        } else if (this.audio._liveFilter) {
            this.audio.disableLiveFilter();
        }

        // Reverb — macro overrides slot live effect
        const slot = this.slots.slots[this.slots.selectedIndex];
        const slotFx = slot && slot._liveEffects;

        if (mapped.reverb) {
            const p = mapped.reverb;
            this.audio.enableLiveReverb(
                p.decay !== undefined ? p.decay : 2,
                p.mix !== undefined ? p.mix / 100 : 0.4
            );
        } else if (this.audio._liveReverb && !(slotFx && slotFx.reverb)) {
            // Only disable if no slot-level reverb is set
            this.audio.disableLiveReverb();
        }

        // Delay — macro overrides slot live effect
        if (mapped.delay) {
            const p = mapped.delay;
            this.audio.enableLiveDelay(
                p.time !== undefined ? p.time / 1000 : 0.3,
                p.feedback !== undefined ? p.feedback / 100 : 0.4,
                p.mix !== undefined ? p.mix / 100 : 0.5
            );
        } else if (this.audio._liveDelay && !(slotFx && slotFx.delay)) {
            // Only disable if no slot-level delay is set
            this.audio.disableLiveDelay();
        }

        // Pitch shift — tape-style via playbackRate
        if (mapped.pitchshift) {
            const semitones = mapped.pitchshift.semitones !== undefined ? mapped.pitchshift.semitones : 0;
            this.audio.setPlaybackRate(Math.pow(2, semitones / 12));
        } else {
            // Reset to normal speed if no pitch mapping active
            this.audio.setPlaybackRate(1);
        }
    }

    // Show mapping menu when right-clicking/long-pressing an FX param slider
    showMacroMapMenu(e, fxName, paramDef) {
        e.preventDefault();
        this._pendingMapParam = { fx: fxName, param: paramDef };

        const menu = document.getElementById('macro-map-menu');
        const x = e.clientX || e.pageX || 0;
        const y = e.clientY || e.pageY || 0;
        menu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
        menu.hidden = false;

        // Update menu labels to show current mappings
        const macros = this._getSlotMacros();
        menu.querySelectorAll('button[data-macro]').forEach(btn => {
            const idx = btn.dataset.macro;
            if (idx === 'clear') return;
            const m = macros ? macros[parseInt(idx)] : null;
            if (m && m.mapping) {
                btn.textContent = `M${parseInt(idx) + 1} (${m.mapping.label})`;
            } else {
                btn.textContent = `Map to M${parseInt(idx) + 1}`;
            }
        });

        const close = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.hidden = true;
                document.removeEventListener('click', close);
            }
        };
        setTimeout(() => document.addEventListener('click', close), 10);
    }

    _applyMacroMapping(macroIdx) {
        const pending = this._pendingMapParam;
        this._pendingMapParam = null;
        if (!pending) return;

        const macros = this._getSlotMacros();
        if (!macros) return;

        if (macroIdx === 'clear') {
            // Find and clear any macro mapped to this param
            for (let m = 0; m < 4; m++) {
                if (macros[m].mapping &&
                    macros[m].mapping.fx === pending.fx &&
                    macros[m].mapping.paramKey === pending.param.key) {
                    macros[m].mapping = null;
                }
            }
        } else {
            const m = parseInt(macroIdx);
            const p = pending.param;
            macros[m].mapping = {
                fx: pending.fx,
                paramKey: p.key,
                label: p.label,
                min: p.min,
                max: p.max,
                step: p.step,
                unit: p.unit || '',
                scale: p.scale || 'linear'
            };
        }

        this.restoreMacroUI();
    }

    // === Batch Export ===

    async exportAllSlots() {
        const filled = this.slots.slots.filter(s => s.hasAudio);
        if (filled.length === 0) {
            alert('No recordings to export');
            return;
        }

        for (const slot of filled) {
            let channels, sampleRate;
            if (slot.index === this.slots.selectedIndex && this.channels) {
                channels = this.channels;
                sampleRate = this.bufferSampleRate;
            } else {
                const data = await this.slots.getSlotAudio(slot.index);
                if (!data) continue;
                channels = data.channels;
                sampleRate = data.sampleRate;
            }

            const blob = AudioEngine.encodeWAV(channels, sampleRate);
            const name = slot.name || `slot-${slot.index + 1}`;
            const filename = `soniphorm-${name}.wav`;

            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);

            // Small delay between downloads so browser doesn't block them
            await new Promise(r => setTimeout(r, 300));
        }
    }

    // === Cross-slot Processing ===

    openCrossDialog() {
        if (!this.channels) return;

        // Populate source slot dropdown (exclude current slot)
        const select = document.getElementById('cross-source');
        select.innerHTML = '';
        this.slots.slots.forEach(s => {
            if (s.hasAudio && s.index !== this.slots.selectedIndex) {
                const opt = document.createElement('option');
                opt.value = s.index;
                opt.textContent = `${String(s.index + 1).padStart(2, '0')} — ${s.name || 'untitled'}`;
                select.appendChild(opt);
            }
        });

        if (select.options.length === 0) {
            alert('Need at least one other slot with audio');
            return;
        }

        document.getElementById('cross-dialog').hidden = false;
    }

    async _getCrossSourceAudio() {
        const sourceIndex = parseInt(document.getElementById('cross-source').value);
        return await this.slots.getSlotAudio(sourceIndex);
    }

    async _processCross(channels, sampleRate, start, end) {
        const op = document.getElementById('cross-op').value;
        const sourceData = await this._getCrossSourceAudio();
        if (!sourceData) throw new Error('Could not load source slot');

        const sourceChannel = sourceData.channels[0];
        const numChannels = channels.length;
        const regionLen = end - start;

        if (op === 'convolve') {
            // Use source audio as impulse response via OfflineAudioContext
            const offline = new OfflineAudioContext(numChannels, regionLen + sourceChannel.length, sampleRate);
            const buffer = offline.createBuffer(numChannels, regionLen, sampleRate);
            for (let ch = 0; ch < numChannels; ch++) {
                buffer.getChannelData(ch).set(channels[ch].subarray(start, end));
            }

            // Trim source to max 3 seconds for IR
            const maxIRLen = Math.min(sourceChannel.length, sampleRate * 3);
            const irBuffer = offline.createBuffer(1, maxIRLen, sampleRate);
            irBuffer.getChannelData(0).set(sourceChannel.subarray(0, maxIRLen));

            const source = offline.createBufferSource();
            source.buffer = buffer;
            const convolver = offline.createConvolver();
            convolver.buffer = irBuffer;
            source.connect(convolver);
            convolver.connect(offline.destination);
            source.start();

            const rendered = await offline.startRendering();
            const result = channels.map(ch => new Float32Array(ch));
            for (let ch = 0; ch < numChannels; ch++) {
                const data = rendered.getChannelData(Math.min(ch, rendered.numberOfChannels - 1));
                // Normalise convolution output
                let peak = 0;
                for (let i = 0; i < regionLen; i++) {
                    peak = Math.max(peak, Math.abs(data[i]));
                }
                const gain = peak > 0 ? 0.9 / peak : 1;
                for (let i = 0; i < regionLen; i++) {
                    result[ch][start + i] = data[i] * gain;
                }
            }
            return result;

        } else if (op === 'ringmod') {
            const result = channels.map(ch => new Float32Array(ch));
            for (let ch = 0; ch < numChannels; ch++) {
                for (let i = 0; i < regionLen; i++) {
                    const srcSample = sourceChannel[i % sourceChannel.length];
                    result[ch][start + i] = channels[ch][start + i] * srcSample;
                }
            }
            return result;

        } else if (op === 'vocoder') {
            // Simple spectral envelope transfer using FFT
            const fSize = 2048;
            const hop = fSize / 4;
            const result = channels.map(ch => new Float32Array(ch));

            for (let ch = 0; ch < numChannels; ch++) {
                const carrier = channels[ch].subarray(start, end);
                const modulator = sourceChannel;

                const processed = DSP.ola(carrier, fSize, hop, hop, (real, imag, frameIdx) => {
                    // Get modulator frame at same position
                    const modStart = (frameIdx * hop) % Math.max(1, modulator.length - fSize);
                    const modReal = new Float32Array(fSize);
                    const modImag = new Float32Array(fSize);
                    const win = DSP.hannWindow(fSize);

                    for (let i = 0; i < fSize; i++) {
                        const idx = modStart + i;
                        modReal[i] = (idx < modulator.length ? modulator[idx] : 0) * win[i];
                        modImag[i] = 0;
                    }
                    DSP.fft(modReal, modImag);

                    // Transfer spectral envelope: use modulator magnitudes with carrier phases
                    for (let i = 0; i < fSize; i++) {
                        const modMag = Math.sqrt(modReal[i] * modReal[i] + modImag[i] * modImag[i]);
                        const carMag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
                        if (carMag > 1e-10) {
                            const scale = modMag / carMag;
                            real[i] *= scale;
                            imag[i] *= scale;
                        }
                    }
                });

                // Normalise
                let peak = 0;
                for (let i = 0; i < processed.length; i++) {
                    peak = Math.max(peak, Math.abs(processed[i]));
                }
                const gain = peak > 0 ? 0.9 / peak : 1;
                const len = Math.min(processed.length, regionLen);
                for (let i = 0; i < len; i++) {
                    result[ch][start + i] = processed[i] * gain;
                }
            }
            return result;
        }

        throw new Error('Unknown cross-slot operation: ' + op);
    }

    async previewCross() {
        if (!this.channels) return;
        const { start, end } = this._getFxRegion();
        const maxSamples = this.bufferSampleRate * 3;
        const previewEnd = Math.min(end, start + maxSamples);

        const btn = document.getElementById('cross-preview');
        btn.textContent = '...';
        btn.disabled = true;

        try {
            const result = await this._processCross(this.channels, this.bufferSampleRate, start, previewEnd);
            this.audio.stop();
            this.audio.play(result, this.bufferSampleRate, start, previewEnd, () => {
                document.getElementById('play-btn').classList.remove('playing');
            });
        } catch (e) {
            console.error('Cross-slot preview error:', e);
        } finally {
            btn.textContent = 'Preview';
            btn.disabled = false;
        }
    }

    async applyCross() {
        if (!this.channels) return;
        const { start, end } = this._getFxRegion();

        const applyBtn = document.getElementById('cross-apply');
        applyBtn.textContent = 'Processing...';
        applyBtn.disabled = true;

        try {
            this.pushUndo();
            const result = await this._processCross(this.channels, this.bufferSampleRate, start, end);
            this.channels = result;
            this.saveCurrentSlot();
            this.refreshWaveform();
            document.getElementById('cross-dialog').hidden = true;
        } catch (e) {
            console.error('Cross-slot apply error:', e);
            this.undo();
            alert('Cross-slot processing failed');
        } finally {
            applyBtn.textContent = 'Apply';
            applyBtn.disabled = false;
        }
    }

    // === Layer & Bounce ===

    openLayerDialog() {
        const slotsWithAudio = this.slots.slots.filter(s => s.hasAudio);
        if (slotsWithAudio.length < 2) {
            alert('Need at least 2 slots with audio to layer');
            return;
        }

        const container = document.getElementById('layer-slot-list');
        container.innerHTML = '';

        for (const slot of this.slots.slots) {
            if (!slot.hasAudio) continue;
            const row = document.createElement('div');
            row.className = 'layer-slot-row';
            row.dataset.slotIndex = slot.index;

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'layer-cb';

            const name = document.createElement('span');
            name.className = 'layer-slot-name';
            name.textContent = `${String(slot.index + 1).padStart(2, '0')} — ${slot.name || 'untitled'}`;

            const volCtrl = document.createElement('span');
            volCtrl.className = 'layer-slot-ctrl';
            const volLabel = document.createElement('label');
            volLabel.textContent = 'VOL';
            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.className = 'layer-vol';
            volSlider.min = '0';
            volSlider.max = '100';
            volSlider.value = '100';
            const volVal = document.createElement('span');
            volVal.className = 'layer-val';
            volVal.textContent = '100%';
            volSlider.addEventListener('input', () => {
                volVal.textContent = volSlider.value + '%';
            });
            volCtrl.appendChild(volLabel);
            volCtrl.appendChild(volSlider);
            volCtrl.appendChild(volVal);

            const panCtrl = document.createElement('span');
            panCtrl.className = 'layer-slot-ctrl';
            const panLabel = document.createElement('label');
            panLabel.textContent = 'PAN';
            const panSlider = document.createElement('input');
            panSlider.type = 'range';
            panSlider.className = 'layer-pan';
            panSlider.min = '-100';
            panSlider.max = '100';
            panSlider.value = '0';
            const panVal = document.createElement('span');
            panVal.className = 'layer-val';
            panVal.textContent = 'C';
            panSlider.addEventListener('input', () => {
                const v = parseInt(panSlider.value);
                panVal.textContent = v < 0 ? Math.abs(v) + 'L' : v > 0 ? v + 'R' : 'C';
            });
            panCtrl.appendChild(panLabel);
            panCtrl.appendChild(panSlider);
            panCtrl.appendChild(panVal);

            row.appendChild(cb);
            row.appendChild(name);
            row.appendChild(volCtrl);
            row.appendChild(panCtrl);
            container.appendChild(row);
        }

        document.getElementById('layer-dialog').hidden = false;
    }

    _getLayerSelections() {
        const rows = document.querySelectorAll('#layer-slot-list .layer-slot-row');
        const selections = [];
        for (const row of rows) {
            const cb = row.querySelector('.layer-cb');
            if (!cb.checked) continue;
            selections.push({
                slotIndex: parseInt(row.dataset.slotIndex),
                volume: parseInt(row.querySelector('.layer-vol').value) / 100,
                pan: parseInt(row.querySelector('.layer-pan').value) / 100
            });
        }
        return selections;
    }

    async _renderLayerMix(selections) {
        await this.ensureAudioInit();
        const sampleRate = this.audio.audioContext.sampleRate;

        // Load all selected slot audio
        const audioData = [];
        let maxLength = 0;
        for (const sel of selections) {
            const data = await this.slots.getSlotAudio(sel.slotIndex);
            if (!data) continue;
            audioData.push({ data, sel });
            maxLength = Math.max(maxLength, data.channels[0].length);
        }

        if (audioData.length === 0) throw new Error('No audio to mix');

        const offline = new OfflineAudioContext(2, maxLength, sampleRate);

        for (const { data, sel } of audioData) {
            const buf = offline.createBuffer(
                data.channels.length,
                data.channels[0].length,
                data.sampleRate
            );
            for (let ch = 0; ch < data.channels.length; ch++) {
                buf.getChannelData(ch).set(data.channels[ch]);
            }

            const source = offline.createBufferSource();
            source.buffer = buf;

            const gain = offline.createGain();
            gain.gain.setValueAtTime(sel.volume, 0);

            const panner = offline.createStereoPanner();
            panner.pan.setValueAtTime(sel.pan, 0);

            source.connect(gain);
            gain.connect(panner);
            panner.connect(offline.destination);
            source.start(0);
        }

        const rendered = await offline.startRendering();
        const channels = [];
        for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
            channels.push(new Float32Array(rendered.getChannelData(ch)));
        }
        return { channels, sampleRate: rendered.sampleRate };
    }

    async previewLayer() {
        const selections = this._getLayerSelections();
        if (selections.length < 2) {
            alert('Select at least 2 slots to layer');
            return;
        }

        const btn = document.getElementById('layer-preview');
        btn.textContent = 'Mixing...';
        btn.disabled = true;

        try {
            const result = await this._renderLayerMix(selections);
            // Play the preview
            const ctx = this.audio.audioContext;
            const buf = ctx.createBuffer(result.channels.length, result.channels[0].length, result.sampleRate);
            for (let ch = 0; ch < result.channels.length; ch++) {
                buf.getChannelData(ch).set(result.channels[ch]);
            }
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start();
        } catch (e) {
            console.error('Layer preview error:', e);
            alert('Preview failed');
        } finally {
            btn.textContent = 'Preview';
            btn.disabled = false;
        }
    }

    async bounceLayer() {
        const selections = this._getLayerSelections();
        if (selections.length < 2) {
            alert('Select at least 2 slots to layer');
            return;
        }

        const btn = document.getElementById('layer-bounce');
        btn.textContent = 'Bouncing...';
        btn.disabled = true;

        try {
            const result = await this._renderLayerMix(selections);
            const emptySlot = this.slots.findEmptySlot();
            if (emptySlot < 0) {
                alert('No empty slots available');
                return;
            }

            // Auto-name: layer-01+03+05
            const slotNums = selections.map(s => String(s.slotIndex + 1).padStart(2, '0'));
            const layerName = 'layer-' + slotNums.join('+');

            await this.slots.saveSlotAudio(emptySlot, result.channels, result.sampleRate);
            this.slots.slots[emptySlot].name = layerName;
            await this.slots.renameSlot(emptySlot, layerName);

            // Update buffer cache for sequencer/sampler
            if (this.audio.audioContext) {
                const buf = this.audio.audioContext.createBuffer(
                    result.channels.length,
                    result.channels[0].length,
                    result.sampleRate
                );
                for (let ch = 0; ch < result.channels.length; ch++) {
                    buf.getChannelData(ch).set(result.channels[ch]);
                }
                this._slotBuffers[emptySlot] = buf;
            }

            document.getElementById('layer-dialog').hidden = true;
            this.buildSlotGrid();
            this.renderSlotGrid();
            this.updateToolbarState();
        } catch (e) {
            console.error('Layer bounce error:', e);
            alert('Bounce failed');
        } finally {
            btn.textContent = 'Bounce';
            btn.disabled = false;
        }
    }

    // === Main Menu ===

    _toggleMainMenu() {
        const menu = document.getElementById('main-menu');
        menu.hidden = !menu.hidden;
        if (!menu.hidden) {
            const close = (ev) => {
                if (!menu.contains(ev.target) && ev.target.id !== 'menu-btn') {
                    menu.hidden = true;
                    document.removeEventListener('click', close);
                }
            };
            setTimeout(() => document.addEventListener('click', close), 10);
        }
    }

    async deleteAll() {
        if (!confirm('Delete ALL slots, patterns, and settings? This cannot be undone.')) return;

        // Stop everything
        this.audio.stop();
        this.cancelAnimationLoop();
        if (this.sequencer && this.sequencer.playing) {
            this.sequencer.stop();
            this._seqStopAnimation();
        }

        // Clear all slots
        for (let i = 0; i < 16; i++) {
            await this.slots.clearSlot(i);
        }

        // Clear sequencer
        if (this.sequencer) {
            this.sequencer.clearPattern();
            this.sequencer.setBpm(120);
            this.sequencer.mutateEnabled = false;
            this.sequencer.stutterEnabled = false;
            this._seqPreMutatePattern = null;
            this._seqStutterSlots.clear();
            this._seqMutateSlots.clear();
            this._slotBuffers = {};
            this._saveSeqPattern();
        }

        // Clear sampler
        if (this.sampler) {
            this.sampler.stopAll();
            this.sampler.invalidateMorphCache();
            for (let i = 0; i < 16; i++) {
                Object.assign(this.sampler.pads[i], Sampler.defaultPad());
            }
            this._saveSamplerConfig();
        }

        // Clear app state
        this.channels = null;
        this.clipboard = null;
        this.undoStack = [];
        this.redoStack = [];

        // Reset UI
        this.waveform.clear();
        document.getElementById('waveform-empty').hidden = false;
        document.getElementById('play-btn').classList.remove('playing');
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
        document.getElementById('seq-mutate-btn').classList.remove('mutate-on');

        // Exit to rec mode if in seq/sample mode
        if (this._seqMode || this._sampleMode) {
            this.switchMode('rec');
        }

        this.renderSlotGrid();
        this.updateTransportInfo();
        this.updateToolbarState();
    }

    // === UI Updates ===

    updateTransportInfo() {
        const rate = this.bufferSampleRate || 48000;
        document.getElementById('info-rate').textContent = (rate / 1000).toFixed(1) + 'kHz';
        const dur = this.channels ? this.channels[0].length / this.bufferSampleRate : 0;
        document.getElementById('info-duration').textContent = this.formatTime(dur);
    }

    updateToolbarState() {
        const hasAudio = !!this.channels;
        const hasSel = hasAudio && !!this.waveform.getSelection();
        const hasSlot = this.slots.selectedIndex >= 0;

        document.getElementById('rec-btn').disabled = false;
        document.getElementById('play-btn').disabled = !hasAudio;
        document.getElementById('stop-btn').disabled = !hasAudio;
        document.getElementById('loop-btn').disabled = !hasAudio;
        document.getElementById('trim-btn').disabled = !hasSel;
        document.getElementById('cut-btn').disabled = !hasSel;
        document.getElementById('copy-btn').disabled = !hasSel;
        document.getElementById('paste-btn').disabled = !this.clipboard;
        document.getElementById('silence-btn').disabled = !hasSel;
        document.getElementById('fadein-btn').disabled = !hasAudio;
        document.getElementById('fadeout-btn').disabled = !hasAudio;
        document.getElementById('reverse-btn').disabled = !hasAudio;
        document.getElementById('norm-btn').disabled = !hasAudio;
        document.getElementById('save-btn').disabled = !hasAudio;
        document.getElementById('load-btn').disabled = false;
        document.getElementById('bounce-btn').disabled = !hasAudio;
        document.getElementById('export-all-btn').disabled = !this.slots.slots.some(s => s.hasAudio);
        document.getElementById('cross-btn').disabled = !hasAudio;
        document.getElementById('layer-btn').disabled = this.slots.slots.filter(s => s.hasAudio).length < 2;

        // FX buttons
        document.querySelectorAll('.fx-btn').forEach(btn => {
            btn.disabled = !hasAudio;
        });

        this.updateUndoCount();
    }

    // === Sequencer ===

    _initSequencer() {
        this.sequencer = new Sequencer(null); // audioContext set later

        // Provide callbacks
        this.sequencer.getSlotBuffer = (slotIndex) => {
            return this._slotBuffers[slotIndex] || null;
        };
        this.sequencer.getLoadedSlots = () => {
            const loaded = [];
            for (let i = 0; i < 16; i++) {
                if (this.slots.slots[i].hasAudio) loaded.push(i);
            }
            return loaded;
        };
        this.sequencer.onStepChange = (step) => {
            this._seqHighlightStep(step);
            this._seqFlashSampleRows(step);
            this._seqFlashPads(step);
        };
        this.sequencer.onMutate = (step) => {
            this._seqFlashMutate(step);
            this.renderSeqGrid();
        };
        this.sequencer.onPatternLoop = () => {
            // Switch to queued pattern at loop boundary
            if (this._seqQueuedBankIndex !== null) {
                const queued = this._seqQueuedBankIndex;
                this._seqQueuedBankIndex = null;
                this._seqPreviewBankIndex = null;
                this.seqSwitchBank(queued);
            }
            if (this.sequencer.mutateEnabled) {
                this.renderSeqGrid();
            }
        };
        this.sequencer.getPadSettings = (slotIndex) => {
            return this.sampler ? this.sampler.pads[slotIndex] : null;
        };

        // Mute/Solo state
        this._seqMutedSlots = new Set();
        this._seqSoloSlot = -1; // -1 = no solo
        this.sequencer.shouldPlaySlot = (slotIndex) => {
            if (this._seqSoloSlot >= 0) return slotIndex === this._seqSoloSlot;
            return !this._seqMutedSlots.has(slotIndex);
        };

        // Per-slot stutter/mutate
        this._seqStutterSlots = new Set();
        this._seqMutateSlots = new Set();
        this.sequencer.shouldStutterSlot = (slotIndex) => {
            return this._seqStutterSlots.has(slotIndex);
        };
        this.sequencer.shouldMutateSlot = (slotIndex) => {
            return this._seqMutateSlots.has(slotIndex);
        };

        this._slotBuffers = {}; // slotIndex → AudioBuffer (shared by sequencer + sampler)
        this._seqModeMenuStep = -1;

        // Load persisted pattern
        this._loadSeqPattern();
    }

    async toggleSeqMode() {
        // Legacy — redirect to new switchMode
        await this.switchMode(this._seqMode ? 'rec' : 'seq');
    }

    async _seqPreloadBuffers() {
        for (let i = 0; i < 16; i++) {
            if (this.slots.slots[i].hasAudio && !this._slotBuffers[i]) {
                try {
                    const data = await this.slots.getSlotAudio(i);
                    if (data && this.audio.audioContext) {
                        const buf = this.audio.audioContext.createBuffer(
                            data.channels.length,
                            data.channels[0].length,
                            data.sampleRate
                        );
                        for (let ch = 0; ch < data.channels.length; ch++) {
                            buf.getChannelData(ch).set(data.channels[ch]);
                        }
                        this._slotBuffers[i] = buf;
                    }
                } catch (e) {
                    console.warn('Failed to preload slot', i, e);
                }
            }
        }
    }

    renderSeqGrid() {
        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');

        slotEls.forEach((el, i) => {
            if (i >= this.sequencer.pattern.length) return;
            const step = this.sequencer.pattern[i];
            const hasSound = step.slots.length > 0 && step.slots.some(
                e => this.slots.slots[e.slot] && this.slots.slots[e.slot].hasAudio
            );

            // Step number
            const numEl = el.querySelector('.slot-number');
            numEl.textContent = String(i + 1).padStart(2, '0');

            // Content
            const nameEl = el.querySelector('.slot-name');
            if (hasSound) {
                // Show slot numbers with per-slot pitch (e.g. "01+05" or "01(+3)")
                const labels = step.slots.map(e => {
                    let lbl = String(e.slot + 1).padStart(2, '0');
                    if (e.pitch !== 0) lbl += '(' + (e.pitch > 0 ? '+' : '') + e.pitch + ')';
                    return lbl;
                });
                nameEl.innerHTML = `<span class="step-slot-label">${labels.join('+')}</span>`;
                nameEl.className = 'slot-name';

                // Bank color based on first slot
                const bank = Math.floor(step.slots[0].slot / 4);
                el.className = 'slot step-bank-' + bank;
                el.dataset.bank = bank;

                // Mode icons (no step-level pitch any more)
                let icons = '';
                if (step.mode === 'loop') icons += 'L ';
                if (step.direction === 'reverse') icons += '\u25C0 ';
                let iconsEl = el.querySelector('.step-mode-icons');
                if (!iconsEl) {
                    iconsEl = document.createElement('span');
                    iconsEl.className = 'step-mode-icons';
                    el.appendChild(iconsEl);
                }
                iconsEl.textContent = icons.trim();
            } else {
                nameEl.innerHTML = '--';
                nameEl.className = 'slot-name empty';
                el.className = 'slot step-empty';
                el.dataset.bank = Math.floor(i / 4);

                const iconsEl = el.querySelector('.step-mode-icons');
                if (iconsEl) iconsEl.textContent = '';
            }
        });
    }

    seqStepTap(stepIndex) {
        this._seqModeMenuStep = stepIndex;
        this._renderSeqSampleList();
        this.renderSeqGrid();
        // Highlight selected step
        const slotEls = document.querySelectorAll('#slot-grid .slot');
        slotEls.forEach((el, i) => {
            el.classList.toggle('pad-selected', i === stepIndex);
        });
    }

    _renderSeqSampleList() {
        const container = document.getElementById('seq-sample-list');
        const stepIndex = this._seqModeMenuStep;
        const step = this.sequencer.pattern[stepIndex];
        container.innerHTML = '';

        // Header with step number and mode/direction controls
        const header = document.createElement('div');
        header.className = 'seq-sample-list-header';
        const modeBtn = document.createElement('button');
        modeBtn.className = 'seq-mode-btn' + (step.mode === 'loop' ? ' on' : '');
        modeBtn.textContent = step.mode === 'loop' ? 'LOOP' : 'ONE';
        modeBtn.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text2);font-family:var(--mono);font-size:10px;font-weight:700;padding:2px 8px;cursor:pointer;';
        if (step.mode === 'loop') modeBtn.style.color = 'var(--yellow)';
        modeBtn.addEventListener('click', () => {
            const newMode = step.mode === 'loop' ? 'oneshot' : 'loop';
            this.sequencer.setStepMode(stepIndex, newMode);
            this._renderSeqSampleList();
            this.renderSeqGrid();
            this._saveSeqPattern();
        });

        const dirBtn = document.createElement('button');
        dirBtn.className = 'seq-dir-btn' + (step.direction === 'reverse' ? ' on' : '');
        dirBtn.textContent = step.direction === 'reverse' ? 'REV' : 'FWD';
        dirBtn.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text2);font-family:var(--mono);font-size:10px;font-weight:700;padding:2px 8px;cursor:pointer;';
        if (step.direction === 'reverse') dirBtn.style.color = 'var(--red)';
        dirBtn.addEventListener('click', () => {
            const newDir = step.direction === 'reverse' ? 'forward' : 'reverse';
            this.sequencer.setStepDirection(stepIndex, newDir);
            for (const entry of step.slots) this.sequencer.invalidateBuffer(entry.slot);
            this._renderSeqSampleList();
            this.renderSeqGrid();
            this._saveSeqPattern();
        });

        header.textContent = '';
        header.appendChild(document.createTextNode('STEP ' + String(stepIndex + 1).padStart(2, '0')));
        header.appendChild(modeBtn);
        header.appendChild(dirBtn);
        container.appendChild(header);

        // Sample rows
        for (let i = 0; i < 16; i++) {
            const slot = this.slots.slots[i];
            if (!slot.hasAudio) continue;

            const entry = this.sequencer.getSlotEntry(stepIndex, i);
            const isOn = !!entry;
            const pitch = entry ? entry.pitch : 0;

            const row = document.createElement('div');
            const isMuted = this._seqMutedSlots.has(i);
            const isSolo = this._seqSoloSlot === i;
            const isSilenced = this._seqSoloSlot >= 0 ? !isSolo : isMuted;
            row.className = 'seq-sample-row' + (isOn ? ' on' : '') + (isSilenced ? ' muted' : '') + (isSolo ? ' solo' : '');
            row.dataset.slotIdx = i;

            // Trigger zone: wraps num + name for audition/recording
            const triggerZone = document.createElement('span');
            triggerZone.className = 'seq-trigger-zone';

            const numSpan = document.createElement('span');
            numSpan.className = 'slot-num';
            numSpan.textContent = String(i + 1).padStart(2, '0');
            triggerZone.appendChild(numSpan);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'slot-name';
            nameSpan.textContent = slot.name || 'untitled';
            triggerZone.appendChild(nameSpan);

            // Trigger zone: press to audition, record if in rec mode
            const slotIdx = i;
            let triggerUsedTouch = false;
            const triggerDown = (ev) => {
                ev.stopPropagation();
                this._seqTriggerFromList(slotIdx);
            };
            const triggerUp = (ev) => {
                ev.stopPropagation();
                this._seqTriggerRelease(slotIdx);
            };
            triggerZone.addEventListener('mousedown', (ev) => {
                if (triggerUsedTouch) return;
                triggerDown(ev);
            });
            triggerZone.addEventListener('mouseup', (ev) => {
                if (triggerUsedTouch) return;
                triggerUp(ev);
            });
            triggerZone.addEventListener('mouseleave', (ev) => {
                if (triggerUsedTouch) return;
                triggerUp(ev);
            });
            triggerZone.addEventListener('touchstart', (ev) => {
                triggerUsedTouch = true;
                ev.preventDefault();
                triggerDown(ev);
            });
            triggerZone.addEventListener('touchend', (ev) => {
                ev.preventDefault();
                triggerUp(ev);
                setTimeout(() => { triggerUsedTouch = false; }, 400);
            });
            triggerZone.addEventListener('touchcancel', () => {
                triggerUp({ stopPropagation: () => {} });
                setTimeout(() => { triggerUsedTouch = false; }, 400);
            });
            // Prevent click from bubbling to row toggle
            triggerZone.addEventListener('click', (ev) => ev.stopPropagation());

            row.appendChild(triggerZone);

            // Solo button
            const soloBtn = document.createElement('button');
            soloBtn.className = 'seq-solo-btn' + (this._seqSoloSlot === i ? ' on' : '');
            soloBtn.textContent = 'S';
            soloBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._seqSoloSlot = (this._seqSoloSlot === i) ? -1 : i;
                this._renderSeqSampleList();
            });
            row.appendChild(soloBtn);

            // Mute button
            const muteBtn = document.createElement('button');
            muteBtn.className = 'seq-mute-btn' + (this._seqMutedSlots.has(i) ? ' on' : '');
            muteBtn.textContent = 'M';
            muteBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (this._seqMutedSlots.has(i)) {
                    this._seqMutedSlots.delete(i);
                } else {
                    this._seqMutedSlots.add(i);
                }
                this._renderSeqSampleList();
            });
            row.appendChild(muteBtn);

            // Stutter button
            const stutterBtn = document.createElement('button');
            stutterBtn.className = 'seq-stutter-slot-btn' + (this._seqStutterSlots.has(i) ? ' on' : '');
            stutterBtn.textContent = 'ST';
            stutterBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (this._seqStutterSlots.has(i)) {
                    this._seqStutterSlots.delete(i);
                } else {
                    this._seqStutterSlots.add(i);
                }
                // Sync global flag
                this.sequencer.stutterEnabled = this._seqStutterSlots.size > 0;
                document.getElementById('seq-stutter-btn').classList.toggle('stutter-on', this._seqStutterSlots.size > 0);
                this._renderSeqSampleList();
            });
            row.appendChild(stutterBtn);

            // Mutate button
            const mutateBtn = document.createElement('button');
            mutateBtn.className = 'seq-mutate-slot-btn' + (this._seqMutateSlots.has(i) ? ' on' : '');
            mutateBtn.textContent = 'MT';
            mutateBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (this._seqMutateSlots.has(i)) {
                    this._seqMutateSlots.delete(i);
                } else {
                    this._seqMutateSlots.add(i);
                }
                // Sync global flag and pre-mutate snapshot
                const wasEnabled = this.sequencer.mutateEnabled;
                this.sequencer.mutateEnabled = this._seqMutateSlots.size > 0;
                if (this.sequencer.mutateEnabled && !wasEnabled) {
                    this._seqPreMutatePattern = this.sequencer.toJSON();
                } else if (!this.sequencer.mutateEnabled && wasEnabled && this._seqPreMutatePattern) {
                    this.sequencer.fromJSON(this._seqPreMutatePattern);
                    this.sequencer.mutateEnabled = false;
                    this._seqPreMutatePattern = null;
                    this.renderSeqGrid();
                }
                document.getElementById('seq-mutate-btn').classList.toggle('mutate-on', this._seqMutateSlots.size > 0);
                this._renderSeqSampleList();
                this._saveSeqPattern();
            });
            row.appendChild(mutateBtn);

            // ON/OFF indicator
            const toggleBtn = document.createElement('span');
            toggleBtn.className = 'seq-toggle-btn' + (isOn ? ' on' : '');
            toggleBtn.textContent = isOn ? 'ON' : 'OFF';
            row.appendChild(toggleBtn);

            // Click entire row to toggle
            row.addEventListener('click', (ev) => {
                // Don't toggle if clicking control buttons or trigger zone
                if (ev.target.closest('.seq-trigger-zone')) return;
                if (ev.target.closest('.seq-pitch-btn')) return;
                if (ev.target.closest('.seq-solo-btn') || ev.target.closest('.seq-mute-btn')) return;
                if (ev.target.closest('.seq-stutter-slot-btn') || ev.target.closest('.seq-mutate-slot-btn')) return;
                this.sequencer.toggleSlotOnStep(stepIndex, i);
                this._renderSeqSampleList();
                this.renderSeqGrid();
                this._saveSeqPattern();
            });

            // Pitch controls
            const pitchCtrl = document.createElement('div');
            pitchCtrl.className = 'seq-pitch-ctrl';
            const pitchDown = document.createElement('button');
            pitchDown.className = 'seq-pitch-btn';
            pitchDown.innerHTML = '&minus;';
            pitchDown.addEventListener('click', () => {
                const e = this.sequencer.getSlotEntry(stepIndex, i);
                if (!e) return;
                this.sequencer.setSlotPitch(stepIndex, i, e.pitch - 1);
                this._renderSeqSampleList();
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            const pitchVal = document.createElement('span');
            pitchVal.className = 'seq-pitch-val';
            pitchVal.textContent = pitch > 0 ? '+' + pitch : String(pitch);
            const pitchUp = document.createElement('button');
            pitchUp.className = 'seq-pitch-btn';
            pitchUp.textContent = '+';
            pitchUp.addEventListener('click', () => {
                const e = this.sequencer.getSlotEntry(stepIndex, i);
                if (!e) return;
                this.sequencer.setSlotPitch(stepIndex, i, e.pitch + 1);
                this._renderSeqSampleList();
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            pitchCtrl.appendChild(pitchDown);
            pitchCtrl.appendChild(pitchVal);
            pitchCtrl.appendChild(pitchUp);
            row.appendChild(pitchCtrl);

            container.appendChild(row);
        }
    }

    openStepModeMenu(stepIndex, e) {
        const step = this.sequencer.pattern[stepIndex];
        this._seqModeMenuStep = stepIndex;
        const menu = document.getElementById('step-mode-menu');

        // Remove any previous close handler so it doesn't immediately hide this menu
        if (this._stepMenuCloseHandler) {
            document.removeEventListener('click', this._stepMenuCloseHandler);
            this._stepMenuCloseHandler = null;
        }

        // Position: centered if from tap, or at pointer if from context menu
        if (e._useCentered) {
            const stepEl = document.querySelectorAll('#slot-grid .slot')[stepIndex];
            if (stepEl) {
                const rect = stepEl.getBoundingClientRect();
                menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
                menu.style.top = Math.max(0, rect.top - 200) + 'px';
            } else {
                menu.style.left = '50%';
                menu.style.top = '40%';
            }
        } else {
            const x = (e.clientX || e.pageX || 0);
            const y = (e.clientY || e.pageY || 0);
            menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
            menu.style.top = Math.min(y, window.innerHeight - 260) + 'px';
        }
        menu.hidden = false;

        // Populate slot picker with checkboxes + per-slot pitch
        const picker = document.getElementById('step-slot-picker');
        picker.innerHTML = '';
        for (let i = 0; i < 16; i++) {
            const slot = this.slots.slots[i];
            if (!slot.hasAudio) continue;
            const entry = this.sequencer.getSlotEntry(stepIndex, i);
            const checked = !!entry;
            const pitch = entry ? entry.pitch : 0;
            const row = document.createElement('div');
            row.className = 'step-slot-option' + (checked ? ' checked' : '');
            row.innerHTML = `
                <input type="checkbox" data-slot-idx="${i}" ${checked ? 'checked' : ''}>
                <span class="slot-opt-num">${String(i + 1).padStart(2, '0')}</span>
                <span class="slot-opt-name">${slot.name || 'untitled'}</span>
                <button class="step-pitch-btn slot-pitch-down" data-slot="${i}">&minus;</button>
                <span class="slot-pitch-val" data-slot="${i}">${pitch > 0 ? '+' + pitch : pitch}</span>
                <button class="step-pitch-btn slot-pitch-up" data-slot="${i}">+</button>
            `;
            const cb = row.querySelector('input');
            cb.addEventListener('change', (ev) => {
                this.sequencer.toggleSlotOnStep(stepIndex, i);
                row.classList.toggle('checked', ev.target.checked);
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            const pitchDown = row.querySelector('.slot-pitch-down');
            const pitchUp = row.querySelector('.slot-pitch-up');
            const pitchVal = row.querySelector('.slot-pitch-val');
            pitchDown.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const e = this.sequencer.getSlotEntry(stepIndex, i);
                if (!e) return;
                this.sequencer.setSlotPitch(stepIndex, i, e.pitch - 1);
                pitchVal.textContent = e.pitch > 0 ? '+' + e.pitch : e.pitch;
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            pitchUp.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const e = this.sequencer.getSlotEntry(stepIndex, i);
                if (!e) return;
                this.sequencer.setSlotPitch(stepIndex, i, e.pitch + 1);
                pitchVal.textContent = e.pitch > 0 ? '+' + e.pitch : e.pitch;
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            picker.appendChild(row);
        }

        // Update active states for mode/direction
        menu.querySelectorAll('button').forEach(btn => {
            if (btn.dataset.mode) {
                btn.classList.toggle('active', btn.dataset.mode === step.mode);
            }
            if (btn.dataset.dir) {
                btn.classList.toggle('active', btn.dataset.dir === step.direction);
            }
        });

        const close = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.hidden = true;
                document.removeEventListener('click', close);
                this._stepMenuCloseHandler = null;
            }
        };
        this._stepMenuCloseHandler = close;
        setTimeout(() => document.addEventListener('click', close), 10);
    }

    _setStepMode(mode) {
        if (this._seqModeMenuStep < 0) return;
        this.sequencer.setStepMode(this._seqModeMenuStep, mode);
        this.renderSeqGrid();
        this._saveSeqPattern();

        // Update menu active states
        document.querySelectorAll('#step-mode-menu button[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
    }

    _setStepDirection(dir) {
        if (this._seqModeMenuStep < 0) return;
        this.sequencer.setStepDirection(this._seqModeMenuStep, dir);
        // Invalidate reverse buffer cache for all slots on this step
        const step = this.sequencer.pattern[this._seqModeMenuStep];
        for (const entry of step.slots) {
            this.sequencer.invalidateBuffer(entry.slot);
        }
        this.renderSeqGrid();
        this._saveSeqPattern();

        document.querySelectorAll('#step-mode-menu button[data-dir]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.dir === dir);
        });
    }

    // Per-slot pitch is now handled inline in the step mode menu slot picker

    // Sequencer transport
    async seqPlayStop() {
        await this.ensureAudioInit();
        if (!this.audio.audioContext) return;
        this.sequencer.audioContext = this.audio.audioContext;
        this.sequencer.outputNode = this.audio.getEffectsBus();

        if (this.sequencer.playing) {
            this.sequencer.stop();
            this._seqStopAnimation();
            document.getElementById('seq-play-btn').innerHTML = '&#9654; PLAY';
            // Auto-disable recording
            if (this._seqRecording) {
                this._seqRecording = false;
                document.getElementById('seq-rec-btn').classList.remove('rec-on');
            }
        } else {
            // Stop main waveform playback if active
            this.stopAudio();
            // Preload any new buffers
            await this._seqPreloadBuffers();
            this.sequencer.play();
            this._seqStartAnimation();
            document.getElementById('seq-play-btn').innerHTML = '&#9632; STOP';
            // Show seq transport if starting from sample mode
            if (this._sampleMode) {
                this._seqShowTransportInSample = true;
                document.getElementById('seq-transport').classList.add('active');
            }
        }
    }

    _seqStartAnimation() {
        const animate = () => {
            this._seqAnimFrame = requestAnimationFrame(animate);
        };
        this._seqAnimFrame = requestAnimationFrame(animate);
    }

    _seqStopAnimation() {
        if (this._seqAnimFrame) {
            cancelAnimationFrame(this._seqAnimFrame);
            this._seqAnimFrame = null;
        }
        // Clear step highlight
        document.querySelectorAll('#slot-grid .slot').forEach(el => {
            el.classList.remove('step-active');
        });
    }

    _seqHighlightStep(stepIndex) {
        const slotEls = document.querySelectorAll('#slot-grid .slot');
        slotEls.forEach((el, i) => {
            el.classList.toggle('step-active', i === stepIndex);
        });
    }

    _seqFlashSampleRows(stepIndex) {
        const step = this.sequencer.pattern[stepIndex];
        if (!step || step.slots.length === 0) return;
        const rows = document.querySelectorAll('#seq-sample-list .seq-sample-row');
        for (const entry of step.slots) {
            for (const row of rows) {
                if (parseInt(row.dataset.slotIdx) === entry.slot) {
                    row.classList.remove('seq-triggered');
                    void row.offsetWidth;
                    row.classList.add('seq-triggered');
                }
            }
        }
    }

    _seqFlashPads(stepIndex) {
        if (!this._sampleMode) return;
        const step = this.sequencer.pattern[stepIndex];
        if (!step || step.slots.length === 0) return;
        const slotEls = document.querySelectorAll('#slot-grid .slot');
        for (const entry of step.slots) {
            const el = slotEls[entry.slot];
            if (!el) continue;
            el.classList.add('pad-active');
            setTimeout(() => el.classList.remove('pad-active'), 150);
        }
    }

    _seqFlashMutate(stepIndex) {
        const el = document.querySelectorAll('#slot-grid .slot')[stepIndex];
        if (!el) return;
        el.classList.remove('step-mutated');
        // Force reflow
        void el.offsetWidth;
        el.classList.add('step-mutated');
    }

    seqAdjustBpm(delta) {
        this.sequencer.setBpm(this.sequencer.bpm + delta);
        this._updateBpmDisplay();
        this._saveSeqPattern();
    }

    seqEditBpm() {
        const input = prompt('BPM:', this.sequencer.bpm);
        if (input !== null) {
            const bpm = parseInt(input);
            if (!isNaN(bpm)) {
                this.sequencer.setBpm(bpm);
                this._updateBpmDisplay();
                this._saveSeqPattern();
            }
        }
    }

    seqTapTempo() {
        this.sequencer.tapTempo();
        this._updateBpmDisplay();
        this._saveSeqPattern();
    }

    _updateBpmDisplay() {
        document.getElementById('bpm-display').textContent = this.sequencer.bpm;
    }

    seqRandomise() {
        this.sequencer.stutterEnabled = false;
        this._seqPreMutatePattern = null;
        this.sequencer.mutateEnabled = false;
        this._seqStutterSlots.clear();
        this._seqMutateSlots.clear();
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
        document.getElementById('seq-mutate-btn').classList.remove('mutate-on');
        this.sequencer.randomise(0.75);
        this.renderSeqGrid();
        this._saveSeqPattern();
    }

    seqStutter() {
        // Global toggle: enable/disable stutter for ALL loaded slots
        const anyOn = this._seqStutterSlots.size > 0;
        if (anyOn) {
            this._seqStutterSlots.clear();
            this.sequencer.stutterEnabled = false;
        } else {
            for (let i = 0; i < 16; i++) {
                if (this.slots.slots[i].hasAudio) this._seqStutterSlots.add(i);
            }
            this.sequencer.stutterEnabled = true;
        }
        document.getElementById('seq-stutter-btn').classList.toggle('stutter-on', this._seqStutterSlots.size > 0);
        if (this._seqModeMenuStep >= 0) this._renderSeqSampleList();
    }

    seqToggleMutate() {
        // Global toggle: enable/disable mutate for ALL loaded slots
        const anyOn = this._seqMutateSlots.size > 0;
        if (anyOn) {
            this._seqMutateSlots.clear();
            this.sequencer.mutateEnabled = false;
            // Restore original pattern
            if (this._seqPreMutatePattern) {
                this.sequencer.fromJSON(this._seqPreMutatePattern);
                // fromJSON restores mutateEnabled from snapshot, force it off
                this.sequencer.mutateEnabled = false;
                this._seqPreMutatePattern = null;
                this.renderSeqGrid();
            }
        } else {
            for (let i = 0; i < 16; i++) {
                if (this.slots.slots[i].hasAudio) this._seqMutateSlots.add(i);
            }
            this.sequencer.mutateEnabled = true;
            this._seqPreMutatePattern = this.sequencer.toJSON();
        }
        document.getElementById('seq-mutate-btn').classList.toggle('mutate-on', this._seqMutateSlots.size > 0);
        if (this._seqModeMenuStep >= 0) this._renderSeqSampleList();
        this._saveSeqPattern();
    }

    seqClear() {
        this.sequencer.stutterEnabled = false;
        this._seqPreMutatePattern = null;
        this.sequencer.mutateEnabled = false;
        this._seqStutterSlots.clear();
        this._seqMutateSlots.clear();
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
        document.getElementById('seq-mutate-btn').classList.remove('mutate-on');
        this.sequencer.clearPattern();
        this.renderSeqGrid();
        this._saveSeqPattern();
    }

    async seqBounce() {
        if (!this.audio.audioContext) return;
        this.sequencer.audioContext = this.audio.audioContext;

        const numLoopsStr = prompt('Number of pattern loops to render:', '1');
        if (numLoopsStr === null) return;
        const numLoops = Math.max(1, Math.min(8, parseInt(numLoopsStr) || 1));

        // Preload buffers
        await this._seqPreloadBuffers();

        try {
            const result = await this.sequencer.bounce(numLoops);
            if (!result || !result.channels || result.channels[0].length === 0) {
                alert('Pattern is empty — nothing to bounce');
                return;
            }

            // Find empty slot
            const emptyIdx = this.slots.findEmptySlot();
            if (emptyIdx < 0) {
                alert('No empty slots — clear a slot first');
                return;
            }

            await this.slots.saveSlotAudio(emptyIdx, result.channels, result.sampleRate);
            this.slots.slots[emptyIdx].name = 'seq-bounce';
            await this.slots.renameSlot(emptyIdx, 'seq-bounce');

            // Also update sequencer buffer cache
            if (this.audio.audioContext) {
                const buf = this.audio.audioContext.createBuffer(
                    result.channels.length,
                    result.channels[0].length,
                    result.sampleRate
                );
                for (let ch = 0; ch < result.channels.length; ch++) {
                    buf.getChannelData(ch).set(result.channels[ch]);
                }
                this._slotBuffers[emptyIdx] = buf;
            }

            this.renderSeqGrid();
            alert(`Bounced to slot ${emptyIdx + 1}`);
        } catch (e) {
            console.error('Bounce failed:', e);
            alert('Bounce failed: ' + e.message);
        }
    }

    // === Live Recording into Sequencer (Looper) ===

    async seqToggleRecord() {
        this._seqRecording = !this._seqRecording;
        document.getElementById('seq-rec-btn').classList.toggle('rec-on', this._seqRecording);
        if (this._seqRecording) {
            // Snapshot pattern for undo before this recording pass
            this._seqLooperUndoStack.push(this.sequencer.toJSON());
            // Cap undo stack at 20 layers
            if (this._seqLooperUndoStack.length > 20) this._seqLooperUndoStack.shift();
            // If seq not playing, start playback
            if (!this.sequencer.playing) {
                await this.seqPlayStop();
            }
        }
    }

    seqLooperUndo() {
        if (this._seqLooperUndoStack.length === 0) return;
        const snapshot = this._seqLooperUndoStack.pop();
        this.sequencer.fromJSON(snapshot);
        if (this._seqMode) this.renderSeqGrid();
        this._saveSeqPattern();
    }

    _seqTriggerFromList(slotIndex) {
        // Audition the sound
        if (this.sampler) {
            this.sampler.trigger(slotIndex);
        }
        // Visual flash
        const rows = document.querySelectorAll('#seq-sample-list .seq-sample-row');
        for (const row of rows) {
            if (parseInt(row.dataset.slotIdx) === slotIndex) {
                row.classList.remove('seq-triggered');
                void row.offsetWidth;
                row.classList.add('seq-triggered');
            }
        }
        // Record if in recording mode and playing
        if (this._seqRecording && this.sequencer.playing) {
            this._recordPadToStep(slotIndex, 0, 'list:' + slotIndex);
        }
    }

    _seqTriggerRelease(slotIndex) {
        if (this.sampler) {
            this.sampler.release(slotIndex);
        }
        if (this._seqRecording) {
            this._recordNoteOff('list:' + slotIndex);
        }
    }

    _recordPadToStep(slotIndex, pitch, trackingKey) {
        if (!this._seqRecording || !this.sequencer.playing) return;
        const step = this.sequencer.currentStep;
        if (step < 0) return;
        if (pitch !== undefined) {
            // Chromatic recording: add with specific pitch, duration TBD on release
            this.sequencer.addSlotToStep(step, slotIndex, pitch, 0);
            // Track the note for duration calculation on release
            const entry = this.sequencer.pattern[step].slots[this.sequencer.pattern[step].slots.length - 1];
            if (trackingKey) {
                this._seqRecordingNotes.set(trackingKey, { step, entry });
            }
        } else {
            // Pad recording: add with duration TBD on release
            this.sequencer.addSlotToStep(step, slotIndex, 0, 0);
            const entry = this.sequencer.pattern[step].slots[this.sequencer.pattern[step].slots.length - 1];
            if (trackingKey) {
                this._seqRecordingNotes.set(trackingKey, { step, entry });
            }
        }
        if (this._seqMode) {
            this.renderSeqGrid();
            if (this._seqModeMenuStep === step) this._renderSeqSampleList();
        }
        this._saveSeqPattern();
    }

    _recordNoteOff(trackingKey) {
        if (!this._seqRecordingNotes.has(trackingKey)) return;
        const { step: startStep, entry } = this._seqRecordingNotes.get(trackingKey);
        this._seqRecordingNotes.delete(trackingKey);
        if (!this.sequencer.playing) return;
        const currentStep = this.sequencer.currentStep;
        // Calculate duration in steps (wrapping around pattern)
        const patLen = this.sequencer.pattern.length;
        let dur = currentStep - startStep;
        if (dur <= 0) dur += patLen;
        // Clamp to reasonable range (1 to pattern length)
        dur = Math.max(1, Math.min(patLen, dur));
        entry.duration = dur;
        this._saveSeqPattern();
    }

    // Persistence (with 16 banks)
    _saveSeqPattern() {
        try {
            // Ensure banks array exists
            if (!this._seqBanks) {
                this._seqBanks = new Array(16).fill(null);
            }
            // Save current pattern into current bank
            this._seqBanks[this._seqBankIndex] = this.sequencer.toJSON();
            const data = {
                currentBank: this._seqBankIndex,
                banks: this._seqBanks
            };
            localStorage.setItem('soniphorm-seq-banks', JSON.stringify(data));
        } catch (e) {
            console.warn('Failed to save seq pattern:', e);
        }
    }

    _loadSeqPattern() {
        try {
            // Try new bank format first
            const banksJson = localStorage.getItem('soniphorm-seq-banks');
            if (banksJson) {
                const data = JSON.parse(banksJson);
                this._seqBankIndex = data.currentBank || 0;
                this._seqBanks = data.banks || new Array(16).fill(null);
                // Ensure 16 banks
                while (this._seqBanks.length < 16) this._seqBanks.push(null);
                const bankData = this._seqBanks[this._seqBankIndex];
                if (bankData) {
                    this.sequencer.fromJSON(bankData);
                }
                return;
            }
            // Fall back to old single-pattern format (migration)
            const json = localStorage.getItem('soniphorm-seq-pattern');
            if (json) {
                this.sequencer.fromJSON(JSON.parse(json));
                // Migrate: save into bank 0
                this._seqBanks = new Array(16).fill(null);
                this._seqBanks[0] = this.sequencer.toJSON();
                this._seqBankIndex = 0;
                this._saveSeqPattern();
                // Remove old key
                localStorage.removeItem('soniphorm-seq-pattern');
            } else {
                this._seqBanks = new Array(16).fill(null);
            }
        } catch (e) {
            console.warn('Failed to load seq pattern:', e);
            this._seqBanks = new Array(16).fill(null);
        }
    }

    seqSwitchBank(newIndex) {
        // Clamp to 0-15
        newIndex = Math.max(0, Math.min(15, newIndex));
        if (newIndex === this._seqBankIndex) return;

        // Save current pattern to current bank
        if (!this._seqBanks) this._seqBanks = new Array(16).fill(null);
        this._seqBanks[this._seqBankIndex] = this.sequencer.toJSON();

        // Load new bank
        this._seqBankIndex = newIndex;
        const bankData = this._seqBanks[newIndex];
        if (bankData) {
            this.sequencer.fromJSON(bankData);
        } else {
            this.sequencer.clearPattern();
        }

        // Clear stutter/mutate state
        this.sequencer.stutterEnabled = false;
        this._seqPreMutatePattern = null;
        this.sequencer.mutateEnabled = false;
        this._seqStutterSlots.clear();
        this._seqMutateSlots.clear();
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
        document.getElementById('seq-mutate-btn').classList.remove('mutate-on');

        // Sync step count dropdown and rebuild grid for new bank's step count
        const stepSelect = document.getElementById('seq-step-count');
        if (stepSelect) stepSelect.value = this.sequencer.stepCount;
        this.buildSlotGrid();

        // Update display
        this.renderSeqGrid();
        this._updateBpmDisplay();
        this._updateBankDisplay();
        this._saveSeqPattern();
        if (this._seqModeMenuStep >= 0) this._renderSeqSampleList();
    }

    _seqPreviewBank(delta) {
        const current = this._seqPreviewBankIndex !== null ? this._seqPreviewBankIndex : this._seqBankIndex;
        const newIndex = Math.max(0, Math.min(15, current + delta));
        if (newIndex === this._seqBankIndex && this._seqPreviewBankIndex === null) {
            // Already on active bank, try to move
            const next = Math.max(0, Math.min(15, newIndex + delta));
            if (next === this._seqBankIndex) return;
            this._seqPreviewBankIndex = next;
        } else if (newIndex === this._seqBankIndex) {
            // Returned to active bank — cancel preview
            this._seqPreviewBankIndex = null;
        } else {
            this._seqPreviewBankIndex = newIndex;
        }
        this._updateBankDisplay();
        // Show previewed pattern in grid
        if (this._seqPreviewBankIndex !== null) {
            if (!this._seqBanks) this._seqBanks = new Array(16).fill(null);
            // Save current first
            this._seqBanks[this._seqBankIndex] = this.sequencer.toJSON();
            const bankData = this._seqBanks[this._seqPreviewBankIndex];
            if (bankData) {
                this.sequencer.fromJSON(bankData);
            } else {
                this.sequencer.clearPattern();
            }
            this.renderSeqGrid();
            this._renderSeqSampleList();
            // Restore active pattern back (preview is visual only)
            const activeData = this._seqBanks[this._seqBankIndex];
            if (activeData) {
                this.sequencer.fromJSON(activeData);
            } else {
                this.sequencer.clearPattern();
            }
        } else {
            this.renderSeqGrid();
            this._renderSeqSampleList();
        }
    }

    _seqConfirmBank() {
        if (this._seqPreviewBankIndex === null) return;
        if (this.sequencer && this.sequencer.playing) {
            // Queue: switch at end of current pattern loop
            this._seqQueuedBankIndex = this._seqPreviewBankIndex;
            this._updateBankDisplay();
        } else {
            // Not playing: switch immediately
            this.seqSwitchBank(this._seqPreviewBankIndex);
            this._seqPreviewBankIndex = null;
            this._seqQueuedBankIndex = null;
            this._updateBankDisplay();
        }
    }

    _updateBankDisplay() {
        const label = document.getElementById('zoom-fit');
        label.classList.remove('pat-active', 'pat-preview', 'pat-queued');
        if (this._seqMode) {
            if (this._seqQueuedBankIndex !== null) {
                // Confirmed but waiting for loop end — show queued pattern, green
                label.textContent = 'PAT ' + String(this._seqQueuedBankIndex + 1).padStart(2, '0');
                label.classList.add('pat-queued');
            } else if (this._seqPreviewBankIndex !== null) {
                // Browsing but not confirmed — orange
                label.textContent = '>' + String(this._seqPreviewBankIndex + 1).padStart(2, '0') + '<';
                label.classList.add('pat-preview');
            } else {
                // Showing active pattern — green
                label.textContent = 'PAT ' + String(this._seqBankIndex + 1).padStart(2, '0');
                label.classList.add('pat-active');
            }
            label.style.color = '';
        } else {
            label.textContent = '[ ]';
            label.style.color = '';
        }
    }

    // === Sampler ===

    _initSampler() {
        this.sampler = new Sampler(null);

        this.sampler.getSlotBuffer = (slotIndex) => {
            return this._slotBuffers[slotIndex] || null;
        };

        this.sampler.onTrigger = (slotIndex) => {
            this._sampleHighlightPad(slotIndex, true);
        };
        this.sampler.onRelease = (slotIndex) => {
            this._sampleHighlightPad(slotIndex, false);
        };

        // Keyboard events
        document.addEventListener('keydown', (e) => this._onKeyDown(e));
        document.addEventListener('keyup', (e) => this._onKeyUp(e));

        this._loadSamplerConfig();
    }

    _onKeyDown(e) {
        // Allow in sample mode, or in seq mode during recording
        if (!this._sampleMode && !(this._seqMode && this._seqRecording)) return;
        // Ignore if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        if (e.repeat) return; // ignore key repeat

        const padIdx = this.sampler.keyMap[e.code];
        if (padIdx !== undefined) {
            e.preventDefault();
            this._keysDown.add(e.code);
            this.sampler.trigger(padIdx);
            // Record to current step if recording
            if (this._seqRecording && this.sequencer.playing) {
                this._recordPadToStep(padIdx, undefined, 'pad-' + padIdx);
            }
        }
    }

    _onKeyUp(e) {
        if (!this._sampleMode && !(this._seqMode && this._seqRecording)) return;
        const padIdx = this.sampler.keyMap[e.code];
        if (padIdx !== undefined && this._keysDown.has(e.code)) {
            e.preventDefault();
            this._keysDown.delete(e.code);
            // Record note-off for duration tracking
            if (this._seqRecording && this.sequencer.playing) {
                this._recordNoteOff('pad-' + padIdx);
            }
            this.sampler.release(padIdx);
        }
    }

    // === Mode Switching ===

    async switchMode(mode) {
        await this.ensureAudioInit();

        // Stop rec-mode playback when leaving rec mode
        if (!this._seqMode && !this._sampleMode) {
            this.stopAudio();
        }

        // Exit current mode
        if (this._seqMode) {
            // Keep sequencer playing if switching to sample mode
            if (this.sequencer.playing && mode !== 'sample') {
                this.sequencer.stop();
                this._seqStopAnimation();
            }
            this._seqShowTransportInSample = (mode === 'sample');
            this._saveSeqPattern();
            this._seqMode = false;
            // Restore waveform canvas
            document.getElementById('waveform').style.display = '';
            document.getElementById('seq-sample-list').hidden = true;
            document.getElementById('zoom-fit').textContent = '[ ]';
            if (this.channels) {
                document.getElementById('waveform-empty').hidden = true;
            } else {
                document.getElementById('waveform-empty').hidden = false;
            }
        }
        if (this._sampleMode) {
            this.sampler.stopAll();
            this._keysDown.clear();
            this._seqShowTransportInSample = false;
            // Exit chromatic mode if active
            if (this._chromaticMode) {
                this._chromaticMode = false;
                this.waveform.chromaticMode = false;
                this._unbindChromaticEvents();
                document.getElementById('pad-mode-keys').classList.remove('keys-on');
            }
            // Stop sequencer if switching away from sample to non-seq mode
            if (mode !== 'seq' && this.sequencer && this.sequencer.playing) {
                this.sequencer.stop();
                this._seqStopAnimation();
            }
            this._sampleMode = false;
        }

        // Enter new mode
        if (mode === 'seq') {
            this._seqMode = true;
            if (this.audio.audioContext) {
                this.sequencer.audioContext = this.audio.audioContext;
                this.sequencer.outputNode = this.audio.getEffectsBus();
                // Also init sampler for live recording
                this.sampler.audioContext = this.audio.audioContext;
                this.sampler.outputNode = this.audio.getEffectsBus();
            }
            await this._seqPreloadBuffers();
            // Sync step count dropdown
            const stepSelect = document.getElementById('seq-step-count');
            if (stepSelect) stepSelect.value = this.sequencer.stepCount;
            this.buildSlotGrid();
            this.renderSeqGrid();
            this._updateBpmDisplay();
            document.getElementById('seq-mutate-btn').classList.toggle('mutate-on', this.sequencer.mutateEnabled);
            document.getElementById('seq-stutter-btn').classList.toggle('stutter-on', this.sequencer.stutterEnabled);
            document.getElementById('seq-mutate-amount').value = Math.round(this.sequencer.mutateAmount * 100);
            document.getElementById('seq-stutter-amount').value = Math.round(this.sequencer.stutterAmount * 100);
            // Show sample list in waveform area
            document.getElementById('waveform').style.display = 'none';
            document.getElementById('waveform-empty').hidden = true;
            document.getElementById('seq-sample-list').hidden = false;
            this._seqModeMenuStep = 0;
            this._renderSeqSampleList();
            this._updateBankDisplay();
        } else if (mode === 'sample') {
            this._sampleMode = true;
            if (this.audio.audioContext) {
                this.sampler.audioContext = this.audio.audioContext;
                this.sampler.outputNode = this.audio.getEffectsBus();
            }
            await this._seqPreloadBuffers(); // reuse same buffer cache
            this.renderSampleGrid();
        } else {
            // rec mode — restore normal grid
            this.renderSlotGrid();
        }

        // Apply slot live effects so the bus has the correct chain active
        this._applySlotLiveEffects();

        // Update toggle buttons
        document.getElementById('mode-rec').classList.toggle('active', mode === 'rec');
        document.getElementById('mode-sample').classList.toggle('active', mode === 'sample');
        document.getElementById('mode-seq').classList.toggle('active', mode === 'seq');

        // Show/hide transport bars and toolbar
        document.getElementById('seq-transport').classList.toggle('active', mode === 'seq' || (mode === 'sample' && this._seqShowTransportInSample));
        document.getElementById('sample-transport').classList.toggle('active', mode === 'sample');
        document.getElementById('slot-grid').classList.toggle('seq-mode', mode === 'seq');
        document.getElementById('slot-grid').classList.toggle('sample-mode', mode === 'sample');
        document.getElementById('toolbar').classList.toggle('sample-mode', mode === 'sample');
        document.getElementById('toolbar').classList.toggle('seq-mode', mode === 'seq');
        document.getElementById('macro-bar').hidden = (mode !== 'rec');

        // Header title
        const titles = { rec: 'SOUNDLAB', sample: 'SAMPLER', seq: 'SEQUENCER' };
        document.querySelector('.header-title').textContent = titles[mode];

        // Update sample transport after panel is visible (canvas needs dimensions)
        if (mode === 'sample') {
            this._updateSampleTransport();
        }

        // Recalculate waveform canvas after flex layout changes (fixes centrepoint shift
        // when returning to rec mode after chromatic keyboard changed canvas dimensions)
        if (mode === 'rec' && this.waveform) {
            requestAnimationFrame(() => {
                this.waveform.resize();
            });
        }
    }

    // === Sample Grid ===

    renderSampleGrid() {
        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');

        slotEls.forEach((el, i) => {
            const slot = this.slots.slots[i];
            const pad = this.sampler.pads[i];

            // Slot number
            const numEl = el.querySelector('.slot-number');
            numEl.textContent = String(i + 1).padStart(2, '0');

            // Name
            const nameEl = el.querySelector('.slot-name');
            nameEl.textContent = slot.hasAudio ? (slot.name || 'untitled') : 'empty';
            nameEl.className = `slot-name ${slot.hasAudio ? '' : 'empty'}`;

            // Base class
            el.className = 'slot';
            el.dataset.bank = slot.bank;
            if (i === this._sampleSelectedPad) el.classList.add('pad-selected');
            if (pad.mode === 'morph' && pad.morphTarget !== null) el.classList.add('pad-morph');
            if (this.sampler.isPlaying(i)) el.classList.add('pad-playing');

            // Remove seq icons if present
            const iconsEl = el.querySelector('.step-mode-icons');
            if (iconsEl) iconsEl.remove();

            // Key label
            let keyEl = el.querySelector('.pad-key-label');
            if (!keyEl) {
                keyEl = document.createElement('span');
                keyEl.className = 'pad-key-label';
                el.appendChild(keyEl);
            }
            keyEl.textContent = this.sampler.keyLabels[i];

            // Mode label
            let modeEl = el.querySelector('.pad-mode-label');
            if (!modeEl) {
                modeEl = document.createElement('span');
                modeEl.className = 'pad-mode-label';
                el.appendChild(modeEl);
            }
            const modeLabels = { oneshot: '', loop: 'LP', gate: 'GT', morph: 'MRP' };
            modeEl.textContent = modeLabels[pad.mode] || '';
        });
    }

    _sampleHighlightPad(slotIndex, active) {
        const el = document.querySelectorAll('#slot-grid .slot')[slotIndex];
        if (!el) return;
        el.classList.toggle('pad-active', active);
        if (!active) {
            el.classList.remove('pad-playing');
        } else if (this.sampler.isPlaying(slotIndex)) {
            el.classList.add('pad-playing');
        }
    }

    _updateSamplerLoopFromMarkers(loop) {
        const padIdx = this._sampleSelectedPad;
        const pad = this.sampler.pads[padIdx];
        const buf = this._slotBuffers[padIdx];
        if (!buf) return;
        const sr = buf.sampleRate;
        pad.loopStart = loop.start / sr;
        pad.loopEnd = loop.end / sr;
        this.sampler.updateLoopRegion(padIdx, pad.loopStart, pad.loopEnd);
        this._saveSamplerConfig();
    }

    _updateSamplerRegionFromSelection() {
        // Update all playing looping voices with the current waveform selection
        for (let i = 0; i < 16; i++) {
            if (!this.sampler.isPlaying(i)) continue;
            const sel = this.waveform ? this.waveform.getSelection() : null;
            const buf = this._slotBuffers[i];
            if (sel && buf) {
                this.sampler.updateRegion(i, sel.start / buf.sampleRate, sel.end / buf.sampleRate);
            } else if (buf) {
                this.sampler.updateRegion(i, 0, -1);
            }
        }
    }

    // Pad tap handling (from onSlotTap)
    async samplePadTap(index, e) {
        if (!this.slots.slots[index].hasAudio) return;

        // Load this slot's audio into the waveform if switching pads
        if (index !== this._sampleSelectedPad) {
            this._sampleSelectedPad = index;
            const data = await this.slots.getSlotAudio(index);
            if (data) {
                this.channels = data.channels;
                this.bufferSampleRate = data.sampleRate;
                this.waveform.setAudio(this.channels, this.bufferSampleRate);
                document.getElementById('waveform-empty').hidden = true;
            }
            this.slots.selectSlot(index);
            this.updateTransportInfo();
        }

        // Pass waveform selection as playback region
        const pad = this.sampler.pads[index];
        const sel = this.waveform ? this.waveform.getSelection() : null;
        const buf = this._slotBuffers[index];
        if (sel && buf) {
            const sr = buf.sampleRate;
            pad.regionStart = sel.start / sr;
            pad.regionEnd = sel.end / sr;
        } else {
            pad.regionStart = 0;
            pad.regionEnd = -1;
        }

        // Apply waveform loop markers to pad if present
        if (this.waveform && buf) {
            const loopMarkers = this.waveform.getLoopMarkers();
            if (loopMarkers && pad.mode === 'loop') {
                const sr = buf.sampleRate;
                pad.loopStart = loopMarkers.start / sr;
                pad.loopEnd = loopMarkers.end / sr;
            }
        }

        this._updateSampleTransport();
        this.renderSampleGrid();
        this.sampler.trigger(index);

        // Record to sequencer if looper recording is armed
        if (this._seqRecording && this.sequencer.playing) {
            this._recordPadToStep(index, undefined, 'pad-' + index);
        }
    }

    samplePadRelease(index) {
        // Record note-off for duration tracking
        if (this._seqRecording && this.sequencer.playing) {
            this._recordNoteOff('pad-' + index);
        }
        this.sampler.release(index);
    }

    // === Pad Mode Config ===

    setPadMode(mode) {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        pad.mode = mode;

        // Update toggle active states
        document.getElementById('pad-mode-oneshot').classList.toggle('active', mode === 'oneshot');
        document.getElementById('pad-mode-loop').classList.toggle('active', mode === 'loop');

        // Show/hide loop markers
        if (this.waveform) {
            if (mode === 'loop') {
                this.waveform.setLoopVisible(true);
                if (pad.loopStart >= 0 && pad.loopEnd >= 0) {
                    const buf = this._slotBuffers[this._sampleSelectedPad];
                    if (buf) {
                        this.waveform.setLoopMarkers(
                            Math.round(pad.loopStart * buf.sampleRate),
                            Math.round(pad.loopEnd * buf.sampleRate)
                        );
                    }
                }
            } else {
                this.waveform.setLoopVisible(false);
                this.waveform.clearLoopMarkers();
            }
        }

        this.sampler.invalidateMorphCache();
        this.renderSampleGrid();
        this._saveSamplerConfig();
    }

    _togglePadReverse() {
        const padIdx = this._sampleSelectedPad;
        const pad = this.sampler.pads[padIdx];
        pad.reverse = !pad.reverse;
        this.sampler.invalidateReverseBuffer(padIdx);
        document.getElementById('pad-mode-rev').classList.toggle('rev-on', pad.reverse);
        this._saveSamplerConfig();
    }

    _populateMorphTargets() {
        const select = document.getElementById('morph-target');
        const pad = this.sampler.pads[this._sampleSelectedPad];
        select.innerHTML = '';
        for (let i = 0; i < 16; i++) {
            if (i === this._sampleSelectedPad) continue;
            if (!this.slots.slots[i].hasAudio) continue;
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `${String(i + 1).padStart(2, '0')} — ${this.slots.slots[i].name || 'untitled'}`;
            if (pad.morphTarget === i) opt.selected = true;
            select.appendChild(opt);
        }
        // Always sync target from select (handles null, NaN, or stale values)
        if (select.options.length > 0) {
            // If current target isn't in the list, reset to first option
            if (pad.morphTarget === null || isNaN(pad.morphTarget) || !select.querySelector(`option[value="${pad.morphTarget}"]`)) {
                pad.morphTarget = parseInt(select.options[0].value);
                select.value = pad.morphTarget;
            }
        } else {
            pad.morphTarget = null;
        }

        document.getElementById('morph-type').value = pad.morphType;
        document.getElementById('morph-amount').value = Math.round(pad.morphAmount * 100);
        document.getElementById('morph-amount-val').textContent = Math.round(pad.morphAmount * 100) + '%';
    }

    _updateMorphConfig() {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        const targetVal = parseInt(document.getElementById('morph-target').value);
        pad.morphTarget = isNaN(targetVal) ? null : targetVal;
        pad.morphType = document.getElementById('morph-type').value;
        pad.morphAmount = parseInt(document.getElementById('morph-amount').value) / 100;
        this.sampler.invalidateMorphCache();
        this._saveSamplerConfig();
    }

    _updateSampleTransport() {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        const slot = this.slots.slots[this._sampleSelectedPad];
        const name = slot.hasAudio ? (slot.name || 'untitled') : 'empty';
        document.getElementById('sample-pad-info').textContent =
            `${String(this._sampleSelectedPad + 1).padStart(2, '0')} ${name}`;

        // Update ONE/LOOP toggle
        document.getElementById('pad-mode-oneshot').classList.toggle('active', pad.mode === 'oneshot');
        document.getElementById('pad-mode-loop').classList.toggle('active', pad.mode === 'loop');

        // Show/hide loop markers on waveform
        if (this.waveform) {
            if (pad.mode === 'loop' && pad.loopStart >= 0 && pad.loopEnd >= 0) {
                const buf = this._slotBuffers[this._sampleSelectedPad];
                if (buf) {
                    this.waveform.setLoopMarkers(
                        Math.round(pad.loopStart * buf.sampleRate),
                        Math.round(pad.loopEnd * buf.sampleRate)
                    );
                }
                this.waveform.setLoopVisible(true);
            } else if (pad.mode === 'loop') {
                this.waveform.clearLoopMarkers();
                this.waveform.setLoopVisible(true);
            } else {
                this.waveform.clearLoopMarkers();
                this.waveform.setLoopVisible(false);
            }
        }

        // Update REV button
        document.getElementById('pad-mode-rev').classList.toggle('rev-on', pad.reverse);

        // ENV panel: pitch + volume sliders
        document.getElementById('pad-pitch').value = pad.pitch;
        document.getElementById('pad-pitch-val').textContent = (pad.pitch >= 0 ? '+' : '') + pad.pitch + 'st';
        document.getElementById('pad-volume').value = Math.round(pad.volume * 100);
        document.getElementById('pad-volume-val').textContent = Math.round(pad.volume * 100) + '%';

        // ENV panel: canvas envelopes (both amp + pitch)
        this._drawEnvelopes();

        // FILT panel
        const filtToggle = document.getElementById('pad-filter-toggle');
        filtToggle.textContent = pad.filterEnabled ? 'ON' : 'OFF';
        filtToggle.classList.toggle('active', pad.filterEnabled);
        document.getElementById('pad-filter-type').value = pad.filterType;
        document.getElementById('pad-filter-freq').value = this._sliderFromFreq(pad.filterFreq);
        document.getElementById('pad-filter-freq-val').textContent = pad.filterFreq;
        document.getElementById('pad-filter-q').value = Math.round(pad.filterQ * 10);
        document.getElementById('pad-filter-q-val').textContent = pad.filterQ.toFixed(1);

        // LFO panel
        const lfoToggle = document.getElementById('pad-lfo-toggle');
        lfoToggle.textContent = pad.lfoEnabled ? 'ON' : 'OFF';
        lfoToggle.classList.toggle('active', pad.lfoEnabled);
        document.getElementById('pad-lfo-target').value = pad.lfoTarget;
        document.getElementById('pad-lfo-rate').value = Math.round(pad.lfoRate * 10);
        document.getElementById('pad-lfo-rate-val').textContent = pad.lfoRate.toFixed(1);
        document.getElementById('pad-lfo-depth').value = Math.round(pad.lfoDepth * 100);
        document.getElementById('pad-lfo-depth-val').textContent = Math.round(pad.lfoDepth * 100) + '%';
        document.getElementById('pad-lfo-shape').value = pad.lfoShape;

        // MORPH panel
        if (pad.mode === 'morph') {
            this._populateMorphTargets();
        }
    }

    // === Sample Tab Switching ===

    _switchSampleTab(tabName) {
        document.querySelectorAll('.sample-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });
        document.getElementById('panel-env').hidden = (tabName !== 'env');
        document.getElementById('panel-filter').hidden = (tabName !== 'filter');
        document.getElementById('panel-lfo').hidden = (tabName !== 'lfo');
        document.getElementById('panel-morph').hidden = (tabName !== 'morph');
        if (tabName === 'env') this._drawEnvelopes();

        // MORPH tab: enter morph mode and populate targets
        if (tabName === 'morph') {
            const pad = this.sampler.pads[this._sampleSelectedPad];
            pad.mode = 'morph';
            document.getElementById('pad-mode-oneshot').classList.remove('active');
            document.getElementById('pad-mode-loop').classList.remove('active');
            this._populateMorphTargets();
            this.sampler.invalidateMorphCache();
            this.renderSampleGrid();
            this._saveSamplerConfig();
        }
    }

    // === Pad Parameter Updates ===

    _updatePadEnv() {
        const idx = this._sampleSelectedPad;
        const pad = this.sampler.pads[idx];
        pad.pitch = parseInt(document.getElementById('pad-pitch').value);
        pad.volume = parseInt(document.getElementById('pad-volume').value) / 100;

        // Live-update pitch and volume on playing voice
        const voice = this.sampler._voices[idx];
        if (voice) {
            const now = this.sampler.audioContext.currentTime;
            voice.source.playbackRate.setValueAtTime(Math.pow(2, pad.pitch / 12), now);
            voice.volumeGain.gain.setValueAtTime(pad.volume, now);
        }

        document.getElementById('pad-pitch-val').textContent = (pad.pitch >= 0 ? '+' : '') + pad.pitch + 'st';
        document.getElementById('pad-volume-val').textContent = Math.round(pad.volume * 100) + '%';
        this._saveSamplerConfig();
    }

    // === Envelope Curve Editor ===

    _initEnvEditor() {
        const canvasAmp = document.getElementById('env-canvas-amp');
        const canvasPitch = document.getElementById('env-canvas-pitch');

        // Pitch envelope enable/disable toggle
        document.getElementById('env-pitch-enable').addEventListener('click', () => {
            const pad = this.sampler.pads[this._sampleSelectedPad];
            pad.pitchEnvEnabled = !pad.pitchEnvEnabled;
            this._drawEnvelopes();
            this._saveSamplerConfig();
        });

        // Mobile envelope toggle (AMP <-> PITCH)
        document.getElementById('env-mobile-toggle').addEventListener('click', () => {
            const ampGroup = document.querySelector('.env-group-amp');
            const pitchGroup = document.querySelector('.env-group-pitch');
            const btn = document.getElementById('env-mobile-toggle');
            const showingPitch = pitchGroup.classList.contains('env-show');
            if (showingPitch) {
                // Switch back to AMP
                pitchGroup.classList.remove('env-show');
                ampGroup.classList.remove('env-hide');
                btn.textContent = 'PITCH';
                btn.classList.remove('showing-pitch');
            } else {
                // Switch to PITCH
                pitchGroup.classList.add('env-show');
                ampGroup.classList.add('env-hide');
                btn.textContent = 'AMP';
                btn.classList.add('showing-pitch');
            }
            // Redraw envelopes since canvas may have resized
            requestAnimationFrame(() => this._drawEnvelopes());
        });

        // Pointer events for both canvases
        for (const [canvas, envType] of [[canvasAmp, 'amp'], [canvasPitch, 'pitch']]) {
            canvas.addEventListener('pointerdown', (e) => this._envPointerDown(e, envType));
            canvas.addEventListener('pointermove', (e) => this._envPointerMove(e, envType));
            canvas.addEventListener('pointerup', (e) => this._envPointerUp(e));
            canvas.addEventListener('pointercancel', (e) => this._envPointerUp(e));
        }

        // Resize handler
        window.addEventListener('resize', () => this._drawEnvelopes());
    }

    _getEnvValuesFor(type) {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        if (type === 'pitch') {
            return {
                attack: pad.pitchEnvAttack,
                decay: pad.pitchEnvDecay,
                sustain: pad.pitchEnvSustain,
                release: pad.pitchEnvRelease,
                enabled: pad.pitchEnvEnabled
            };
        }
        return {
            attack: pad.attack,
            decay: pad.decay,
            sustain: pad.sustain,
            release: pad.release,
            enabled: true
        };
    }

    _setEnvValuesFor(type, attack, decay, sustain, release) {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        if (type === 'pitch') {
            pad.pitchEnvAttack = attack;
            pad.pitchEnvDecay = decay;
            pad.pitchEnvSustain = sustain;
            pad.pitchEnvRelease = release;
        } else {
            pad.attack = attack;
            pad.decay = decay;
            pad.sustain = sustain;
            pad.release = release;
        }
    }

    _drawEnvelopes() {
        this._drawEnvelopeOn('env-canvas-amp', 'amp');
        this._drawEnvelopeOn('env-canvas-pitch', 'pitch');
    }

    _drawEnvelopeOn(canvasId, envType) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const W = rect.width;
        const H = rect.height;
        ctx.clearRect(0, 0, W, H);

        const pad = this.sampler ? this.sampler.pads[this._sampleSelectedPad] : null;
        if (!pad) return;

        const env = this._getEnvValuesFor(envType);
        const nodes = envType === 'amp' ? '_envNodesAmp' : '_envNodesPitch';
        const valuesId = envType === 'amp' ? 'env-values-amp' : 'env-values-pitch';

        // Show pitch enable/disable toggle (only relevant for pitch canvas)
        if (envType === 'pitch') {
            const enableBtn = document.getElementById('env-pitch-enable');
            enableBtn.hidden = false;
            enableBtn.textContent = env.enabled ? 'DISABLE' : 'ENABLE';
            if (!env.enabled) {
                ctx.strokeStyle = 'rgba(148,163,184,0.2)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, H);
                ctx.lineTo(W * 0.2, 4);
                ctx.lineTo(W * 0.5, H * 0.6);
                ctx.lineTo(W * 0.7, H * 0.6);
                ctx.lineTo(W, H);
                ctx.stroke();
                this[nodes] = [];
                this._updateEnvValues(env, valuesId);
                return;
            }
        }

        // Layout: proportional time segments with min widths
        const padding = 8;
        const drawW = W - padding * 2;
        const drawH = H - padding * 2;
        const sustainHoldFrac = 0.15;
        const totalTime = env.attack + env.decay + env.release + 0.001;
        const sustainHoldW = drawW * sustainHoldFrac;
        const timeW = drawW - sustainHoldW;

        const minSeg = 12;
        let atkW = Math.max(minSeg, (env.attack / totalTime) * timeW);
        let decW = Math.max(minSeg, (env.decay / totalTime) * timeW);
        let relW = Math.max(minSeg, (env.release / totalTime) * timeW);
        const segTotal = atkW + decW + relW;
        if (segTotal > timeW) {
            const scale = timeW / segTotal;
            atkW *= scale;
            decW *= scale;
            relW *= scale;
        }
        const susW = drawW - atkW - decW - relW;

        const x0 = padding;
        const x1 = padding + atkW;
        const x2 = padding + atkW + decW;
        const x3 = padding + atkW + decW + susW;
        const x4 = padding + drawW;
        const yTop = padding;
        const yBot = padding + drawH;
        const ySus = yTop + (1 - env.sustain) * drawH;

        this[nodes] = [
            { x: x1, y: yTop },
            { x: x2, y: ySus },
            { x: x3, y: ySus }
        ];

        // Draw filled area
        ctx.beginPath();
        ctx.moveTo(x0, yBot);
        ctx.lineTo(x1, yTop);
        ctx.lineTo(x2, ySus);
        ctx.lineTo(x3, ySus);
        ctx.lineTo(x4, yBot);
        ctx.closePath();
        const accentColor = envType === 'pitch' ? '234,179,8' : '14,165,233';
        ctx.fillStyle = `rgba(${accentColor},0.08)`;
        ctx.fill();

        // Draw gridlines
        ctx.strokeStyle = 'rgba(148,163,184,0.08)';
        ctx.lineWidth = 1;
        const y50 = yTop + 0.5 * drawH;
        ctx.beginPath();
        ctx.moveTo(padding, y50);
        ctx.lineTo(padding + drawW, y50);
        ctx.stroke();
        if (env.sustain > 0.01 && env.sustain < 0.99) {
            ctx.strokeStyle = 'rgba(148,163,184,0.12)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(padding, ySus);
            ctx.lineTo(padding + drawW, ySus);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Draw curve
        const strokeColor = envType === 'pitch' ? '#eab308' : '#0ea5e9';
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x0, yBot);
        ctx.lineTo(x1, yTop);
        ctx.lineTo(x2, ySus);
        ctx.lineTo(x3, ySus);
        ctx.lineTo(x4, yBot);
        ctx.stroke();

        // Draw nodes
        const nodeColor = envType === 'pitch' ? '#eab308' : '#0ea5e9';
        const nodeArr = this[nodes];
        for (let i = 0; i < nodeArr.length; i++) {
            const n = nodeArr[i];
            ctx.beginPath();
            ctx.arc(n.x, n.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = nodeColor;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        this._updateEnvValues(env, valuesId);
    }

    _updateEnvValues(env, elId) {
        const el = document.getElementById(elId);
        if (!el) return;
        const fmtTime = (s) => {
            const ms = Math.round(s * 1000);
            return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
        };
        el.textContent = `A:${fmtTime(env.attack)}  D:${fmtTime(env.decay)}  S:${Math.round(env.sustain * 100)}%  R:${fmtTime(env.release)}`;
    }

    _envPointerDown(e, envType) {
        const canvasId = envType === 'amp' ? 'env-canvas-amp' : 'env-canvas-pitch';
        const canvas = document.getElementById(canvasId);
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;

        const nodeArr = envType === 'amp' ? this._envNodesAmp : this._envNodesPitch;
        let closest = -1;
        let closestDist = 24;
        for (let i = 0; i < nodeArr.length; i++) {
            const n = nodeArr[i];
            const dist = Math.sqrt((px - n.x) ** 2 + (py - n.y) ** 2);
            if (dist < closestDist) {
                closestDist = dist;
                closest = i;
            }
        }

        if (closest >= 0) {
            this._envDragging = closest;
            this._envDragTarget = envType;
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
        }
    }

    _envPointerMove(e, envType) {
        if (this._envDragging < 0 || this._envDragTarget !== envType) return;
        e.preventDefault();

        const canvasId = envType === 'amp' ? 'env-canvas-amp' : 'env-canvas-pitch';
        const canvas = document.getElementById(canvasId);
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;

        const padding = 8;
        const drawW = rect.width - padding * 2;
        const drawH = rect.height - padding * 2;

        const env = this._getEnvValuesFor(envType);
        const sustainHoldFrac = 0.15;
        const totalTime = env.attack + env.decay + env.release + 0.001;
        const sustainHoldW = drawW * sustainHoldFrac;
        const timeW = drawW - sustainHoldW;

        const node = this._envDragging;

        if (node === 0) {
            const xClamped = Math.max(padding + 8, Math.min(px, padding + drawW * 0.45));
            const frac = (xClamped - padding) / timeW;
            const newAtk = Math.max(0.001, Math.min(2.0, frac * totalTime));
            this._setEnvValuesFor(envType, newAtk, env.decay, env.sustain, env.release);
        } else if (node === 1) {
            const atkFrac = env.attack / totalTime;
            const atkEndX = padding + atkFrac * timeW;
            const xClamped = Math.max(atkEndX + 8, Math.min(px, padding + drawW * 0.7));
            const decFrac = (xClamped - atkEndX) / timeW;
            const newDec = Math.max(0.001, Math.min(2.0, decFrac * totalTime));
            const yClamped = Math.max(padding, Math.min(py, padding + drawH));
            const newSus = Math.max(0, Math.min(1, 1 - (yClamped - padding) / drawH));
            this._setEnvValuesFor(envType, env.attack, newDec, newSus, env.release);
        } else if (node === 2) {
            const minX = padding + drawW * 0.35;
            const maxX = padding + drawW - 8;
            const xClamped = Math.max(minX, Math.min(px, maxX));
            const relPixels = padding + drawW - xClamped;
            const relFrac = relPixels / timeW;
            const newRel = Math.max(0.005, Math.min(5.0, relFrac * totalTime));
            this._setEnvValuesFor(envType, env.attack, env.decay, env.sustain, newRel);
        }

        this._drawEnvelopeOn(canvasId, envType);
    }

    _envPointerUp(e) {
        if (this._envDragging >= 0) {
            this._envDragging = -1;
            this._envDragTarget = null;
            this._saveSamplerConfig();
        }
    }

    _togglePadFilter() {
        const idx = this._sampleSelectedPad;
        const pad = this.sampler.pads[idx];
        pad.filterEnabled = !pad.filterEnabled;
        const btn = document.getElementById('pad-filter-toggle');
        btn.textContent = pad.filterEnabled ? 'ON' : 'OFF';
        btn.classList.toggle('active', pad.filterEnabled);

        // Live-update: toggling filter requires retrigger since we can't
        // insert/remove a node from a playing chain. Update existing filter if present.
        const voice = this.sampler._voices[idx];
        if (voice && voice.filter) {
            const now = this.sampler.audioContext.currentTime;
            if (pad.filterEnabled) {
                voice.filter.frequency.setValueAtTime(pad.filterFreq, now);
                voice.filter.Q.setValueAtTime(pad.filterQ, now);
                voice.filter.type = pad.filterType;
            } else {
                // Bypass: set to allpass-like (high freq, low Q)
                voice.filter.frequency.setValueAtTime(22000, now);
                voice.filter.Q.setValueAtTime(0.001, now);
            }
        }
        this._saveSamplerConfig();
    }

    // Log scale: slider 0-1000 -> freq 20-20000Hz
    _freqFromSlider(val) {
        const minLog = Math.log(20);
        const maxLog = Math.log(20000);
        return Math.round(Math.exp(minLog + (val / 1000) * (maxLog - minLog)));
    }
    _sliderFromFreq(freq) {
        const minLog = Math.log(20);
        const maxLog = Math.log(20000);
        return Math.round(((Math.log(Math.max(20, freq)) - minLog) / (maxLog - minLog)) * 1000);
    }

    _updatePadFilter() {
        const idx = this._sampleSelectedPad;
        const pad = this.sampler.pads[idx];
        pad.filterType = document.getElementById('pad-filter-type').value;
        pad.filterFreq = this._freqFromSlider(parseInt(document.getElementById('pad-filter-freq').value));
        pad.filterQ = parseInt(document.getElementById('pad-filter-q').value) / 10;

        // Live-update filter on playing voice
        const voice = this.sampler._voices[idx];
        if (voice && voice.filter && pad.filterEnabled) {
            const now = this.sampler.audioContext.currentTime;
            voice.filter.type = pad.filterType;
            voice.filter.frequency.setValueAtTime(pad.filterFreq, now);
            voice.filter.Q.setValueAtTime(pad.filterQ, now);
        }

        document.getElementById('pad-filter-freq-val').textContent = pad.filterFreq;
        document.getElementById('pad-filter-q-val').textContent = pad.filterQ.toFixed(1);
        this._saveSamplerConfig();
    }

    _togglePadLfo() {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        pad.lfoEnabled = !pad.lfoEnabled;
        const btn = document.getElementById('pad-lfo-toggle');
        btn.textContent = pad.lfoEnabled ? 'ON' : 'OFF';
        btn.classList.toggle('active', pad.lfoEnabled);
        this._saveSamplerConfig();
    }

    _updatePadLfo() {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        pad.lfoTarget = document.getElementById('pad-lfo-target').value;
        pad.lfoRate = parseInt(document.getElementById('pad-lfo-rate').value) / 10;
        pad.lfoDepth = parseInt(document.getElementById('pad-lfo-depth').value) / 100;
        pad.lfoShape = document.getElementById('pad-lfo-shape').value;

        document.getElementById('pad-lfo-rate-val').textContent = pad.lfoRate.toFixed(1);
        document.getElementById('pad-lfo-depth-val').textContent = Math.round(pad.lfoDepth * 100) + '%';
        this._saveSamplerConfig();
    }

    // === Chromatic Keyboard ===

    _toggleChromaticMode() {
        this._chromaticMode = !this._chromaticMode;
        document.getElementById('pad-mode-keys').classList.toggle('keys-on', this._chromaticMode);
        const canvas = document.getElementById('waveform');
        if (this._chromaticMode) {
            this.waveform.chromaticMode = true;
            canvas.style.display = '';
            document.getElementById('waveform-empty').hidden = true;
            this._renderPianoKeyboard();
            this._bindChromaticEvents();
        } else {
            this.waveform.chromaticMode = false;
            this._unbindChromaticEvents();
            // Restore normal waveform display
            if (this.channels) {
                this.waveform.setAudio(this.channels, this.bufferSampleRate);
            } else {
                this.waveform.clear();
                document.getElementById('waveform-empty').hidden = false;
            }
        }
    }

    _renderPianoKeyboard() {
        const canvas = document.getElementById('waveform');
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === 0 || h === 0) return;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const totalNotes = this._chromaticOctaveSpan * 12;
        const startNote = this._chromaticBaseOctave * 12; // MIDI note number (C of base octave)
        const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        const isBlack = [false,true,false,true,false,false,true,false,true,false,true,false];

        // Calculate white key count for layout
        let whiteCount = 0;
        for (let n = 0; n < totalNotes; n++) {
            if (!isBlack[n % 12]) whiteCount++;
        }
        const whiteKeyWidth = w / whiteCount;
        const blackKeyWidth = whiteKeyWidth * 0.6;
        const blackKeyHeight = h * 0.6;

        // Background
        ctx.fillStyle = '#0a0e1a';
        ctx.fillRect(0, 0, w, h);

        // Draw white keys first
        const homePitch = 60; // MIDI note for original sample pitch
        let whiteIdx = 0;
        this._chromaticKeyRects = []; // Store rects for hit testing: [{x, w, h, noteIdx, isBlack}]
        for (let n = 0; n < totalNotes; n++) {
            if (!isBlack[n % 12]) {
                const x = whiteIdx * whiteKeyWidth;
                const midiNote = startNote + n;
                const isHome = (midiNote === homePitch);
                const isHeld = (n === this._chromaticHeldNote);
                // White key rect — held gets light blue, home pitch gets a distinct grey
                ctx.fillStyle = isHeld ? '#38bdf8' : isHome ? '#b0b8c0' : '#e8e8e8';
                ctx.fillRect(x + 1, 0, whiteKeyWidth - 2, h - 2);
                ctx.strokeStyle = '#999';
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 1, 0, whiteKeyWidth - 2, h - 2);

                // Note label
                const octave = Math.floor(midiNote / 12);
                const noteName = noteNames[midiNote % 12];
                ctx.fillStyle = '#333';
                ctx.font = '10px "JetBrains Mono", monospace';
                ctx.textAlign = 'center';
                ctx.fillText(noteName + octave, x + whiteKeyWidth / 2, h - 8);

                this._chromaticKeyRects.push({ x: x, w: whiteKeyWidth, h: h, noteIdx: n, isBlack: false });
                whiteIdx++;
            }
        }

        // Draw black keys on top
        whiteIdx = 0;
        for (let n = 0; n < totalNotes; n++) {
            if (!isBlack[n % 12]) {
                // If next note is black, draw it
                if (n + 1 < totalNotes && isBlack[(n + 1) % 12]) {
                    const x = (whiteIdx + 1) * whiteKeyWidth - blackKeyWidth / 2;
                    const isHeldBlack = (n + 1 === this._chromaticHeldNote);
                    ctx.fillStyle = isHeldBlack ? '#0ea5e9' : '#1a1a1a';
                    ctx.fillRect(x, 0, blackKeyWidth, blackKeyHeight);
                    ctx.strokeStyle = '#333';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x, 0, blackKeyWidth, blackKeyHeight);

                    this._chromaticKeyRects.push({ x: x, w: blackKeyWidth, h: blackKeyHeight, noteIdx: n + 1, isBlack: true });
                }
                whiteIdx++;
            }
        }
    }

    _chromaticNoteFromX(clientX, clientY) {
        const canvas = document.getElementById('waveform');
        const rect = canvas.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        if (!this._chromaticKeyRects) return null;

        // Check black keys first (they overlap white keys)
        for (const kr of this._chromaticKeyRects) {
            if (kr.isBlack && px >= kr.x && px <= kr.x + kr.w && py <= kr.h) {
                return kr.noteIdx;
            }
        }
        // Then white keys
        for (const kr of this._chromaticKeyRects) {
            if (!kr.isBlack && px >= kr.x && px <= kr.x + kr.w && py <= kr.h) {
                return kr.noteIdx;
            }
        }
        return null;
    }

    _chromaticPlayNote(noteIdx) {
        if (noteIdx === null) return;
        const startNote = this._chromaticBaseOctave * 12;
        const midiNote = startNote + noteIdx;
        const semitones = midiNote - 60; // offset from middle C
        const padIdx = this._sampleSelectedPad;
        if (!this.sampler || !this.slots.slots[padIdx].hasAudio) return;

        // Release previous held note if different
        if (this._chromaticHeldNote !== undefined && this._chromaticHeldNote !== null && this._chromaticHeldNote !== noteIdx) {
            this.sampler.release(padIdx);
        }

        this._chromaticHeldNote = noteIdx;
        this._renderPianoKeyboard();

        // Temporarily set pitch and trigger with loop for sustain
        const pad = this.sampler.pads[padIdx];
        const originalPitch = pad.pitch;
        const originalMode = pad.mode;
        pad.pitch = semitones;
        pad.mode = 'gate'; // gate mode so release stops the sound
        this.sampler._stopVoice(padIdx);
        const buffer = this.sampler._getPlayBuffer(padIdx);
        if (buffer) {
            this.sampler._startVoice(padIdx, buffer, true);
        }
        // Restore original settings — _startVoice reads them synchronously
        pad.pitch = originalPitch;
        pad.mode = originalMode;
        if (this.sampler.onTrigger) this.sampler.onTrigger(padIdx);

        // Record to sequencer if looper recording is armed
        // Store pitch relative to pad's base pitch, since sequencer adds pad.pitch on playback
        if (this._seqRecording && this.sequencer.playing) {
            this._recordPadToStep(padIdx, semitones - pad.pitch, 'chromatic-' + noteIdx);
        }
    }

    _chromaticReleaseNote() {
        const padIdx = this._sampleSelectedPad;
        if (this._chromaticHeldNote !== undefined && this._chromaticHeldNote !== null) {
            // Record note-off for duration tracking
            if (this._seqRecording && this.sequencer.playing) {
                this._recordNoteOff('chromatic-' + this._chromaticHeldNote);
            }
            const pad = this.sampler.pads[padIdx];
            this.sampler._fadeOutVoice(padIdx, pad.release);
            if (this.sampler.onRelease) this.sampler.onRelease(padIdx);
            this._chromaticHeldNote = null;
            this._renderPianoKeyboard();
        }
    }

    _bindChromaticEvents() {
        const canvas = document.getElementById('waveform');
        this._chromaticHeldNote = null;

        // Touch: start triggers note, move glides, end releases
        this._chromaticTouchStartHandler = (e) => {
            e.preventDefault();
            if (e.touches.length === 2) {
                // Two-finger horizontal drag: shift octave
                this._chromaticPanStartX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                this._chromaticPanStartOctave = this._chromaticBaseOctave;
                return;
            }
            if (e.touches.length === 1) {
                const noteIdx = this._chromaticNoteFromX(e.touches[0].clientX, e.touches[0].clientY);
                this._chromaticPlayNote(noteIdx);
            }
        };
        this._chromaticTouchMoveHandler = (e) => {
            e.preventDefault();
            if (e.touches.length === 2) {
                if (this._chromaticPanStartX !== null) {
                    const currentMid = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                    const delta = currentMid - this._chromaticPanStartX;
                    const octShift = Math.round(delta / 80);
                    this._chromaticBaseOctave = Math.max(0, Math.min(8, this._chromaticPanStartOctave - octShift));
                    this._renderPianoKeyboard();
                }
                return;
            }
            if (e.touches.length === 1) {
                const noteIdx = this._chromaticNoteFromX(e.touches[0].clientX, e.touches[0].clientY);
                if (noteIdx !== null && noteIdx !== this._chromaticHeldNote) {
                    this._chromaticPlayNote(noteIdx); // triggers release of old + play new
                }
            }
        };
        this._chromaticTouchEndHandler = (e) => {
            e.preventDefault();
            if (e.touches.length < 2) {
                this._chromaticPanStartX = null;
            }
            if (e.touches.length === 0) {
                this._chromaticReleaseNote();
            }
        };

        // Mouse: down triggers, up releases
        this._chromaticMouseHandler = (e) => {
            const noteIdx = this._chromaticNoteFromX(e.clientX, e.clientY);
            this._chromaticPlayNote(noteIdx);
        };
        this._chromaticMouseUpHandler = () => {
            this._chromaticReleaseNote();
        };

        canvas.addEventListener('touchstart', this._chromaticTouchStartHandler, { passive: false });
        canvas.addEventListener('touchmove', this._chromaticTouchMoveHandler, { passive: false });
        canvas.addEventListener('touchend', this._chromaticTouchEndHandler, { passive: false });
        canvas.addEventListener('mousedown', this._chromaticMouseHandler);
        canvas.addEventListener('mouseup', this._chromaticMouseUpHandler);
    }

    _unbindChromaticEvents() {
        const canvas = document.getElementById('waveform');
        if (this._chromaticTouchStartHandler) {
            canvas.removeEventListener('touchstart', this._chromaticTouchStartHandler);
            canvas.removeEventListener('touchmove', this._chromaticTouchMoveHandler);
            canvas.removeEventListener('touchend', this._chromaticTouchEndHandler);
        }
        if (this._chromaticMouseHandler) {
            canvas.removeEventListener('mousedown', this._chromaticMouseHandler);
            canvas.removeEventListener('mouseup', this._chromaticMouseUpHandler);
        }
        this._chromaticTouchStartHandler = null;
        this._chromaticTouchMoveHandler = null;
        this._chromaticMouseHandler = null;
        this._chromaticPanStartX = null;
        this._chromaticHeldNote = null;
    }

    // Persistence
    _saveSamplerConfig() {
        try {
            localStorage.setItem('soniphorm-sampler', JSON.stringify(this.sampler.toJSON()));
        } catch (e) {
            console.warn('Failed to save sampler config:', e);
        }
    }

    _loadSamplerConfig() {
        try {
            const json = localStorage.getItem('soniphorm-sampler');
            if (json) this.sampler.fromJSON(JSON.parse(json));
        } catch (e) {
            console.warn('Failed to load sampler config:', e);
        }
    }


    async _requestWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            this._wakeLock = await navigator.wakeLock.request('screen');
        } catch (e) {
            // Wake lock denied or not available
        }
    }

    _releaseWakeLock() {
        if (this._wakeLock) {
            this._wakeLock.release();
            this._wakeLock = null;
        }
    }

    formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        const ms = Math.floor((s % 1) * 1000);
        return `${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }
}

// === Boot ===
const app = new App();
app.init().catch(console.error);
