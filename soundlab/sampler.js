/**
 * Sampler — Drum-machine / pad-trigger engine for Soniphorm Soundlab.
 * Plain JS class (no ES modules). Uses Web Audio API + DSP.js.
 *
 * Features:
 *   - 16 pads with keyboard mapping (4x4: 1-4 / Q-R / A-F / Z-V)
 *   - Play modes: oneshot, loop, gate (hold-to-play), morph
 *   - Per-pad ADSR envelope, volume, biquad filter, LFO
 *   - Morph mode: real-time creative inter-sample processing
 *   - Voice management with per-pad polyphony control
 */
class Sampler {
    constructor(audioContext) {
        this.audioContext = audioContext;

        // Per-pad configuration
        this.pads = [];
        for (let i = 0; i < 16; i++) {
            this.pads.push(Sampler.defaultPad());
        }

        // Active voices: slotIndex -> voice object
        this._voices = {};

        // Morph buffer cache: key -> AudioBuffer
        this._morphCache = {};

        // Keyboard mapping (code -> pad index)
        this.keyMap = {
            'Digit1': 0,  'Digit2': 1,  'Digit3': 2,  'Digit4': 3,
            'KeyQ': 4,    'KeyW': 5,    'KeyE': 6,    'KeyR': 7,
            'KeyA': 8,    'KeyS': 9,    'KeyD': 10,   'KeyF': 11,
            'KeyZ': 12,   'KeyX': 13,   'KeyC': 14,   'KeyV': 15
        };
        this.keyLabels = [
            '1','2','3','4',
            'Q','W','E','R',
            'A','S','D','F',
            'Z','X','C','V'
        ];

        // Callbacks
        this.getSlotBuffer = null;  // (slotIndex) => AudioBuffer | null
        this.onTrigger = null;      // (slotIndex)
        this.onRelease = null;      // (slotIndex)
    }

    static defaultPad() {
        return {
            mode: 'oneshot',
            morphTarget: null,
            morphType: 'ring',
            morphAmount: 0.5,
            pitch: 0,
            volume: 1.0,
            attack: 0.01,
            decay: 0.1,
            sustain: 1.0,
            release: 0.05,
            filterEnabled: false,
            filterType: 'lowpass',
            filterFreq: 2000,
            filterQ: 1.0,
            lfoEnabled: false,
            lfoTarget: 'filter',
            lfoRate: 2.0,
            lfoDepth: 0.5,
            lfoShape: 'sine',
            regionStart: 0,
            regionEnd: -1
        };
    }

    // === Triggering ===

    trigger(slotIndex) {
        if (!this.audioContext) return;
        const pad = this.pads[slotIndex];

        if (pad.mode === 'morph') {
            this._stopVoice(slotIndex);
            const buf = this._getMorphBuffer(slotIndex);
            if (buf) this._startVoice(slotIndex, buf, false);
        } else {
            const buffer = this._getPlayBuffer(slotIndex);
            if (!buffer) return;

            switch (pad.mode) {
                case 'oneshot':
                    this._stopVoice(slotIndex);
                    this._startVoice(slotIndex, buffer, false);
                    break;
                case 'loop':
                    if (this._voices[slotIndex]) {
                        this._fadeOutVoice(slotIndex, pad.release);
                    } else {
                        this._startVoice(slotIndex, buffer, true);
                    }
                    break;
                case 'gate':
                    this._stopVoice(slotIndex);
                    this._startVoice(slotIndex, buffer, true);
                    break;
            }
        }

        if (this.onTrigger) this.onTrigger(slotIndex);
    }

    release(slotIndex) {
        const pad = this.pads[slotIndex];
        if (pad.mode === 'gate') {
            this._fadeOutVoice(slotIndex, pad.release);
        }
        if (this.onRelease) this.onRelease(slotIndex);
    }

    isPlaying(slotIndex) {
        return !!this._voices[slotIndex];
    }

    stopAll() {
        for (const idx of Object.keys(this._voices)) {
            this._stopVoice(parseInt(idx));
        }
    }

    // === Voice Management ===

    updateRegion(slotIndex, regionStart, regionEnd) {
        const voice = this._voices[slotIndex];
        if (!voice || !voice.source.loop) return;
        const buf = voice.source.buffer;
        if (!buf) return;
        const pad = this.pads[slotIndex];
        pad.regionStart = regionStart;
        pad.regionEnd = regionEnd;
        const regEnd = (regionEnd > 0) ? Math.min(regionEnd, buf.duration) : buf.duration;
        voice.source.loopStart = regionStart;
        voice.source.loopEnd = regEnd;
    }

