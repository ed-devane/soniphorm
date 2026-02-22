/**
 * Sequencer — 16-step sequencer engine for Soniphorm.
 * Plain JS class (no ES modules). Uses Web Audio API.
 * Load via <script> tag; the class is globally accessible.
 *
 * Each step's `slots` array contains objects: { slot: N, pitch: 0 }
 * so every slot on a step can have its own pitch (tape-style).
 */
class Sequencer {
    constructor(audioContext) {
        this.audioContext = audioContext;
        this.playing = false;
        this.bpm = 120;
        this.currentStep = -1;
        this.mutateEnabled = false;
        this.mutateAmount = 0.5;    // 0-1: controls probability of per-step mutation
        this.stutterEnabled = false;
        this.stutterAmount = 0.5;   // 0-1: controls retrigger speed (2x to 16x subdivisions)

        // Pattern: variable-length steps (16-64, default 16)
        this.stepCount = 16;
        this.pattern = [];
        for (let i = 0; i < this.stepCount; i++) {
            this.pattern.push({
                slots: [],              // array of { slot: N, pitch: 0 }
                mode: 'oneshot',        // 'oneshot' | 'loop'
                direction: 'forward'    // 'forward' | 'reverse'
            });
        }

        // Buffer cache: slotIndex → { forward: AudioBuffer, reverse: AudioBuffer }
        this._bufferCache = {};

        // Scheduling
        this._schedulerTimer = null;
        this._nextStepTime = 0;
        this._nextStepIndex = 0;
        this._lookahead = 0.1;
        this._scheduleInterval = 25;
        this._activeSources = [];

        // Tap tempo
        this._tapTimes = [];

        // Output routing (null = ctx.destination; set to effects bus for live FX)
        this.outputNode = null;

        // Callbacks
        this.onStepChange = null;
        this.onMutate = null;
        this.onPatternLoop = null;
        this.getSlotBuffer = null;
        this.getLoadedSlots = null;
        this.getPadSettings = null;  // (slotIndex) => pad object or null
        this.shouldPlaySlot = null;  // (slotIndex) => bool — for mute/solo
        this.shouldStutterSlot = null; // (slotIndex) => bool — per-slot stutter
        this.shouldMutateSlot = null;  // (slotIndex) => bool — per-slot mutate
    }

    get stepDuration() {
        return 60 / this.bpm / 4;
    }

    // === Transport ===

    play() {
        if (this.playing) return;
        if (!this.audioContext) return;
        this.playing = true;
        this._nextStepIndex = 0;
        this._nextStepTime = this.audioContext.currentTime + 0.05;
        this._schedulerTimer = setInterval(() => this._scheduler(), this._scheduleInterval);
    }

    stop() {
        this.playing = false;
        if (this._schedulerTimer) {
            clearInterval(this._schedulerTimer);
            this._schedulerTimer = null;
        }
        for (const src of this._activeSources) {
            try { src.stop(); } catch (e) {}
        }
        this._activeSources = [];
        this.currentStep = -1;
    }

    setBpm(bpm) {
        this.bpm = Math.max(20, Math.min(300, bpm));
    }

    tapTempo() {
        const now = performance.now();
        if (this._tapTimes.length >= 1 && now - this._tapTimes[this._tapTimes.length - 1] > 2000) {
            this._tapTimes = [];
        }
        this._tapTimes.push(now);
        if (this._tapTimes.length > 5) this._tapTimes.shift();
        if (this._tapTimes.length >= 2) {
            let sum = 0;
            for (let i = 1; i < this._tapTimes.length; i++) {
                sum += this._tapTimes[i] - this._tapTimes[i - 1];
            }
            this.setBpm(Math.round(60000 / (sum / (this._tapTimes.length - 1))));
        }
    }

    // === Scheduling ===

    _scheduler() {
        while (this._nextStepTime < this.audioContext.currentTime + this._lookahead) {
            this._scheduleStep(this._nextStepIndex, this._nextStepTime);
            this._advanceStep();
        }
    }

