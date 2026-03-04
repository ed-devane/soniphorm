/**
 * dsp.js — DSP utility library for the Soniphorm browser-based audio editor.
 *
 * Provides:
 *   DSP.fft / DSP.ifft        — Radix-2 Cooley-Tukey FFT / inverse FFT
 *   DSP.hannWindow             — Hann window generator
 *   DSP.hammingWindow          — Hamming window generator
 *   DSP.ola                    — Generic overlap-add processor
 *   DSP.nextPow2               — Smallest power of 2 >= n
 *   DSP.resample               — Linear-interpolation sample-rate converter
 *
 * Load this as a plain <script> tag BEFORE effects.js.
 * No ES modules — everything lives on the global `DSP` object.
 */

const DSP = {

  // ---------------------------------------------------------------
  //  Helpers
  // ---------------------------------------------------------------

  /**
   * Return the smallest power of 2 that is >= n.
   * @param {number} n
   * @returns {number}
   */
  nextPow2(n) {
    if (n <= 1) return 1;
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  },

  /**
   * Linear-interpolation resampler.
   * @param {Float32Array} channel  — mono audio samples
   * @param {number}       fromRate — original sample rate (Hz)
   * @param {number}       toRate   — target sample rate (Hz)
   * @returns {Float32Array} resampled audio at toRate
   */
  resample(channel, fromRate, toRate) {
    if (fromRate === toRate) {
      // Nothing to do — return a copy so the caller can mutate freely.
      return new Float32Array(channel);
    }

    const ratio = fromRate / toRate;
    const outLen = Math.round(channel.length / ratio);
    const out = new Float32Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;

      // Clamp the upper neighbour to the last valid index.
      const a = channel[idx];
      const b = idx + 1 < channel.length ? channel[idx + 1] : channel[channel.length - 1];

      out[i] = a + frac * (b - a);
    }

    return out;
  },

  // ---------------------------------------------------------------
  //  Window Functions
  // ---------------------------------------------------------------

  /**
   * Generate a Hann window of the given size.
   *   w[n] = 0.5 * (1 - cos(2 * PI * n / (N - 1)))
   * @param {number} size
   * @returns {Float32Array}
   */
  hannWindow(size) {
    const win = new Float32Array(size);
    const denom = size - 1;
    for (let n = 0; n < size; n++) {
      win[n] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * n) / denom));
    }
    return win;
  },

  /**
   * Generate a Hamming window of the given size.
   *   w[n] = 0.54 - 0.46 * cos(2 * PI * n / (N - 1))
   * @param {number} size
   * @returns {Float32Array}
   */
  hammingWindow(size) {
    const win = new Float32Array(size);
    const denom = size - 1;
    for (let n = 0; n < size; n++) {
      win[n] = 0.54 - 0.46 * Math.cos((2.0 * Math.PI * n) / denom);
    }
    return win;
  },

  // ---------------------------------------------------------------
  //  FFT — Radix-2 Cooley-Tukey (in-place, iterative)
  // ---------------------------------------------------------------

  /**
   * In-place forward FFT.
   *
   * @param {Float32Array} real — real parts (length must be a power of 2)
   * @param {Float32Array} imag — imaginary parts (same length as real)
   *
   * Both arrays are modified in-place to contain the DFT result.
   */
  fft(real, imag) {
    const N = real.length;

    // --- Bit-reversal permutation ---
    const halfN = N >>> 1;
    let j = 0;
    for (let i = 0; i < N - 1; i++) {
      if (i < j) {
        // Swap real[i] <-> real[j]
        let tmp = real[i];
        real[i] = real[j];
        real[j] = tmp;
        // Swap imag[i] <-> imag[j]
        tmp = imag[i];
        imag[i] = imag[j];
        imag[j] = tmp;
      }
      let k = halfN;
      while (k <= j) {
        j -= k;
        k >>>= 1;
      }
      j += k;
    }

    // --- Butterfly stages ---
    for (let size = 2; size <= N; size <<= 1) {
      const halfSize = size >>> 1;
      const angleStep = -2.0 * Math.PI / size; // negative for forward FFT

      // Twiddle factor seed for this stage.
      const wReal = Math.cos(angleStep);
      const wImag = Math.sin(angleStep);

      for (let start = 0; start < N; start += size) {
        let curReal = 1.0;
        let curImag = 0.0;

        for (let k = 0; k < halfSize; k++) {
          const evenIdx = start + k;
          const oddIdx  = start + k + halfSize;

          // Twiddle * odd element
          const tReal = curReal * real[oddIdx] - curImag * imag[oddIdx];
          const tImag = curReal * imag[oddIdx] + curImag * real[oddIdx];

          // Butterfly
          real[oddIdx] = real[evenIdx] - tReal;
          imag[oddIdx] = imag[evenIdx] - tImag;
          real[evenIdx] += tReal;
          imag[evenIdx] += tImag;

          // Advance twiddle factor
          const nextReal = curReal * wReal - curImag * wImag;
          const nextImag = curReal * wImag + curImag * wReal;
          curReal = nextReal;
          curImag = nextImag;
        }
      }
    }
  },

  /**
   * In-place inverse FFT.
   *
   * Strategy: conjugate -> forward FFT -> conjugate -> scale by 1/N.
   *
   * @param {Float32Array} real — real parts (length must be a power of 2)
   * @param {Float32Array} imag — imaginary parts (same length as real)
   */
  ifft(real, imag) {
    const N = real.length;

    // Conjugate
    for (let i = 0; i < N; i++) imag[i] = -imag[i];

    // Forward FFT
    DSP.fft(real, imag);

    // Conjugate again and scale
    const invN = 1.0 / N;
    for (let i = 0; i < N; i++) {
      real[i] *= invN;
      imag[i] = -imag[i] * invN;
    }
  },

  // ---------------------------------------------------------------
  //  Overlap-Add Framework
  // ---------------------------------------------------------------

  /**
   * General overlap-add processor.
   *
   * Workflow per frame:
   *   1. Extract a frame of `frameSize` samples from inputChannel.
   *   2. Apply a Hann analysis window.
   *   3. Forward FFT.
   *   4. Call `processFrame(real, imag, frameIndex)` — user modifies
   *      the spectrum in-place.
   *   5. Inverse FFT.
   *   6. Apply a Hann synthesis window.
   *   7. Overlap-add into the output buffer.
   *
   * Normalization:
   *   When hopIn === hopOut the double Hann window (analysis + synthesis)
   *   with 50 % overlap sums to unity, so no extra gain compensation is
   *   needed at hop = frameSize / 2.  For other hop sizes we accumulate
   *   the squared-window energy per sample and divide the output by it
   *   (the standard COLA normalization).
   *
   * @param {Float32Array} inputChannel — mono audio
   * @param {number}       frameSize    — FFT window size (power of 2)
   * @param {number}       hopIn        — input hop (advance in input per frame)
   * @param {number}       hopOut       — output hop (advance in output per frame)
   * @param {Function}     processFrame — callback(real, imag, frameIndex)
   * @returns {Float32Array} processed output audio
   */
  ola(inputChannel, frameSize, hopIn, hopOut, processFrame) {
    const inputLen = inputChannel.length;

    // Number of complete frames we can extract from the input.
    const numFrames = Math.floor((inputLen - frameSize) / hopIn) + 1;

    // Length of the output buffer.
    const outputLen = (numFrames - 1) * hopOut + frameSize;

    const output   = new Float32Array(outputLen);
    const winSum   = new Float32Array(outputLen); // accumulated window energy

    // Pre-compute the analysis/synthesis window (Hann).
    const window = DSP.hannWindow(frameSize);

    // Scratch buffers for each frame.
    const real = new Float32Array(frameSize);
    const imag = new Float32Array(frameSize);

    for (let f = 0; f < numFrames; f++) {
      const inOffset  = f * hopIn;
      const outOffset = f * hopOut;

      // --- 1. Copy & apply analysis window ---
      for (let n = 0; n < frameSize; n++) {
        real[n] = inputChannel[inOffset + n] * window[n];
        imag[n] = 0.0;
      }

      // --- 2. Forward FFT ---
      DSP.fft(real, imag);

      // --- 3. User processing in the frequency domain ---
      processFrame(real, imag, f);

      // --- 4. Inverse FFT ---
      DSP.ifft(real, imag);

      // --- 5. Apply synthesis window & overlap-add ---
      for (let n = 0; n < frameSize; n++) {
        const w = window[n];
        output[outOffset + n] += real[n] * w;

        // Accumulate the squared window for COLA normalisation.
        winSum[outOffset + n] += w * w;
      }
    }

    // --- 6. Normalize by accumulated window energy ---
    // At the trailing edge winSum is tiny, causing amplitude spikes.
    // Only fade the tail — preserve the leading edge for transients.
    let maxWinSum = 0;
    for (let i = 0; i < outputLen; i++) {
      if (winSum[i] > maxWinSum) maxWinSum = winSum[i];
    }
    const threshold = maxWinSum * 0.5;
    // Find where the stable region ends
    let stableEnd = outputLen;
    for (let i = outputLen - 1; i >= 0; i--) {
      if (winSum[i] >= threshold) { stableEnd = i + 1; break; }
    }
    for (let i = 0; i < outputLen; i++) {
      if (winSum[i] >= threshold) {
        output[i] /= winSum[i];
      } else if (winSum[i] > 1e-8) {
        if (i >= stableEnd) {
          // Trailing edge: fade out proportionally to avoid spike
          output[i] = (output[i] / winSum[i]) * (winSum[i] / threshold);
        } else {
          // Leading edge: normal division, preserve transients
          output[i] /= winSum[i];
        }
      }
    }

    return output;
  }
};
