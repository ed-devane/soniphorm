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

        // Sequencer
        this.sequencer = null;
        this._seqMode = false;
        this._seqRecording = false;
        this._seqShowTransportInSample = false;

        // Sampler
        this.sampler = null;
        this._sampleMode = false;

        // Noise gate
        this._gateEnabled = false;

        // Input device selection
        this._selectedInputDeviceId = null;

        // MIDI
        this.midi = null;
        this._midiHeldNotes = new Map(); // midiNote -> voiceKey

        // Kit mode
        this._kitMode = false;
        this._kitParentSlot = -1;
        this._kitSlotBuffers = {}; // subIndex -> AudioBuffer
        this._kitSelectedSub = 0;
        this._drumGridView = false; // true = drum grid, false = normal seq view
        this._kitPlayMode = false;  // PAD PLAY: immediate trigger on first tap with velocity

        // Gen mode
        this._genMode = false;
        this.gen = null;
    }

    async init() {
        // Create controllers first (UI binding needs them)
        this.rec = new RecController(this);
        this.seq = new SeqController(this);
        this.sample = new SampleController(this);
        this.genCtrl = new GenController(this);
        this.seq._initSequencer();
        this.sample._initSampler();
        this._initMidi();
        this.genCtrl._initGen();

        // Build UI (depends on controllers being available)
        this.buildSlotGrid();
        this.bindToolbar();
        this.bindDialogs();
        this.updateToolbarState();
        this.updateTransportInfo();
        // Waveform
        try {
            const canvas = document.getElementById('waveform');
            this.waveform = new WaveformRenderer(canvas);
            this.waveform.onSelectionChange = (sel) => {
                this.updateToolbarState();
                // If looping, restart with new selection
                if (this.audio.isPlaying && this.audio.isLooping) {
                    this.rec._restartLoop();
                }
                // Update sampler region/loop live
                if (this._sampleMode) {
                    const pad = this.sampler.pads[this.sample._sampleSelectedPad];
                    if (pad.mode === 'loop' && sel) {
                        this.waveform.setLoopMarkers(sel.start, sel.end);
                        this.waveform.clearSelection();
                        this.sample._updateSamplerLoopFromMarkers(sel);
                    } else {
                        this.sample._updateSamplerRegionFromSelection();
                    }
                }
            };
            this.waveform.onLoopChange = (loop) => {
                if (this._sampleMode) this.sample._updateSamplerLoopFromMarkers(loop);
            };
            this.waveform.onLoopClear = () => {
                if (this._sampleMode) {
                    const pad = this.sampler.pads[this.sample._sampleSelectedPad];
                    pad.loopStart = -1;
                    pad.loopEnd = -1;
                    this.waveform.clearLoopMarkers();
                    this.sampler.updateLoopRegion(this.sample._sampleSelectedPad, -1, -1);
                    this.sample._saveSamplerConfig();
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
                if (this._genMode) this.genCtrl._genResizeOverlay();
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
                if (el._longPressFired) { el._longPressFired = false; e.stopPropagation(); return; }
                this.onSlotTap(i, e);
            });
            if (i < 16) {
                el.addEventListener('contextmenu', (e) => this.onSlotContext(i, e));
                el.addEventListener('dblclick', async (e) => {
                    // Double-click kit slot -> enter kit mode
                    if (!this._kitMode && this.slots.slots[i].type === 'kit') {
                        await this.ensureAudioInit();
                        await this._enterKitMode(i);
                        return;
                    }
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

            // Sample/Gen mode: trigger on press, release on lift
            let usedTouch = false;
            let longPressTimer = null;

            if (i < 16) {
                el.addEventListener('mousedown', (e) => {
                    if (usedTouch) return;
                    if (e.button !== 0) return;
                    if (this._sampleMode) this.sample.samplePadTap(i);
                    else if (this._genMode) this.genCtrl._genPadTrigger(i);
                    else {
                        // Long-press for context menu on desktop without right-click (e.g. macOS single-button)
                        longPressTimer = setTimeout(() => {
                            longPressTimer = null;
                            el._longPressFired = true;
                            this.onSlotContext(i, { preventDefault: () => {}, clientX: e.clientX, clientY: e.clientY });
                        }, 500);
                    }
                });
                el.addEventListener('mouseup', () => {
                    if (usedTouch) return;
                    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                    if (this._sampleMode) this.sample.samplePadRelease(i);
                    else if (this._genMode) this.sampler.release(i);
                });
                el.addEventListener('mouseleave', () => {
                    if (usedTouch) return;
                    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                    if (this._sampleMode) this.sample.samplePadRelease(i);
                    else if (this._genMode) this.sampler.release(i);
                });

                // Touch events
                el.addEventListener('touchstart', (e) => {
                    usedTouch = true;
                    if (this._sampleMode) {
                        e.preventDefault();
                        this.sample.samplePadTap(i);
                    } else if (this._genMode) {
                        e.preventDefault();
                        this.genCtrl._genPadTrigger(i);
                    } else {
                        // Long-press for context menu on iOS (contextmenu event not fired)
                        const touch = e.touches[0];
                        longPressTimer = setTimeout(() => {
                            longPressTimer = null;
                            this.onSlotContext(i, { preventDefault: () => {}, clientX: touch.clientX, clientY: touch.clientY });
                        }, 500);
                    }
                });
                el.addEventListener('touchmove', () => {
                    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                });
                el.addEventListener('touchend', (e) => {
                    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                    if (this._sampleMode) {
                        e.preventDefault();
                        this.sample.samplePadRelease(i);
                    } else if (this._genMode) {
                        e.preventDefault();
                        this.sampler.release(i);
                    }
                    setTimeout(() => { usedTouch = false; }, 400);
                });
                el.addEventListener('touchcancel', () => {
                    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                    if (this._sampleMode) this.sample.samplePadRelease(i);
                    else if (this._genMode) this.sampler.release(i);
                    setTimeout(() => { usedTouch = false; }, 400);
                });
            }

            grid.appendChild(el);
        }
        if (!this._seqMode && !this._genMode) this.renderSlotGrid();
    }

    renderSlotGrid() {
        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');
        slotEls.forEach((el, i) => {
            const slot = this.slots.slots[i];
            const nameEl = el.querySelector('.slot-name');
            const isKit = slot.type === 'kit';

            if (isKit) {
                nameEl.textContent = slot.name || 'Kit';
                nameEl.className = 'slot-name';
            } else {
                nameEl.textContent = slot.hasAudio ? (slot.name || 'untitled') : 'empty';
                nameEl.className = `slot-name ${slot.hasAudio ? '' : 'empty'}`;
            }

            // Restore normal mode classes
            el.className = 'slot';
            el.dataset.bank = slot.bank;
            if (isKit) el.classList.add('slot-kit');

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
            if (isKit) {
                // Show kit indicator instead of waveform
                const ctx = miniCanvas.getContext('2d');
                miniCanvas.width = miniCanvas.clientWidth;
                miniCanvas.height = miniCanvas.clientHeight;
                ctx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
            } else if (slot.hasAudio && slot.peaks) {
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
            this.seq.seqStepTap(index);
            return;
        }
        // In gen mode, select pad for mapping
        if (this._genMode) {
            this.genCtrl._genSelectPad(index);
            return;
        }
        // In sampler mode, trigger is handled by mousedown/touchstart
        if (this._sampleMode) {
            return;
        }
        await this.ensureAudioInit();
        const slot = this.slots.slots[index];

        // Kit slots: single click selects, double-click enters kit mode
        if (slot.type === 'kit') {
            this.slots.selectSlot(index);
            this.channels = null;
            this.waveform.clear();
            document.getElementById('waveform-empty').hidden = false;
            this.renderSlotGrid();
            this.updateTransportInfo();
            return;
        }

        // If we're recording into this slot, stop recording
        if (this.recordingSlotIndex === index) {
            await this.rec.stopRecording();
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
            await this.rec.startRecording(index);
            return;
        }

        // If already selected and has audio, toggle play/stop
        if (index === this.slots.selectedIndex && slot.hasAudio && this.channels) {
            if (this.audio.isPlaying) {
                this.rec.stopAudio();
            } else {
                this.rec.playAudio(true); // from start
            }
            return;
        }

        // Select the slot
        this.audio.stop();
        this.rec.cancelAnimationLoop();
        const _pb = document.getElementById('play-btn'); _pb.classList.remove('playing'); _pb.innerHTML = '&#9654; PLAY';
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
        this.rec._applySlotLiveEffects();
    }

    // === Context Menu ===

    onSlotContext(index, e) {
        e.preventDefault?.();
        // In sequencer mode, long-press selects step (same as tap)
        if (this._seqMode) {
            this.seq.seqStepTap(index);
            return;
        }
        // In sampler mode, long-press selects pad for config (transport updates)
        if (this._sampleMode) {
            this.sample._sampleSelectedPad = index;
            this.sample._updateSampleTransport();
            this.sample.renderSampleGrid();
            return;
        }
        const slot = this.slots.slots[index];

        // Kit mode: context menu for kit sub-slots
        if (this._kitMode) {
            const sub = this.slots.getKitSlotMeta(this._kitParentSlot, index);
            if (!sub || !sub.hasAudio) return;
            const menu = document.getElementById('context-menu');
            // Hide kit-specific buttons, show normal ones
            menu.querySelector('[data-action="make-kit"]').hidden = true;
            menu.querySelector('[data-action="unmake-kit"]').hidden = true;
            menu.querySelector('[data-action="duplicate"]').hidden = true;
            menu.querySelector('[data-action="rename"]').hidden = false;
            menu.querySelector('[data-action="save"]').hidden = false;
            menu.querySelector('[data-action="clear"]').hidden = false;
            const x = e.clientX || e.pageX;
            const y = e.clientY || e.pageY;
            menu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
            menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
            menu.hidden = false;
            menu._slotIndex = index;
            menu._kitMode = true;
            menu._kitParentSlot = this._kitParentSlot;
            const close = (ev) => {
                if (!menu.contains(ev.target)) {
                    menu.hidden = true;
                    document.removeEventListener('click', close);
                }
            };
            setTimeout(() => document.addEventListener('click', close), 10);
            return;
        }

        // Empty slot with no audio and not a kit — only show "Make Drum Kit"
        if (!slot.hasAudio && slot.type !== 'kit') {
            const menu = document.getElementById('context-menu');
            menu.querySelector('[data-action="rename"]').hidden = true;
            menu.querySelector('[data-action="duplicate"]').hidden = true;
            menu.querySelector('[data-action="save"]').hidden = true;
            menu.querySelector('[data-action="clear"]').hidden = true;
            menu.querySelector('[data-action="make-kit"]').hidden = false;
            menu.querySelector('[data-action="unmake-kit"]').hidden = true;
            const x = e.clientX || e.pageX;
            const y = e.clientY || e.pageY;
            menu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
            menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
            menu.hidden = false;
            menu._slotIndex = index;
            menu._kitMode = false;
            const close = (ev) => {
                if (!menu.contains(ev.target)) {
                    menu.hidden = true;
                    document.removeEventListener('click', close);
                }
            };
            setTimeout(() => document.addEventListener('click', close), 10);
            return;
        }

        const menu = document.getElementById('context-menu');
        const isKit = slot.type === 'kit';
        menu.querySelector('[data-action="rename"]').hidden = false;
        menu.querySelector('[data-action="duplicate"]').hidden = isKit;
        menu.querySelector('[data-action="save"]').hidden = isKit;
        menu.querySelector('[data-action="clear"]').hidden = false;
        menu.querySelector('[data-action="make-kit"]').hidden = isKit;
        menu.querySelector('[data-action="unmake-kit"]').hidden = !isKit;

        const x = e.clientX || e.pageX;
        const y = e.clientY || e.pageY;
        menu.style.left = Math.min(x, window.innerWidth - 170) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
        menu.hidden = false;
        menu._slotIndex = index;
        menu._kitMode = false;

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
        document.getElementById('rename-ok').addEventListener('click', async () => {
            const name = input.value.trim() || 'untitled';
            if (dialog._isKitSlot) {
                await this.slots.renameKitSlot(dialog._kitParentSlot, dialog._slotIndex, name);
                dialog._isKitSlot = false;
                dialog.hidden = true;
                this._renderKitGrid();
            } else {
                this.slots.renameSlot(dialog._slotIndex, name);
                dialog.hidden = true;
                if (this._kitMode) {
                    this._renderKitGrid();
                } else {
                    this.renderSlotGrid();
                }
            }
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
            const isKitCtx = menu._kitMode;
            const kitParent = menu._kitParentSlot;
            menu.hidden = true;
            if (!action || index == null) return;

            switch (action) {
                case 'rename':
                    if (isKitCtx) {
                        this._showKitSlotRenameDialog(kitParent, index);
                    } else {
                        this.rec.showRenameDialog(index);
                    }
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
                    if (isKitCtx) {
                        await this._saveKitSlotToDevice(kitParent, index);
                    } else {
                        await this.rec.saveSlotToDevice(index);
                    }
                    break;
                case 'clear':
                    if (isKitCtx) {
                        if (confirm(`Clear kit pad ${index + 1}?`)) {
                            await this.slots.clearKitSlot(kitParent, index);
                            delete this._kitSlotBuffers[index];
                            this._renderKitGrid();
                        }
                    } else {
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
                    }
                    break;
                case 'make-kit':
                    await this.slots.makeKit(index);
                    this.renderSlotGrid();
                    break;
                case 'unmake-kit':
                    if (confirm(`Unmake drum kit in slot ${index + 1}? All kit samples will be deleted.`)) {
                        await this.slots.unmakeKit(index);
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

    // === Toolbar ===

    bindToolbar() {
        const $ = (id) => document.getElementById(id);

        $('rec-btn').addEventListener('click', async () => {
            await this.ensureAudioInit();
            if (this.recordingSlotIndex >= 0) {
                await this.rec.stopRecording();
            } else if (this.slots.selectedIndex >= 0) {
                const slot = this.slots.getSelectedSlot();
                if (slot && !slot.hasAudio) {
                    await this.rec.startRecording(this.slots.selectedIndex);
                } else {
                    // Find an empty slot
                    const empty = this.slots.findEmptySlot();
                    if (empty >= 0) {
                        this.slots.selectSlot(empty);
                        this.channels = null;
                        this.waveform.clear();
                        this.renderSlotGrid();
                        await this.rec.startRecording(empty);
                    } else {
                        alert('No empty slots available');
                    }
                }
            }
        });

        $('play-btn').addEventListener('click', () => {
            if ($('play-btn').classList.contains('playing')) this.rec.stopAudio();
            else this.rec.playAudio();
        });
        $('loop-btn').addEventListener('click', () => this.rec.toggleLoop());

        // Noise gate
        $('gate-btn').addEventListener('click', () => this.rec.toggleGate());
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
        $('trim-btn').addEventListener('click', () => this.rec.applyEdit('trim'));
        $('reverse-btn').addEventListener('click', () => this.rec.applyEdit('reverse'));
        $('norm-btn').addEventListener('click', () => this.rec.applyEdit('normalise'));

        // Process expander
        $('process-btn').addEventListener('click', () => {
            const bar = document.getElementById('process-group');
            bar.hidden = !bar.hidden;
            $('process-btn').classList.toggle('active', !bar.hidden);
        });

        // File operations
        $('save-btn').addEventListener('click', () => this.rec.saveCurrentToDevice());
        $('load-btn').addEventListener('click', () => $('file-input').click());
        $('file-input').addEventListener('change', (e) => this.rec.loadFile(e));

        // FX buttons
        document.querySelectorAll('.fx-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const fxName = btn.dataset.fx;
                if (fxName && Effects.registry[fxName]) {
                    this.rec.openFxDialog(fxName);
                }
            });
        });

        // Sample page FX panel: cross, layer, bounce
        $('sample-cross-btn').addEventListener('click', () => this.rec.openCrossDialog());
        $('sample-layer-btn').addEventListener('click', () => this.rec.openLayerDialog());
        $('sample-bounce-btn').addEventListener('click', () => this.rec.bounceToSlot());

        // Cross-slot dialog
        $('cross-preview').addEventListener('click', () => this.rec.previewCross());
        $('cross-apply').addEventListener('click', () => this.rec.applyCross());
        $('cross-cancel').addEventListener('click', () => {
            document.getElementById('cross-dialog').hidden = true;
            this.audio.stop();
        });

        // Layer & Bounce dialog
        $('layer-preview').addEventListener('click', () => this.rec.previewLayer());
        $('layer-bounce').addEventListener('click', () => this.rec.bounceLayer());
        $('layer-cancel').addEventListener('click', () => {
            document.getElementById('layer-dialog').hidden = true;
            this.audio.stop();
        });

        // FX dialog buttons
        $('fx-preview').addEventListener('click', () => this.rec.previewFx());
        $('fx-apply').addEventListener('click', () => this.rec.applyFx());
        $('fx-cancel').addEventListener('click', () => this.rec.closeFxDialog());

        // Main menu
        $('menu-btn').addEventListener('click', () => this._toggleMainMenu());

        // MIDI settings toggle (direct handler on menu button)
        const midiBtn = $('midi-btn');
        if (midiBtn) {
            midiBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const panel = document.getElementById('midi-settings');
                const show = panel.hidden;
                panel.hidden = !show;
                e.target.classList.toggle('menu-active', show);
                if (show) this._refreshMidiPortUI();
            });
        }


        document.getElementById('main-menu').addEventListener('click', async (e) => {
            const action = e.target.dataset.action;
            if (!action) return; // clicked the select dropdown, don't close
            if (action === 'input') {
                const select = $('input-device-select');
                const hint = $('input-device-hint');
                if (!select.hidden) {
                    select.hidden = true;
                    if (hint) hint.hidden = true;
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
                if (hint) hint.hidden = false;
                return;
            }
            if (action === 'midi') return; // handled by direct listener
            document.getElementById('main-menu').hidden = true;
            if (action === 'bounce') this.rec.bounceToSlot();
            if (action === 'export-all') this.rec.exportAllSlots();
            if (action === 'save-project') this.rec.saveProject();
            if (action === 'load-project') { document.getElementById('project-file-input').click(); return; }
            if (action === 'delete-all') this.deleteAll();
            if (action === 'install') this._promptInstall();
        });

        // Mode toggle: REC / SAMPLE / SEQ
        $('mode-rec').addEventListener('click', () => this.switchMode('rec'));
        $('mode-sample').addEventListener('click', () => this.switchMode('sample'));
        $('mode-seq').addEventListener('click', () => this.switchMode('seq'));
        $('mode-gen').addEventListener('click', () => this.switchMode('gen'));

        // Waveform context menu
        const wfCanvas = document.getElementById('waveform');
        wfCanvas.addEventListener('contextmenu', (e) => {
            if (this._sampleMode || this._seqMode || this._genMode) return;
            e.preventDefault();
            this._showWaveformMenu(e.clientX, e.clientY);
        });
        let _wfLongTimer = null;
        wfCanvas.addEventListener('touchstart', (e) => {
            const t = e.touches[0];
            _wfLongTimer = setTimeout(() => {
                _wfLongTimer = null;
                this._showWaveformMenu(t.clientX, t.clientY);
            }, 600);
        }, { passive: true });
        wfCanvas.addEventListener('touchmove', () => {
            if (_wfLongTimer) { clearTimeout(_wfLongTimer); _wfLongTimer = null; }
        }, { passive: true });
        wfCanvas.addEventListener('touchend', () => {
            if (_wfLongTimer) { clearTimeout(_wfLongTimer); _wfLongTimer = null; }
        }, { passive: true });
        // Update nudge button visibility after waveform interaction
        wfCanvas.addEventListener('mouseup', () => this.updateToolbarState());
        wfCanvas.addEventListener('touchend', () => this.updateToolbarState(), { passive: true });
        document.getElementById('waveform-menu').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-wfm]');
            if (!btn) return;
            document.getElementById('waveform-menu').hidden = true;
            const a = btn.dataset.wfm;
            if (a === 'cut')     this.rec.applyEdit('cut');
            if (a === 'copy')    this.rec.copySelection();
            if (a === 'paste')   this.rec.applyEdit('paste');
            if (a === 'silence') this.rec.applyEdit('silence');
            if (a === 'fadein')  this.rec.applyEdit('fadeIn');
            if (a === 'fadeout') this.rec.applyEdit('fadeOut');
            if (a === 'cross')   this.rec.openCrossDialog();
            if (a === 'layer')   this.rec.openLayerDialog();
            if (a === 'bounce')  this.rec.bounceToSlot();
        });
        document.addEventListener('click', () => {
            document.getElementById('waveform-menu').hidden = true;
        });

        // Gen transport bindings
        $('gen-source-file').addEventListener('click', () => this.genCtrl._genSetSource('file'));
        $('gen-source-cam').addEventListener('click', () => this.genCtrl._genSetSource('camera'));
        $('gen-cam-select').addEventListener('change', () => this.genCtrl._genSwitchCamera());
        $('gen-load-btn').addEventListener('click', () => $('gen-file-input').click());
        $('gen-file-input').addEventListener('change', (e) => this.genCtrl._genLoadVideo(e));
        $('project-file-input').addEventListener('change', (e) => this.rec.loadProject(e));
        $('gen-play-btn').addEventListener('click', () => this.genCtrl._genTogglePlay());
        $('gen-stop-btn').addEventListener('click', () => this.genCtrl._genStop());
        $('gen-rec-btn').addEventListener('click', () => this.genCtrl._genToggleRec());
        $('gen-toggle-btn').addEventListener('click', () => this.genCtrl._genToggleMaster());
        $('gen-loop-btn').addEventListener('click', () => this.genCtrl._genToggleLoop());
        $('gen-in-slider').addEventListener('input', (e) => this.genCtrl._genOnInSlider(e.target.value));
        $('gen-out-slider').addEventListener('input', (e) => this.genCtrl._genOnOutSlider(e.target.value));
        $('gen-add-mapping-btn').addEventListener('click', () => this.genCtrl._genAddMapping());
        $('gen-clear-pad-maps-btn').addEventListener('click', () => this.genCtrl._genClearPadMappings());
        $('gen-zones-btn').addEventListener('click', () => this.genCtrl._genToggleZonesMode());
        $('gen-add-zone-btn').addEventListener('click', () => this.genCtrl._genAddZone());
        $('gen-clear-zones-btn').addEventListener('click', () => {
            this.gen.zones = [];
            this.gen._nextZoneId = 100;
            this.genCtrl._genUpdateZonePanel();
            this.genCtrl._genDrawOverlay();
            this.genCtrl._genSaveZones();
        });

        // Kit mode back button
        $('kit-back-btn').addEventListener('click', () => this._exitKitMode());

        // Kit PAD PLAY mode toggle
        $('kit-play-btn').addEventListener('click', async () => {
            this._kitPlayMode = !this._kitPlayMode;
            $('kit-play-btn').classList.toggle('active', this._kitPlayMode);
            if (this._kitPlayMode) {
                // Init audio within this user gesture so iOS allows context resume
                await this.ensureAudioInit();
                if (!this.sampler.audioContext) {
                    this.sampler.audioContext = this.audio.audioContext;
                    this.sampler.outputNode = this.audio.getEffectsBus();
                }
                // Decode buffers now if audio context wasn't ready at _enterKitMode time
                if (Object.keys(this._kitSlotBuffers).length === 0) {
                    await this._preloadKitBuffers(this._kitParentSlot);
                }
            }
        });

        // Drum grid toggle
        $('seq-drum-grid-btn').addEventListener('click', () => this.seq._toggleDrumGrid());

        // Sampler transport — mode buttons
        $('pad-mode-oneshot').addEventListener('click', () => this.sample.setPadMode('oneshot'));
        $('pad-mode-loop').addEventListener('click', () => this.sample.setPadMode('loop'));
        $('pad-mode-gate').addEventListener('click', () => this.sample.setPadMode('gate'));
        $('pad-mode-rev').addEventListener('click', () => this.sample._togglePadReverse());
        $('pad-mode-keys').addEventListener('click', () => this.sample._toggleChromaticMode());

        // Sample tabs
        document.querySelectorAll('.sample-tab').forEach(tab => {
            tab.addEventListener('click', () => this.sample._switchSampleTab(tab.dataset.tab));
        });

        // ENV panel: mini sliders for pitch/volume
        $('pad-pitch').addEventListener('input', () => this.sample._updatePadEnv());
        $('pad-volume').addEventListener('input', () => this.sample._updatePadEnv());

        // ENV panel: canvas envelope editor
        this.sample._initEnvEditor();

        // FILT panel
        $('pad-filter-toggle').addEventListener('click', () => this.sample._togglePadFilter());
        $('pad-filter-type').addEventListener('change', () => this.sample._updatePadFilter());
        $('pad-filter-freq').addEventListener('input', () => this.sample._updatePadFilter());
        $('pad-filter-q').addEventListener('input', () => this.sample._updatePadFilter());

        // LFO panel
        $('pad-lfo-toggle').addEventListener('click', () => this.sample._togglePadLfo());
        $('pad-lfo-target').addEventListener('change', () => this.sample._updatePadLfo());
        $('pad-lfo-rate').addEventListener('input', () => this.sample._updatePadLfo());
        $('pad-lfo-depth').addEventListener('input', () => this.sample._updatePadLfo());
        $('pad-lfo-shape').addEventListener('change', () => this.sample._updatePadLfo());

        // MORPH panel
        $('morph-target').addEventListener('change', () => this.sample._updateMorphConfig());
        $('morph-type').addEventListener('change', () => this.sample._updateMorphConfig());
        $('morph-amount').addEventListener('input', () => {
            document.getElementById('morph-amount-val').textContent = document.getElementById('morph-amount').value + '%';
            this.sample._updateMorphConfig();
        });
        $('seq-play-btn').addEventListener('click', () => this.seq.seqPlayStop());
        $('seq-rec-btn').addEventListener('click', () => this.seq.seqToggleRecord());
        $('seq-undo-btn').addEventListener('click', () => this.seq.seqLooperUndo());
        $('bpm-down').addEventListener('click', () => this.seq.seqAdjustBpm(-1));
        $('bpm-up').addEventListener('click', () => this.seq.seqAdjustBpm(1));
        $('bpm-display').addEventListener('click', () => this.seq.seqEditBpm());
        $('tap-tempo-btn').addEventListener('click', () => this.seq.seqTapTempo());
        $('seq-rev-btn').addEventListener('click', () => {
            this.sequencer.reverse = !this.sequencer.reverse;
            document.getElementById('seq-rev-btn').classList.toggle('rev-on', this.sequencer.reverse);
            this.seq._saveSeqPattern();
        });
        $('seq-speed-btn').addEventListener('click', () => {
            const speeds = [0.5, 1, 2, 4];
            const idx = speeds.indexOf(this.sequencer.speed);
            this.sequencer.speed = speeds[(idx + 1) % speeds.length];
            document.getElementById('seq-speed-btn').textContent = this.sequencer.speed + 'x';
            this.seq._saveSeqPattern();
        });
        $('seq-random-btn').addEventListener('click', () => this.seq.seqRandomise());
        $('seq-stutter-btn').addEventListener('click', () => this.seq.seqStutter());
        $('seq-stutter-amount').addEventListener('input', (e) => {
            this.sequencer.stutterAmount = parseInt(e.target.value) / 100;
        });
        $('seq-mutate-btn').addEventListener('click', () => this.seq.seqToggleMutate());
        $('seq-mutate-amount').addEventListener('input', (e) => {
            this.sequencer.mutateAmount = parseInt(e.target.value) / 100;
        });
        $('seq-bounce-btn').addEventListener('click', () => this.seq.seqBounce());
        $('seq-clear-btn').addEventListener('click', () => this.seq.seqClear());
        $('seq-step-count').addEventListener('change', (e) => {
            const n = parseInt(e.target.value);
            this.sequencer.setStepCount(n);
            this.buildSlotGrid();
            this.seq.renderSeqGrid();
            this.seq._saveSeqPattern();
        });

        // Step mode menu (mode/direction buttons only; per-slot pitch is in the picker)
        document.getElementById('step-mode-menu').addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.mode) this.seq._setStepMode(btn.dataset.mode);
            if (btn.dataset.dir) this.seq._setStepDirection(btn.dataset.dir);
        });

        // Undo/redo
        $('undo-btn').addEventListener('click', () => this.rec.undo());
        $('redo-btn').addEventListener('click', () => this.rec.redo());

        // Zoom
        $('zoom-in').addEventListener('click', () => {
            if (this._seqMode) {
                this.seq._seqPreviewBank(1);
                return;
            }
            if (this._sampleMode && this.sample._chromaticMode) {
                this.sample._chromaticOctaveSpan = Math.min(7, this.sample._chromaticOctaveSpan + 1);
                this.sample._renderPianoKeyboard();
                return;
            }
            this.waveform.setZoom(this.waveform.getZoom() * 1.5);
            this.waveform.render();
        });
        $('zoom-out').addEventListener('click', () => {
            if (this._seqMode) {
                this.seq._seqPreviewBank(-1);
                return;
            }
            if (this._sampleMode && this.sample._chromaticMode) {
                this.sample._chromaticOctaveSpan = Math.max(1, this.sample._chromaticOctaveSpan - 1);
                this.sample._renderPianoKeyboard();
                return;
            }
            this.waveform.setZoom(this.waveform.getZoom() / 1.5);
            this.waveform.render();
        });
        $('zoom-fit').addEventListener('click', () => {
            if (this._seqMode) {
                this.seq._seqConfirmBank();
                return;
            }
            this.waveform.setZoom(1);
            this.waveform.setScrollOffset(0);
            this.waveform.render();
        });
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
        this.rec.cancelAnimationLoop();
        if (this.sequencer && this.sequencer.playing) {
            this.sequencer.stop();
            this.seq._seqStopAnimation();
        }

        // Exit kit mode if active
        if (this._kitMode) this._exitKitMode();

        // Clear all slots (including kit sub-slots)
        for (let i = 0; i < 16; i++) {
            if (this.slots.slots[i].type === 'kit') {
                await this.slots.clearAllKitSlots(i);
                delete this.slots.kitSlots[i];
                this.slots.slots[i].type = 'normal';
                try { localStorage.removeItem('soniphorm-kit-pads-' + i); } catch (e) {}
                try { localStorage.removeItem('soniphorm-gen-zones-' + i); } catch (e) {}
            }
            await this.slots.clearSlot(i);
        }

        // Clear sequencer
        if (this.sequencer) {
            this.sequencer.clearPattern();
            this.sequencer.setBpm(120);
            this.sequencer.mutateEnabled = false;
            this.sequencer.stutterEnabled = false;
            this.seq._seqPreMutatePattern = null;
            this.seq._seqStutterSlots.clear();
            this.seq._seqMutateSlots.clear();
            this._slotBuffers = {};
            this.seq._saveSeqPattern();
        }

        // Clear sampler
        if (this.sampler) {
            this.sampler.stopAll();
            this.sampler.invalidateMorphCache();
            for (let i = 0; i < 16; i++) {
                Object.assign(this.sampler.pads[i], Sampler.defaultPad());
            }
            this.sample._saveSamplerConfig();
        }

        // Clear gen sensors
        if (this.genCtrl) {
            this.genCtrl._genClearAllSensors();
        }

        // Clear app state
        this.channels = null;
        this.clipboard = null;
        this.undoStack = [];
        this.redoStack = [];

        // Reset UI
        this.waveform.clear();
        document.getElementById('waveform-empty').hidden = false;
        const _pb = document.getElementById('play-btn'); _pb.classList.remove('playing'); _pb.innerHTML = '&#9654; PLAY';
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

        document.getElementById('rec-btn').disabled = false;
        document.getElementById('play-btn').disabled = !hasAudio;
        document.getElementById('loop-btn').disabled = !hasAudio;
        document.getElementById('trim-btn').disabled = !hasSel;
        document.getElementById('reverse-btn').disabled = !hasAudio;
        document.getElementById('norm-btn').disabled = !hasAudio;
        document.getElementById('process-btn').disabled = !hasAudio;
        document.getElementById('save-btn').disabled = !hasAudio;
        document.getElementById('load-btn').disabled = false;

        // FX buttons (process bar + sample FX panel)
        document.querySelectorAll('.fx-btn').forEach(btn => {
            btn.disabled = !hasAudio;
        });

        const hasMultiSlot = this.slots.slots.filter(s => s.hasAudio).length >= 2;
        document.getElementById('sample-cross-btn').disabled = !hasAudio;
        document.getElementById('sample-layer-btn').disabled = !hasMultiSlot;
        document.getElementById('sample-bounce-btn').disabled = !hasAudio;

        this.rec.updateUndoCount();
    }

    _showWaveformMenu(x, y) {
        const menu = document.getElementById('waveform-menu');
        const hasSel = !!this.waveform.getSelection();
        const hasAudio = !!this.channels;
        const hasMulti = this.slots.slots.filter(s => s.hasAudio).length >= 2;
        menu.querySelector('[data-wfm="cut"]').hidden     = !hasSel;
        menu.querySelector('[data-wfm="copy"]').hidden    = !hasSel;
        menu.querySelector('[data-wfm="paste"]').hidden   = !this.clipboard;
        menu.querySelector('[data-wfm="silence"]').hidden = !hasSel;
        menu.querySelector('[data-wfm="fadein"]').hidden  = !hasAudio;
        menu.querySelector('[data-wfm="fadeout"]').hidden = !hasAudio;
        menu.querySelector('[data-wfm="cross"]').hidden   = !hasAudio;
        menu.querySelector('[data-wfm="layer"]').hidden   = !hasMulti;
        menu.querySelector('[data-wfm="bounce"]').hidden  = !hasAudio;
        menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
        menu.style.top  = Math.min(y, window.innerHeight - 240) + 'px';
        menu.hidden = false;
    }

    // === Mode Switching ===

    async switchMode(mode) {
        await this.ensureAudioInit();

        // Stop rec-mode playback when leaving rec mode
        if (!this._seqMode && !this._sampleMode) {
            this.rec.stopAudio();
        }

        // Exit current mode
        if (this._seqMode) {
            this.seq.exit(mode);
        }
        if (this._genMode) {
            this.genCtrl.exit();
        }
        if (this._sampleMode) {
            this.sample.exit(mode);
        }

        // Enter new mode
        if (mode === 'seq') {
            await this.seq.enter();
        } else if (mode === 'sample') {
            await this.sample.enter();
        } else if (mode === 'gen') {
            await this.genCtrl.enter();
        } else {
            // rec mode — rebuild grid (seq mode may have >16 slots)
            if (this._kitMode) {
                this._buildKitGrid();
                this._renderKitGrid();
            } else {
                this.buildSlotGrid();
                this.renderSlotGrid();
            }
        }

        // Apply slot live effects so the bus has the correct chain active
        this.rec._applySlotLiveEffects();

        // Update toggle buttons
        document.getElementById('mode-rec').classList.toggle('active', mode === 'rec');
        document.getElementById('mode-sample').classList.toggle('active', mode === 'sample');
        document.getElementById('mode-seq').classList.toggle('active', mode === 'seq');
        document.getElementById('mode-gen').classList.toggle('active', mode === 'gen');

        // Show/hide transport bars and toolbar
        document.getElementById('seq-transport').classList.toggle('active', mode === 'seq' || (mode === 'sample' && this._seqShowTransportInSample));
        document.getElementById('sample-transport').classList.toggle('active', mode === 'sample');
        document.getElementById('gen-transport').classList.toggle('active', mode === 'gen');
        document.getElementById('slot-grid').classList.toggle('seq-mode', mode === 'seq');
        document.getElementById('slot-grid').classList.toggle('sample-mode', mode === 'sample');
        document.getElementById('slot-grid').classList.toggle('gen-mode', mode === 'gen');
        document.getElementById('toolbar').classList.toggle('sample-mode', mode === 'sample');
        document.getElementById('toolbar').classList.toggle('seq-mode', mode === 'seq');
        document.getElementById('toolbar').classList.toggle('gen-mode', mode === 'gen');

        // Header title
        if (this._kitMode) {
            const kitName = this.slots.slots[this._kitParentSlot].name || 'Kit';
            document.querySelector('.header-title').textContent = 'KIT: ' + kitName;
        } else {
            const titles = { rec: 'SONICRAFT', sample: 'SAMPLER', seq: 'SEQUENCER', gen: 'GENERATIVE' };
            document.querySelector('.header-title').textContent = titles[mode];
        }

        // Show drum grid toggle button in SEQ mode when in kit mode
        document.getElementById('seq-drum-grid-btn').hidden = !(mode === 'seq' && this._kitMode);

        // Zones button visibility is handled by genCtrl.enter() (after auto-kit-mode-entry)
        if (mode !== 'gen') document.getElementById('gen-zones-btn').hidden = true;

        // Maintain kit-mode class on slot grid
        if (this._kitMode) {
            document.getElementById('slot-grid').classList.add('kit-mode');
        }

        // Update sample transport after panel is visible (canvas needs dimensions)
        if (mode === 'sample') {
            this.sample._updateSampleTransport();
        }

        // Recalculate waveform canvas after flex layout changes (fixes centrepoint shift
        // when returning to rec mode after chromatic keyboard changed canvas dimensions)
        if (mode === 'rec' && this.waveform) {
            requestAnimationFrame(() => {
                this.waveform.resize();
            });
        }
    }

    // === MIDI ===

    async _initMidi() {
        if (typeof MidiManager === 'undefined') return;
        this.midi = new MidiManager();

        this.midi.onNoteOn = (note, velocity) => this._midiNoteOn(note, velocity);
        this.midi.onNoteOff = (note) => this._midiNoteOff(note);
        this.midi.onCC = (cc, value, mapping) => this._midiCC(cc, value, mapping);
        this.midi.onClockStart = () => {
            if (!this.sequencer.playing) this.seq.seqPlayStop();
        };
        this.midi.onClockStop = () => {
            if (this.sequencer.playing) this.seq.seqPlayStop();
        };
        this.midi.onBpmEstimate = (bpm) => {
            if (this.midi.clockMode === 'receive') {
                this.sequencer.setBpm(bpm);
                document.getElementById('bpm-display').textContent = bpm;
            }
        };
        this.midi.onPortsChanged = () => this._refreshMidiPortUI();
        this.midi.onLearnComplete = (target, cc) => {
            const indicator = document.getElementById('midi-indicator');
            if (indicator) indicator.classList.remove('midi-learning');
        };
        this.midi.onLearnCancel = () => {
            const indicator = document.getElementById('midi-indicator');
            if (indicator) indicator.classList.remove('midi-learning');
        };

        const ok = await this.midi.init();
        const indicator = document.getElementById('midi-indicator');
        if (ok && indicator) {
            indicator.hidden = false;
            if (this.midi.activeInput || this.midi.activeOutput) {
                indicator.classList.add('midi-active');
            }
        }

        // Wire MIDI settings controls
        const inSel = document.getElementById('midi-input-select');
        const outSel = document.getElementById('midi-output-select');
        const chSel = document.getElementById('midi-channel-select');
        const outChSel = document.getElementById('midi-out-channel-select');
        const clkSel = document.getElementById('midi-clock-select');

        if (inSel) inSel.addEventListener('change', () => {
            this.midi.selectInput(inSel.value);
            this._updateMidiIndicator();
        });
        if (outSel) outSel.addEventListener('change', () => {
            this.midi.selectOutput(outSel.value);
            this._updateMidiIndicator();
        });
        if (chSel) {
            chSel.value = this.midi.channel;
            chSel.addEventListener('change', () => {
                this.midi.channel = parseInt(chSel.value);
                this.midi._saveSettings();
            });
        }
        if (outChSel) {
            outChSel.value = this.midi.outChannel;
            outChSel.addEventListener('change', () => {
                this.midi.outChannel = parseInt(outChSel.value);
                this.midi._saveSettings();
            });
        }
        if (clkSel) {
            clkSel.value = this.midi.clockMode;
            clkSel.addEventListener('change', () => {
                this.midi.clockMode = clkSel.value;
                this.midi._saveSettings();
            });
        }

        this._refreshMidiPortUI();
    }

    _updateMidiIndicator() {
        const indicator = document.getElementById('midi-indicator');
        if (!indicator || !this.midi) return;
        indicator.classList.toggle('midi-active', !!(this.midi.activeInput || this.midi.activeOutput));
    }

    _midiNoteOn(midiNote, velocity) {
        if (!this.sampler) return;
        this.ensureAudioInit();
        const padIdx = this.sample._sampleSelectedPad;

        if (this._sampleMode && this.sample._chromaticMode) {
            // Chromatic mode: play at MIDI pitch + pad pitch as transpose
            const pad = this.sampler.pads[padIdx];
            const semitones = (midiNote - 60) + pad.pitch;
            const voiceKey = 'midi-' + midiNote;
            if (this._kitMode) {
                const meta = this.slots.getKitSlotMeta(this._kitParentSlot, padIdx);
                if (!meta || !meta.hasAudio) return;
            } else {
                if (!this.slots.slots[padIdx].hasAudio) return;
            }
            this.sampler.triggerPoly(padIdx, semitones, voiceKey);
            this._midiHeldNotes.set(midiNote, voiceKey);
            if (this._seqRecording && this.sequencer.playing) {
                this.seq._recordPadToStep(padIdx, midiNote - 60, voiceKey);
            }
        } else if (this._sampleMode || (this._seqMode && this._seqRecording)) {
            // Pad mode: notes 36-51 map to pads 0-15 (GM drum / kit sub-pads)
            const padMap = midiNote - 36;
            if (padMap < 0 || padMap > 15) return;
            if (this._kitMode) {
                const meta = this.slots.getKitSlotMeta(this._kitParentSlot, padMap);
                if (!meta || !meta.hasAudio) return;
            } else {
                if (!this.slots.slots[padMap].hasAudio) return;
            }
            this.sampler.trigger(padMap);
            if (this._seqRecording && this.sequencer.playing) {
                this.seq._recordPadToStep(padMap, undefined, 'midi-pad-' + padMap);
            }
        }
    }

    _midiNoteOff(midiNote) {
        if (!this.sampler) return;
        const padIdx = this.sample._sampleSelectedPad;

        if (this._sampleMode && this.sample._chromaticMode) {
            const voiceKey = this._midiHeldNotes.get(midiNote);
            if (voiceKey) {
                const pad = this.sampler.pads[padIdx];
                this.sampler.releasePoly(voiceKey, pad.release);
                if (this.sampler.onRelease) this.sampler.onRelease(padIdx);
                this._midiHeldNotes.delete(midiNote);
                if (this._seqRecording && this.sequencer.playing) {
                    this.seq._recordNoteOff(voiceKey);
                }
            }
        } else if (this._sampleMode || (this._seqMode && this._seqRecording)) {
            const padMap = midiNote - 36;
            if (padMap < 0 || padMap > 15) return;
            this.sampler.release(padMap);
            if (this._seqRecording && this.sequencer.playing) {
                this.seq._recordNoteOff('midi-pad-' + padMap);
            }
        }
    }

    _midiCC(cc, value, mapping) {
        // CC handling (macros removed)
    }

    _midiSendStep(stepIndex, time) {
        if (!this.midi || !this.midi.activeOutput) return;
        const step = this.sequencer.pattern[stepIndex];
        if (!step) return;
        const now = this.sequencer.audioContext.currentTime;
        const delayMs = Math.max(0, (time - now) * 1000);

        // Send clock ticks if in send mode (6 ticks per step = 24 PPQ at 1/16 resolution)
        if (this.midi.clockMode === 'send') {
            const stepMs = this.sequencer.stepDuration * 1000;
            for (let t = 0; t < 6; t++) {
                setTimeout(() => this.midi.sendClockTick(), delayMs + (t * stepMs / 6));
            }
        }

        // Send note events for each entry in the step
        for (const entry of step.slots) {
            if (this.sequencer.shouldPlaySlot && !this.sequencer.shouldPlaySlot(entry.slot)) continue;

            let note, vel, ch;
            if (entry.kitSub !== undefined) {
                // Kit sub-slot: use GM drum mapping
                note = 36 + entry.kitSub;
                const pad = this.sampler ? this.sampler.pads[entry.kitSub] : null;
                vel = entry.velocity !== undefined ? entry.velocity : Math.max(1, Math.min(127, Math.round((pad ? pad.volume : 1) * 127)));
                ch = entry.slot & 0x0F;
            } else {
                const pad = this.sampler ? this.sampler.pads[entry.slot] : null;
                const baseMidi = 36 + entry.slot;
                const pitchOffset = entry.pitch + (pad ? pad.pitch : 0);
                note = Math.max(0, Math.min(127, baseMidi + pitchOffset));
                vel = Math.max(1, Math.min(127, Math.round((pad ? pad.volume : 1) * 127)));
                ch = entry.slot & 0x0F; // slot 0-15 → MIDI channel 1-16
            }

            // Note duration: use entry.duration if set, otherwise one step
            const durSteps = (entry.duration > 0) ? entry.duration : 1;
            const durMs = durSteps * this.sequencer.stepDuration * 1000;

            setTimeout(() => this.midi.sendNoteOn(note, vel, ch), delayMs);
            setTimeout(() => this.midi.sendNoteOff(note, ch), delayMs + durMs - 5);
        }
    }

    _refreshMidiPortUI() {
        if (!this.midi) return;
        const inSel = document.getElementById('midi-input-select');
        const outSel = document.getElementById('midi-output-select');
        if (inSel) {
            const curVal = inSel.value;
            inSel.innerHTML = '<option value="">None</option>';
            for (const p of this.midi.inputs) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                inSel.appendChild(opt);
            }
            inSel.value = (this.midi.activeInput ? this.midi.activeInput.id : '') || curVal || '';
        }
        if (outSel) {
            const curVal = outSel.value;
            outSel.innerHTML = '<option value="">None</option>';
            for (const p of this.midi.outputs) {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                outSel.appendChild(opt);
            }
            outSel.value = (this.midi.activeOutput ? this.midi.activeOutput.id : '') || curVal || '';
        }
        const chSel = document.getElementById('midi-channel-select');
        if (chSel) chSel.value = this.midi.channel;
        const outChSel = document.getElementById('midi-out-channel-select');
        if (outChSel) outChSel.value = this.midi.outChannel;
        const clkSel = document.getElementById('midi-clock-select');
        if (clkSel) clkSel.value = this.midi.clockMode;
    }

    // Persistence
    // === Kit Mode ===

    static get GM_NOTE_NAMES() {
        return ['C2','C#2','D2','D#2','E2','F2','F#2','G2','G#2','A2','A#2','B2','C3','C#3','D3','D#3'];
    }

    async _enterKitMode(slotIndex) {
        this._kitMode = true;
        this._kitParentSlot = slotIndex;
        this._kitSelectedSub = 0;
        this._kitSlotBuffers = {};

        // Preload kit sub-slot audio buffers
        await this._preloadKitBuffers(slotIndex);

        // Swap sampler to use kit buffers
        this.sampler.getSlotBuffer = (subIndex) => {
            return this._kitSlotBuffers[subIndex] || null;
        };

        // Load kit pad config
        this._loadKitPadConfig(slotIndex);

        // Wire sampler audio context if already initialised
        if (this.audio.audioContext) {
            this.sampler.audioContext = this.audio.audioContext;
            this.sampler.outputNode = this.audio.getEffectsBus();
        }

        // Show back button + PAD PLAY in toolbar
        document.getElementById('kit-back-btn').hidden = false;
        document.getElementById('kit-play-btn').hidden = false;
        document.getElementById('kit-play-sep').hidden = false;
        this._kitPlayMode = false;
        document.getElementById('kit-play-btn').classList.remove('active');

        // Update header
        const kitName = this.slots.slots[slotIndex].name || 'Kit';
        document.querySelector('.header-title').textContent = 'KIT: ' + kitName;

        // Add kit-mode class to slot grid
        document.getElementById('slot-grid').classList.add('kit-mode');

        // Rebuild and render the grid for kit sub-slots
        this._buildKitGrid();
        this._renderKitGrid();
    }

    _exitKitMode() {
        this._kitMode = false;
        this._kitParentSlot = -1;
        this._kitSlotBuffers = {};
        this._drumGridView = false;

        // Hide back button + PAD PLAY in toolbar
        document.getElementById('kit-back-btn').hidden = true;
        document.getElementById('kit-play-btn').hidden = true;
        document.getElementById('kit-play-sep').hidden = true;
        this._kitPlayMode = false;

        // Hide drum grid if visible
        document.getElementById('drum-grid').hidden = true;
        this._drumGridView = false;
        document.getElementById('seq-drum-grid-btn').hidden = true;

        // Remove kit-mode class
        document.getElementById('slot-grid').classList.remove('kit-mode');

        // Restore sampler buffer callback to normal
        this.sampler.getSlotBuffer = (slotIndex) => {
            return this._slotBuffers[slotIndex] || null;
        };

        // Reload normal sampler config
        this.sample._loadSamplerConfig();

        // Return to REC mode view
        this.switchMode('rec');
    }

    async _preloadKitBuffers(parentSlot) {
        for (let j = 0; j < 16; j++) {
            const meta = this.slots.getKitSlotMeta(parentSlot, j);
            if (meta && meta.hasAudio) {
                try {
                    const data = await this.slots.getKitSlotAudio(parentSlot, j);
                    if (data && this.audio.audioContext) {
                        const buf = this.audio.audioContext.createBuffer(
                            data.channels.length,
                            data.channels[0].length,
                            data.sampleRate
                        );
                        for (let ch = 0; ch < data.channels.length; ch++) {
                            buf.getChannelData(ch).set(data.channels[ch]);
                        }
                        this._kitSlotBuffers[j] = buf;
                    }
                } catch (e) {
                    console.warn('Failed to preload kit slot', parentSlot, j, e);
                }
            }
        }
    }

    _buildKitGrid() {
        const grid = document.getElementById('slot-grid');
        grid.innerHTML = '';

        for (let i = 0; i < 16; i++) {
            const el = document.createElement('div');
            el.className = 'slot';
            el.dataset.index = i;
            el.dataset.bank = Math.floor(i / 4);

            el.innerHTML = `
                <span class="slot-number">${App.GM_NOTE_NAMES[i]}</span>
                <span class="slot-name empty">empty</span>
                <div class="slot-mini"><canvas></canvas></div>
            `;

            // Touch/mouse handling for kit sub-pads
            let usedTouch = false;
            let longPressTimer = null;

            // PAD PLAY mode: immediate trigger on pointerdown with velocity
            el.addEventListener('pointerdown', (e) => {
                if (!this._kitPlayMode || this._sampleMode || this._seqMode) return;
                const meta = this.slots.getKitSlotMeta(this._kitParentSlot, i);
                if (!meta || !meta.hasAudio) return;
                e.preventDefault();
                // Velocity: prefer real pressure, fall back to contact area proxy
                let vel;
                if (e.pressure > 0 && e.pressure !== 0.5) {
                    vel = Math.max(0.1, e.pressure);
                } else {
                    const area = (e.width || 1) * (e.height || 1);
                    vel = area > 4 ? Math.min(1, Math.max(0.15, area / 400)) : 0.8;
                }
                // Trigger — resume context first if suspended (Android Chrome may suspend it)
                const ctx = this.sampler.audioContext;
                if (ctx && ctx.state === 'suspended') {
                    ctx.resume().then(() => this.sampler.trigger(i, vel));
                } else {
                    this.sampler.trigger(i, vel);
                }
                el.classList.add('kit-triggered');
                setTimeout(() => el.classList.remove('kit-triggered'), 80);
            });

            el.addEventListener('click', (e) => {
                if (this._kitPlayMode && !this._sampleMode && !this._seqMode) return; // handled by pointerdown
                if (this._sampleMode) return;
                if (this._seqMode) {
                    this.seq.seqStepTap(i);
                    return;
                }
                this._onKitSlotTap(i);
            });

            el.addEventListener('contextmenu', (e) => this.onSlotContext(i, e));

            el.addEventListener('mousedown', (e) => {
                if (usedTouch) return;
                if (this._sampleMode && e.button === 0) this.sample.samplePadTap(i);
            });
            el.addEventListener('mouseup', () => {
                if (usedTouch) return;
                if (this._sampleMode) this.sample.samplePadRelease(i);
            });
            el.addEventListener('mouseleave', () => {
                if (usedTouch) return;
                if (this._sampleMode) this.sample.samplePadRelease(i);
            });
            el.addEventListener('touchstart', (e) => {
                usedTouch = true;
                if (this._sampleMode) {
                    e.preventDefault();
                    this.sample.samplePadTap(i);
                } else {
                    // Long-press for context menu on iOS
                    const touch = e.touches[0];
                    longPressTimer = setTimeout(() => {
                        longPressTimer = null;
                        this.onSlotContext(i, { preventDefault: () => {}, clientX: touch.clientX, clientY: touch.clientY });
                    }, 500);
                }
            });
            el.addEventListener('touchmove', () => {
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            });
            el.addEventListener('touchend', (e) => {
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                if (this._sampleMode) {
                    e.preventDefault();
                    this.sample.samplePadRelease(i);
                }
                setTimeout(() => { usedTouch = false; }, 400);
            });
            el.addEventListener('touchcancel', () => {
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                if (this._sampleMode) this.sample.samplePadRelease(i);
                setTimeout(() => { usedTouch = false; }, 400);
            });

            grid.appendChild(el);
        }
    }

    _renderKitGrid() {
        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');

        slotEls.forEach((el, i) => {
            const meta = this.slots.getKitSlotMeta(this._kitParentSlot, i);
            const nameEl = el.querySelector('.slot-name');
            if (meta && meta.hasAudio) {
                nameEl.textContent = meta.name || 'untitled';
                nameEl.className = 'slot-name';
            } else {
                nameEl.textContent = 'empty';
                nameEl.className = 'slot-name empty';
            }

            const numEl = el.querySelector('.slot-number');
            numEl.textContent = App.GM_NOTE_NAMES[i];

            el.className = 'slot';
            el.dataset.bank = Math.floor(i / 4);

            if (i === this._kitSelectedSub) el.classList.add('pad-selected');

            // Draw mini waveform
            const miniCanvas = el.querySelector('.slot-mini canvas');
            if (meta && meta.hasAudio && meta.peaks) {
                const isSelected = i === this._kitSelectedSub;
                const color = isSelected ? 'rgba(255,255,255,0.8)' : 'rgba(14,165,233,0.6)';
                WaveformRenderer.drawMiniFromPeaks(miniCanvas, meta.peaks, color);
            } else {
                const ctx = miniCanvas.getContext('2d');
                miniCanvas.width = miniCanvas.clientWidth;
                miniCanvas.height = miniCanvas.clientHeight;
                ctx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
            }

            // Add key label in sample mode
            if (this._sampleMode) {
                let keyEl = el.querySelector('.pad-key-label');
                if (!keyEl) {
                    keyEl = document.createElement('span');
                    keyEl.className = 'pad-key-label';
                    el.appendChild(keyEl);
                }
                keyEl.textContent = this.sampler.keyLabels[i];
            }
        });
    }

    async _onKitSlotTap(subIndex) {
        await this.ensureAudioInit();

        // If recording is active, tapping any kit pad stops the recording
        if (this.recordingSlotIndex >= 0) {
            await this.rec.stopRecording();
            return;
        }

        // If a waveform selection exists and target sub-slot is empty, copy region
        const meta = this.slots.getKitSlotMeta(this._kitParentSlot, subIndex);
        if (!meta?.hasAudio && this.channels && this.waveform.getSelection()) {
            const sel = this.waveform.getSelection();
            if (sel && confirm(`Copy selection to kit pad ${subIndex + 1}?`)) {
                const copied = this.channels.map(ch => ch.slice(sel.start, sel.end));
                await this.slots.saveKitSlotAudio(this._kitParentSlot, subIndex, copied, this.bufferSampleRate);

                // Decode buffer for sampler
                const ctx = this.audio.audioContext;
                const buf = ctx.createBuffer(copied.length, copied[0].length, this.bufferSampleRate);
                for (let ch = 0; ch < copied.length; ch++) {
                    buf.getChannelData(ch).set(copied[ch]);
                }
                this._kitSlotBuffers[subIndex] = buf;

                // Show the copied audio in waveform & prompt rename
                this._kitSelectedSub = subIndex;
                this.channels = copied;
                this.waveform.setAudio(this.channels, this.bufferSampleRate);
                document.getElementById('waveform-empty').hidden = true;
                this._showKitSlotRenameDialog(this._kitParentSlot, subIndex);
                this._renderKitGrid();
                this.updateTransportInfo();
                this.updateToolbarState();
                return;
            }
        }

        // If already selected and has audio, toggle play/stop
        if (subIndex === this._kitSelectedSub && meta?.hasAudio && this.channels) {
            if (this.audio.isPlaying) {
                this.rec.stopAudio();
            } else {
                this.rec.playAudio(true);
            }
            return;
        }

        this._kitSelectedSub = subIndex;

        if (meta && meta.hasAudio) {
            this.audio.stop();
            this.rec.cancelAnimationLoop();
            const data = await this.slots.getKitSlotAudio(this._kitParentSlot, subIndex);
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

        this._renderKitGrid();
        this.updateTransportInfo();
        this.updateToolbarState();
    }

    _showKitSlotRenameDialog(parentSlot, subIndex) {
        const dialog = document.getElementById('rename-dialog');
        const input = document.getElementById('rename-input');
        const meta = this.slots.getKitSlotMeta(parentSlot, subIndex);
        dialog._slotIndex = subIndex;
        dialog._kitParentSlot = parentSlot;
        dialog._isKitSlot = true;
        input.value = (meta && meta.name) || '';
        dialog.hidden = false;
        setTimeout(() => input.focus(), 50);
    }

    async _saveKitSlotToDevice(parentSlot, subIndex) {
        const data = await this.slots.getKitSlotAudio(parentSlot, subIndex);
        if (!data) return;
        const blob = AudioEngine.encodeWAV(data.channels, data.sampleRate);
        const meta = this.slots.getKitSlotMeta(parentSlot, subIndex);
        const name = (meta && meta.name) || 'kit-sample';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `soniphorm-${name}-${timestamp}.wav`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    _loadKitPadConfig(parentSlot) {
        try {
            const json = localStorage.getItem('soniphorm-kit-pads-' + parentSlot);
            if (json) {
                this.sampler.fromJSON(JSON.parse(json));
            } else {
                // Reset to defaults
                for (let i = 0; i < 16; i++) {
                    this.sampler.pads[i] = Sampler.defaultPad();
                }
            }
        } catch (e) {
            console.warn('Failed to load kit pad config:', e);
        }
    }

    _saveKitPadConfig() {
        if (!this._kitMode) return;
        try {
            localStorage.setItem('soniphorm-kit-pads-' + this._kitParentSlot, JSON.stringify(this.sampler.toJSON()));
        } catch (e) {
            console.warn('Failed to save kit pad config:', e);
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
