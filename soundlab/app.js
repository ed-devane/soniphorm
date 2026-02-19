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
        this._seqPreStutterPattern = null; // saved pattern for stutter undo

        // Sampler
        this.sampler = null;
        this._sampleMode = false;
        this._sampleSelectedPad = 0; // currently selected pad for config
        this._keysDown = new Set(); // track held keys for gate mode
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
            this.waveform.onSelectionChange = () => {
                this.updateToolbarState();
                // If looping, restart with new selection
                if (this.audio.isPlaying && this.audio.isLooping) {
                    this._restartLoop();
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

        // Init audio context on first interaction
        document.addEventListener('click', () => this.ensureAudioInit(), { once: true });
        document.addEventListener('touchstart', () => this.ensureAudioInit(), { once: true });
    }

    async ensureAudioInit() {
        try {
            await this.audio.init();
            if (this.audio.audioContext) {
                this.slots.setAudioContext(this.audio.audioContext);
            }
        } catch (e) { console.warn('Audio init:', e); }
    }

    // === Slot Grid ===

    buildSlotGrid() {
        const grid = document.getElementById('slot-grid');
        grid.innerHTML = '';
        for (let i = 0; i < 16; i++) {
            const slot = this.slots.slots[i];
            const el = document.createElement('div');
            el.className = 'slot';
            el.dataset.index = i;
            el.dataset.bank = slot.bank;

            el.innerHTML = `
                <span class="slot-number">${String(i + 1).padStart(2, '0')}</span>
                <span class="slot-name ${slot.hasAudio ? '' : 'empty'}">${slot.hasAudio ? slot.name || 'untitled' : 'empty'}</span>
                <div class="slot-mini"><canvas></canvas></div>
            `;

            el.addEventListener('click', (e) => this.onSlotTap(i, e));
            el.addEventListener('contextmenu', (e) => this.onSlotContext(i, e));

            // Sample mode: trigger on press, release on lift
            el.addEventListener('mousedown', (e) => {
                if (this._sampleMode && e.button === 0) this.samplePadTap(i);
            });
            el.addEventListener('mouseup', () => { if (this._sampleMode) this.samplePadRelease(i); });
            el.addEventListener('mouseleave', () => { if (this._sampleMode) this.samplePadRelease(i); });

            // Long press for context menu on mobile
            let pressTimer = null;
            el.addEventListener('touchstart', (e) => {
                if (this._sampleMode) {
                    this.samplePadTap(i);
                }
                pressTimer = setTimeout(() => {
                    e.preventDefault();
                    this.onSlotContext(i, e.touches[0]);
                }, 500);
            });
            el.addEventListener('touchend', () => {
                clearTimeout(pressTimer);
                if (this._sampleMode) this.samplePadRelease(i);
            });
            el.addEventListener('touchmove', () => clearTimeout(pressTimer));

            grid.appendChild(el);
        }
        this.renderSlotGrid();
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
            await this.audio.startRecording();
        } catch (e) {
            alert('Could not access microphone. Check permissions.');
            return;
        }
        this.recordingSlotIndex = index;
        this._recChunks = [];
        this._recTotalLen = 0;
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
        this.cancelAnimationLoop();
        document.getElementById('rec-btn').classList.remove('recording');

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
        // In sequencer mode, long-press opens step mode menu
        if (this._seqMode) {
            this.openStepModeMenu(index, e);
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
            allSlots.forEach(slot => {
                const slider = slot.querySelector('.macro-slider');
                slider.addEventListener('focus', () => {
                    allSlots.forEach(s => {
                        if (s === slot) {
                            s.classList.add('expanded');
                            s.classList.remove('collapsed');
                        } else {
                            s.classList.add('collapsed');
                            s.classList.remove('expanded');
                        }
                    });
                });
                slider.addEventListener('blur', () => {
                    allSlots.forEach(s => s.classList.remove('expanded', 'collapsed'));
                });
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
        document.getElementById('main-menu').addEventListener('click', (e) => {
            const action = e.target.dataset.action;
            document.getElementById('main-menu').hidden = true;
            if (action === 'export-all') this.exportAllSlots();
            if (action === 'delete-all') this.deleteAll();
        });

        // Mode toggle: REC / SAMPLE / SEQ
        $('mode-rec').addEventListener('click', () => this.switchMode('rec'));
        $('mode-sample').addEventListener('click', () => this.switchMode('sample'));
        $('mode-seq').addEventListener('click', () => this.switchMode('seq'));

        // Sampler transport — mode buttons
        $('pad-mode-oneshot').addEventListener('click', () => this.setPadMode('oneshot'));
        $('pad-mode-loop').addEventListener('click', () => this.setPadMode('loop'));
        $('pad-mode-gate').addEventListener('click', () => this.setPadMode('gate'));
        $('pad-mode-morph').addEventListener('click', () => this.setPadMode('morph'));
        $('sample-stop-all').addEventListener('click', () => this.sampler && this.sampler.stopAll());

        // Sample tabs
        document.querySelectorAll('.sample-tab').forEach(tab => {
            tab.addEventListener('click', () => this._switchSampleTab(tab.dataset.tab));
        });

        // ENV panel sliders
        $('pad-volume').addEventListener('input', () => this._updatePadEnv());
        $('pad-attack').addEventListener('input', () => this._updatePadEnv());
        $('pad-decay').addEventListener('input', () => this._updatePadEnv());
        $('pad-sustain').addEventListener('input', () => this._updatePadEnv());
        $('pad-release').addEventListener('input', () => this._updatePadEnv());

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
        $('bpm-down').addEventListener('click', () => this.seqAdjustBpm(-1));
        $('bpm-up').addEventListener('click', () => this.seqAdjustBpm(1));
        $('bpm-display').addEventListener('click', () => this.seqEditBpm());
        $('tap-tempo-btn').addEventListener('click', () => this.seqTapTempo());
        $('seq-random-btn').addEventListener('click', () => this.seqRandomise());
        $('seq-stutter-btn').addEventListener('click', () => this.seqStutter());
        $('seq-mutate-btn').addEventListener('click', () => this.seqToggleMutate());
        $('seq-bounce-btn').addEventListener('click', () => this.seqBounce());
        $('seq-clear-btn').addEventListener('click', () => this.seqClear());

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
            this.waveform.setZoom(this.waveform.getZoom() * 1.5);
            this.waveform.render();
        });
        $('zoom-out').addEventListener('click', () => {
            this.waveform.setZoom(this.waveform.getZoom() / 1.5);
            this.waveform.render();
        });
        $('zoom-fit').addEventListener('click', () => {
            this.waveform.setZoom(1);
            this.waveform.setScrollOffset(0);
            this.waveform.render();
        });
    }

    // === Playback ===

    playAudio() {
        if (!this.channels) return;
        const sel = this.waveform.getSelection();
        const cursor = this.waveform.getCursor();
        const start = sel ? sel.start : cursor;
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
            this._seqPreStutterPattern = null;
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
        };
        this.sequencer.onMutate = (step) => {
            this._seqFlashMutate(step);
            this.renderSeqGrid();
        };
        this.sequencer.onPatternLoop = () => {
            if (this.sequencer.mutateEnabled) {
                this.renderSeqGrid();
            }
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
        // Open step mode menu on tap (with slot picker)
        this.openStepModeMenu(stepIndex, { clientX: null, clientY: null, _useCentered: true });
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

        if (this.sequencer.playing) {
            this.sequencer.stop();
            this._seqStopAnimation();
            document.getElementById('seq-play-btn').innerHTML = '&#9654; PLAY';
        } else {
            // Stop main waveform playback if active
            this.stopAudio();
            // Preload any new buffers
            await this._seqPreloadBuffers();
            this.sequencer.play();
            this._seqStartAnimation();
            document.getElementById('seq-play-btn').innerHTML = '&#9632; STOP';
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
        this._seqPreStutterPattern = null;
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
        this.sequencer.randomise(0.75);
        this.renderSeqGrid();
        this._saveSeqPattern();
    }

    seqStutter() {
        const btn = document.getElementById('seq-stutter-btn');
        if (this._seqPreStutterPattern) {
            // Undo stutter: restore saved pattern
            this.sequencer.fromJSON(this._seqPreStutterPattern);
            this._seqPreStutterPattern = null;
            btn.classList.remove('stutter-on');
        } else {
            // Save current pattern then apply stutter
            this._seqPreStutterPattern = this.sequencer.toJSON();
            this.sequencer.stutter();
            btn.classList.add('stutter-on');
        }
        this.renderSeqGrid();
        this._saveSeqPattern();
    }

    seqToggleMutate() {
        this.sequencer.mutateEnabled = !this.sequencer.mutateEnabled;
        document.getElementById('seq-mutate-btn').classList.toggle('mutate-on', this.sequencer.mutateEnabled);
        this._saveSeqPattern();
    }

    seqClear() {
        this._seqPreStutterPattern = null;
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
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

    // Persistence
    _saveSeqPattern() {
        try {
            const data = this.sequencer.toJSON();
            localStorage.setItem('soniphorm-seq-pattern', JSON.stringify(data));
        } catch (e) {
            console.warn('Failed to save seq pattern:', e);
        }
    }

    _loadSeqPattern() {
        try {
            const json = localStorage.getItem('soniphorm-seq-pattern');
            if (json) {
                this.sequencer.fromJSON(JSON.parse(json));
            }
        } catch (e) {
            console.warn('Failed to load seq pattern:', e);
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
        if (!this._sampleMode) return;
        // Ignore if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        if (e.repeat) return; // ignore key repeat

        const padIdx = this.sampler.keyMap[e.code];
        if (padIdx !== undefined) {
            e.preventDefault();
            this._keysDown.add(e.code);
            this.sampler.trigger(padIdx);
        }
    }

    _onKeyUp(e) {
        if (!this._sampleMode) return;
        const padIdx = this.sampler.keyMap[e.code];
        if (padIdx !== undefined && this._keysDown.has(e.code)) {
            e.preventDefault();
            this._keysDown.delete(e.code);
            this.sampler.release(padIdx);
        }
    }

    // === Mode Switching ===

    async switchMode(mode) {
        await this.ensureAudioInit();

        // Exit current mode
        if (this._seqMode) {
            if (this.sequencer.playing) {
                this.sequencer.stop();
                this._seqStopAnimation();
            }
            this._saveSeqPattern();
            this._seqMode = false;
        }
        if (this._sampleMode) {
            this.sampler.stopAll();
            this._keysDown.clear();
            this._sampleMode = false;
        }

        // Enter new mode
        if (mode === 'seq') {
            this._seqMode = true;
            if (this.audio.audioContext) {
                this.sequencer.audioContext = this.audio.audioContext;
            }
            await this._seqPreloadBuffers();
            this.renderSeqGrid();
            this._updateBpmDisplay();
            document.getElementById('seq-mutate-btn').classList.toggle('mutate-on', this.sequencer.mutateEnabled);
        } else if (mode === 'sample') {
            this._sampleMode = true;
            if (this.audio.audioContext) {
                this.sampler.audioContext = this.audio.audioContext;
            }
            await this._seqPreloadBuffers(); // reuse same buffer cache
            this.renderSampleGrid();
            this._updateSampleTransport();
        } else {
            // rec mode — restore normal grid
            this.renderSlotGrid();
        }

        // Update toggle buttons
        document.getElementById('mode-rec').classList.toggle('active', mode === 'rec');
        document.getElementById('mode-sample').classList.toggle('active', mode === 'sample');
        document.getElementById('mode-seq').classList.toggle('active', mode === 'seq');

        // Show/hide transport bars
        document.getElementById('seq-transport').classList.toggle('active', mode === 'seq');
        document.getElementById('sample-transport').classList.toggle('active', mode === 'sample');
        document.getElementById('slot-grid').classList.toggle('seq-mode', mode === 'seq');
        document.getElementById('slot-grid').classList.toggle('sample-mode', mode === 'sample');

        // Header title
        const titles = { rec: 'SOUNDLAB', sample: 'SAMPLER', seq: 'SEQUENCER' };
        document.querySelector('.header-title').textContent = titles[mode];
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

    // Pad tap handling (from onSlotTap)
    samplePadTap(index, e) {
        if (!this.slots.slots[index].hasAudio) return;
        this._sampleSelectedPad = index;
        this._updateSampleTransport();
        this.renderSampleGrid();
        this.sampler.trigger(index);
    }

    samplePadRelease(index) {
        this.sampler.release(index);
    }

    // === Pad Mode Config ===

    setPadMode(mode) {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        pad.mode = mode;

        // Update button active states
        document.querySelectorAll('.pad-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === 'pad-mode-' + mode);
        });

        // Auto-switch to MORPH tab when morph mode selected
        if (mode === 'morph') {
            this._switchSampleTab('morph');
            this._populateMorphTargets();
        }

        this.sampler.invalidateMorphCache();
        this.renderSampleGrid();
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

        // Update mode buttons
        document.querySelectorAll('.pad-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === 'pad-mode-' + pad.mode);
        });

        // ENV panel
        document.getElementById('pad-volume').value = Math.round(pad.volume * 100);
        document.getElementById('pad-volume-val').textContent = Math.round(pad.volume * 100) + '%';
        document.getElementById('pad-attack').value = Math.round(pad.attack * 1000);
        document.getElementById('pad-attack-val').textContent = Math.round(pad.attack * 1000) + 'ms';
        document.getElementById('pad-decay').value = Math.round(pad.decay * 1000);
        document.getElementById('pad-decay-val').textContent = Math.round(pad.decay * 1000) + 'ms';
        document.getElementById('pad-sustain').value = Math.round(pad.sustain * 100);
        document.getElementById('pad-sustain-val').textContent = Math.round(pad.sustain * 100) + '%';
        document.getElementById('pad-release').value = Math.round(pad.release * 1000);
        document.getElementById('pad-release-val').textContent = Math.round(pad.release * 1000) + 'ms';

        // FILT panel
        const filtToggle = document.getElementById('pad-filter-toggle');
        filtToggle.textContent = pad.filterEnabled ? 'ON' : 'OFF';
        filtToggle.classList.toggle('active', pad.filterEnabled);
        document.getElementById('pad-filter-type').value = pad.filterType;
        document.getElementById('pad-filter-freq').value = pad.filterFreq;
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
    }

    // === Pad Parameter Updates ===

    _updatePadEnv() {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        pad.volume = parseInt(document.getElementById('pad-volume').value) / 100;
        pad.attack = parseInt(document.getElementById('pad-attack').value) / 1000;
        pad.decay = parseInt(document.getElementById('pad-decay').value) / 1000;
        pad.sustain = parseInt(document.getElementById('pad-sustain').value) / 100;
        pad.release = parseInt(document.getElementById('pad-release').value) / 1000;

        document.getElementById('pad-volume-val').textContent = Math.round(pad.volume * 100) + '%';
        document.getElementById('pad-attack-val').textContent = Math.round(pad.attack * 1000) + 'ms';
        document.getElementById('pad-decay-val').textContent = Math.round(pad.decay * 1000) + 'ms';
        document.getElementById('pad-sustain-val').textContent = Math.round(pad.sustain * 100) + '%';
        document.getElementById('pad-release-val').textContent = Math.round(pad.release * 1000) + 'ms';
        this._saveSamplerConfig();
    }

    _togglePadFilter() {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        pad.filterEnabled = !pad.filterEnabled;
        const btn = document.getElementById('pad-filter-toggle');
        btn.textContent = pad.filterEnabled ? 'ON' : 'OFF';
        btn.classList.toggle('active', pad.filterEnabled);
        this._saveSamplerConfig();
    }

    _updatePadFilter() {
        const pad = this.sampler.pads[this._sampleSelectedPad];
        pad.filterType = document.getElementById('pad-filter-type').value;
        pad.filterFreq = parseInt(document.getElementById('pad-filter-freq').value);
        pad.filterQ = parseInt(document.getElementById('pad-filter-q').value) / 10;

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