    _scheduleStep(stepIndex, time) {
        const delay = Math.max(0, (time - this.audioContext.currentTime) * 1000);
        setTimeout(() => {
            this.currentStep = stepIndex;
            if (this.onStepChange) this.onStepChange(stepIndex);
        }, delay);

        const step = this.pattern[stepIndex];
        if (!step || step.slots.length === 0) return;

        for (let s = 0; s < step.slots.length; s++) {
            const entry = step.slots[s];
            if (this.shouldPlaySlot && !this.shouldPlaySlot(entry.slot)) continue;
            const buffer = this._getBuffer(entry.slot, step.direction === 'reverse');
            if (!buffer) continue;

            // Per-slot stutter: check if this slot has stutter enabled
            const slotStutter = this.shouldStutterSlot ? this.shouldStutterSlot(entry.slot) : this.stutterEnabled;
            const subdivs = slotStutter ? this._getStutterSubdivisions() : 1;
            const subDur = this.stepDuration / subdivs;
            const pad = this.getPadSettings ? this.getPadSettings(entry.slot) : null;

            for (let sub = 0; sub < subdivs; sub++) {
                const subTime = time + sub * subDur;
                this._playBuffer(this.audioContext, buffer, entry, step, subTime, pad, subDur);
            }
        }
    }

    _getStutterSubdivisions() {
        // Map 0-1 amount to subdivisions: 2, 3, 4, 6, 8, 12, 16
        const divs = [2, 3, 4, 6, 8, 12, 16];
        const idx = Math.min(divs.length - 1, Math.floor(this.stutterAmount * divs.length));
        return divs[idx];
    }

    _playBuffer(ctx, buffer, entry, step, time, pad, maxDuration) {
        const source = ctx.createBufferSource();
        source.buffer = buffer;

        // Pitch: combine step pitch + pad pitch
        const totalPitch = entry.pitch + (pad ? pad.pitch : 0);
        if (totalPitch !== 0) {
            source.playbackRate.setValueAtTime(Math.pow(2, totalPitch / 12), time);
        }
        if (step.mode === 'loop') {
            source.loop = true;
            source.loopStart = 0;
            source.loopEnd = buffer.duration;
        }

        // Build chain: source -> [filter] -> envelopeGain -> volumeGain -> destination
        let lastNode = source;
        let filter = null;

        // Optional filter from pad settings
        if (pad && pad.filterEnabled) {
            filter = ctx.createBiquadFilter();
            filter.type = pad.filterType;
            filter.frequency.setValueAtTime(pad.filterFreq, time);
            filter.Q.setValueAtTime(pad.filterQ, time);
            lastNode.connect(filter);
            lastNode = filter;
        }

        // Envelope (ADSR)
        const envelopeGain = ctx.createGain();
        if (pad) {
            envelopeGain.gain.setValueAtTime(0, time);
            envelopeGain.gain.linearRampToValueAtTime(1.0, time + pad.attack);
            envelopeGain.gain.linearRampToValueAtTime(pad.sustain, time + pad.attack + pad.decay);
        } else {
            envelopeGain.gain.setValueAtTime(1, time);
        }
        lastNode.connect(envelopeGain);
        lastNode = envelopeGain;

        // Volume
        const volumeGain = ctx.createGain();
        volumeGain.gain.setValueAtTime(pad ? pad.volume : 1.0, time);
        lastNode.connect(volumeGain);
        lastNode = volumeGain;

        // Route to effects bus for live playback, direct for bounce (OfflineAudioContext)
        const output = (ctx === this.audioContext && this.outputNode) ? this.outputNode : ctx.destination;
        lastNode.connect(output);

        // Optional LFO
        let lfo = null;
        if (pad && pad.lfoEnabled && pad.lfoDepth > 0 && pad.lfoTarget !== 'position') {
            lfo = ctx.createOscillator();
            lfo.type = pad.lfoShape;
            lfo.frequency.setValueAtTime(pad.lfoRate, time);
            const lfoGain = ctx.createGain();
            switch (pad.lfoTarget) {
                case 'filter':
                    if (filter) {
                        lfoGain.gain.setValueAtTime(pad.filterFreq * pad.lfoDepth, time);
                        lfo.connect(lfoGain);
                        lfoGain.connect(filter.frequency);
                    }
                    break;
                case 'volume':
                    lfoGain.gain.setValueAtTime(pad.volume * pad.lfoDepth, time);
                    lfo.connect(lfoGain);
                    lfoGain.connect(volumeGain.gain);
                    break;
                case 'pitch':
                    lfoGain.gain.setValueAtTime(pad.lfoDepth * 100, time);
                    lfo.connect(lfoGain);
                    lfoGain.connect(source.detune);
                    break;
            }
            lfo.start(time);
        }

        // Pitch envelope: modulate detune (cents)
        if (pad && pad.pitchEnvEnabled) {
            const peakCents = pad.pitchEnvAmount * 100;
            const sustainCents = pad.pitchEnvAmount * pad.pitchEnvSustain * 100;
            source.detune.setValueAtTime(peakCents, time);
            source.detune.linearRampToValueAtTime(peakCents, time + pad.pitchEnvAttack);
            source.detune.linearRampToValueAtTime(sustainCents, time + pad.pitchEnvAttack + pad.pitchEnvDecay);
        }

        source.start(time);

        // Determine stop time based on: entry duration, stutter, or loop mode
        const entryDur = (entry.duration > 0) ? entry.duration * this.stepDuration : 0;
        const stutterCut = maxDuration && maxDuration < this.stepDuration;
        const needsStop = step.mode === 'loop' || stutterCut || entryDur > 0;
        if (needsStop) {
            let dur;
            if (stutterCut) {
                dur = maxDuration;
            } else if (entryDur > 0) {
                dur = entryDur;
            } else {
                dur = this.stepDuration;
            }
            const stopTime = time + dur;
            source.stop(stopTime);
            if (lfo) lfo.stop(stopTime);
        }

        this._activeSources.push(source);
        if (lfo) this._activeSources.push(lfo);
        source.onended = () => {
            const idx = this._activeSources.indexOf(source);
            if (idx >= 0) this._activeSources.splice(idx, 1);
            if (lfo) {
                try { lfo.stop(); } catch (e) {}
                const li = this._activeSources.indexOf(lfo);
                if (li >= 0) this._activeSources.splice(li, 1);
            }
        };
    }

