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
        this._resampleTargetSlot = -1;
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
    }

    async init() {
        // Create controllers first (UI binding needs them)
        this.rec = new RecController(this);
        this.seq = new SeqController(this);
        this.sample = new SampleController(this);
        this.seq._initSequencer();
        this.sample._initSampler();
        this._initMidi();
        this._initDmx();
        this._initDevice();

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
            });
        } catch (e) {
            console.error('Waveform init failed:', e);
        }

        // Load persisted slot data from IndexedDB
        try {
            await this.slots.init();
            this.slots.onChange = () => this.renderSlotGrid();
            this._restoreDeviceSlotState(); // device-recording markers live in localStorage, not IndexedDB -- must run after slots exist
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

    // Shared start/stop for both recording sources -- every existing gesture (toolbar
    // REC button toggle, tapping the currently-recording slot to stop, tapping a
    // selected empty slot to start) routes through these two so device recording
    // shows up exactly like local mic recording: same recordingSlotIndex bookkeeping,
    // same slot highlight, same rename-on-finish -- just a different backend.
    async _beginRecording(index) {
        if (this.device && this.device.isConnected()) {
            // _deviceInMscMode survives a page refresh (persisted to localStorage) --
            // catch this before wasting a 2s watchdog timeout on it. A device in MSC
            // mode is running runMscMode()'s minimal loop, which recognizes only
            // "MSCMODE OFF" and silently ignores everything else, including RECBTN.
            if (this._deviceInMscMode) {
                alert('SCM is in mass storage mode -- exit it first (device menu > "Exit mass storage mode...") before recording.');
                return;
            }
            this.recordingSlotIndex = index;
            document.getElementById('waveform-empty').hidden = true;
            document.getElementById('rec-btn').classList.add('recording');
            this.renderSlotGrid();
            this._armDeviceRecordWatchdog();
            try {
                await this.device.toggleRecord();
            } catch (err) {
                this._clearDeviceRecordWatchdog();
                this.recordingSlotIndex = -1;
                document.getElementById('rec-btn').classList.remove('recording');
                this.renderSlotGrid();
                alert('Device record failed: ' + err.message);
            }
            return;
        }
        await this.rec.startRecording(index);
    }

    async _endRecording() {
        if (this.device && this.device.isConnected() && this.recordingSlotIndex >= 0) {
            this._armDeviceRecordWatchdog();
            try {
                await this.device.toggleRecord();
            } catch (err) {
                this._clearDeviceRecordWatchdog();
                alert('Device record failed: ' + err.message);
            }
            return;
        }
        await this.rec.stopRecording();
    }

    // Shared by both play triggers (toolbar Play button, tapping a device-recorded
    // slot). Remembers which slot so _handleDeviceState's 'playing' case can draw
    // that slot's placeholder waveform in the main viewer -- same reused peaks
    // data as the mini slot canvas, just not accumulated live since it's already
    // complete by playback time.
    _playDeviceSlot(index, slot) {
        this._devicePlayingSlot = index;
        const p = slot._devicePath ? this.device.playFile(slot._devicePath) : this.device.play();
        p.catch(err => alert('Playback failed: ' + err.message));
    }

    // Every RECBTN send arms this. Cleared the instant ANY parsed line arrives
    // (see _handleDeviceState) -- REC_STATE, REC ERR/WARN, busy, meter, whatever --
    // since receiving literally anything proves the firmware is alive and responding.
    // If nothing arrives at all within the timeout, the most likely explanation is
    // there's no AudioRecorder module in the currently loaded patch at all: the
    // firmware's RECBTN handler only acts (and only ever prints REC_STATE/REC ERR/
    // REC WARN/etc.) from *inside* its per-module AudioRecorder loop, so with no such
    // module present, sending RECBTN produces zero output whatsoever -- the two
    // silent-rejection bugs already fixed this session (no SD card, triggerMode=1)
    // both lived one level deeper than that and still printed *something*. This is
    // the general catch-all for "nothing happens, nothing anywhere says why."
    _armDeviceRecordWatchdog() {
        this._clearDeviceRecordWatchdog();
        this._deviceRecordWatchdog = setTimeout(() => {
            this._deviceRecordWatchdog = null;
            this._deviceRecordingActive = false;
            this.recordingSlotIndex = -1;
            document.getElementById('rec-btn').classList.remove('recording');
            document.getElementById('device-level-meter').hidden = true;
            this.device.disableMeter().catch(() => {});
            this.renderSlotGrid();
            alert('SCM: no response to record command (2s timeout). Most likely cause: no AudioRecorder module in the currently loaded patch, or the device is in mass storage mode. Could also mean the connection dropped.');
        }, 2000);
    }

    _clearDeviceRecordWatchdog() {
        if (this._deviceRecordWatchdog) {
            clearTimeout(this._deviceRecordWatchdog);
            this._deviceRecordWatchdog = null;
        }
    }

    // Like slots.findEmptySlot(), but also skips slots holding a device recording --
    // findEmptySlot() only knows about hasAudio/type, not the device-recording marker.
    _findRecordableSlot() {
        for (let i = 0; i < this.slots.slots.length; i++) {
            const s = this.slots.slots[i];
            if (!s.hasAudio && s.type !== 'kit' && !s._deviceRecording) return i;
        }
        return -1;
    }

    // Device-recording markers (_deviceRecording/_devicePath/name) live on the
    // in-memory slot objects, not IndexedDB (there's no local audio to persist
    // there) -- without this they'd vanish on every page reload while the actual
    // files sit untouched on SCM's SD card. Small enough for localStorage, same
    // pattern as DeviceController's own connection-preference persistence.
    _saveDeviceSlotState() {
        try {
            const state = {};
            this.slots.slots.forEach((s, i) => {
                if (s._deviceRecording) {
                    state[i] = { path: s._devicePath, name: s.name || null, peaks: s.peaks || null };
                }
            });
            localStorage.setItem('soniphorm-device-slots', JSON.stringify(state));
        } catch (_) {}
    }

    _restoreDeviceSlotState() {
        let state;
        try {
            const json = localStorage.getItem('soniphorm-device-slots');
            if (!json) return;
            state = JSON.parse(json);
        } catch (_) { return; }
        for (const i of Object.keys(state)) {
            const slot = this.slots.slots[i];
            // A real local recording (from IndexedDB) takes precedence over a stale
            // device marker -- shouldn't normally overlap, but don't fight it if it does.
            if (!slot || slot.hasAudio) continue;
            slot._deviceRecording = true;
            slot._devicePath = state[i].path;
            if (state[i].name) slot.name = capSlotName(state[i].name);
            if (state[i].peaks) slot.peaks = state[i].peaks;
        }
    }

    // Fully empties a slot: local audio (IndexedDB, via clearSlot()) AND any
    // device-recording marker pointing at a file on the SCM's SD card. clearSlot()
    // alone only clears the local-audio half -- _deviceRecording/_devicePath live
    // entirely outside SlotManager (see _saveDeviceSlotState() above), so a slot
    // whose device file no longer exists (e.g. the SD card got reformatted) would
    // otherwise stay permanently marked as holding a device recording: skipped by
    // _findRecordableSlot() forever, and its rec/play buttons routed at a dead
    // file instead of allowing a new recording in. Always clear both halves together.
    async _clearSlotFully(index) {
        await this.slots.clearSlot(index);
        const slot = this.slots.slots[index];
        if (slot) {
            slot._deviceRecording = false;
            slot._devicePath = null;
        }
        this._saveDeviceSlotState();
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

            // Sample mode: trigger on press, release on lift
            let usedTouch = false;
            let longPressTimer = null;

            if (i < 16) {
                el.addEventListener('mousedown', (e) => {
                    if (usedTouch) return;
                    if (e.button !== 0) return;
                    if (this._sampleMode) this.sample.samplePadTap(i);
                    else {
                        // Long-press for context menu on desktop without right-click (e.g. macOS single-button)
                        longPressTimer = setTimeout(() => {
                            longPressTimer = null;
                            el._longPressFired = true;
                            // Suppress the click fired on mouseup so it doesn't immediately close the menu
                            document.addEventListener('click', (ev) => { ev.stopPropagation(); }, { capture: true, once: true });
                            this.onSlotContext(i, { preventDefault: () => {}, clientX: e.clientX, clientY: e.clientY });
                        }, 500);
                    }
                });
                el.addEventListener('mouseup', () => {
                    if (usedTouch) return;
                    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                    if (this._sampleMode) this.sample.samplePadRelease(i);
                });
                el.addEventListener('mouseleave', () => {
                    if (usedTouch) return;
                    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                    if (this._sampleMode) this.sample.samplePadRelease(i);
                });

                // Touch events
                el.addEventListener('touchstart', (e) => {
                    usedTouch = true;
                    if (this._sampleMode) {
                        e.preventDefault();
                        this.sample.samplePadTap(i);
                    } else {
                        // Long-press for context menu on iOS (contextmenu event not fired)
                        const touch = e.touches[0];
                        longPressTimer = setTimeout(() => {
                            longPressTimer = null;
                            document.addEventListener('click', (ev) => { ev.stopPropagation(); }, { capture: true, once: true });
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
            const isKit = slot.type === 'kit';

            if (isKit) {
                nameEl.textContent = slot.name || 'Kit';
                nameEl.className = 'slot-name';
            } else if (slot._deviceRecording) {
                // Recorded on SCM's SD card, not pulled into the browser yet (no local
                // hasAudio) -- distinct from both "empty" and a real local recording so
                // it's clear there's something here worth tapping to play, not record over.
                nameEl.textContent = slot.name || 'on device';
                nameEl.className = 'slot-name device-recording';
            } else {
                nameEl.textContent = slot.hasAudio ? (slot.name || 'untitled') : 'empty';
                nameEl.className = `slot-name ${slot.hasAudio ? '' : 'empty'}`;
            }

            // Restore normal mode classes
            el.className = 'slot';
            el.dataset.bank = slot.bank;
            if (isKit) el.classList.add('slot-kit');
            if (slot._deviceRecording) el.classList.add('device-recording');

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
            el.classList.toggle('resampling', i === this._resampleTargetSlot);

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
            } else if (slot._deviceRecording && slot.peaks) {
                // Low-res placeholder built from streamed MTR levels, not real audio --
                // same drawing code as a genuine recording, distinct color so it still
                // reads as "not the real waveform yet" (replaced wholesale by real
                // peaks once actual audio is ever pulled in, e.g. future MSC import).
                const color = isSelected ? 'rgba(255,255,255,0.7)' : 'rgba(59,130,246,0.6)';
                WaveformRenderer.drawMiniFromPeaks(miniCanvas, slot.peaks, color);
            } else if (slot._deviceRecording) {
                // No peaks captured for this one (e.g. meter stream dropped mid-take) --
                // plain tint rather than a blank canvas so it doesn't read as truly empty.
                const ctx = miniCanvas.getContext('2d');
                miniCanvas.width = miniCanvas.clientWidth;
                miniCanvas.height = miniCanvas.clientHeight;
                ctx.fillStyle = 'rgba(59,130,246,0.25)';
                ctx.fillRect(0, 0, miniCanvas.width, miniCanvas.height);
            } else if (!slot.hasAudio) {
                const ctx = miniCanvas.getContext('2d');
                miniCanvas.width = miniCanvas.clientWidth;
                miniCanvas.height = miniCanvas.clientHeight;
                ctx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
            }
        });
    }

    // Shared by REC and SAMPLE mode's onSlotTap() -- if there's an active
    // waveform selection and the tapped slot is empty, offers to copy that
    // region into it. Returns true if it handled the tap (copy done), false
    // if there was nothing to do or the user declined (caller falls through
    // to its own normal tap handling in that case).
    async _trySelectionCopyToSlot(index) {
        const slot = this.slots.slots[index];
        if (!slot || slot.hasAudio || !this.channels) return false;
        const sel = this.waveform.getSelection();
        if (!sel) return false;
        if (!confirm(`Copy selection to slot ${index + 1}?`)) return false;
        const copied = this.channels.map(ch => ch.slice(sel.start, sel.end));
        await this.slots.saveSlotAudio(index, copied, this.bufferSampleRate);
        this.renderSlotGrid();
        return true;
    }

    async onSlotTap(index) {
        // Stop resample from any mode by tapping the target slot
        if (this._resampleTargetSlot === index) {
            await this.rec.stopResample();
            return;
        }
        // In sequencer mode, tap opens step config
        if (this._seqMode) {
            this.seq.seqStepTap(index);
            return;
        }
        // In sampler mode, trigger is handled by mousedown/touchstart -- but a
        // selection-to-empty-slot copy (see _trySelectionCopyToSlot()) is still
        // worth honoring here first: SAMPLE mode's own waveform view reuses the
        // same shared this.channels/this.waveform REC mode does (see
        // sample-controller.js's pad-select loading them), so a region selected
        // while auditioning a pad's sample is just as real a selection as one
        // made in REC mode -- it just never used to be checked here at all.
        if (this._sampleMode) {
            await this.ensureAudioInit();
            await this._trySelectionCopyToSlot(index);
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
            await this._endRecording();
            return;
        }

        // If we're recording into a different slot, or resampling, ignore
        if (this.recordingSlotIndex >= 0) return;
        if (this._resampleTargetSlot >= 0) return;

        // If a selection exists and this is an empty slot, offer to copy
        if (await this._trySelectionCopyToSlot(index)) return;

        // Slot already holds a device recording (audio lives on SCM's SD card, not
        // pulled into the browser yet) -- play it back instead of recording over it.
        // Uses RECPLAY <path> (real slot-to-file linking) when the slot's path is
        // known; falls back to RECBTN 2 (plays whatever's newest on SD) only for
        // older slots that predate _devicePath tracking.
        if (index === this.slots.selectedIndex && slot._deviceRecording) {
            if (this.device && this.device.isConnected()) this._playDeviceSlot(index, slot);
            return;
        }
        // If this slot is already selected and empty, start recording
        if (index === this.slots.selectedIndex && !slot.hasAudio) {
            await this._beginRecording(index);
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
            menu.querySelector('[data-action="resample"]').hidden = true;
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

        // Empty slot with no audio and not a kit — show "Make Drum Kit" and "Resample"
        if (!slot.hasAudio && slot.type !== 'kit') {
            const menu = document.getElementById('context-menu');
            menu.querySelector('[data-action="rename"]').hidden = true;
            menu.querySelector('[data-action="duplicate"]').hidden = true;
            menu.querySelector('[data-action="save"]').hidden = true;
            menu.querySelector('[data-action="clear"]').hidden = true;
            menu.querySelector('[data-action="make-kit"]').hidden = false;
            menu.querySelector('[data-action="unmake-kit"]').hidden = true;
            menu.querySelector('[data-action="resample"]').hidden = false;
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
        menu.querySelector('[data-action="resample"]').hidden = true;

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
            // maxlength on the input only constrains typing -- _showDeviceRenameDialog()
            // prefills it with the device's raw filename via input.value = base, which
            // maxlength doesn't retroactively truncate, so an untouched long prefill can
            // still reach here uncapped without this.
            const name = capSlotName(input.value.trim()) || 'untitled';
            if (dialog._devicePath) {
                // Take recorded on the SCM's own SD card -- rename in place via FMOVE
                // rather than the local slot rename (there's no in-browser audio buffer
                // for this take; it stays on-device until pulled off, e.g. via mass storage).
                const oldPath = dialog._devicePath;
                const slotIndex = dialog._deviceSlotIndex;
                dialog._devicePath = null;
                dialog._deviceSlotIndex = null;
                dialog.hidden = true;
                const dir = oldPath.substring(0, oldPath.lastIndexOf('/'));
                const newPath = `${dir}/${name}.wav`;
                try {
                    await this.device.renameFile(oldPath, newPath);
                    const status = document.getElementById('device-status');
                    if (status) status.textContent = `Saved as ${name}.wav`;
                    // renameFile only touches the file on SD -- the slot grid has no
                    // idea a rename happened otherwise (no local hasAudio to key off).
                    if (slotIndex >= 0 && this.slots.slots[slotIndex]) {
                        this.slots.slots[slotIndex].name = name;
                        this.slots.slots[slotIndex]._devicePath = newPath;
                        this._saveDeviceSlotState();
                        this.renderSlotGrid();
                    }
                } catch (err) {
                    alert('Rename failed: ' + err.message);
                }
                return;
            }
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
            // Leave the device recording under its auto-generated name -- but still show
            // that name on the slot (the input box is pre-filled with it) rather than
            // falling back to the generic "on device" placeholder.
            if (dialog._devicePath && dialog._deviceSlotIndex >= 0 && this.slots.slots[dialog._deviceSlotIndex]) {
                this.slots.slots[dialog._deviceSlotIndex].name = capSlotName(input.value);
                this._saveDeviceSlotState();
                this.renderSlotGrid();
            }
            dialog._devicePath = null;
            dialog._deviceSlotIndex = null;
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
                            await this._clearSlotFully(index);
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
                case 'resample':
                    await this.rec.startResample(index);
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
                await this._endRecording();
            } else if (this.slots.selectedIndex >= 0) {
                const slot = this.slots.getSelectedSlot();
                if (slot && slot._deviceRecording) {
                    // Selected slot already holds a device recording -- play it back
                    // (same rule as tapping it directly) rather than recording over it.
                    if (this.device && this.device.isConnected()) this._playDeviceSlot(this.slots.selectedIndex, slot);
                } else if (slot && !slot.hasAudio) {
                    await this._beginRecording(this.slots.selectedIndex);
                } else {
                    // Find an empty slot (skipping ones that hold a device recording,
                    // which findEmptySlot() doesn't know about)
                    const empty = this._findRecordableSlot();
                    if (empty >= 0) {
                        this.slots.selectSlot(empty);
                        this.channels = null;
                        this.waveform.clear();
                        this.renderSlotGrid();
                        await this._beginRecording(empty);
                    } else {
                        alert('No empty slots available');
                    }
                }
            }
        });

        $('play-btn').addEventListener('click', () => {
            const slot = this.slots.getSelectedSlot();
            if (slot && slot._deviceRecording) {
                if (this.device && this.device.isConnected()) this._playDeviceSlot(this.slots.selectedIndex, slot);
                return;
            }
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

        // Edit expander (cut/copy/paste)
        $('edit-btn').addEventListener('click', () => {
            const bar = document.getElementById('edit-group');
            bar.hidden = !bar.hidden;
            $('edit-btn').classList.toggle('active', !bar.hidden);
        });
        $('cut-btn').addEventListener('click', () => this.rec.applyEdit('cut'));
        $('copy-btn').addEventListener('click', () => this.rec.copySelection());
        $('paste-btn').addEventListener('click', () => this.rec.applyEdit('paste'));

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
        // scm-indicator is a one-click cycle through the whole device workflow --
        // BLE-first (matches the phone-centric, cable-free story), not the menu's
        // Serial-preferred connect(). Deliberately not a menu shortcut (redundant
        // with menu-btn next to it). The explicit USB/Bluetooth/MSC buttons in the
        // device menu stay as the fallback for anyone who wants to be specific or
        // whose computer has no Bluetooth.
        //
        // States, purely derived from isConnected()/_deviceInMscMode except one
        // extra bit (_scmBtnImportedThisMsc) needed because "in MSC mode,
        // disconnected" looks identical whether this is the first click after
        // entering (should load files) or a later one (should reconnect) --
        // reset to false every time MSC mode is freshly entered (_enterMscMode()).
        //   1. disconnected, not in MSC mode -> connect via BLE
        //   2. connected, not in MSC mode     -> enter mass storage mode
        //   3. in MSC mode, not yet loaded    -> load recordings from drive
        //   4. in MSC mode, already loaded    -> reconnect (which also auto-exits
        //                                        MSC mode, see onConnect above)
        $('scm-indicator').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!this.device) return;

            if (this._deviceInMscMode) {
                if (!this._scmBtnImportedThisMsc) {
                    this._scmBtnImportedThisMsc = true;
                    this._scmBtnLoading = true;
                    this._updateDeviceStatus();
                    try {
                        await this._importRecordingsFromDrive();
                    } finally {
                        this._scmBtnLoading = false;
                        this._updateDeviceStatus();
                    }
                    return;
                }
                try {
                    await this.device.connectBle();
                } catch (err) {
                    alert('Couldn\'t find your SCM. Check it\'s powered on and Bluetooth is enabled -- or connect via USB from the device menu.');
                }
                return;
            }

            if (this.device.isConnected()) {
                if (!confirm('Reboot SCM into mass storage mode? The SD card will mount as a drive, and the device will disconnect until you reconnect.')) return;
                try {
                    await this._enterMscMode();
                } catch (err) {
                    alert('Failed to enter mass storage mode: ' + err.message);
                }
                return;
            }

            try {
                await this.device.connectBle();
            } catch (err) {
                // Web Bluetooth doesn't distinguish "user cancelled the chooser"
                // from "no device found" cleanly enough to stay silent on one and
                // not the other (both can surface as NotFoundError) -- always show
                // the friendly fallback rather than risk swallowing a real failure.
                alert('Couldn\'t find your SCM. Check it\'s powered on and Bluetooth is enabled -- or connect via USB from the device menu.');
            }
        });

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

        // DMX settings toggle
        const dmxBtn = $('dmx-btn');
        if (dmxBtn) {
            dmxBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const panel = document.getElementById('dmx-settings');
                const show = panel.hidden;
                panel.hidden = !show;
                e.target.classList.toggle('menu-active', show);
                if (show) this._updateDmxStatus();
            });
        }

        // Device (SCM) settings toggle
        const deviceBtn = $('device-btn');
        if (deviceBtn) {
            deviceBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const panel = document.getElementById('device-settings');
                const show = panel.hidden;
                panel.hidden = !show;
                e.target.classList.toggle('menu-active', show);
                if (show) this._updateDeviceStatus();
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
            if (action === 'dmx') return; // handled by direct listener
            this._closeMainMenu();
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

        // Waveform context menu
        const wfCanvas = document.getElementById('waveform');
        wfCanvas.addEventListener('contextmenu', (e) => {
            if (this._sampleMode || this._seqMode) return;
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

        $('project-file-input').addEventListener('change', (e) => this.rec.loadProject(e));

        // Kit mode back button
        $('kit-back-btn').addEventListener('click', () => this._exitKitMode());

        // Kit PAD PLAY mode toggle
        $('kit-play-btn').addEventListener('click', async () => {
            this._kitPlayMode = !this._kitPlayMode;
            $('kit-play-btn').classList.toggle('active', this._kitPlayMode);
            // Ensure buffers are decoded (audio context is valid by this point)
            if (this._kitPlayMode && Object.keys(this._kitSlotBuffers).length === 0) {
                await this._preloadKitBuffers(this._kitParentSlot);
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
        if (menu.hidden) {
            menu.hidden = false;
            // Bound once and reused -- instance-scoped rather than a fresh closure
            // per open, so _closeMainMenu() (called from other places too: the
            // action-button dispatcher, the DMX test dialog) always cleans up
            // exactly the listeners/timer that are actually live, regardless of
            // which call opened the menu most recently. A fresh-closure-per-open
            // version left old listeners/timers dangling whenever the menu was
            // closed by one of those other direct-hide sites instead of this
            // function's own outside-click/timeout path -- reopening would then
            // layer a second live timer on top of the first, and the stale one
            // could fire mid-interaction and close the menu unexpectedly.
            if (!this._menuOutsideClickHandler) {
                this._menuOutsideClickHandler = (ev) => {
                    const m = document.getElementById('main-menu');
                    if (!m.hidden && !m.contains(ev.target) && ev.target.id !== 'menu-btn') this._closeMainMenu();
                };
            }
            if (!this._menuInteractionHandler) {
                this._menuInteractionHandler = () => this._armMenuAutoClose();
            }
            setTimeout(() => document.addEventListener('click', this._menuOutsideClickHandler), 10);
            menu.addEventListener('click', this._menuInteractionHandler);
            menu.addEventListener('change', this._menuInteractionHandler); // <select> interactions inside the menu
            this._armMenuAutoClose();
        } else {
            this._closeMainMenu();
        }
    }

    // Any interaction inside the menu (including opening a sub-panel like MIDI/
    // DMX/device settings) resets this -- only genuine 10s inactivity closes it.
    _armMenuAutoClose() {
        if (this._menuAutoCloseTimer) clearTimeout(this._menuAutoCloseTimer);
        this._menuAutoCloseTimer = setTimeout(() => this._closeMainMenu(), 10000);
    }

    _closeMainMenu() {
        const menu = document.getElementById('main-menu');
        menu.hidden = true;
        if (this._menuOutsideClickHandler) document.removeEventListener('click', this._menuOutsideClickHandler);
        if (this._menuInteractionHandler) {
            menu.removeEventListener('click', this._menuInteractionHandler);
            menu.removeEventListener('change', this._menuInteractionHandler);
        }
        if (this._menuAutoCloseTimer) { clearTimeout(this._menuAutoCloseTimer); this._menuAutoCloseTimer = null; }
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
            }
            await this._clearSlotFully(i);
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
        const selectedSlot = this.slots.getSelectedSlot();
        const deviceRecordingSelected = !!(selectedSlot && selectedSlot._deviceRecording);

        document.getElementById('rec-btn').disabled = false;
        document.getElementById('play-btn').disabled = !hasAudio && !deviceRecordingSelected;
        document.getElementById('loop-btn').disabled = !hasAudio;
        document.getElementById('trim-btn').disabled = !hasSel;
        document.getElementById('reverse-btn').disabled = !hasAudio;
        document.getElementById('norm-btn').disabled = !hasAudio;
        document.getElementById('edit-btn').disabled = !hasAudio;
        document.getElementById('cut-btn').disabled = !hasSel;
        document.getElementById('copy-btn').disabled = !hasSel;
        document.getElementById('paste-btn').disabled = !this.clipboard;
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
        if (this._sampleMode) {
            this.sample.exit(mode);
        }

        // Enter new mode
        if (mode === 'seq') {
            await this.seq.enter();
        } else if (mode === 'sample') {
            await this.sample.enter();
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

        // Show/hide transport bars and toolbar
        document.getElementById('seq-transport').classList.toggle('active', mode === 'seq' || (mode === 'sample' && this._seqShowTransportInSample));
        document.getElementById('sample-transport').classList.toggle('active', mode === 'sample');
        document.getElementById('slot-grid').classList.toggle('seq-mode', mode === 'seq');
        document.getElementById('slot-grid').classList.toggle('sample-mode', mode === 'sample');
        document.getElementById('toolbar').classList.toggle('sample-mode', mode === 'sample');
        document.getElementById('toolbar').classList.toggle('seq-mode', mode === 'seq');

        // Header title
        if (this._kitMode) {
            const kitName = this.slots.slots[this._kitParentSlot].name || 'Kit';
            document.querySelector('.header-title').textContent = 'KIT: ' + kitName;
        } else {
            const titles = { rec: 'SONICRAFT', sample: 'SAMPLER', seq: 'SEQUENCER' };
            document.querySelector('.header-title').textContent = titles[mode];
        }

        // Show drum grid toggle button in SEQ mode when in kit mode
        document.getElementById('seq-drum-grid-btn').hidden = !(mode === 'seq' && this._kitMode);

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
        const mapSel = document.getElementById('midi-notemap-select');
        if (mapSel) {
            mapSel.value = this.midi.noteMap;
            mapSel.addEventListener('change', () => {
                this.midi.noteMap = mapSel.value;
                this.midi._saveSettings();
            });
        }

        this._refreshMidiPortUI();
    }

    // === DMX ===

    async _initDmx() {
        if (typeof DmxController === 'undefined') return;
        this.dmx = new DmxController();

        this.dmx.onConnect = () => this._updateDmxStatus();
        this.dmx.onDisconnect = () => this._updateDmxStatus();
        this.dmx.onError = (err) => {
            console.warn('DMX error:', err);
            this._updateDmxStatus();
        };

        // Wire menu buttons
        const connectBtn = document.getElementById('dmx-connect-btn');
        const testBtn = document.getElementById('dmx-test-btn');
        const blackoutBtn = document.getElementById('dmx-blackout-btn');
        if (connectBtn) {
            connectBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (this.dmx.connected) {
                    await this.dmx.disconnect();
                } else {
                    try {
                        await this.dmx.connect();
                    } catch (err) {
                        alert('DMX connect failed: ' + err.message);
                    }
                }
            });
        }
        if (testBtn) {
            testBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._openDmxTestDialog();
            });
        }
        if (blackoutBtn) {
            blackoutBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.dmx) this.dmx.blackout();
            });
        }

        // Dialog close / channel range controls
        const closeBtn = document.getElementById('dmx-dialog-close');
        const applyBtn = document.getElementById('dmx-ch-apply');
        const zeroBtn = document.getElementById('dmx-ch-zero');
        if (closeBtn) closeBtn.addEventListener('click', () => this._closeDmxTestDialog());
        if (applyBtn) applyBtn.addEventListener('click', () => this._buildDmxSliders());
        if (zeroBtn) zeroBtn.addEventListener('click', () => this._zeroDmxVisible());

        // Attempt auto-connect if a port was previously authorized and we had
        // been connected on last load.
        const prefs = this.dmx.loadSettings();
        if (prefs.autoConnect && this.dmx.isSupported()) {
            this.dmx.tryAutoConnect().catch(() => {});
        }

        this._updateDmxStatus();
    }

    _updateDmxStatus() {
        const status = document.getElementById('dmx-status');
        const btn = document.getElementById('dmx-connect-btn');
        if (!this.dmx) return;
        if (!this.dmx.isSupported()) {
            if (status) status.textContent = 'Web Serial not supported';
            if (btn) btn.disabled = true;
            return;
        }
        if (status) status.textContent = this.dmx.connected ? 'Connected' : 'Not connected';
        if (btn) btn.textContent = this.dmx.connected ? 'Disconnect' : 'Connect…';
    }

    // === Smart Contact Mic (device recording) ===

    _initDevice() {
        if (typeof DeviceController === 'undefined') return;
        this.device = new DeviceController();
        this._deviceRecordingActive = false;
        this._deviceRecordingPath = null;
        this._devicePlayingSlot = -1;
        this._deviceInMscMode = this._loadMscModeState();
        this._updateMscButton();

        this.device.onConnect = () => {
            this._updateDeviceStatus();
            this._updateMscButton();
            // If still marked as in MSC mode, finish the job automatically -- unlike
            // requestPort()/requestDevice() (which genuinely need a fresh user
            // gesture, confirmed the hard way: a confirm() dialog's "OK" click does
            // NOT count, Chrome rejected it with "must be handling a user gesture"),
            // sending a command over an ALREADY-open connection has no such
            // requirement. The click that triggered this connect (the real USB/
            // Bluetooth button) is gesture enough to get here; nothing further is
            // needed to also exit MSC mode right after.
            if (this._deviceInMscMode) this._exitMscMode(true);
            this.device.getSdSpace().then((space) => this._maybeWarnSdSpace(space)).catch(() => {});
        };
        this.device.onDisconnect = () => {
            this._deviceRecordingActive = false;
            if (this.recordingSlotIndex >= 0) {
                this.recordingSlotIndex = -1;
                this.renderSlotGrid();
            }
            document.getElementById('rec-btn').classList.remove('recording');
            document.getElementById('device-level-meter').hidden = true;
            // Used to unconditionally reset _deviceInMscMode to false here, on the
            // theory that "any disconnect this app didn't just cause" means the
            // device rebooted back to normal. That reasoning doesn't hold: entering
            // MSC mode ALSO disconnects (the device reboots into it) -- so the very
            // first disconnect after a successful "Mass storage mode..." click was
            // this exact "unrelated" case by the code's own logic, immediately
            // undoing the true value the click handler had just set. Confirmed live:
            // Ed entered MSC mode, imported files, and the button still read "Mass
            // storage mode..." (enter) instead of "Exit..." because of this.
            // _deviceInMscMode is already kept correct by the two calls that
            // actually change it (enterMassStorageMode()/_exitMscMode(), both set
            // synchronously before any resulting reboot-disconnect fires) plus the
            // defensive correction in _handleDeviceState()'s mscModeOn/mscModeOff
            // cases, which reacts to the device's own genuine "MSC_MODE ON/OFF"
            // boot announcement -- real ground truth, unlike a bare disconnect
            // event, which carries no information about which mode caused it (or
            // whether the device even rebooted at all -- a plain cable-pull/BLE-
            // out-of-range disconnect doesn't reboot anything, so the device's mode
            // is unchanged and this app's belief about it should be too).
            this._updateDeviceStatus();
            this._updateMscButton();
            this._sdSpaceWarned = false; // re-check fresh next connect, don't carry a stale "already told them" flag
        };
        this.device.onError = (err) => {
            console.warn('Device error:', err);
            this._updateDeviceStatus();
        };
        this.device.onState = (event) => this._handleDeviceState(event);

        const connectBtn = document.getElementById('device-connect-btn');
        const connectBleBtn = document.getElementById('device-connect-ble-btn');
        if (connectBtn) {
            connectBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (this.device.isConnected()) {
                    await this.device.disconnect();
                } else {
                    try {
                        await this.device.connectSerial();
                    } catch (err) {
                        alert('Device connect failed: ' + err.message);
                    }
                }
            });
        }
        if (connectBleBtn) {
            connectBleBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (this.device.isConnected()) {
                    await this.device.disconnect();
                } else {
                    try {
                        await this.device.connectBle();
                    } catch (err) {
                        alert('Device connect failed: ' + err.message);
                    }
                }
            });
        }
        const mscBtn = document.getElementById('device-msc-btn');
        if (mscBtn) {
            mscBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!this.device.isConnected()) {
                    // Was a silent no-op -- looked exactly like a broken button
                    // (confirmed live: Ed clicked "Exit mass storage mode..." while
                    // not connected and saw nothing happen at all, no error).
                    alert('Not connected to SCM -- connect via USB or Bluetooth first.');
                    return;
                }
                // _deviceInMscMode is the app's own memory of which command it last
                // sent, not something read back from the device -- the device's own
                // "MSC_MODE ON" announcement prints immediately on entry, likely
                // before the app has even reconnected (device reboots + re-enumerates,
                // which takes real time), so waiting to observe it would race. The app
                // already knows what it told the device to do; that's more reliable
                // than trying to catch a line that may have already gone by.
                if (this._deviceInMscMode) {
                    await this._exitMscMode(false);
                    return;
                }
                if (!confirm('Reboot SCM into mass storage mode? The SD card will mount as a drive, and the device will disconnect until you reconnect and switch back with this button again.')) return;
                try {
                    await this._enterMscMode();
                } catch (err) {
                    alert('Failed to enter mass storage mode: ' + err.message);
                }
            });
        }
        const importBtn = document.getElementById('device-import-btn');
        if (importBtn) {
            importBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._importRecordingsFromDrive();
            });
        }

        const prefs = this.device.loadSettings();
        if (prefs.autoConnect && this.device.isSupported()) {
            this.device.tryAutoConnect().catch(() => {});
        }

        this._updateDeviceStatus();
    }

    _updateDeviceStatus() {
        const status = document.getElementById('device-status');
        const btn = document.getElementById('device-connect-btn');
        const bleBtn = document.getElementById('device-connect-ble-btn');
        const indicator = document.getElementById('scm-indicator');
        if (!this.device) return;
        if (!this.device.isSupported()) {
            if (status) status.textContent = 'Not supported — use Chrome/Edge, or Bluefy on iOS';
            if (btn) btn.disabled = true;
            if (bleBtn) bleBtn.disabled = true;
            if (indicator) { indicator.classList.remove('connected'); indicator.title = 'SCM: not supported in this browser'; }
            return;
        }
        const connected = this.device.isConnected();
        const transport = this.device.getTransport();
        if (status) status.textContent = connected ? 'Connected' : 'Not connected';
        // Two separate connect buttons (USB / Bluetooth) rather than one auto-detect
        // button -- 'serial' in navigator is a browser capability, not a signal that
        // a device is actually reachable over USB right now, so auto-preferring
        // Serial silently made BLE unreachable on any Serial-capable browser (e.g.
        // a device powered but not USB-connected had nowhere to go). When connected,
        // hide the transport that ISN'T active and turn the active one into Disconnect.
        if (btn) {
            if (connected && transport === 'ble') {
                btn.hidden = true;
            } else {
                btn.hidden = false;
                btn.textContent = connected ? 'Disconnect' : 'USB…';
                btn.disabled = !('serial' in navigator);
            }
        }
        if (bleBtn) {
            if (connected && transport === 'serial') {
                bleBtn.hidden = true;
            } else {
                bleBtn.hidden = false;
                bleBtn.textContent = connected ? 'Disconnect' : 'Bluetooth…';
                bleBtn.disabled = !('bluetooth' in navigator);
            }
        }
        if (indicator) {
            // Tooltip mirrors the click handler's own state cycle exactly (see
            // its comment) so hovering tells you what the next click will do.
            // Text label too -- color alone (grey/green/yellow) wasn't enough of
            // a cue, especially for the "actively loading" moment, which used to
            // look identical to plain "in MSC mode, nothing happening yet".
            indicator.classList.toggle('msc-mode', this._deviceInMscMode);
            indicator.classList.toggle('connected', connected && !this._deviceInMscMode);
            indicator.classList.toggle('loading', !!this._scmBtnLoading);
            if (this._scmBtnLoading) {
                indicator.textContent = 'LOAD';
                indicator.title = 'SCM: loading recordings from drive…';
            } else if (this._deviceInMscMode) {
                indicator.textContent = 'SD';
                indicator.title = this._scmBtnImportedThisMsc
                    ? 'SCM: mass storage mode -- click to reconnect'
                    : 'SCM: mass storage mode -- click to load recordings';
            } else {
                indicator.textContent = 'SCM';
                indicator.title = connected
                    ? `SCM: connected (${transport === 'ble' ? 'Bluetooth' : 'USB'}) -- click to enter mass storage mode`
                    : 'SCM: not connected -- click to connect via Bluetooth';
            }
        }
    }

    // Small localStorage flag, same pattern as DeviceController's own connection
    // prefs -- survives a page reload while the device is mid-MSC-mode (e.g. user
    // navigates away and back before reconnecting to switch it back).
    _saveMscModeState() {
        try { localStorage.setItem('soniphorm-device-msc', this._deviceInMscMode ? '1' : '0'); } catch (_) {}
    }

    _loadMscModeState() {
        try { return localStorage.getItem('soniphorm-device-msc') === '1'; } catch (_) { return false; }
    }

    _updateMscButton() {
        const btn = document.getElementById('device-msc-btn');
        if (btn) btn.textContent = this._deviceInMscMode ? 'Exit mass storage mode…' : 'Mass storage mode…';
    }

    // Runs the moment MSC mode is confirmed entered (see the mscModeOn case in
    // _handleDeviceState()) -- fully automatic, no "Load recordings from drive..."
    // click needed, PROVIDED a folder handle from an earlier manual import is
    // still on file with permission genuinely granted (queryPermission(), unlike
    // requestPermission(), never needs a user gesture, so this is safe to run
    // from a background device-data callback). First-ever import (or one after a
    // revoked/never-granted handle) still needs the manual button -- there is no
    // way to call showDirectoryPicker() itself outside a real click. Silently
    // does nothing if there's no pending recording to pull, so this doesn't pop
    // an unwanted "no pending recordings" alert every time MSC mode is entered
    // just to browse files manually.
    async _tryAutoImportFromDrive() {
        if (!('showDirectoryPicker' in window)) return;
        const hasPending = this.slots.slots.some(s => s && s._deviceRecording && s._devicePath && !s.hasAudio);
        if (!hasPending) return;
        const dirHandle = await this._getSavedImportDirHandle();
        if (!dirHandle) return;
        try {
            if ((await dirHandle.queryPermission({ mode: 'read' })) !== 'granted') return;
        } catch (_) {
            return;
        }
        await this._importRecordingsFromDrive();
    }

    // Visual progress for _importRecordingsFromDrive() -- a left-to-right green
    // fill on the specific slot currently being pulled in, not a separate
    // element that'd change the app's layout. There's no true byte-level
    // progress available (file.arrayBuffer() doesn't expose one), so the fill
    // advances across the real await boundaries within one file's import
    // (open handle -> read file -> decode -> save) rather than faking a smooth
    // animation -- coarse, but genuine width per completed step, not cosmetic.
    _setSlotImporting(index, importing) {
        const el = document.querySelector(`#slot-grid .slot[data-index="${index}"]`);
        if (!el) return;
        el.classList.toggle('importing', importing);
        let fill = el.querySelector('.slot-import-fill');
        if (importing) {
            if (!fill) {
                fill = document.createElement('div');
                fill.className = 'slot-import-fill';
                el.appendChild(fill);
            }
            fill.style.width = '0%';
        } else if (fill) {
            fill.remove();
        }
    }

    _setSlotImportProgress(index, fraction) {
        const fill = document.querySelector(`#slot-grid .slot[data-index="${index}"] .slot-import-fill`);
        if (fill) fill.style.width = `${Math.round(fraction * 100)}%`;
    }

    // Pulls the WAV files for this session's device recordings (_deviceRecording
    // slots -- audio that lives only on the SCM's SD card, not yet in the browser)
    // straight from the mounted MSC drive. Web Serial is dead once MSC mode is
    // active, so this can't go over the device connection -- it uses the separate
    // File System Access API instead. The very first import on a given browser
    // still needs one real user gesture (a folder picker) -- browsers don't allow
    // silently reading arbitrary drive contents -- but the granted directory handle
    // is persisted (see _getSavedImportDirHandle/_saveImportDirHandle below) and
    // reused on later imports, so it's a one-time cost rather than every time.
    async _importRecordingsFromDrive() {
        if (!('showDirectoryPicker' in window)) {
            alert('Your browser can\'t pick a folder for this (needs desktop Chrome or Edge).');
            return;
        }
        const pending = [];
        this.slots.slots.forEach((s, i) => {
            if (s && s._deviceRecording && s._devicePath && !s.hasAudio) pending.push({ index: i, slot: s });
        });
        if (pending.length === 0) {
            alert('No pending device recordings to import -- every recorded slot already has its audio, or nothing has been recorded on the device yet this session.');
            return;
        }

        let dirHandle = await this._getSavedImportDirHandle();
        if (dirHandle) {
            // Re-verify permission on the saved handle rather than assume it still
            // holds -- Chrome either silently re-grants (recently used site) or shows
            // a one-click reconfirm, neither of which is the full navigate-and-pick
            // dialog, so this is still a real improvement even when it isn't silent.
            let granted = false;
            try {
                const opts = { mode: 'read' };
                granted = (await dirHandle.queryPermission(opts)) === 'granted';
                if (!granted) granted = (await dirHandle.requestPermission(opts)) === 'granted';
            } catch (_) { granted = false; }
            if (!granted) dirHandle = null;
        }

        if (!dirHandle) {
            try {
                // id: lets Chrome remember this picker's last location independently
                // of other showDirectoryPicker() calls elsewhere in the app, so even
                // a forced re-pick (permission revoked, wrong drive last time) opens
                // close to the right place instead of the OS default.
                dirHandle = await window.showDirectoryPicker({ id: 'soniphorm-scm-rec' });
            } catch (err) {
                if (err.name === 'AbortError') return;
                alert('Could not open folder: ' + err.message);
                return;
            }
            this._saveImportDirHandle(dirHandle).catch(() => {});
        }

        // Recordings live in /rec on the SD card -- descend into it if the drive
        // root was picked instead; if this IS the rec folder (or has no such
        // subfolder), just use what was picked.
        try {
            dirHandle = await dirHandle.getDirectoryHandle('rec');
        } catch (_) { /* already inside rec, or no rec subfolder here */ }

        await this.ensureAudioInit();
        let imported = 0;
        const missing = [];
        for (let i = 0; i < pending.length; i++) {
            const { index, slot } = pending[i];
            const basename = slot._devicePath.split('/').pop();
            this._setSlotImporting(index, true);
            try {
                const fileHandle = await dirHandle.getFileHandle(basename);
                this._setSlotImportProgress(index, 1 / 5);
                const file = await fileHandle.getFile();
                this._setSlotImportProgress(index, 2 / 5);
                const arrayBuffer = await file.arrayBuffer();
                this._setSlotImportProgress(index, 3 / 5);
                const audioBuffer = await this.audio.audioContext.decodeAudioData(arrayBuffer);
                this._setSlotImportProgress(index, 4 / 5);
                const channels = [];
                for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
                    channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
                }
                await this.slots.saveSlotAudio(index, channels, audioBuffer.sampleRate);
                this._setSlotImportProgress(index, 1);
                slot._deviceRecording = false;
                slot._devicePath = null;
                imported++;
            } catch (err) {
                console.warn('Import failed for', basename, err);
                missing.push(basename);
            }
            this._setSlotImporting(index, false);
        }
        this._saveDeviceSlotState();
        this.renderSlotGrid();

        // Nothing matched at all -- most likely the saved handle points at a stale
        // or wrong folder (drive letter reassigned, wrong drive picked last time).
        // Forget it so the next attempt re-prompts with a real picker instead of
        // silently failing the same way every time.
        if (imported === 0 && pending.length > 0) {
            this._clearSavedImportDirHandle().catch(() => {});
        }

        // The whole reason to be in MSC mode is almost always to pull files off the
        // card -- once an import finishes, auto-revert to normal runtime instead of
        // leaving the user to remember the manual "Exit mass storage mode..." button.
        // Only possible if the device connection survived the import (it uses the
        // separate File System Access API, not this connection, so this is a bonus
        // when true rather than something to force) -- silently does nothing extra
        // if not connected, same as before this existed.
        const autoRevert = this._deviceInMscMode && this.device && this.device.isConnected();

        let msg = `Imported ${imported} recording${imported === 1 ? '' : 's'}.`;
        if (missing.length > 0) msg += ` Not found in the picked folder: ${missing.join(', ')}.`;
        if (autoRevert) msg += ' Reverting SD card to normal mode...';
        alert(msg);

        if (autoRevert) {
            await this._exitMscMode(true);
            return;
        }

        // Common case: the import used the separate File System Access API without
        // ever needing a live device connection, so there's usually nothing to
        // silently revert through above. Previously tried firing connect() right
        // after a confirm() dialog here, on the theory that its "OK" click would
        // count as a fresh user gesture -- confirmed live that it does NOT: Chrome
        // rejected requestPort() with "must be handling a user gesture" even though
        // it ran synchronously off the dialog's dismissal. Native confirm()/alert()
        // don't carry real transient activation the way an actual button click
        // does. Just point at the real USB/Bluetooth buttons instead -- onConnect
        // now auto-exits MSC mode the moment either one succeeds (see _initDevice()),
        // so clicking one of those finishes the job in one step anyway.
        if (this._deviceInMscMode && this.device && !this.device.isConnected()) {
            alert('SCM is still in mass storage mode. Reconnect via USB or Bluetooth (device menu) and it\'ll exit automatically.');
        }
    }

    // Shared by the manual "Mass storage mode..." button and the scm-indicator's
    // smart-connect cycle. Resets _scmBtnImportedThisMsc -- see the scm-indicator
    // click handler -- so a fresh MSC session always starts back at "next click
    // loads files", regardless of which button was used to enter it.
    async _enterMscMode() {
        await this.device.enterMassStorageMode();
        this._deviceInMscMode = true;
        this._scmBtnImportedThisMsc = false;
        this._saveMscModeState();
        this._updateMscButton();
        this._updateDeviceStatus();
    }

    // Shared by the manual "Exit mass storage mode..." button and the automatic
    // revert after a successful drive import. silent=true swallows failures (a
    // best-effort convenience, not a user-initiated action -- a failure just
    // leaves the device in MSC mode, recoverable via the manual button same as
    // before this existed).
    async _exitMscMode(silent) {
        try {
            await this.device.exitMassStorageMode();
            this._deviceInMscMode = false;
            this._saveMscModeState();
            this._updateMscButton();
            this._updateDeviceStatus();
        } catch (err) {
            if (silent) {
                console.warn('Auto-exit mass storage mode failed:', err);
            } else {
                alert('Failed to exit mass storage mode: ' + err.message);
            }
        }
    }

    // === Persisted device-import folder handle ===
    // FileSystemDirectoryHandle is structured-cloneable, so IndexedDB can store it
    // directly -- a tiny dedicated DB rather than adding a store to SlotManager's
    // schema, since this is unrelated to slot/audio data.
    _openImportHandleDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('soniphorm-device-handles', 1);
            req.onupgradeneeded = () => { req.result.createObjectStore('handles'); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async _getSavedImportDirHandle() {
        try {
            const db = await this._openImportHandleDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction('handles', 'readonly');
                const req = tx.objectStore('handles').get('scmRecDir');
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        } catch (_) {
            return null;
        }
    }

    async _saveImportDirHandle(handle) {
        const db = await this._openImportHandleDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('handles', 'readwrite');
            tx.objectStore('handles').put(handle, 'scmRecDir');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async _clearSavedImportDirHandle() {
        const db = await this._openImportHandleDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('handles', 'readwrite');
            tx.objectStore('handles').delete('scmRecDir');
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    // Unsolicited REC_STATE events from the SCM — see DeviceController._handleLine.
    _handleDeviceState(event) {
        this._clearDeviceRecordWatchdog(); // receiving anything at all proves the firmware is alive
        const status = document.getElementById('device-status');
        const recBtn = document.getElementById('rec-btn');
        switch (event.type) {
            case 'recording':
                this._deviceRecordingActive = true;
                this._deviceRecordingPath = event.path;
                if (this.recordingSlotIndex < 0) {
                    // Started some other way (e.g. SCM's own hardware button, not this
                    // app) -- auto-pick a slot so the grid still reflects it, same
                    // fallback the toolbar REC button uses when nothing is selected.
                    const empty = this._findRecordableSlot();
                    if (empty >= 0) {
                        this.recordingSlotIndex = empty;
                        this.slots.selectSlot(empty);
                    }
                }
                recBtn.classList.add('recording');
                document.getElementById('waveform-empty').hidden = true;
                this.renderSlotGrid();
                if (status) status.textContent = 'Recording…';
                document.getElementById('device-level-meter').hidden = false;
                this._deviceRecordingPeaks = []; // accumulate MTR peaks into a low-res placeholder waveform
                this.device.enableMeter().catch(() => {});
                break;
            case 'finalizing':
                if (status) status.textContent = 'Saving…';
                break;
            case 'idle': {
                this._deviceRecordingActive = false;
                const recordedSlot = this.recordingSlotIndex;
                this.recordingSlotIndex = -1;
                recBtn.classList.remove('recording');
                if (recordedSlot >= 0 && this.slots.slots[recordedSlot]) {
                    // Marks the slot as "occupied by a device recording" -- tapping it
                    // again plays back (via device.play()) instead of recording over it,
                    // since there's no local hasAudio to key off (audio lives on SCM's SD
                    // card, not pulled into the browser). Cleared only by a future
                    // explicit "clear slot" action, not implemented yet.
                    this.slots.slots[recordedSlot]._deviceRecording = true;
                    this.slots.slots[recordedSlot]._devicePath = this._deviceRecordingPath;
                    if (this._deviceRecordingPeaks && this._deviceRecordingPeaks.length > 0) {
                        // Low-res placeholder waveform built purely from streamed MTR
                        // levels (~20Hz), not real audio -- drawn via the same
                        // drawMiniFromPeaks() path as a genuine local recording, just
                        // fed coarser/symmetric [peak,-peak] bars instead of true
                        // per-window min/max. Replaced wholesale once real audio is
                        // ever pulled in (e.g. future MSC import) by just overwriting
                        // slot.peaks with real data at that point.
                        this.slots.slots[recordedSlot].peaks = this._deviceRecordingPeaks;
                    }
                    this._saveDeviceSlotState();
                }
                this._deviceRecordingPeaks = null;
                this.renderSlotGrid();
                document.getElementById('device-level-meter').hidden = true;
                this.device.disableMeter().catch(() => {});
                // Main waveform view was showing the live placeholder during recording --
                // no "selected device recording" load path for it yet, so just clear back
                // to empty rather than leave a frozen last frame on screen.
                const mainCanvas = document.getElementById('waveform');
                if (mainCanvas) {
                    const ctx = mainCanvas.getContext('2d');
                    ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
                }
                document.getElementById('waveform-empty').hidden = false;
                if (this._deviceRecordingPath) {
                    if (status) status.textContent = event.seconds ? `Saved (${event.seconds.toFixed(1)}s)` : 'Saved';
                    this._showDeviceRenameDialog(this._deviceRecordingPath, recordedSlot);
                    this._deviceRecordingPath = null;
                }
                // Free space only actually shrinks once a take finalizes -- check here
                // rather than polling, so the warning (if any) lands right after the
                // recording that pushed the card over the threshold.
                this.device.getSdSpace().then((space) => this._maybeWarnSdSpace(space)).catch(() => {});
                break;
            }
            case 'busy':
                if (status) status.textContent = 'Device busy — wait for save to finish';
                break;
            case 'playing': {
                if (status) status.textContent = 'Playing…';
                // Draw the slot's placeholder waveform (built from the MTR stream
                // during its original recording) in the main viewer -- there's no
                // live position/progress data from firmware, so this is a static
                // display of the whole take rather than a moving playhead.
                const playSlot = this._devicePlayingSlot >= 0 ? this.slots.slots[this._devicePlayingSlot] : null;
                if (playSlot && playSlot.peaks) {
                    document.getElementById('waveform-empty').hidden = true;
                    const mainCanvas = document.getElementById('waveform');
                    if (mainCanvas) WaveformRenderer.drawMiniFromPeaks(mainCanvas, playSlot.peaks, 'rgba(34,197,94,0.7)');
                }
                break;
            }
            case 'paused':
                if (status) status.textContent = 'Paused';
                break; // leave whatever's drawn -- paused, not stopped
            case 'playbackIdle':
                if (status) status.textContent = 'Connected';
                if (this._devicePlayingSlot >= 0) {
                    this._devicePlayingSlot = -1;
                    const mainCanvas = document.getElementById('waveform');
                    if (mainCanvas) mainCanvas.getContext('2d').clearRect(0, 0, mainCanvas.width, mainCanvas.height);
                    document.getElementById('waveform-empty').hidden = false;
                }
                break;
            case 'mscModeOn':
            case 'mscModeOff':
                // Defensive correction only -- _deviceInMscMode is normally set the
                // moment the app sends the command (see the button handler), not from
                // this announcement, since it prints before the app has likely
                // reconnected after the reboot. Catches drift if the device was left
                // in a state from before this app-side tracking existed.
                this._deviceInMscMode = (event.type === 'mscModeOn');
                this._saveMscModeState();
                this._updateMscButton();
                this._updateDeviceStatus();
                if (event.type === 'mscModeOn') this._tryAutoImportFromDrive();
                break;
            case 'error':
                if (status) status.textContent = event.raw;
                // Roll back the optimistic "recording" UI (_beginRecording sets it
                // before the firmware confirms) -- e.g. "REC ERR: no SD card" arrives
                // instead of REC_STATE RECORDING when there's nothing to record to,
                // and without this the button/slot would just stay stuck red forever.
                if (this._deviceRecordingActive || this.recordingSlotIndex >= 0) {
                    this._deviceRecordingActive = false;
                    this.recordingSlotIndex = -1;
                    recBtn.classList.remove('recording');
                    this.renderSlotGrid();
                    document.getElementById('device-level-meter').hidden = true;
                    this.device.disableMeter().catch(() => {});
                }
                alert('SCM: ' + event.raw);
                break;
            case 'meter':
                this._updateDeviceMeter(event.peak);
                break;
            case 'piezoMeter':
                break; // TEMP DIAG from firmware, no longer displayed -- harmless to keep receiving
        }
    }

    // Warns once per connection when the SD card crosses ~90% full, so Ed hears
    // about it before a recording fails outright rather than after. Threshold lives
    // here (not firmware) so there's exactly one place that defines "nearly full" --
    // SDSPACE just reports raw numbers. Hysteresis (re-arms below 85%) means it
    // won't fire again on every single take once already over the line.
    _maybeWarnSdSpace(space) {
        if (!space) return;
        if (space.pct < 85) { this._sdSpaceWarned = false; return; }
        if (space.pct < 90 || this._sdSpaceWarned) return;
        this._sdSpaceWarned = true;
        const freeMB = Math.round(space.freeBytes / (1024 * 1024));
        alert(`SCM: SD card is ${space.pct}% full (${freeMB}MB free) — recordings may soon fail to save.`);
    }

    // Live input-peak meter while device-recording -- reuses the same inputPeak the
    // firmware already streams to its own hardware VU LED (see METER command / MTR:
    // lines in DeviceController). Clip state holds briefly so a short transient over
    // 0dBFS is still visible, not just a one-frame flash.
    _updateDeviceMeter(peak) {
        // Accumulate into a low-res placeholder waveform for the recording slot --
        // see the 'idle' case above, where this becomes slot.peaks. Independent of
        // the visual fill/clip handling below so it still captures the take even if
        // the meter element itself is ever missing.
        if (this._deviceRecordingPeaks) {
            this._deviceRecordingPeaks.push(peak, -peak);
            // Live-draw the same accumulating peaks onto the main waveform view,
            // not just the mini slot canvas -- same drawMiniFromPeaks() call, just
            // a bigger canvas. Cleared back to the empty state once recording ends
            // (see the 'idle' case) rather than left showing a frozen last frame,
            // since there's no "selected device recording" load path for the main
            // view yet (only the mini slot canvas persists that, via slot.peaks).
            const mainCanvas = document.getElementById('waveform');
            if (mainCanvas) WaveformRenderer.drawMiniFromPeaks(mainCanvas, this._deviceRecordingPeaks, 'rgba(59,130,246,0.7)');
        }

        const status = document.getElementById('device-status');
        if (status) status.textContent = `Recording… (peak ${peak.toFixed(2)})`;

        const fill = document.getElementById('device-level-meter-fill');
        if (!fill) return;
        fill.style.height = `${Math.max(0, Math.min(100, peak * 100))}%`;
        if (peak >= 0.98) this._deviceClipUntil = Date.now() + 1000;
        fill.classList.toggle('clip', Date.now() < (this._deviceClipUntil || 0));
    }

    // Reuses the existing rename-dialog UI (same modal local recordings use) — the
    // OK/Cancel handlers in bindUI() branch on dialog._devicePath to call FMOVE
    // instead of the local slot rename.
    _showDeviceRenameDialog(path, slotIndex) {
        const dialog = document.getElementById('rename-dialog');
        const input = document.getElementById('rename-input');
        const base = path.split('/').pop().replace(/\.wav$/i, '');
        dialog._devicePath = path;
        dialog._deviceSlotIndex = slotIndex;
        // maxlength on the input only constrains typing, not this programmatic
        // assignment -- cap here too so what's shown always matches what'll be saved.
        input.value = capSlotName(base);
        dialog.hidden = false;
        setTimeout(() => input.focus(), 50);
    }

    _openDmxTestDialog() {
        const dlg = document.getElementById('dmx-dialog');
        if (!dlg) return;
        // Close the main menu so the dialog isn't obscured
        this._closeMainMenu();
        dlg.hidden = false;
        this._buildDmxSliders();
    }

    _closeDmxTestDialog() {
        const dlg = document.getElementById('dmx-dialog');
        if (dlg) dlg.hidden = true;
    }

    _buildDmxSliders() {
        const container = document.getElementById('dmx-sliders');
        if (!container || !this.dmx) return;
        const startInput = document.getElementById('dmx-ch-start');
        const countInput = document.getElementById('dmx-ch-count');
        const start = Math.max(1, Math.min(512, parseInt(startInput.value) || 1));
        const count = Math.max(1, Math.min(512 - start + 1, parseInt(countInput.value) || 24));
        startInput.value = start;
        countInput.value = count;

        container.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const ch = start + i;
            const row = document.createElement('div');
            row.className = 'dmx-slider-row';

            const label = document.createElement('span');
            label.className = 'dmx-ch-label';
            label.textContent = ch;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = 0;
            slider.max = 255;
            slider.value = this.dmx.getChannel(ch);
            slider.dataset.channel = ch;

            const val = document.createElement('span');
            val.className = 'dmx-ch-val';
            val.textContent = slider.value;

            slider.addEventListener('input', () => {
                const v = parseInt(slider.value);
                this.dmx.setChannel(ch, v);
                val.textContent = v;
            });

            row.appendChild(label);
            row.appendChild(slider);
            row.appendChild(val);
            container.appendChild(row);
        }
    }

    _zeroDmxVisible() {
        const container = document.getElementById('dmx-sliders');
        if (!container || !this.dmx) return;
        container.querySelectorAll('input[type=range]').forEach(s => {
            const ch = parseInt(s.dataset.channel);
            this.dmx.setChannel(ch, 0);
            s.value = 0;
            const val = s.nextElementSibling;
            if (val) val.textContent = '0';
        });
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
            // Pad mode: map note to pad via selected note map
            const padMap = this.midi.mapNoteToPad(midiNote);
            if (padMap < 0) return;
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
            const padMap = this.midi.mapNoteToPad(midiNote);
            if (padMap < 0) return;
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
        const mapSel = document.getElementById('midi-notemap-select');
        if (mapSel) mapSel.value = this.midi.noteMap;
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

        // Show back + PAD PLAY in toolbar
        document.getElementById('kit-back-btn').hidden = false;
        document.getElementById('kit-back-sep').hidden = false;
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

        // Hide back + PAD PLAY in toolbar
        document.getElementById('kit-back-btn').hidden = true;
        document.getElementById('kit-back-sep').hidden = true;
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
                const buf = this._kitSlotBuffers[i];
                const ctx = this.audio.audioContext;
                if (!buf || !ctx) return;
                e.preventDefault();
                // Velocity: prefer real pressure, fall back to contact area proxy
                let vel = 0.8;
                if (e.pressure > 0 && e.pressure !== 0.5) {
                    vel = Math.max(0.1, e.pressure);
                } else {
                    const area = (e.width || 1) * (e.height || 1);
                    if (area > 4) vel = Math.min(1, Math.max(0.15, area / 400));
                }
                // Play directly via AudioContext — bypasses sampler, proven to work
                const play = () => {
                    const source = ctx.createBufferSource();
                    source.buffer = buf;
                    const gain = ctx.createGain();
                    gain.gain.value = vel;
                    source.connect(gain);
                    gain.connect(this.audio.getEffectsBus() || ctx.destination);
                    source.start();
                };
                if (ctx.state === 'suspended') {
                    ctx.resume().then(play);
                } else {
                    play();
                }
                el.classList.add('kit-triggered');
                setTimeout(() => el.classList.remove('kit-triggered'), 80);
            });

            el.addEventListener('click', (e) => {
                if (el._longPressFired) { el._longPressFired = false; e.stopPropagation(); return; }
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
                if (e.button !== 0) return;
                if (this._sampleMode) this.sample.samplePadTap(i);
                else if (!this._seqMode) {
                    // Long-press for context menu on desktop without right-click (e.g. macOS single-button)
                    longPressTimer = setTimeout(() => {
                        longPressTimer = null;
                        el._longPressFired = true;
                        document.addEventListener('click', (ev) => { ev.stopPropagation(); }, { capture: true, once: true });
                        this.onSlotContext(i, { preventDefault: () => {}, clientX: e.clientX, clientY: e.clientY });
                    }, 500);
                }
            });
            el.addEventListener('mouseup', () => {
                if (usedTouch) return;
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
                if (this._sampleMode) this.sample.samplePadRelease(i);
            });
            el.addEventListener('mouseleave', () => {
                if (usedTouch) return;
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
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
                        document.addEventListener('click', (ev) => { ev.stopPropagation(); }, { capture: true, once: true });
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
