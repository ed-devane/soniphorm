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

        this.port.onmessage = (e) => {
            if (e.data === 'stop') this._active = false;
        };
    }

    process(inputs) {
        if (!this._active) return false;

        const input = inputs[0];
        if (!input || input.length === 0 || input[0].length === 0) return true;

        const channelData = input[0];
        for (let i = 0; i < channelData.length; i++) {
            this._buffer[this._writePos] = channelData[i];

            const abs = Math.abs(channelData[i]);
            if (abs > this._peak) this._peak = abs;

            this._writePos++;
            if (this._writePos >= this._bufferSize) {
                this.port.postMessage(
                    { chunk: this._buffer, peak: this._peak },
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