    _advanceStep() {
        this._nextStepTime += this.stepDuration;
        this._nextStepIndex++;
        if (this._nextStepIndex >= this.pattern.length) {
            this._nextStepIndex = 0;
            if (this.onPatternLoop) this.onPatternLoop();
            if (this.mutateEnabled) this._applyMutations();
        }
    }

    // === Buffer Management ===

    _getBuffer(slotIndex, reverse) {
        const key = reverse ? 'reverse' : 'forward';
        if (this._bufferCache[slotIndex] && this._bufferCache[slotIndex][key]) {
            return this._bufferCache[slotIndex][key];
        }
        if (this.getSlotBuffer) {
            const buf = this.getSlotBuffer(slotIndex);
            if (buf) {
                if (!this._bufferCache[slotIndex]) this._bufferCache[slotIndex] = {};
                this._bufferCache[slotIndex].forward = buf;
                if (reverse) {
                    this._bufferCache[slotIndex].reverse = this._reverseBuffer(buf);
                    return this._bufferCache[slotIndex].reverse;
                }
                return buf;
            }
        }
        return null;
    }

    _reverseBuffer(buffer) {
        const numChannels = buffer.numberOfChannels;
        const length = buffer.length;
        const reversed = this.audioContext.createBuffer(numChannels, length, buffer.sampleRate);
        for (let ch = 0; ch < numChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dst = reversed.getChannelData(ch);
            for (let i = 0; i < length; i++) dst[i] = src[length - 1 - i];
        }
        return reversed;
    }

    invalidateBuffer(slotIndex) { delete this._bufferCache[slotIndex]; }
    invalidateAllBuffers() { this._bufferCache = {}; }

    // === Step Assignment ===

    /** Toggle a slot on/off for a step. Adds with pitch 0, duration 0 if not present. */
    toggleSlotOnStep(stepIndex, slotIdx) {
        const step = this.pattern[stepIndex];
        const pos = step.slots.findIndex(e => e.slot === slotIdx);
        if (pos >= 0) {
            step.slots.splice(pos, 1);
        } else {
            step.slots.push({ slot: slotIdx, pitch: 0, duration: 0 });
        }
    }

    /** Check if a slot is active on a step. */
    hasSlotOnStep(stepIndex, slotIdx) {
        return this.pattern[stepIndex].slots.some(e => e.slot === slotIdx);
    }

    /** Get the slot entry object for a given slot on a step (or null). */
    getSlotEntry(stepIndex, slotIdx) {
        return this.pattern[stepIndex].slots.find(e => e.slot === slotIdx) || null;
    }

    /** Add a slot with specific pitch and duration to a step (allows duplicates for polyphony). */
    addSlotToStep(stepIndex, slotIdx, pitch, duration) {
        this.pattern[stepIndex].slots.push({ slot: slotIdx, pitch: pitch || 0, duration: duration || 0 });
    }

    /** Set pitch for a specific slot on a step. */
    setSlotPitch(stepIndex, slotIdx, semitones) {
        const entry = this.getSlotEntry(stepIndex, slotIdx);
        if (entry) {
            entry.pitch = Math.max(-24, Math.min(24, semitones));
        }
    }

    setStepSlots(stepIndex, slotArray) {
        this.pattern[stepIndex].slots = slotArray.map(s => {
            if (typeof s === 'object') return { slot: s.slot, pitch: s.pitch || 0 };
            return { slot: s, pitch: 0 };
        });
    }

