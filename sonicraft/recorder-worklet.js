/**
 * AudioWorklet processor for recording audio input.
 * Accumulates 128-sample frames into 4096-sample chunks
 * and sends them to the main thread via postMessage.
 *
 * Replaces the deprecated ScriptProcessorNode.
 */
class RecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._bufferSize = 4096;
        this._buffer = new Float32Array(this._bufferSize);
        this._writePos = 0;
        this._peak = 0;
        this._active = true;

        // Noise gate state
        this._gateEnabled = false;
        this._gateThreshold = 0.01; // linear amplitude
        this._gateOpen = true;
        this._gateRamp = 1.0; // 0-1 for click-free transitions

        this.port.onmessage = (e) => {
            if (e.data === 'stop') {
                this._active = false;
            } else if (e.data && typeof e.data === 'object') {
                if (e.data.gate !== undefined) this._gateEnabled = !!e.data.gate;
                if (e.data.gateThreshold !== undefined) this._gateThreshold = e.data.gateThreshold;
            }
        };
    }

    process(inputs) {
        if (!this._active) return false;

        const input = inputs[0];
        if (!input || input.length === 0 || input[0].length === 0) return true;

        const channelData = input[0];

        if (this._gateEnabled) {
            // Compute per-frame peak for gate decision
            let framePeak = 0;
            for (let i = 0; i < channelData.length; i++) {
                const abs = Math.abs(channelData[i]);
                if (abs > framePeak) framePeak = abs;
            }
            this._gateOpen = framePeak >= this._gateThreshold;
        }

        const targetRamp = (this._gateEnabled && !this._gateOpen) ? 0 : 1;

        for (let i = 0; i < channelData.length; i++) {
            // Smooth ramp towards target (1/64 convergence per sample for click-free)
            this._gateRamp += (targetRamp - this._gateRamp) * (1 / 64);

            const sample = channelData[i] * this._gateRamp;
            this._buffer[this._writePos] = sample;

            const abs = Math.abs(sample);
            if (abs > this._peak) this._peak = abs;

            this._writePos++;
            if (this._writePos >= this._bufferSize) {
                this.port.postMessage(
                    { chunk: this._buffer, peak: this._peak, gateOpen: this._gateOpen },
                    [this._buffer.buffer]
                );
                this._buffer = new Float32Array(this._bufferSize);
                this._writePos = 0;
                this._peak = 0;
            }
        }
        return true;
    }
}

registerProcessor('recorder-processor', RecorderProcessor);
