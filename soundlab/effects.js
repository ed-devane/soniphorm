const Effects = {

    registry: {

        reverb: {
            label: 'Reverb',
            params: [
                { key: 'decay', label: 'Decay', min: 0.1, max: 8, step: 0.1, default: 2, unit: 's' },
                { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 40, unit: '%' }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                const decay = params.decay || 2;
                const mix = (params.mix !== undefined ? params.mix : 40) / 100;
                const numChannels = channels.length;

                const irChannels = Effects.generateIR(sampleRate, decay, numChannels);

                const wet = await Effects.processOffline(channels, sampleRate, start, end, async function(offline, source) {
                    const irLength = irChannels[0].length;
                    const irBuffer = offline.createBuffer(numChannels, irLength, sampleRate);
                    for (let ch = 0; ch < numChannels; ch++) {
                        irBuffer.getChannelData(ch).set(irChannels[ch]);
                    }

                    const convolver = offline.createConvolver();
                    convolver.buffer = irBuffer;

                    source.connect(convolver);
                    return convolver;
                });

                const result = channels.map(function(ch) { return new Float32Array(ch); });
                for (let ch = 0; ch < numChannels; ch++) {
                    for (let i = start; i < end; i++) {
                        result[ch][i] = channels[ch][i] * (1 - mix) + wet[ch][i] * mix;
                    }
                }
                return result;
            }
        },

        delay: {
            label: 'Delay',
            params: [
                { key: 'time', label: 'Time', min: 10, max: 1000, step: 10, default: 300, unit: 'ms' },
                { key: 'feedback', label: 'Feedback', min: 0, max: 90, step: 1, default: 40, unit: '%' },
                { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 50, unit: '%' }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                const delayTime = (params.time || 300) / 1000;
                const feedback = (params.feedback !== undefined ? params.feedback : 40) / 100;
                const mix = (params.mix !== undefined ? params.mix : 50) / 100;
                const delaySamples = Math.floor(delayTime * sampleRate);
                const numChannels = channels.length;

                const result = channels.map(function(ch) { return new Float32Array(ch); });

                for (let ch = 0; ch < numChannels; ch++) {
                    var regionLength = end - start;
                    var delayBuffer = new Float32Array(regionLength);

                    for (var i = 0; i < regionLength; i++) {
                        var drySample = channels[ch][start + i];
                        var delayedSample = 0;

                        if (i - delaySamples >= 0) {
                            delayedSample = delayBuffer[i - delaySamples];
                        }

                        delayBuffer[i] = drySample + delayedSample * feedback;
                        var wetSample = delayedSample;
                        result[ch][start + i] = drySample * (1 - mix) + wetSample * mix;
                    }
                }
                return result;
            }
        },

        overdrive: {
            label: 'Overdrive',
            params: [
                { key: 'drive', label: 'Drive', min: 1, max: 50, step: 1, default: 10 },
                { key: 'tone', label: 'Tone', min: 0, max: 100, step: 1, default: 50, unit: '%' }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var drive = params.drive || 10;
                var tone = (params.tone !== undefined ? params.tone : 50) / 100;
                var numChannels = channels.length;

                var result = channels.map(function(ch) { return new Float32Array(ch); });

                // Tone controls a simple one-pole low-pass filter coefficient
                // tone=1 means fully bright (no filtering), tone=0 means very dark
                var cutoff = 200 + tone * 19800; // 200 Hz to 20000 Hz
                var rc = 1.0 / (2.0 * Math.PI * cutoff);
                var dt = 1.0 / sampleRate;
                var alpha = dt / (rc + dt);

                for (var ch = 0; ch < numChannels; ch++) {
                    var prev = 0;
                    for (var i = start; i < end; i++) {
                        var sample = channels[ch][i] * drive;
                        sample = Math.tanh(sample);
                        // One-pole low-pass filter
                        prev = prev + alpha * (sample - prev);
                        result[ch][i] = prev;
                    }
                }
                return result;
            }
        },

        bitcrush: {
            label: 'Bitcrush',
            params: [
                { key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, default: 8 },
                { key: 'downsample', label: 'Downsample', min: 1, max: 50, step: 1, default: 1 }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var bits = params.bits || 8;
                var downsample = params.downsample || 1;
                var numChannels = channels.length;
                var levels = Math.pow(2, bits);

                var result = channels.map(function(ch) { return new Float32Array(ch); });

                for (var ch = 0; ch < numChannels; ch++) {
                    var held = 0;
                    for (var i = start; i < end; i++) {
                        var regionIndex = i - start;
                        if (regionIndex % downsample === 0) {
                            held = Math.round(channels[ch][i] * levels) / levels;
                        }
                        result[ch][i] = held;
                    }
                }
                return result;
            }
        },

        filter: {
            label: 'Filter',
            params: [
                { key: 'type', label: 'Type', type: 'select', options: ['lowpass', 'highpass', 'bandpass', 'notch'], default: 'lowpass' },
                { key: 'frequency', label: 'Frequency', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz', scale: 'log' },
                { key: 'q', label: 'Q', min: 0.1, max: 30, step: 0.1, default: 1 }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var filterType = params.type || 'lowpass';
                var frequency = params.frequency || 1000;
                var q = params.q !== undefined ? params.q : 1;

                var processed = await Effects.processOffline(channels, sampleRate, start, end, async function(offline, source) {
                    var biquad = offline.createBiquadFilter();
                    biquad.type = filterType;
                    biquad.frequency.value = frequency;
                    biquad.Q.value = q;

                    source.connect(biquad);
                    return biquad;
                });

                return processed;
            }
        },

        ringmod: {
            label: 'Ring Mod',
            params: [
                { key: 'frequency', label: 'Frequency', min: 1, max: 5000, step: 1, default: 440, unit: 'Hz' },
                { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, default: 100, unit: '%' }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var frequency = params.frequency || 440;
                var mix = (params.mix !== undefined ? params.mix : 100) / 100;
                var numChannels = channels.length;

                var result = channels.map(function(ch) { return new Float32Array(ch); });

                for (var ch = 0; ch < numChannels; ch++) {
                    for (var i = start; i < end; i++) {
                        var sampleIndex = i - start;
                        var mod = Math.sin(2 * Math.PI * frequency * sampleIndex / sampleRate);
                        var wet = channels[ch][i] * mod;
                        result[ch][i] = channels[ch][i] * (1 - mix) + wet * mix;
                    }
                }
                return result;
            }
        },

        wavefolding: {
            label: 'Wavefolding',
            params: [
                { key: 'threshold', label: 'Threshold', min: 0.1, max: 1.0, step: 0.01, default: 0.5 },
                { key: 'gain', label: 'Gain', min: 1, max: 10, step: 0.1, default: 2 }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var threshold = params.threshold !== undefined ? params.threshold : 0.5;
                var gain = params.gain || 2;
                var numChannels = channels.length;

                var result = channels.map(function(ch) { return new Float32Array(ch); });

                for (var ch = 0; ch < numChannels; ch++) {
                    for (var i = start; i < end; i++) {
                        var sample = channels[ch][i] * gain;

                        // Fold the waveform when it exceeds the threshold
                        while (Math.abs(sample) > threshold) {
                            if (sample > threshold) {
                                sample = 2 * threshold - sample;
                            } else if (sample < -threshold) {
                                sample = -2 * threshold - sample;
                            }
                        }

                        // Clamp to [-1, 1]
                        if (sample > 1) sample = 1;
                        if (sample < -1) sample = -1;

                        result[ch][i] = sample;
                    }
                }
                return result;
            }
        },

        stutter: {
            label: 'Stutter',
            params: [
                { key: 'sliceMs', label: 'Slice', min: 10, max: 500, step: 10, default: 100, unit: 'ms' },
                { key: 'repeats', label: 'Repeats', min: 1, max: 16, step: 1, default: 4 },
                { key: 'scatter', label: 'Scatter', min: 0, max: 100, step: 1, default: 0, unit: '%' }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var sliceMs = params.sliceMs || 100;
                var repeats = params.repeats || 4;
                var scatter = (params.scatter !== undefined ? params.scatter : 0) / 100;
                var numChannels = channels.length;
                var sliceSamples = Math.floor((sliceMs / 1000) * sampleRate);
                var regionLength = end - start;

                var result = channels.map(function(ch) { return new Float32Array(ch); });

                // Work through the region in slices
                var writePos = 0;

                for (var sliceStart = 0; sliceStart < regionLength; sliceStart += sliceSamples) {
                    var sliceEnd = Math.min(sliceStart + sliceSamples, regionLength);
                    var currentSliceLength = sliceEnd - sliceStart;

                    // Write the original slice, then repeat it
                    for (var r = 0; r < repeats; r++) {
                        if (writePos >= regionLength) break;

                        // If scatter > 0, randomly skip some repetitions (but always write the first one)
                        if (r > 0 && scatter > 0 && Math.random() < scatter) {
                            writePos += currentSliceLength;
                            continue;
                        }

                        var copyLength = Math.min(currentSliceLength, regionLength - writePos);
                        for (var ch = 0; ch < numChannels; ch++) {
                            for (var s = 0; s < copyLength; s++) {
                                result[ch][start + writePos + s] = channels[ch][start + sliceStart + s];
                            }
                        }
                        writePos += currentSliceLength;
                    }
                }

                return result;
            }
        },

        timestretch: {
            label: 'Time Stretch',
            params: [
                { key: 'rate', label: 'Rate', min: 0.25, max: 4.0, step: 0.05, default: 1.0 }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var rate = params.rate !== undefined ? params.rate : 1.0;
                var numChannels = channels.length;
                var frameSize = 4096;
                var hopIn = frameSize / 4;
                var hopOut = Math.round(hopIn * rate);

                var result = channels.map(function(ch) {
                    var region = ch.subarray(start, end);
                    // Phase vocoder via DSP.ola — processFrame receives already-FFT'd data
                    var halfSize = frameSize / 2 + 1;
                    var prevPhaseIn = new Float32Array(halfSize);
                    var phaseAccum = new Float32Array(halfSize);
                    var isFirstFrame = true;

                    var processedRegion = DSP.ola(region, frameSize, hopIn, hopOut, function(frameReal, frameImag) {
                        var freqPerBin = 2 * Math.PI * hopIn / frameSize;

                        for (var k = 0; k < halfSize; k++) {
                            var mag = Math.sqrt(frameReal[k] * frameReal[k] + frameImag[k] * frameImag[k]);
                            var phase = Math.atan2(frameImag[k], frameReal[k]);

                            if (isFirstFrame) {
                                phaseAccum[k] = phase;
                            } else {
                                var phaseDiff = phase - prevPhaseIn[k];
                                var expectedDiff = k * freqPerBin;
                                var wrappedDiff = phaseDiff - expectedDiff;
                                wrappedDiff = wrappedDiff - Math.round(wrappedDiff / (2 * Math.PI)) * 2 * Math.PI;
                                var trueFreq = expectedDiff + wrappedDiff;
                                phaseAccum[k] += trueFreq * (hopOut / hopIn);
                            }

                            prevPhaseIn[k] = phase;
                            frameReal[k] = mag * Math.cos(phaseAccum[k]);
                            frameImag[k] = mag * Math.sin(phaseAccum[k]);
                        }

                        // Mirror negative frequencies
                        for (var k = halfSize; k < frameSize; k++) {
                            frameReal[k] = frameReal[frameSize - k];
                            frameImag[k] = -frameImag[frameSize - k];
                        }

                        isFirstFrame = false;
                    });

                    var before = ch.subarray(0, start);
                    var after = ch.subarray(end);
                    var out = new Float32Array(before.length + processedRegion.length + after.length);
                    out.set(before, 0);
                    out.set(processedRegion, before.length);
                    out.set(after, before.length + processedRegion.length);
                    return out;
                });

                return result;
            }
        },

        pitchshift: {
            label: 'Pitch Shift',
            params: [
                { key: 'semitones', label: 'Semitones', min: -12, max: 12, step: 1, default: 0 }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var semitones = params.semitones !== undefined ? params.semitones : 0;
                var pitchRatio = Math.pow(2, semitones / 12);
                var numChannels = channels.length;
                var regionLength = end - start;
                var frameSize = 4096;
                var hopIn = frameSize / 4;
                // Time-stretch by 1/pitchRatio to compensate for resampling
                var stretchRate = 1.0 / pitchRatio;
                var hopOut = Math.round(hopIn * stretchRate);

                var result = channels.map(function(ch) {
                    var region = ch.subarray(start, end);

                    // Step 1: Time-stretch the region by 1/pitchRatio (phase vocoder)
                    var halfSize = frameSize / 2 + 1;
                    var prevPhaseIn = new Float32Array(halfSize);
                    var phaseAccum = new Float32Array(halfSize);
                    var isFirstFrame = true;

                    var stretched = DSP.ola(region, frameSize, hopIn, hopOut, function(frameReal, frameImag) {
                        var freqPerBin = 2 * Math.PI * hopIn / frameSize;

                        for (var k = 0; k < halfSize; k++) {
                            var mag = Math.sqrt(frameReal[k] * frameReal[k] + frameImag[k] * frameImag[k]);
                            var phase = Math.atan2(frameImag[k], frameReal[k]);

                            if (isFirstFrame) {
                                phaseAccum[k] = phase;
                            } else {
                                var phaseDiff = phase - prevPhaseIn[k];
                                var expectedDiff = k * freqPerBin;
                                var wrappedDiff = phaseDiff - expectedDiff;
                                wrappedDiff = wrappedDiff - Math.round(wrappedDiff / (2 * Math.PI)) * 2 * Math.PI;
                                var trueFreq = expectedDiff + wrappedDiff;
                                phaseAccum[k] += trueFreq * (hopOut / hopIn);
                            }

                            prevPhaseIn[k] = phase;
                            frameReal[k] = mag * Math.cos(phaseAccum[k]);
                            frameImag[k] = mag * Math.sin(phaseAccum[k]);
                        }

                        for (var k = halfSize; k < frameSize; k++) {
                            frameReal[k] = frameReal[frameSize - k];
                            frameImag[k] = -frameImag[frameSize - k];
                        }

                        isFirstFrame = false;
                    });

                    // Step 2: Resample to change pitch and restore original length
                    var resampled = DSP.resample(stretched, sampleRate * pitchRatio, sampleRate);

                    // Trim or pad to match original region length
                    var processedRegion = new Float32Array(regionLength);
                    var copyLen = Math.min(resampled.length, regionLength);
                    processedRegion.set(resampled.subarray(0, copyLen));

                    var before = ch.subarray(0, start);
                    var after = ch.subarray(end);
                    var out = new Float32Array(before.length + processedRegion.length + after.length);
                    out.set(before, 0);
                    out.set(processedRegion, before.length);
                    out.set(after, before.length + processedRegion.length);
                    return out;
                });

                return result;
            }
        },

        paulstretch: {
            label: 'Paulstretch',
            params: [
                { key: 'stretch', label: 'Stretch', min: 2, max: 50, step: 1, default: 8 },
                { key: 'windowSize', label: 'Window Size', min: 0.1, max: 1.0, step: 0.05, default: 0.3, unit: 's' }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var stretch = params.stretch !== undefined ? params.stretch : 8;
                var windowSec = params.windowSize !== undefined ? params.windowSize : 0.3;
                var numChannels = channels.length;
                var regionLength = end - start;

                // Convert window size to samples, round up to next power of 2
                var windowSamples = DSP.nextPow2(Math.ceil(windowSec * sampleRate));
                var halfWindow = windowSamples / 2;

                // Input hop and output hop
                var hopIn = Math.max(1, Math.round(windowSamples / stretch));
                var hopOut = halfWindow;

                // Estimate output length
                var numFrames = Math.ceil(regionLength / hopIn);
                var outputLength = numFrames * hopOut + windowSamples;

                var window = DSP.hannWindow(windowSamples);

                var result = channels.map(function(ch) {
                    var region = ch.subarray(start, end);
                    var output = new Float32Array(outputLength);

                    var readPos = 0;
                    var writePos = 0;

                    while (readPos < regionLength) {
                        // Extract frame and zero-pad if needed
                        var real = new Float32Array(windowSamples);
                        var imag = new Float32Array(windowSamples);

                        for (var i = 0; i < windowSamples; i++) {
                            var idx = readPos + i;
                            if (idx >= 0 && idx < regionLength) {
                                real[i] = region[idx] * window[i];
                            }
                        }

                        // FFT
                        DSP.fft(real, imag);

                        // Keep magnitudes, randomize phases
                        for (var k = 0; k < windowSamples; k++) {
                            var mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
                            var randomPhase = Math.random() * 2 * Math.PI;
                            real[k] = mag * Math.cos(randomPhase);
                            imag[k] = mag * Math.sin(randomPhase);
                        }

                        // IFFT
                        DSP.ifft(real, imag);

                        // Window output and overlap-add
                        for (var i = 0; i < windowSamples; i++) {
                            if (writePos + i < outputLength) {
                                output[writePos + i] += real[i] * window[i];
                            }
                        }

                        readPos += hopIn;
                        writePos += hopOut;
                    }

                    // Trim output to actual content
                    var finalLength = writePos + windowSamples;
                    if (finalLength > outputLength) finalLength = outputLength;
                    var processedRegion = output.subarray(0, finalLength);

                    var before = ch.subarray(0, start);
                    var after = ch.subarray(end);
                    var out = new Float32Array(before.length + processedRegion.length + after.length);
                    out.set(before, 0);
                    out.set(processedRegion, before.length);
                    out.set(after, before.length + processedRegion.length);
                    return out;
                });

                return result;
            }
        },

        granularfreeze: {
            label: 'Granular Freeze',
            params: [
                { key: 'position', label: 'Position', min: 0, max: 100, step: 1, default: 50, unit: '%' },
                { key: 'grainSize', label: 'Grain Size', min: 10, max: 200, step: 5, default: 50, unit: 'ms' },
                { key: 'density', label: 'Density', min: 1, max: 20, step: 1, default: 8 },
                { key: 'duration', label: 'Duration', min: 0.5, max: 10, step: 0.5, default: 3, unit: 's' }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var position = (params.position !== undefined ? params.position : 50) / 100;
                var grainSizeMs = params.grainSize !== undefined ? params.grainSize : 50;
                var density = params.density !== undefined ? params.density : 8;
                var duration = params.duration !== undefined ? params.duration : 3;
                var numChannels = channels.length;
                var regionLength = end - start;

                var grainSamples = Math.floor((grainSizeMs / 1000) * sampleRate);
                var outputLength = Math.floor(duration * sampleRate);
                var halfGrain = Math.floor(grainSamples / 2);

                // Freeze point within the selection
                var freezePoint = Math.floor(position * regionLength);

                // Create a Hann window for grains
                var grainWindow = DSP.hannWindow(grainSamples);

                var result = channels.map(function(ch) {
                    var region = ch.subarray(start, end);
                    var output = new Float32Array(outputLength);

                    // Calculate total number of grains to scatter
                    var windowsInOutput = Math.ceil(outputLength / grainSamples);
                    var totalGrains = windowsInOutput * density;

                    for (var g = 0; g < totalGrains; g++) {
                        // Random offset from freeze point (+/- half grain size)
                        var sourceOffset = freezePoint + Math.floor((Math.random() - 0.5) * grainSamples);
                        var sourceStart = sourceOffset - halfGrain;

                        // Random position in output
                        var outPos = Math.floor(Math.random() * (outputLength - grainSamples));
                        if (outPos < 0) outPos = 0;

                        for (var i = 0; i < grainSamples; i++) {
                            var srcIdx = sourceStart + i;
                            if (srcIdx >= 0 && srcIdx < regionLength && outPos + i < outputLength) {
                                output[outPos + i] += region[srcIdx] * grainWindow[i];
                            }
                        }
                    }

                    // Normalize to prevent clipping
                    var maxVal = 0;
                    for (var i = 0; i < outputLength; i++) {
                        var absVal = Math.abs(output[i]);
                        if (absVal > maxVal) maxVal = absVal;
                    }
                    if (maxVal > 1.0) {
                        for (var i = 0; i < outputLength; i++) {
                            output[i] /= maxVal;
                        }
                    }

                    var processedRegion = output;
                    var before = ch.subarray(0, start);
                    var after = ch.subarray(end);
                    var out = new Float32Array(before.length + processedRegion.length + after.length);
                    out.set(before, 0);
                    out.set(processedRegion, before.length);
                    out.set(after, before.length + processedRegion.length);
                    return out;
                });

                return result;
            }
        },

        spectralfreeze: {
            label: 'Spectral Freeze',
            params: [
                { key: 'position', label: 'Position', min: 0, max: 100, step: 1, default: 50, unit: '%' },
                { key: 'duration', label: 'Duration', min: 0.5, max: 10, step: 0.5, default: 3, unit: 's' },
                { key: 'smoothing', label: 'Smoothing', min: 0, max: 100, step: 1, default: 80, unit: '%' }
            ],
            process: async function(channels, sampleRate, start, end, params) {
                var position = (params.position !== undefined ? params.position : 50) / 100;
                var duration = params.duration !== undefined ? params.duration : 3;
                var smoothing = (params.smoothing !== undefined ? params.smoothing : 80) / 100;
                var numChannels = channels.length;
                var regionLength = end - start;

                var frameSize = 4096;
                var hopOut = frameSize / 4;
                var outputLength = Math.floor(duration * sampleRate);
                var numFrames = Math.ceil(outputLength / hopOut);

                var window = DSP.hannWindow(frameSize);

                // Freeze point within the selection
                var freezeSample = Math.floor(position * regionLength);

                var result = channels.map(function(ch) {
                    var region = ch.subarray(start, end);

                    // Step 1: Capture magnitude spectrum at freeze position
                    var captureStart = freezeSample - Math.floor(frameSize / 2);
                    var captureReal = new Float32Array(frameSize);
                    var captureImag = new Float32Array(frameSize);

                    for (var i = 0; i < frameSize; i++) {
                        var idx = captureStart + i;
                        if (idx >= 0 && idx < regionLength) {
                            captureReal[i] = region[idx] * window[i];
                        }
                    }

                    DSP.fft(captureReal, captureImag);

                    // Store magnitudes
                    var magnitudes = new Float32Array(frameSize);
                    for (var k = 0; k < frameSize; k++) {
                        magnitudes[k] = Math.sqrt(captureReal[k] * captureReal[k] + captureImag[k] * captureImag[k]);
                    }

                    // Step 2: Generate output with frozen magnitudes and evolving phases
                    var output = new Float32Array(outputLength);
                    var currentPhases = new Float32Array(frameSize);

                    // Initialize phases randomly
                    for (var k = 0; k < frameSize; k++) {
                        currentPhases[k] = Math.random() * 2 * Math.PI;
                    }

                    for (var f = 0; f < numFrames; f++) {
                        var writePos = f * hopOut;
                        var real = new Float32Array(frameSize);
                        var imag = new Float32Array(frameSize);

                        // Evolve phases: blend between current and new random phases
                        // High smoothing = less change = smoother
                        for (var k = 0; k < frameSize; k++) {
                            var newRandom = Math.random() * 2 * Math.PI;
                            // Smoothing controls how much the phase changes
                            // smoothing=1 means phases barely change, smoothing=0 means fully random each frame
                            currentPhases[k] = currentPhases[k] * smoothing + newRandom * (1 - smoothing);

                            real[k] = magnitudes[k] * Math.cos(currentPhases[k]);
                            imag[k] = magnitudes[k] * Math.sin(currentPhases[k]);
                        }

                        DSP.ifft(real, imag);

                        // Window and overlap-add
                        for (var i = 0; i < frameSize; i++) {
                            if (writePos + i < outputLength) {
                                output[writePos + i] += real[i] * window[i];
                            }
                        }
                    }

                    // Normalize to prevent clipping
                    var maxVal = 0;
                    for (var i = 0; i < outputLength; i++) {
                        var absVal = Math.abs(output[i]);
                        if (absVal > maxVal) maxVal = absVal;
                    }
                    if (maxVal > 1.0) {
                        for (var i = 0; i < outputLength; i++) {
                            output[i] /= maxVal;
                        }
                    }

                    var processedRegion = output;
                    var before = ch.subarray(0, start);
                    var after = ch.subarray(end);
                    var out = new Float32Array(before.length + processedRegion.length + after.length);
                    out.set(before, 0);
                    out.set(processedRegion, before.length);
                    out.set(after, before.length + processedRegion.length);
                    return out;
                });

                return result;
            }
        },

        bounce: {
            label: 'Bounce',
            params: [],
            process: async function(channels, sampleRate, start, end, params) {
                var numChannels = channels.length;
                var length = end - start;
                var result = [];

                for (var ch = 0; ch < numChannels; ch++) {
                    var bounced = new Float32Array(length);
                    bounced.set(channels[ch].subarray(start, end));
                    result.push(bounced);
                }

                return result;
            }
        }
    },

    async processOffline(channels, sampleRate, start, end, setupFn) {
        var length = end - start;
        var numChannels = channels.length;
        var offline = new OfflineAudioContext(numChannels, length + sampleRate * 2, sampleRate);

        var buffer = offline.createBuffer(numChannels, length, sampleRate);
        for (var ch = 0; ch < numChannels; ch++) {
            buffer.getChannelData(ch).set(channels[ch].subarray(start, end));
        }

        var source = offline.createBufferSource();
        source.buffer = buffer;

        var finalNode = await setupFn(offline, source);
        finalNode.connect(offline.destination);
        source.start();

        var rendered = await offline.startRendering();

        var result = channels.map(function(ch) { return new Float32Array(ch); });
        for (var ch = 0; ch < numChannels; ch++) {
            var renderedData = rendered.getChannelData(ch);
            result[ch].set(renderedData.subarray(0, length), start);
        }
        return result;
    },

    generateIR(sampleRate, decay, numChannels) {
        numChannels = numChannels || 1;
        var length = Math.floor(sampleRate * decay);
        var channels = [];

        for (var ch = 0; ch < numChannels; ch++) {
            var ir = new Float32Array(length);
            for (var i = 0; i < length; i++) {
                ir[i] = (Math.random() * 2 - 1) * Math.exp(-3 * i / length);
            }
            channels.push(ir);
        }
        return channels;
    }
};