    _startVoice(slotIndex, buffer, loop) {
        const pad = this.pads[slotIndex];
        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // 1. BufferSource
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = loop;
        if (pad.pitch !== 0) {
            source.playbackRate.setValueAtTime(Math.pow(2, pad.pitch / 12), now);
        }

        // Region bounds
        const regStart = pad.regionStart || 0;
        const regEnd = (pad.regionEnd > 0) ? Math.min(pad.regionEnd, buffer.duration) : buffer.duration;
        const regDuration = regEnd - regStart;

        if (loop) {
            source.loopStart = regStart;
            source.loopEnd = regEnd;
        }

        // Build chain: source -> [filter] -> envelopeGain -> volumeGain -> destination
        let lastNode = source;
        let filter = null;
        let lfo = null;
        let lfoGain = null;

        // 2. Optional BiquadFilter
        if (pad.filterEnabled) {
            filter = ctx.createBiquadFilter();
            filter.type = pad.filterType;
            filter.frequency.setValueAtTime(pad.filterFreq, now);
            filter.Q.setValueAtTime(pad.filterQ, now);
            lastNode.connect(filter);
            lastNode = filter;
        }

        // 3. Envelope gain (ADSR)
        const envelopeGain = ctx.createGain();
        envelopeGain.gain.setValueAtTime(0, now);
        // Attack: ramp to 1
        envelopeGain.gain.linearRampToValueAtTime(1.0, now + pad.attack);
        // Decay: ramp to sustain level
        envelopeGain.gain.linearRampToValueAtTime(pad.sustain, now + pad.attack + pad.decay);

        lastNode.connect(envelopeGain);
        lastNode = envelopeGain;

        // 4. Volume gain
        const volumeGain = ctx.createGain();
        volumeGain.gain.setValueAtTime(pad.volume, now);
        lastNode.connect(volumeGain);
        lastNode = volumeGain;

        // 5. Connect to destination
        lastNode.connect(ctx.destination);

        // 6. Optional LFO
        let posLfoInterval = null;
        if (pad.lfoEnabled && pad.lfoDepth > 0) {
            if (pad.lfoTarget === 'position' && loop) {
                // Position LFO: timer-based modulation of loopStart/loopEnd
                const windowSize = regDuration;
                const maxShift = Math.max(0, (buffer.duration - windowSize) * pad.lfoDepth);
                const lfoRate = pad.lfoRate;
                const lfoShape = pad.lfoShape;
                const startTimeRef = now;

                if (maxShift > 0) {
                    posLfoInterval = setInterval(() => {
                        const elapsed = ctx.currentTime - startTimeRef;
                        const phase = elapsed * lfoRate * 2 * Math.PI;
                        let lfoValue; // -1 to 1
                        switch (lfoShape) {
                            case 'sine':     lfoValue = Math.sin(phase); break;
                            case 'square':   lfoValue = Math.sin(phase) >= 0 ? 1 : -1; break;
                            case 'sawtooth': lfoValue = 2 * ((elapsed * lfoRate) % 1) - 1; break;
                            case 'triangle': {
                                const t = (elapsed * lfoRate) % 1;
                                lfoValue = t < 0.5 ? (4 * t - 1) : (3 - 4 * t);
                                break;
                            }
                            default: lfoValue = Math.sin(phase);
                        }
                        const offset = maxShift * (lfoValue * 0.5 + 0.5);
                        source.loopStart = offset;
                        source.loopEnd = offset + windowSize;
                    }, 30);
                }
            } else if (pad.lfoTarget !== 'position') {
                lfo = ctx.createOscillator();
                lfo.type = pad.lfoShape;
                lfo.frequency.setValueAtTime(pad.lfoRate, now);

                lfoGain = ctx.createGain();

                switch (pad.lfoTarget) {
                    case 'filter':
                        if (filter) {
                            // LFO depth in Hz: scale by frequency * depth
                            lfoGain.gain.setValueAtTime(pad.filterFreq * pad.lfoDepth, now);
                            lfo.connect(lfoGain);
                            lfoGain.connect(filter.frequency);
                        }
                        break;
                    case 'volume':
                        // Tremolo: modulate volumeGain
                        lfoGain.gain.setValueAtTime(pad.volume * pad.lfoDepth, now);
                        lfo.connect(lfoGain);
                        lfoGain.connect(volumeGain.gain);
                        break;
                    case 'pitch':
                        // Vibrato: modulate source detune (cents)
                        lfoGain.gain.setValueAtTime(pad.lfoDepth * 100, now); // up to 100 cents
                        lfo.connect(lfoGain);
                        lfoGain.connect(source.detune);
                        break;
                }
                lfo.start(now);
            }
        }

        // Start source
        if (regStart > 0 || regEnd < buffer.duration) {
            if (loop) {
                source.start(now, regStart);
            } else {
                source.start(now, regStart, regDuration);
            }
        } else {
            source.start(now);
        }

        source.onended = () => {
            if (this._voices[slotIndex] && this._voices[slotIndex].source === source) {
                delete this._voices[slotIndex];
                if (this.onRelease) this.onRelease(slotIndex);
            }
        };

        this._voices[slotIndex] = { source, envelopeGain, volumeGain, filter, lfo, lfoGain, posLfoInterval, startTime: now };
    }

