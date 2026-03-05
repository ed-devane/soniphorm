// sample-controller.js — Sampler mode controller (extracted from app.js)

class SampleController {
    constructor(app) {
        this.app = app;
        this._sampleSelectedPad = 0;
        this._keysDown = new Set();
        this._chromaticMode = false;
        this._chromaticBaseOctave = 3;
        this._chromaticOctaveSpan = 3;
        this._envNodesAmp = [];
        this._envNodesPitch = [];
        this._envDragging = -1;
        this._envDragTarget = null;
    }

    // === Sampler Init ===

    _initSampler() {
        this.app.sampler = new Sampler(null);

        this.app.sampler.getSlotBuffer = (slotIndex) => {
            return this.app._slotBuffers[slotIndex] || null;
        };

        this.app.sampler.onTrigger = (slotIndex) => {
            this._sampleHighlightPad(slotIndex, true);
        };
        this.app.sampler.onRelease = (slotIndex) => {
            this._sampleHighlightPad(slotIndex, false);
        };

        // Keyboard events
        document.addEventListener('keydown', (e) => this._onKeyDown(e));
        document.addEventListener('keyup', (e) => this._onKeyUp(e));

        this._loadSamplerConfig();
    }

    _onKeyDown(e) {
        // Allow in sample mode, gen mode, or in seq mode during recording
        if (!this.app._sampleMode && !this.app._genMode && !(this.app._seqMode && this.app._seqRecording)) return;
        // Ignore if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        if (e.repeat) return; // ignore key repeat

        const padIdx = this.app.sampler.keyMap[e.code];
        if (padIdx !== undefined) {
            e.preventDefault();
            this._keysDown.add(e.code);
            this.app.sampler.trigger(padIdx);
            // Record to current step if recording
            if (this.app._seqRecording && this.app.sequencer.playing) {
                this.app.seq._recordPadToStep(padIdx, undefined, 'pad-' + padIdx);
            }
        }
    }

    _onKeyUp(e) {
        if (!this.app._sampleMode && !this.app._genMode && !(this.app._seqMode && this.app._seqRecording)) return;
        const padIdx = this.app.sampler.keyMap[e.code];
        if (padIdx !== undefined && this._keysDown.has(e.code)) {
            e.preventDefault();
            this._keysDown.delete(e.code);
            // Record note-off for duration tracking
            if (this.app._seqRecording && this.app.sequencer.playing) {
                this.app.seq._recordNoteOff('pad-' + padIdx);
            }
            this.app.sampler.release(padIdx);
        }
    }

    // === Lifecycle ===

    async enter() {
        this.app._sampleMode = true;
        if (this.app.audio.audioContext) {
            this.app.sampler.audioContext = this.app.audio.audioContext;
            this.app.sampler.outputNode = this.app.audio.getEffectsBus();
        }
        if (this.app._kitMode) {
            await this.app._preloadKitBuffers(this.app._kitParentSlot);
            this.app._buildKitGrid();
            this.app._renderKitGrid();
        } else {
            await this.app.seq._seqPreloadBuffers();
            this.app.buildSlotGrid();
            this.renderSampleGrid();
        }
    }

    exit(targetMode) {
        this.app.sampler.stopAll();
        this._keysDown.clear();
        this.app._seqShowTransportInSample = false;
        if (this._chromaticMode) {
            this._chromaticMode = false;
            this.app.waveform.chromaticMode = false;
            this._unbindChromaticEvents();
            document.getElementById('pad-mode-keys').classList.remove('keys-on');
        }
        if (targetMode !== 'seq' && this.app.sequencer && this.app.sequencer.playing) {
            this.app.sequencer.stop();
            this.app.seq._seqStopAnimation();
        }
        this.app._sampleMode = false;
    }

    // === Sample Grid ===