    setStepMode(stepIndex, mode) { this.pattern[stepIndex].mode = mode; }
    setStepDirection(stepIndex, direction) { this.pattern[stepIndex].direction = direction; }

    clearPattern() {
        for (let i = 0; i < this.pattern.length; i++) {
            this.pattern[i].slots = [];
            this.pattern[i].mode = 'oneshot';
            this.pattern[i].direction = 'forward';
        }
    }

    setStepCount(n) {
        n = Math.max(16, Math.min(64, n));
        if (n === this.stepCount && n === this.pattern.length) return;
        const wasPlaying = this.playing;
        if (wasPlaying) this.stop();
        this.stepCount = n;
        // Extend or truncate pattern
        while (this.pattern.length < n) {
            this.pattern.push({ slots: [], mode: 'oneshot', direction: 'forward' });
        }
        if (this.pattern.length > n) {
            this.pattern.length = n;
        }
        if (wasPlaying) this.play();
    }

    // === Pattern Manipulation ===

    randomise(density) {
        density = density !== undefined ? density : 0.75;
        const loaded = this.getLoadedSlots ? this.getLoadedSlots() : [];
        if (loaded.length === 0) return;
        for (let i = 0; i < this.pattern.length; i++) {
            if (Math.random() < density) {
                const count = Math.random() < 0.8 ? 1 : 2;
                const picked = [];
                for (let c = 0; c < count; c++) {
                    const s = loaded[Math.floor(Math.random() * loaded.length)];
                    if (!picked.some(e => e.slot === s)) {
                        const pitch = Math.random() < 0.6 ? 0 : Math.floor(Math.random() * 25) - 12;
                        picked.push({ slot: s, pitch: pitch });
                    }
                }
                this.pattern[i].slots = picked;
                this.pattern[i].mode = Math.random() < 0.2 ? 'loop' : 'oneshot';
                this.pattern[i].direction = Math.random() < 0.2 ? 'reverse' : 'forward';
            } else {
                this.pattern[i].slots = [];
                this.pattern[i].mode = 'oneshot';
                this.pattern[i].direction = 'forward';
            }
        }
    }

    toggleStutter() {
        this.stutterEnabled = !this.stutterEnabled;
    }

    _applyMutations() {
        const loaded = this.getLoadedSlots ? this.getLoadedSlots() : [];
        if (loaded.length === 0) return;
        // Filter loaded slots to only those with mutate enabled (if per-slot callback exists)
        const mutatable = this.shouldMutateSlot
            ? loaded.filter(s => this.shouldMutateSlot(s))
            : loaded;
        if (mutatable.length === 0) return;
        const prob = 0.03 + this.mutateAmount * 0.27; // range: 0.03 (subtle) to 0.30 (frantic)
        for (let i = 0; i < this.pattern.length; i++) {
            if (Math.random() < prob) {
                const step = this.pattern[i];
                // Only mutate entries belonging to mutatable slots
                const mutableEntries = step.slots.filter(e => mutatable.includes(e.slot));
                const m = Math.random();
                if (m < 0.35) {
                    if (mutableEntries.length === 0) {
                        // Add a random mutatable slot
                        step.slots.push({ slot: mutatable[Math.floor(Math.random() * mutatable.length)], pitch: 0, duration: 0 });
                    } else if (Math.random() < 0.3) {
                        // Remove mutable entries only
                        this.pattern[i].slots = step.slots.filter(e => !mutatable.includes(e.slot));
                    } else {
                        // Replace a mutable entry with a different mutatable slot
                        const idx = step.slots.indexOf(mutableEntries[Math.floor(Math.random() * mutableEntries.length)]);
                        if (idx >= 0) step.slots[idx] = { slot: mutatable[Math.floor(Math.random() * mutatable.length)], pitch: 0, duration: 0 };
                    }
                } else if (m < 0.5) {
                    step.direction = step.direction === 'forward' ? 'reverse' : 'forward';
                } else if (m < 0.65) {
                    step.mode = step.mode === 'oneshot' ? 'loop' : 'oneshot';
                } else if (m < 0.8) {
                    // Mutate pitch of a random mutable entry
                    if (mutableEntries.length > 0) {
                        const entry = mutableEntries[Math.floor(Math.random() * mutableEntries.length)];
                        entry.pitch = Math.max(-24, Math.min(24, entry.pitch + Math.floor(Math.random() * 5) - 2));
                    }
                } else {
                    if (mutableEntries.length > 0) {
                        // Remove mutable entries
                        this.pattern[i].slots = step.slots.filter(e => !mutatable.includes(e.slot));
                    } else {
                        // Add a random mutatable slot
                        step.slots.push({ slot: mutatable[Math.floor(Math.random() * mutatable.length)], pitch: 0, duration: 0 });
                    }
                }
                if (this.onMutate) this.onMutate(i);
            }
        }
    }