    _stopVoice(slotIndex) {
        const voice = this._voices[slotIndex];
        if (voice) {
            try { voice.source.stop(); } catch (e) {}
            if (voice.lfo) {
                try { voice.lfo.stop(); } catch (e) {}
            }
            if (voice.posLfoInterval) {
                clearInterval(voice.posLfoInterval);
            }
            delete this._voices[slotIndex];
        }
    }

    _fadeOutVoice(slotIndex, duration) {
        const voice = this._voices[slotIndex];
        if (!voice) return;
        const now = this.audioContext.currentTime;
        const dur = Math.max(0.005, duration);

        // Release envelope: cancel scheduled and ramp to 0
        voice.envelopeGain.gain.cancelScheduledValues(now);
        voice.envelopeGain.gain.setValueAtTime(voice.envelopeGain.gain.value, now);
        voice.envelopeGain.gain.linearRampToValueAtTime(0, now + dur);

        // Schedule stop after release
        voice.source.stop(now + dur + 0.01);
        if (voice.lfo) {
            voice.lfo.stop(now + dur + 0.01);
        }
        if (voice.posLfoInterval) {
            clearInterval(voice.posLfoInterval);
        }
        delete this._voices[slotIndex];
    }

    // === Buffer Access ===

    _getPlayBuffer(slotIndex) {
        return this.getSlotBuffer ? this.getSlotBuffer(slotIndex) : null;
    }

    _getMorphBuffer(slotIndex) {
        const pad = this.pads[slotIndex];
        if (pad.morphTarget === null || isNaN(pad.morphTarget)) {
            return this._getPlayBuffer(slotIndex);
        }

        const bufA = this._getPlayBuffer(slotIndex);
        const bufB = this._getPlayBuffer(pad.morphTarget);
        if (!bufA) return null;
        if (!bufB) return bufA;

        const key = `${slotIndex}-${pad.morphTarget}-${pad.morphType}-${Math.round(pad.morphAmount * 100)}`;
        if (this._morphCache[key]) return this._morphCache[key];

        try {
            const result = this._renderMorph(bufA, bufB, pad.morphType, pad.morphAmount);
            if (result) {
                this._morphCache[key] = result;
                return result;
            }
        } catch (e) {
            console.warn('Morph render failed:', e);
        }
        return bufA;
    }

    invalidateMorphCache() {
        this._morphCache = {};
    }

    // === Morph Engine ===

    _renderMorph(bufA, bufB, type, amount) {
        const a = bufA.getChannelData(0);
        const b = bufB.getChannelData(0);
        const len = Math.max(a.length, b.length);
        // Limit to ~5 seconds to keep rendering fast
        const maxLen = Math.min(len, bufA.sampleRate * 5);
        const sr = bufA.sampleRate;

        let result;
        switch (type) {
            case 'ring':    result = this._morphRing(a, b, maxLen, amount); break;
            case 'am':      result = this._morphAM(a, b, maxLen, amount); break;
            case 'spectral': result = this._morphSpectral(a, b, maxLen, sr, amount); break;
            case 'phase':   result = this._morphPhase(a, b, maxLen, sr, amount); break;
            case 'gate':    result = this._morphSpectralGate(a, b, maxLen, sr, amount); break;
            default: return null;
        }
        if (!result) return null;

        // Normalise
        let peak = 0;
        for (let i = 0; i < result.length; i++) {
            peak = Math.max(peak, Math.abs(result[i]));
        }
        if (peak > 0) {
            const gain = 0.9 / peak;
            for (let i = 0; i < result.length; i++) result[i] *= gain;
        }

        // Build AudioBuffer (copy mono to all channels)
        const numCh = bufA.numberOfChannels;
        const buf = this.audioContext.createBuffer(numCh, result.length, sr);
        buf.getChannelData(0).set(result);
        for (let ch = 1; ch < numCh; ch++) {
            buf.getChannelData(ch).set(result);
        }
        return buf;
    }