    renderSampleGrid() {
        // Kit mode: delegate to kit-specific renderer
        if (this.app._kitMode) {
            this.app._renderKitGrid();
            return;
        }

        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');

        slotEls.forEach((el, i) => {
            const slot = this.app.slots.slots[i];
            const pad = this.app.sampler.pads[i];

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
            if (this.app.sampler.isPlaying(i)) el.classList.add('pad-playing');

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
            keyEl.textContent = this.app.sampler.keyLabels[i];

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
        } else if (this.app.sampler.isPlaying(slotIndex)) {
            el.classList.add('pad-playing');
        }
    }

    _updateSamplerLoopFromMarkers(loop) {
        const padIdx = this._sampleSelectedPad;
        const pad = this.app.sampler.pads[padIdx];
        const buf = this.app._slotBuffers[padIdx];
        if (!buf) return;
        const sr = buf.sampleRate;
        pad.loopStart = loop.start / sr;
        pad.loopEnd = loop.end / sr;
        this.app.sampler.updateLoopRegion(padIdx, pad.loopStart, pad.loopEnd);
        this._saveSamplerConfig();
    }

    _updateSamplerRegionFromSelection() {
        // Update all playing looping voices with the current waveform selection
        for (let i = 0; i < 16; i++) {
            if (!this.app.sampler.isPlaying(i)) continue;
            const sel = this.app.waveform ? this.app.waveform.getSelection() : null;
            const buf = this.app._slotBuffers[i];
            if (sel && buf) {
                this.app.sampler.updateRegion(i, sel.start / buf.sampleRate, sel.end / buf.sampleRate);
            } else if (buf) {
                this.app.sampler.updateRegion(i, 0, -1);
            }
        }
    }

    // Pad tap handling (from onSlotTap)
    async samplePadTap(index, e) {
        // Kit mode: trigger kit sub-sample
        if (this.app._kitMode) {
            const meta = this.app.slots.getKitSlotMeta(this.app._kitParentSlot, index);
            if (!meta || !meta.hasAudio) return;

            if (index !== this._sampleSelectedPad) {
                this._sampleSelectedPad = index;
                this.app._kitSelectedSub = index;
                const data = await this.app.slots.getKitSlotAudio(this.app._kitParentSlot, index);
                if (data) {
                    this.app.channels = data.channels;
                    this.app.bufferSampleRate = data.sampleRate;
                    this.app.waveform.setAudio(this.app.channels, this.app.bufferSampleRate);
                    document.getElementById('waveform-empty').hidden = true;
                }
                this.app.updateTransportInfo();
            }

            this._updateSampleTransport();
            this.app._renderKitGrid();
            this.app.sampler.trigger(index);
            if (this.app._seqRecording && this.app.sequencer.playing) {
                this.app.seq._recordPadToStep(index, undefined, 'pad-' + index);
            }
            return;
        }

        if (!this.app.slots.slots[index].hasAudio) return;

        // Load this slot's audio into the waveform if switching pads
        if (index !== this._sampleSelectedPad) {
            this._sampleSelectedPad = index;
            const data = await this.app.slots.getSlotAudio(index);
            if (data) {
                this.app.channels = data.channels;
                this.app.bufferSampleRate = data.sampleRate;
                this.app.waveform.setAudio(this.app.channels, this.app.bufferSampleRate);
                document.getElementById('waveform-empty').hidden = true;
            }
            this.app.slots.selectSlot(index);
            this.app.updateTransportInfo();
        }

        // Pass waveform selection as playback region
        const pad = this.app.sampler.pads[index];
        const sel = this.app.waveform ? this.app.waveform.getSelection() : null;
        const buf = this.app._slotBuffers[index];
        if (sel && buf) {
            const sr = buf.sampleRate;
            pad.regionStart = sel.start / sr;
            pad.regionEnd = sel.end / sr;
        } else {
            pad.regionStart = 0;
            pad.regionEnd = -1;
        }

        // Apply waveform loop markers to pad if present
        if (this.app.waveform && buf) {
            const loopMarkers = this.app.waveform.getLoopMarkers();
            if (loopMarkers && pad.mode === 'loop') {
                const sr = buf.sampleRate;
                pad.loopStart = loopMarkers.start / sr;
                pad.loopEnd = loopMarkers.end / sr;
            }
        }

        this._updateSampleTransport();
        this.renderSampleGrid();
        this.app.sampler.trigger(index);

        // Record to sequencer if looper recording is armed
        if (this.app._seqRecording && this.app.sequencer.playing) {
            this.app.seq._recordPadToStep(index, undefined, 'pad-' + index);
        }
    }

    samplePadRelease(index) {
        // Record note-off for duration tracking
        if (this.app._seqRecording && this.app.sequencer.playing) {
            this.app.seq._recordNoteOff('pad-' + index);
        }
        this.app.sampler.release(index);
    }

    // === Pad Mode Config ===

    setPadMode(mode) {
        const pad = this.app.sampler.pads[this._sampleSelectedPad];
        pad.mode = mode;

        // Update toggle active states
        document.getElementById('pad-mode-oneshot').classList.toggle('active', mode === 'oneshot');
        document.getElementById('pad-mode-loop').classList.toggle('active', mode === 'loop');
        document.getElementById('pad-mode-gate').classList.toggle('active', mode === 'gate');

        // Show/hide loop markers
        if (this.app.waveform) {
            if (mode === 'loop') {
                this.app.waveform.setLoopVisible(true);
                if (pad.loopStart >= 0 && pad.loopEnd >= 0) {
                    const buf = this.app._slotBuffers[this._sampleSelectedPad];
                    if (buf) {
                        this.app.waveform.setLoopMarkers(
                            Math.round(pad.loopStart * buf.sampleRate),
                            Math.round(pad.loopEnd * buf.sampleRate)
                        );
                    }
                }
            } else {
                this.app.waveform.setLoopVisible(false);
                this.app.waveform.clearLoopMarkers();
            }
        }

        this.app.sampler.invalidateMorphCache();
        this.renderSampleGrid();
        this._saveSamplerConfig();
    }

    _togglePadReverse() {
        const padIdx = this._sampleSelectedPad;
        const pad = this.app.sampler.pads[padIdx];
        pad.reverse = !pad.reverse;
        this.app.sampler.invalidateReverseBuffer(padIdx);
        document.getElementById('pad-mode-rev').classList.toggle('rev-on', pad.reverse);
        this._saveSamplerConfig();
    }

    _populateMorphTargets() {
        const select = document.getElementById('morph-target');
        const pad = this.app.sampler.pads[this._sampleSelectedPad];
        select.innerHTML = '';
        for (let i = 0; i < 16; i++) {
            if (i === this._sampleSelectedPad) continue;
            if (!this.app.slots.slots[i].hasAudio) continue;
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `${String(i + 1).padStart(2, '0')} — ${this.app.slots.slots[i].name || 'untitled'}`;
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
        const pad = this.app.sampler.pads[this._sampleSelectedPad];
        const targetVal = parseInt(document.getElementById('morph-target').value);
        pad.morphTarget = isNaN(targetVal) ? null : targetVal;
        pad.morphType = document.getElementById('morph-type').value;
        pad.morphAmount = parseInt(document.getElementById('morph-amount').value) / 100;
        this.app.sampler.invalidateMorphCache();
        this._saveSamplerConfig();
    }

    _updateSampleTransport() {
        const pad = this.app.sampler.pads[this._sampleSelectedPad];
        const slot = this.app.slots.slots[this._sampleSelectedPad];
        const name = slot.hasAudio ? (slot.name || 'untitled') : 'empty';
        document.getElementById('sample-pad-info').textContent =
            `${String(this._sampleSelectedPad + 1).padStart(2, '0')} ${name}`;

        // Update ONE/LOOP/GATE toggle
        document.getElementById('pad-mode-oneshot').classList.toggle('active', pad.mode === 'oneshot');
        document.getElementById('pad-mode-loop').classList.toggle('active', pad.mode === 'loop');
        document.getElementById('pad-mode-gate').classList.toggle('active', pad.mode === 'gate');

        // Show/hide loop markers on waveform
        if (this.app.waveform) {
            if (pad.mode === 'loop' && pad.loopStart >= 0 && pad.loopEnd >= 0) {
                const buf = this.app._slotBuffers[this._sampleSelectedPad];
                if (buf) {
                    this.app.waveform.setLoopMarkers(
                        Math.round(pad.loopStart * buf.sampleRate),
                        Math.round(pad.loopEnd * buf.sampleRate)
                    );
                }
                this.app.waveform.setLoopVisible(true);
            } else if (pad.mode === 'loop') {
                this.app.waveform.clearLoopMarkers();
                this.app.waveform.setLoopVisible(true);
            } else {
                this.app.waveform.clearLoopMarkers();
                this.app.waveform.setLoopVisible(false);
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
        document.getElementById('panel-fx').hidden = (tabName !== 'fx');
        if (tabName === 'env') this._drawEnvelopes();

        // MORPH tab: enter morph mode and populate targets
        if (tabName === 'morph') {
            const pad = this.app.sampler.pads[this._sampleSelectedPad];
            pad.mode = 'morph';
            document.getElementById('pad-mode-oneshot').classList.remove('active');
            document.getElementById('pad-mode-loop').classList.remove('active');
            this._populateMorphTargets();
            this.app.sampler.invalidateMorphCache();
            this.renderSampleGrid();
            this._saveSamplerConfig();
        }
    }

    // === Pad Parameter Updates ===

    _updatePadEnv() {
        const idx = this._sampleSelectedPad;
        const pad = this.app.sampler.pads[idx];
        pad.pitch = parseInt(document.getElementById('pad-pitch').value);
        pad.volume = parseInt(document.getElementById('pad-volume').value) / 100;

        // Live-update pitch and volume on playing voice
        const voice = this.app.sampler._voices[idx];
        if (voice) {
            const now = this.app.sampler.audioContext.currentTime;
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
            const pad = this.app.sampler.pads[this._sampleSelectedPad];
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
        const pad = this.app.sampler.pads[this._sampleSelectedPad];
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
        const pad = this.app.sampler.pads[this._sampleSelectedPad];
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

        const pad = this.app.sampler ? this.app.sampler.pads[this._sampleSelectedPad] : null;
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
        const pad = this.app.sampler.pads[idx];
        pad.filterEnabled = !pad.filterEnabled;
        const btn = document.getElementById('pad-filter-toggle');
        btn.textContent = pad.filterEnabled ? 'ON' : 'OFF';
        btn.classList.toggle('active', pad.filterEnabled);

        // Live-update: toggling filter requires retrigger since we can't
        // insert/remove a node from a playing chain. Update existing filter if present.
        const voice = this.app.sampler._voices[idx];
        if (voice && voice.filter) {
            const now = this.app.sampler.audioContext.currentTime;
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
        const pad = this.app.sampler.pads[idx];
        pad.filterType = document.getElementById('pad-filter-type').value;
        pad.filterFreq = this._freqFromSlider(parseInt(document.getElementById('pad-filter-freq').value));
        pad.filterQ = parseInt(document.getElementById('pad-filter-q').value) / 10;

        // Live-update filter on playing voice
        const voice = this.app.sampler._voices[idx];
        if (voice && voice.filter && pad.filterEnabled) {
            const now = this.app.sampler.audioContext.currentTime;
            voice.filter.type = pad.filterType;
            voice.filter.frequency.setValueAtTime(pad.filterFreq, now);
            voice.filter.Q.setValueAtTime(pad.filterQ, now);
        }

        document.getElementById('pad-filter-freq-val').textContent = pad.filterFreq;
        document.getElementById('pad-filter-q-val').textContent = pad.filterQ.toFixed(1);
        this._saveSamplerConfig();
    }

    _togglePadLfo() {
        const pad = this.app.sampler.pads[this._sampleSelectedPad];
        pad.lfoEnabled = !pad.lfoEnabled;
        const btn = document.getElementById('pad-lfo-toggle');
        btn.textContent = pad.lfoEnabled ? 'ON' : 'OFF';
        btn.classList.toggle('active', pad.lfoEnabled);
        this._saveSamplerConfig();
    }

    _updatePadLfo() {
        const pad = this.app.sampler.pads[this._sampleSelectedPad];
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
            this.app.waveform.chromaticMode = true;
            canvas.style.display = '';
            document.getElementById('waveform-empty').hidden = true;
            this._renderPianoKeyboard();
            this._bindChromaticEvents();
        } else {
            this.app.waveform.chromaticMode = false;
            this._unbindChromaticEvents();
            // Restore normal waveform display
            if (this.app.channels) {
                this.app.waveform.setAudio(this.app.channels, this.app.bufferSampleRate);
            } else {
                this.app.waveform.clear();
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
        if (!this.app.sampler || !this.app.slots.slots[padIdx].hasAudio) return;

        // Release previous held note if different
        if (this._chromaticHeldNote !== undefined && this._chromaticHeldNote !== null && this._chromaticHeldNote !== noteIdx) {
            this.app.sampler.release(padIdx);
        }

        this._chromaticHeldNote = noteIdx;
        this._renderPianoKeyboard();

        // Temporarily set pitch and trigger with loop for sustain
        const pad = this.app.sampler.pads[padIdx];
        const originalPitch = pad.pitch;
        const originalMode = pad.mode;
        pad.pitch = semitones;
        pad.mode = 'gate'; // gate mode so release stops the sound
        this.app.sampler._stopVoice(padIdx);
        const buffer = this.app.sampler._getPlayBuffer(padIdx);
        if (buffer) {
            this.app.sampler._startVoice(padIdx, buffer, true);
        }
        // Restore original settings — _startVoice reads them synchronously
        pad.pitch = originalPitch;
        pad.mode = originalMode;
        if (this.app.sampler.onTrigger) this.app.sampler.onTrigger(padIdx);

        // Record to sequencer if looper recording is armed
        // Store pitch relative to pad's base pitch, since sequencer adds pad.pitch on playback
        if (this.app._seqRecording && this.app.sequencer.playing) {
            this.app.seq._recordPadToStep(padIdx, semitones - pad.pitch, 'chromatic-' + noteIdx);
        }
    }

    _chromaticReleaseNote() {
        const padIdx = this._sampleSelectedPad;
        if (this._chromaticHeldNote !== undefined && this._chromaticHeldNote !== null) {
            // Record note-off for duration tracking
            if (this.app._seqRecording && this.app.sequencer.playing) {
                this.app.seq._recordNoteOff('chromatic-' + this._chromaticHeldNote);
            }
            const pad = this.app.sampler.pads[padIdx];
            this.app.sampler._fadeOutVoice(padIdx, pad.release);
            if (this.app.sampler.onRelease) this.app.sampler.onRelease(padIdx);
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

    // === Config Persistence ===

    _saveSamplerConfig() {
        if (this.app._kitMode) {
            this.app._saveKitPadConfig();
            return;
        }
        try {
            localStorage.setItem('soniphorm-sampler', JSON.stringify(this.app.sampler.toJSON()));
        } catch (e) {
            console.warn('Failed to save sampler config:', e);
        }
    }

    _loadSamplerConfig() {
        try {
            const json = localStorage.getItem('soniphorm-sampler');
            if (json) this.app.sampler.fromJSON(JSON.parse(json));
        } catch (e) {
            console.warn('Failed to load sampler config:', e);
        }
    }
}
