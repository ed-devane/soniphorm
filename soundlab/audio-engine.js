class AudioEngine {
    constructor() {
        this.audioContext = null;
        this._isRecording = false;
        this._isPlaying = false;
        this._isLooping = false;
        this._inputLevel = 0;
        this._recordedChunks = [];
        this._mediaStream = null;
        this._scriptProcessor = null;
        this._mediaStreamSource = null;
        this._sourceNode = null;
        this._playbackStartTime = 0;
        this._playbackStartSample = 0;
        this._playbackEndSample = 0;
        this._playbackSampleRate = 0;
        this.onRecordChunk = null; // callback(Float32Array chunk)

        // AudioWorklet support (replaces deprecated ScriptProcessor)
        this._workletReady = false;
        this._workletNode = null;

        // Real-time effect nodes
        this._liveFilter = null;
        this._liveReverb = null;
        this._liveReverbDry = null;
        this._liveReverbWet = null;
        this._liveReverbDecay = 0;
        this._liveDelay = null;
        this._liveDelayFeedback = null;
        this._liveDelayDry = null;
        this._liveDelayWet = null;
        this._liveGain = null;
    }

    async init() {
        if (this.audioContext) {
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            return;
        }
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        // Try to register AudioWorklet for recording (modern replacement for ScriptProcessor)
        if (this.audioContext.audioWorklet) {
            try {
                await this.audioContext.audioWorklet.addModule('recorder-worklet.js');
                this._workletReady = true;
            } catch (e) {
                console.warn('AudioWorklet not available, using ScriptProcessor fallback:', e);
            }
        }
    }

    async startRecording() {
        if (!this.audioContext) await this.init();

        this._recordedChunks = [];
        this._inputLevel = 0;

        // Reuse existing mic stream if still active, otherwise request a new one
        if (!this._mediaStream || this._mediaStream.getTracks().every(t => t.readyState === 'ended')) {
            this._mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000
                }
            });
        }

        this._mediaStreamSource = this.audioContext.createMediaStreamSource(this._mediaStream);

        if (this._workletReady) {
            // Modern path: AudioWorkletNode
            this._workletNode = new AudioWorkletNode(this.audioContext, 'recorder-processor');
            this._workletNode.port.onmessage = (e) => {
                const { chunk, peak } = e.data;
                this._recordedChunks.push(chunk);
                this._inputLevel = peak;
                if (this.onRecordChunk) this.onRecordChunk(chunk);
            };
            this._mediaStreamSource.connect(this._workletNode);
            this._workletNode.connect(this.audioContext.destination);
        } else {
            // Fallback: ScriptProcessor (deprecated but still widely supported)
            this._scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
            this._scriptProcessor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const chunk = new Float32Array(inputData.length);
                chunk.set(inputData);
                this._recordedChunks.push(chunk);

                let peak = 0;
                for (let i = 0; i < inputData.length; i++) {
                    const abs = Math.abs(inputData[i]);
                    if (abs > peak) peak = abs;
                }
                this._inputLevel = peak;
                if (this.onRecordChunk) this.onRecordChunk(chunk);
            };
            this._mediaStreamSource.connect(this._scriptProcessor);
            this._scriptProcessor.connect(this.audioContext.destination);
        }
        this._isRecording = true;
    }

    stopRecording() {
        this._isRecording = false;

        if (this._workletNode) {
            this._workletNode.port.postMessage('stop');
            this._workletNode.disconnect();
            this._workletNode = null;
        }

        if (this._scriptProcessor) {
            this._scriptProcessor.disconnect();
            this._scriptProcessor.onaudioprocess = null;
            this._scriptProcessor = null;
        }

        if (this._mediaStreamSource) {
            this._mediaStreamSource.disconnect();
            this._mediaStreamSource = null;
        }

        // Keep _mediaStream alive so subsequent recordings reuse the mic permission

        const totalLength = this._recordedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const merged = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of this._recordedChunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }

        this._recordedChunks = [];
        this._inputLevel = 0;

        return {
            channels: [merged],
            sampleRate: this.audioContext.sampleRate
        };
    }

    get isRecording() {
        return this._isRecording;
    }

    get isPlaying() {
        return this._isPlaying;
    }

    get sampleRate() {
        return this.audioContext ? this.audioContext.sampleRate : 0;
    }

    getInputLevel() {
        return this._inputLevel;
    }

    play(channels, sampleRate, startSample = 0, endSample = null, onEnded = null) {
        this.stop();

        const totalSamples = channels[0].length;
        const actualEnd = endSample !== null ? endSample : totalSamples;
        const length = actualEnd - startSample;

        if (length <= 0) return;

        const buffer = this.audioContext.createBuffer(channels.length, length, sampleRate);
        for (let ch = 0; ch < channels.length; ch++) {
            const bufferData = buffer.getChannelData(ch);
            bufferData.set(channels[ch].subarray(startSample, actualEnd));
        }

        this._sourceNode = this.audioContext.createBufferSource();
        this._sourceNode.buffer = buffer;
        this._sourceNode.loop = this._isLooping;

        // Route through live effect chain
        this._connectEffectChain();

        this._playbackStartTime = this.audioContext.currentTime;
        this._playbackStartSample = startSample;
        this._playbackEndSample = actualEnd;
        this._playbackSampleRate = sampleRate;

        this._sourceNode.onended = () => {
            this._isPlaying = false;
            this._sourceNode = null;
            if (onEnded) onEnded();
        };

        this._sourceNode.start();
        this._isPlaying = true;
    }

    setLoop(enabled) {
        this._isLooping = enabled;
        if (this._sourceNode) {
            this._sourceNode.loop = enabled;
        }
    }

    get isLooping() {
        return this._isLooping;
    }

    stop() {
        if (this._sourceNode) {
            try {
                this._sourceNode.onended = null;
                this._sourceNode.stop();
            } catch (e) {
                // Already stopped
            }
            this._sourceNode = null;
        }
        this._isPlaying = false;
    }

    setPlaybackRate(rate) {
        if (this._sourceNode) {
            this._sourceNode.playbackRate.setTargetAtTime(rate, this.audioContext.currentTime, 0.02);
        }
    }

    // === Real-time effect chain ===

    _connectEffectChain() {
        if (!this._sourceNode || !this.audioContext) return;

        // Build chain: source → [filter] → [reverb] → [delay] → gain → destination
        let node = this._sourceNode;

        if (this._liveFilter) {
            node.connect(this._liveFilter);
            node = this._liveFilter;
        }

        if (this._liveReverb && this._liveReverbDry && this._liveReverbWet) {
            // Parallel dry/wet for reverb
            const reverbMerge = this.audioContext.createGain();
            node.connect(this._liveReverbDry);
            node.connect(this._liveReverb);
            this._liveReverb.connect(this._liveReverbWet);
            this._liveReverbDry.connect(reverbMerge);
            this._liveReverbWet.connect(reverbMerge);
            node = reverbMerge;
        }

        if (this._liveDelay) {
            // Parallel dry/wet for delay
            const merger = this.audioContext.createGain();
            this._liveDelayDry = this.audioContext.createGain();
            this._liveDelayWet = this.audioContext.createGain();
            const feedback = this._liveDelayFeedback || this.audioContext.createGain();

            node.connect(this._liveDelayDry);
            node.connect(this._liveDelay);
            this._liveDelay.connect(feedback);
            feedback.connect(this._liveDelay);
            this._liveDelay.connect(this._liveDelayWet);

            this._liveDelayDry.connect(merger);
            this._liveDelayWet.connect(merger);
            node = merger;
        }

        if (!this._liveGain) {
            this._liveGain = this.audioContext.createGain();
        }
        node.connect(this._liveGain);
        this._liveGain.connect(this.audioContext.destination);
    }

    enableLiveFilter(type, frequency, q) {
        if (!this.audioContext) return;
        const isNew = !this._liveFilter;
        if (isNew) {
            this._liveFilter = this.audioContext.createBiquadFilter();
        }
        this._liveFilter.type = type || 'lowpass';
        this._liveFilter.frequency.setTargetAtTime(frequency || 1000, this.audioContext.currentTime, 0.02);
        this._liveFilter.Q.setTargetAtTime(q || 1, this.audioContext.currentTime, 0.02);

        // Only reconnect chain when filter is newly added
        if (isNew && this._isPlaying && this._sourceNode) {
            this._reconnectChain();
        }
    }

    updateLiveFilter(params) {
        if (!this._liveFilter || !this.audioContext) return;
        if (params.type !== undefined) this._liveFilter.type = params.type;
        if (params.frequency !== undefined) {
            this._liveFilter.frequency.setTargetAtTime(params.frequency, this.audioContext.currentTime, 0.02);
        }
        if (params.q !== undefined) {
            this._liveFilter.Q.setTargetAtTime(params.q, this.audioContext.currentTime, 0.02);
        }
    }

    disableLiveFilter() {
        if (this._liveFilter) {
            this._liveFilter.disconnect();
            this._liveFilter = null;
            if (this._isPlaying && this._sourceNode) {
                this._reconnectChain();
            }
        }
    }

    enableLiveReverb(decay, mix) {
        if (!this.audioContext) return;
        decay = decay || 2;
        mix = mix !== undefined ? mix : 0.4;
        const isNew = !this._liveReverb;

        // Generate new IR if decay changed or first time
        if (isNew || Math.abs(this._liveReverbDecay - decay) > 0.05) {
            if (!isNew) {
                // Rebuild convolver with new IR
                try { this._liveReverb.disconnect(); } catch (e) {}
            }
            this._liveReverb = this.audioContext.createConvolver();
            const irLength = Math.floor(this.audioContext.sampleRate * decay);
            const irBuffer = this.audioContext.createBuffer(2, irLength, this.audioContext.sampleRate);
            for (let ch = 0; ch < 2; ch++) {
                const data = irBuffer.getChannelData(ch);
                for (let i = 0; i < irLength; i++) {
                    data[i] = (Math.random() * 2 - 1) * Math.exp(-3 * i / irLength);
                }
            }
            this._liveReverb.buffer = irBuffer;
            this._liveReverbDecay = decay;
        }

        if (isNew) {
            this._liveReverbDry = this.audioContext.createGain();
            this._liveReverbWet = this.audioContext.createGain();
        }
        this._liveReverbDry.gain.setTargetAtTime(1 - mix, this.audioContext.currentTime, 0.02);
        this._liveReverbWet.gain.setTargetAtTime(mix, this.audioContext.currentTime, 0.02);

        if (isNew && this._isPlaying && this._sourceNode) {
            this._reconnectChain();
        }
    }

    updateLiveReverb(params) {
        if (!this._liveReverb || !this.audioContext) return;
        if (params.decay !== undefined && Math.abs(this._liveReverbDecay - params.decay) > 0.05) {
            this.enableLiveReverb(params.decay, params.mix);
            if (this._isPlaying && this._sourceNode) {
                this._reconnectChain();
            }
            return;
        }
        if (params.mix !== undefined) {
            this._liveReverbDry.gain.setTargetAtTime(1 - params.mix, this.audioContext.currentTime, 0.02);
            this._liveReverbWet.gain.setTargetAtTime(params.mix, this.audioContext.currentTime, 0.02);
        }
    }

    disableLiveReverb() {
        if (this._liveReverb) {
            try { this._liveReverb.disconnect(); } catch (e) {}
            this._liveReverb = null;
            this._liveReverbDecay = 0;
        }
        if (this._liveReverbDry) {
            try { this._liveReverbDry.disconnect(); } catch (e) {}
            this._liveReverbDry = null;
        }
        if (this._liveReverbWet) {
            try { this._liveReverbWet.disconnect(); } catch (e) {}
            this._liveReverbWet = null;
        }
        if (this._isPlaying && this._sourceNode) {
            this._reconnectChain();
        }
    }

    enableLiveDelay(time, feedback, mix) {
        if (!this.audioContext) return;
        const isNew = !this._liveDelay;
        if (isNew) {
            this._liveDelay = this.audioContext.createDelay(2.0);
            this._liveDelayFeedback = this.audioContext.createGain();
        }
        this._liveDelay.delayTime.setTargetAtTime(time || 0.3, this.audioContext.currentTime, 0.02);
        this._liveDelayFeedback.gain.setTargetAtTime(feedback || 0.4, this.audioContext.currentTime, 0.02);

        if (isNew && this._isPlaying && this._sourceNode) {
            this._reconnectChain();
        }
    }

    updateLiveDelay(params) {
        if (!this._liveDelay || !this.audioContext) return;
        if (params.time !== undefined) {
            this._liveDelay.delayTime.setTargetAtTime(params.time, this.audioContext.currentTime, 0.02);
        }
        if (params.feedback !== undefined) {
            this._liveDelayFeedback.gain.setTargetAtTime(params.feedback, this.audioContext.currentTime, 0.02);
        }
    }

    disableLiveDelay() {
        if (this._liveDelay) {
            this._liveDelay.disconnect();
            this._liveDelay = null;
            if (this._liveDelayFeedback) {
                this._liveDelayFeedback.disconnect();
                this._liveDelayFeedback = null;
            }
            if (this._isPlaying && this._sourceNode) {
                this._reconnectChain();
            }
        }
    }

    _reconnectChain() {
        if (!this._sourceNode) return;
        // Disconnect everything from source
        try { this._sourceNode.disconnect(); } catch (e) {}
        if (this._liveFilter) try { this._liveFilter.disconnect(); } catch (e) {}
        if (this._liveReverb) try { this._liveReverb.disconnect(); } catch (e) {}
        if (this._liveReverbDry) try { this._liveReverbDry.disconnect(); } catch (e) {}
        if (this._liveReverbWet) try { this._liveReverbWet.disconnect(); } catch (e) {}
        if (this._liveGain) try { this._liveGain.disconnect(); } catch (e) {}
        if (this._liveDelay) try { this._liveDelay.disconnect(); } catch (e) {}
        if (this._liveDelayFeedback) try { this._liveDelayFeedback.disconnect(); } catch (e) {}
        if (this._liveDelayDry) try { this._liveDelayDry.disconnect(); } catch (e) {}
        if (this._liveDelayWet) try { this._liveDelayWet.disconnect(); } catch (e) {}
        this._connectEffectChain();
    }

    clearLiveEffects() {
        if (this._liveFilter) {
            try { this._liveFilter.disconnect(); } catch (e) {}
            this._liveFilter = null;
        }
        if (this._liveReverb) {
            try { this._liveReverb.disconnect(); } catch (e) {}
            this._liveReverb = null;
            this._liveReverbDecay = 0;
        }
        if (this._liveReverbDry) {
            try { this._liveReverbDry.disconnect(); } catch (e) {}
            this._liveReverbDry = null;
        }
        if (this._liveReverbWet) {
            try { this._liveReverbWet.disconnect(); } catch (e) {}
            this._liveReverbWet = null;
        }
        if (this._liveDelay) {
            try { this._liveDelay.disconnect(); } catch (e) {}
            this._liveDelay = null;
        }
        if (this._liveDelayFeedback) {
            try { this._liveDelayFeedback.disconnect(); } catch (e) {}
            this._liveDelayFeedback = null;
        }
        if (this._liveGain) {
            try { this._liveGain.disconnect(); } catch (e) {}
            this._liveGain = null;
        }
    }

    getPlaybackSample() {
        if (!this._isPlaying || !this._sourceNode) return 0;

        const elapsed = this.audioContext.currentTime - this._playbackStartTime;
        const elapsedSamples = Math.floor(elapsed * this._playbackSampleRate);
        const regionLength = this._playbackEndSample - this._playbackStartSample;

        if (this._isLooping && regionLength > 0) {
            return this._playbackStartSample + (elapsedSamples % regionLength);
        }
        return this._playbackStartSample + elapsedSamples;
    }

    static _cloneChannels(channels) {
        return channels.map(ch => new Float32Array(ch));
    }

    static trim(channels, start, end) {
        const length = end - start;
        return channels.map(ch => {
            const trimmed = new Float32Array(length);
            trimmed.set(ch.subarray(start, end));
            return trimmed;
        });
    }

    static cut(channels, start, end) {
        const cutLength = end - start;
        return channels.map(ch => {
            const result = new Float32Array(ch.length - cutLength);
            result.set(ch.subarray(0, start), 0);
            result.set(ch.subarray(end), start);
            return result;
        });
    }

    static silence(channels, start, end) {
        const cloned = AudioEngine._cloneChannels(channels);
        for (const ch of cloned) {
            for (let i = start; i < end; i++) {
                ch[i] = 0;
            }
        }
        return cloned;
    }

    static fadeIn(channels, start, end) {
        const cloned = AudioEngine._cloneChannels(channels);
        const length = end - start;
        for (const ch of cloned) {
            for (let i = 0; i < length; i++) {
                ch[start + i] *= i / length;
            }
        }
        return cloned;
    }

    static fadeOut(channels, start, end) {
        const cloned = AudioEngine._cloneChannels(channels);
        const length = end - start;
        for (const ch of cloned) {
            for (let i = 0; i < length; i++) {
                ch[start + i] *= 1 - (i / length);
            }
        }
        return cloned;
    }

    static reverse(channels, start, end) {
        const cloned = AudioEngine._cloneChannels(channels);
        for (const ch of cloned) {
            let left = start;
            let right = end - 1;
            while (left < right) {
                const temp = ch[left];
                ch[left] = ch[right];
                ch[right] = temp;
                left++;
                right--;
            }
        }
        return cloned;
    }

    static normalise(channels, start, end) {
        const cloned = AudioEngine._cloneChannels(channels);

        let peak = 0;
        for (const ch of cloned) {
            for (let i = start; i < end; i++) {
                const abs = Math.abs(ch[i]);
                if (abs > peak) peak = abs;
            }
        }

        if (peak === 0 || peak >= 0.95) return cloned;

        const scale = 0.95 / peak;
        for (const ch of cloned) {
            for (let i = start; i < end; i++) {
                ch[i] *= scale;
            }
        }

        return cloned;
    }

    static paste(channels, clipboard, position) {
        const clipLength = clipboard[0].length;
        const numChannels = Math.max(channels.length, clipboard.length);

        const result = [];
        for (let ch = 0; ch < numChannels; ch++) {
            const src = ch < channels.length ? channels[ch] : new Float32Array(channels[0].length);
            const clip = ch < clipboard.length ? clipboard[ch] : new Float32Array(clipLength);
            const newLength = src.length + clipLength;
            const out = new Float32Array(newLength);
            out.set(src.subarray(0, position), 0);
            out.set(clip, position);
            out.set(src.subarray(position), position + clipLength);
            result.push(out);
        }

        return result;
    }

    static encodeWAV(channels, sampleRate) {
        const numChannels = channels.length;
        const numSamples = channels[0].length;
        const bitsPerSample = 16;
        const bytesPerSample = bitsPerSample / 8;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = numSamples * blockAlign;
        const headerSize = 44;
        const totalSize = headerSize + dataSize;

        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);

        const writeString = (offset, str) => {
            for (let i = 0; i < str.length; i++) {
                view.setUint8(offset + i, str.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, totalSize - 8, true);
        writeString(8, 'WAVE');

        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);

        writeString(36, 'data');
        view.setUint32(40, dataSize, true);

        let offset = 44;
        for (let i = 0; i < numSamples; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                let sample = channels[ch][i];
                sample = Math.max(-1, Math.min(1, sample));
                const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                view.setInt16(offset, int16, true);
                offset += 2;
            }
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    static async decodeBlob(blob, audioContext) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        const channels = [];
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
            channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
        }

        return {
            channels,
            sampleRate: audioBuffer.sampleRate
        };
    }
}