    _s(arr, i) {
        return i < arr.length ? arr[i] : 0;
    }

    _morphRing(a, b, len, amount) {
        const out = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            const sa = this._s(a, i);
            const sb = this._s(b, i);
            out[i] = sa * (1 - amount) + (sa * sb) * amount;
        }
        return out;
    }

    _morphAM(a, b, len, amount) {
        const out = new Float32Array(len);
        for (let i = 0; i < len; i++) {
            const sa = this._s(a, i);
            const sb = Math.abs(this._s(b, i));
            out[i] = sa * (1 - amount + amount * sb);
        }
        return out;
    }

    _morphSpectral(a, b, len, sr, amount) {
        const frameSize = 2048;
        const hop = frameSize / 2;
        const maxLen = Math.min(len, sr * 2);
        const padA = new Float32Array(maxLen);
        const padB = new Float32Array(maxLen);
        padA.set(a.subarray(0, Math.min(a.length, maxLen)));
        padB.set(b.subarray(0, Math.min(b.length, maxLen)));
        const win = DSP.hannWindow(frameSize);
        const bReal = new Float32Array(frameSize);
        const bImag = new Float32Array(frameSize);

        return DSP.ola(padA, frameSize, hop, hop, (real, imag, frameIdx) => {
            const bOff = frameIdx * hop;

            for (let i = 0; i < frameSize; i++) {
                const idx = bOff + i;
                bReal[i] = (idx < padB.length ? padB[idx] : 0) * win[i];
                bImag[i] = 0;
            }
            DSP.fft(bReal, bImag);

            for (let i = 0; i < frameSize; i++) {
                const magA = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
                const magB = Math.sqrt(bReal[i] * bReal[i] + bImag[i] * bImag[i]);
                const phaseA = Math.atan2(imag[i], real[i]);

                const mag = magA * (1 - amount) + magB * amount;
                real[i] = mag * Math.cos(phaseA);
                imag[i] = mag * Math.sin(phaseA);
            }
        });
    }

    _morphPhase(a, b, len, sr, amount) {
        const frameSize = 2048;
        const hop = frameSize / 2;
        const maxLen = Math.min(len, sr * 2);
        const padA = new Float32Array(maxLen);
        const padB = new Float32Array(maxLen);
        padA.set(a.subarray(0, Math.min(a.length, maxLen)));
        padB.set(b.subarray(0, Math.min(b.length, maxLen)));
        const win = DSP.hannWindow(frameSize);
        const bReal = new Float32Array(frameSize);
        const bImag = new Float32Array(frameSize);

        return DSP.ola(padA, frameSize, hop, hop, (real, imag, frameIdx) => {
            const bOff = frameIdx * hop;

            for (let i = 0; i < frameSize; i++) {
                const idx = bOff + i;
                bReal[i] = (idx < padB.length ? padB[idx] : 0) * win[i];
                bImag[i] = 0;
            }
            DSP.fft(bReal, bImag);

            for (let i = 0; i < frameSize; i++) {
                const magA = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
                const phaseA = Math.atan2(imag[i], real[i]);
                const phaseB = Math.atan2(bImag[i], bReal[i]);

                const phase = phaseA * (1 - amount) + phaseB * amount;
                real[i] = magA * Math.cos(phase);
                imag[i] = magA * Math.sin(phase);
            }
        });
    }

    _morphSpectralGate(a, b, len, sr, amount) {
        const frameSize = 2048;
        const hop = frameSize / 2;
        const maxLen = Math.min(len, sr * 2);
        const padA = new Float32Array(maxLen);
        const padB = new Float32Array(maxLen);
        padA.set(a.subarray(0, Math.min(a.length, maxLen)));
        padB.set(b.subarray(0, Math.min(b.length, maxLen)));
        const win = DSP.hannWindow(frameSize);
        const bReal = new Float32Array(frameSize);
        const bImag = new Float32Array(frameSize);

        return DSP.ola(padA, frameSize, hop, hop, (real, imag, frameIdx) => {
            const bOff = frameIdx * hop;

            for (let i = 0; i < frameSize; i++) {
                const idx = bOff + i;
                bReal[i] = (idx < padB.length ? padB[idx] : 0) * win[i];
                bImag[i] = 0;
            }
            DSP.fft(bReal, bImag);

            // Threshold from B's peak magnitude
            let maxMagB = 0;
            for (let i = 0; i < frameSize; i++) {
                const m = Math.sqrt(bReal[i] * bReal[i] + bImag[i] * bImag[i]);
                if (m > maxMagB) maxMagB = m;
            }
            const threshold = maxMagB * (1 - amount) * 0.1;

            for (let i = 0; i < frameSize; i++) {
                const magB = Math.sqrt(bReal[i] * bReal[i] + bImag[i] * bImag[i]);
                if (magB < threshold) {
                    real[i] *= 0.01;
                    imag[i] *= 0.01;
                }
            }
        });
    }

    // === Persistence ===

    toJSON() {
        return {
            pads: this.pads.map(p => ({
                mode: p.mode,
                morphTarget: p.morphTarget,
                morphType: p.morphType,
                morphAmount: p.morphAmount,
                pitch: p.pitch,
                volume: p.volume,
                attack: p.attack,
                decay: p.decay,
                sustain: p.sustain,
                release: p.release,
                filterEnabled: p.filterEnabled,
                filterType: p.filterType,
                filterFreq: p.filterFreq,
                filterQ: p.filterQ,
                lfoEnabled: p.lfoEnabled,
                lfoTarget: p.lfoTarget,
                lfoRate: p.lfoRate,
                lfoDepth: p.lfoDepth,
                lfoShape: p.lfoShape,
                regionStart: p.regionStart,
                regionEnd: p.regionEnd
            }))
        };
    }

    fromJSON(data) {
        if (!data || !data.pads) return;
        const def = Sampler.defaultPad();
        for (let i = 0; i < 16 && i < data.pads.length; i++) {
            const p = data.pads[i];
            if (p) {
                this.pads[i].mode = p.mode || def.mode;
                this.pads[i].morphTarget = p.morphTarget !== undefined ? p.morphTarget : def.morphTarget;
                this.pads[i].morphType = p.morphType || def.morphType;
                this.pads[i].morphAmount = p.morphAmount !== undefined ? p.morphAmount : def.morphAmount;
                this.pads[i].pitch = p.pitch !== undefined ? p.pitch : def.pitch;
                this.pads[i].volume = p.volume !== undefined ? p.volume : def.volume;
                this.pads[i].attack = p.attack !== undefined ? p.attack : def.attack;
                this.pads[i].decay = p.decay !== undefined ? p.decay : def.decay;
                this.pads[i].sustain = p.sustain !== undefined ? p.sustain : def.sustain;
                this.pads[i].release = p.release !== undefined ? p.release : def.release;
                this.pads[i].filterEnabled = p.filterEnabled !== undefined ? p.filterEnabled : def.filterEnabled;
                this.pads[i].filterType = p.filterType || def.filterType;
                this.pads[i].filterFreq = p.filterFreq !== undefined ? p.filterFreq : def.filterFreq;
                this.pads[i].filterQ = p.filterQ !== undefined ? p.filterQ : def.filterQ;
                this.pads[i].lfoEnabled = p.lfoEnabled !== undefined ? p.lfoEnabled : def.lfoEnabled;
                this.pads[i].lfoTarget = p.lfoTarget || def.lfoTarget;
                this.pads[i].lfoRate = p.lfoRate !== undefined ? p.lfoRate : def.lfoRate;
                this.pads[i].lfoDepth = p.lfoDepth !== undefined ? p.lfoDepth : def.lfoDepth;
                this.pads[i].lfoShape = p.lfoShape || def.lfoShape;
                this.pads[i].regionStart = p.regionStart !== undefined ? p.regionStart : def.regionStart;
                this.pads[i].regionEnd = p.regionEnd !== undefined ? p.regionEnd : def.regionEnd;
            }
        }
    }
}
