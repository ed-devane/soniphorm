// AudioWorkletProcessor for the Smudge module (see factories/granularSynth.js) -
// a straight port of SoniphormPatcher's GenRuntime.ino processGranularSynth().
// This is the one place in the whole app that needs per-sample control (a
// live-writable rolling buffer read by several independently-pitched grains
// at once) - no combination of stock Web Audio nodes can do that, which is
// why this is the app's only AudioWorklet. Self-contained on purpose (no
// imports) since worklet modules are loaded into their own global scope.
//
// Simplified from the original hardware module: mono instead of stereo (this
// whole app is mono - no stereo_width/cloud_pan/panning), reverse and freeze
// are plain level params instead of the firmware's rising-edge CV toggle
// (matches how every other gate-style ctrlIn port in this app works), and
// the scale/chord-quantized pitch mode (grain_scale/grain_root) is omitted -
// a secondary feature layered on top of the core grain engine, out of scope
// here.

const GRAIN_COUNT = 8;
// The firmware capped this at 2s/500ms grains because PSRAM on the ESP32 is
// scarce; no such constraint on a PC/Mac, so both are larger here. Buffer
// stays 2x the max grain size so Position retains room to mean something
// even at the largest grain (a grain the same length as the buffer reads
// the same content from any position).
const BUFFER_SECONDS = 4;
const HANN_SIZE = 256;

class GranularProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'density', defaultValue: 12, minValue: 1, maxValue: 80, automationRate: 'k-rate' },
      { name: 'grainSizeMs', defaultValue: 100, minValue: 5, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'position', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'positionSpread', defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'semitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'pitchSpread', defaultValue: 0.1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'intervalSemitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.15, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'reverseProb', defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'freeze', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.bufferSize = Math.round(sampleRate * BUFFER_SECONDS);
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.grains = Array.from({ length: GRAIN_COUNT }, () => ({
      readPos: 0,
      pitchRatio: 1,
      duration: 0,
      elapsed: 0,
      active: false,
    }));
    this.nextGrainSlot = 0;
    this.grainCounter = 0;
    this.rngState = 0x9e3779b9;
    this.smoothNorm = 1;
    this.hann = new Float32Array(HANN_SIZE);
    for (let i = 0; i < HANN_SIZE; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (HANN_SIZE - 1));
    }
  }

  // xorshift32, 0-1 output - same PRNG family the firmware uses, just not
  // required to bit-match it (grain scatter only needs to look random).
  _rand() {
    let x = this.rngState;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rngState = x;
    return x / 0xffffffff;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;

    const p = parameters;
    const density = p.density[0];
    const grainSize = p.grainSizeMs[0] / 1000; // seconds
    const position = p.position[0];
    const positionSpread = p.positionSpread[0];
    const pitch = Math.min(4, Math.max(0.25, 2 ** (p.semitones[0] / 12)));
    const pitchSpread = p.pitchSpread[0];
    const intervalSemi = p.intervalSemitones[0];
    const pitch2 = intervalSemi !== 0 ? pitch * 2 ** (intervalSemi / 12) : pitch;
    const mix = p.mix[0];
    const feedback = p.feedback[0];
    const reverseProb = p.reverseProb[0];
    const frozen = p.freeze[0] > 0.5;

    // Auto-budget: cap density so concurrent grains stay within GRAIN_COUNT.
    const maxDensity = GRAIN_COUNT / grainSize;
    const effDensity = Math.min(density, maxDensity);

    const { bufferSize, buffer, grains } = this;
    const blockLen = output.length;

    for (let i = 0; i < blockLen; i++) {
      const inSample = input ? input[i] : 0;

      this.grainCounter--;
      if (this.grainCounter <= 0) {
        const interval = Math.max(1, Math.round(sampleRate / effDensity));
        this.grainCounter = interval;

        // Prefer an inactive slot; if all busy, steal the one closest to finishing.
        let slot = -1;
        for (let s = 0; s < GRAIN_COUNT; s++) {
          const idx = (this.nextGrainSlot + s) % GRAIN_COUNT;
          if (!grains[idx].active) {
            slot = idx;
            break;
          }
        }
        if (slot < 0) {
          let bestRemain = Infinity;
          slot = this.nextGrainSlot;
          for (let s = 0; s < GRAIN_COUNT; s++) {
            const remain = grains[s].duration - grains[s].elapsed;
            if (remain < bestRemain) {
              bestRemain = remain;
              slot = s;
            }
          }
        }
        this.nextGrainSlot = (slot + 1) % GRAIN_COUNT;
        const g = grains[slot];

        const randPos = (this._rand() - 0.5) * positionSpread;
        const randPitch = 1 + (this._rand() - 0.5) * pitchSpread;
        const posOffset = Math.min(1, Math.max(0, position + randPos));
        const readOffset = Math.floor(posOffset * bufferSize);

        // Buffer is zero-initialised - always safe to read any position.
        g.readPos = ((this.writePos - readOffset) % bufferSize + bufferSize) % bufferSize;

        const basePitch = intervalSemi !== 0 ? (slot & 1 ? pitch2 : pitch) : pitch;
        g.pitchRatio = basePitch * randPitch;

        if (this._rand() < reverseProb) {
          // Offset start to the end of the grain region so it reads backwards
          // through the same audio instead of jumping somewhere new.
          const grainLen = grainSize * sampleRate * Math.abs(g.pitchRatio);
          g.readPos = (g.readPos + grainLen) % bufferSize;
          g.pitchRatio = -g.pitchRatio;
        }

        g.duration = Math.max(64, Math.round(grainSize * sampleRate));
        g.elapsed = 0;
        g.active = true;
      }

      let grainSum = 0;
      let activeCount = 0;
      for (let gi = 0; gi < GRAIN_COUNT; gi++) {
        const g = grains[gi];
        if (!g.active) continue;
        activeCount++;

        const windowPos = (g.elapsed / g.duration) * (HANN_SIZE - 1);
        let winIdx = windowPos | 0;
        let winFrac = windowPos - winIdx;
        if (winIdx >= HANN_SIZE - 1) {
          winIdx = HANN_SIZE - 2;
          winFrac = 1;
        }
        const envelope = this.hann[winIdx] + (this.hann[winIdx + 1] - this.hann[winIdx]) * winFrac;

        const readInt = g.readPos | 0;
        const readFrac = g.readPos - readInt;
        const readNext = readInt + 1 >= bufferSize ? 0 : readInt + 1;
        const b0 = buffer[readInt];
        const b1 = buffer[readNext];
        const sample = b0 + (b1 - b0) * readFrac;

        grainSum += sample * envelope;

        g.readPos += g.pitchRatio;
        if (g.readPos >= bufferSize) g.readPos -= bufferSize;
        if (g.readPos < 0) g.readPos += bufferSize;

        g.elapsed++;
        if (g.elapsed >= g.duration) g.active = false;
      }

      // Smoothed equal-power normalization - avoids per-sample clicks as the
      // active grain count changes (more overlap would otherwise mean louder).
      const targetNorm = activeCount > 1 ? 1 / Math.sqrt(activeCount) : 1;
      this.smoothNorm += (targetNorm - this.smoothNorm) * 0.002;
      grainSum *= this.smoothNorm;

      if (!frozen) {
        const fbSample = inSample + grainSum * feedback;
        buffer[this.writePos] = feedback > 0 ? Math.tanh(fbSample) : fbSample;
        this.writePos = this.writePos + 1 >= bufferSize ? 0 : this.writePos + 1;
      }

      output[i] = inSample * (1 - mix) + grainSum * mix;
    }

    return true;
  }
}

registerProcessor('granular-processor', GranularProcessor);