    // === Bounce ===

    async bounce(numLoops) {
        numLoops = numLoops || 1;
        const stepDur = this.stepDuration;
        const totalDuration = stepDur * this.pattern.length * numLoops;
        const sampleRate = this.audioContext.sampleRate;

        let maxTail = 0;
        for (let i = 0; i < this.pattern.length; i++) {
            const step = this.pattern[i];
            if (step.slots.length > 0 && step.mode === 'oneshot') {
                for (const entry of step.slots) {
                    const buf = this._getBuffer(entry.slot, step.direction === 'reverse');
                    if (buf && buf.duration > stepDur) {
                        maxTail = Math.max(maxTail, buf.duration - stepDur);
                    }
                }
            }
        }

        const totalWithTail = Math.ceil((totalDuration + maxTail) * sampleRate);
        const offline = new OfflineAudioContext(2, totalWithTail, sampleRate);

        for (let loop = 0; loop < numLoops; loop++) {
            const loopOffset = loop * stepDur * this.pattern.length;
            if (loop > 0 && this.mutateEnabled) this._applyMutations();

            for (let i = 0; i < this.pattern.length; i++) {
                const step = this.pattern[i];
                if (step.slots.length === 0) continue;
                const startTime = loopOffset + i * stepDur;

                for (const entry of step.slots) {
                    const buffer = this._getBuffer(entry.slot, step.direction === 'reverse');
                    if (!buffer) continue;

                    const offlineBuf = offline.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
                    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                        offlineBuf.getChannelData(ch).set(buffer.getChannelData(ch));
                    }

                    const pad = this.getPadSettings ? this.getPadSettings(entry.slot) : null;
                    this._playBuffer(offline, offlineBuf, entry, step, startTime, pad);
                }
            }
        }

        const rendered = await offline.startRendering();
        const channels = [];
        for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
            channels.push(new Float32Array(rendered.getChannelData(ch)));
        }
        return { channels, sampleRate: rendered.sampleRate };
    }

    // === Persistence ===

    toJSON() {
        return {
            bpm: this.bpm,
            stepCount: this.stepCount,
            mutateEnabled: this.mutateEnabled,
            mutateAmount: this.mutateAmount,
            stutterAmount: this.stutterAmount,
            pattern: this.pattern.map(step => ({
                slots: step.slots.map(e => ({ slot: e.slot, pitch: e.pitch, duration: e.duration || 0 })),
                mode: step.mode,
                direction: step.direction
            }))
        };
    }

    fromJSON(data) {
        if (!data) return;
        // Restore step count first so pattern array is correctly sized
        const sc = data.stepCount || 16;
        this.setStepCount(sc);
        if (data.bpm !== undefined) this.bpm = data.bpm;
        if (data.mutateEnabled !== undefined) this.mutateEnabled = data.mutateEnabled;
        if (data.mutateAmount !== undefined) this.mutateAmount = data.mutateAmount;
        if (data.stutterAmount !== undefined) this.stutterAmount = data.stutterAmount;
        if (data.pattern && Array.isArray(data.pattern)) {
            for (let i = 0; i < this.pattern.length && i < data.pattern.length; i++) {
                const s = data.pattern[i];
                if (s) {
                    if (s.slots && Array.isArray(s.slots)) {
                        // New object format: [{slot: N, pitch: 0}, ...]
                        // Also handle old plain-index format: [0, 5, ...]
                        this.pattern[i].slots = s.slots.map(e => {
                            if (typeof e === 'object' && e !== null) {
                                return { slot: e.slot, pitch: e.pitch || 0, duration: e.duration || 0 };
                            }
                            // Old format: plain number — apply step-level pitch if present
                            return { slot: e, pitch: s.pitch || 0, duration: 0 };
                        });
                    } else if (s.slotIndex !== undefined && s.slotIndex !== null) {
                        // Oldest format: single slotIndex
                        this.pattern[i].slots = [{ slot: s.slotIndex, pitch: s.pitch || 0 }];
                    } else {
                        this.pattern[i].slots = [];
                    }
                    this.pattern[i].mode = s.mode || 'oneshot';
                    this.pattern[i].direction = s.direction || 'forward';
                }
            }
        }
    }
}
