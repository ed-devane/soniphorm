// AudioWorkletProcessor for the AudioLooper module (see
// factories/audioLooper.js) - a loop-pedal-style live looper where each pass
// around the loop while overdubbing is kept as its own individually
// editable layer (mute/reverse/shift/volume-envelope), rather than being
// permanently mixed into one signal the moment it's recorded. Only once more
// than 8 layers exist does the oldest get baked into a background
// "foundation" track. Same category of problem as granularProcessor.js
// (Smudge): simultaneously recording live input into an open layer while
// reading up to 8 independently-transformed layers plus a foundation track,
// summed sample-accurately with an inaudible loop seam - no combination of
// stock Web Audio nodes can do concurrent read-while-write like that, and
// SharedArrayBuffer isn't an option on this project's static-hosting
// deployment target (needs COOP/COEP headers GitHub Pages can't set). So this
// worklet owns all layer/foundation audio itself and pushes lightweight
// snapshots (peaks, not full-res buffers) to the main thread over its port
// for the UI to draw. Self-contained on purpose, no imports (worklet modules
// load into their own global scope), same as granularProcessor.js.

const MAX_LAYERS = 8;
const PEAK_BUCKETS = 100;
// How often (in samples) to push a lightweight playhead/layer-state snapshot
// to the main thread - independent of loop wraps, which can be many seconds
// apart. ~40ms at 48kHz is plenty smooth for a UI playhead line.
const STATE_POST_INTERVAL_SAMPLES = 2048;
// Live in-progress-recording peaks update less often than state - full-buffer
// peaks recomputation is O(loop length), and unlike the fixed-size state
// message, a long loop makes that genuinely non-trivial audio-thread work.
// ~150ms is still smooth enough to watch a waveform fill in as it records.
const LIVE_PEAKS_INTERVAL_SAMPLES = STATE_POST_INTERVAL_SAMPLES * 4;
// Moving layerShift jumps the read *target* to a different point in the
// layer's buffer every block while it's being scrubbed - read instantly,
// that's an audible click (a real waveform discontinuity, not just a CV
// artifact). Rather than crossfading two hard-jumped read positions (which
// glitched on every retarget mid-scrub - restarting the crossfade from
// whatever the still-in-progress blend's "new" side was, not from what was
// actually audible at that instant, itself created a fresh discontinuity),
// the actually-read position is a single continuously-smoothed float that
// chases the target one sample at a time and is never allowed to jump - see
// readLayerSample. ~256 samples (~5.3ms at 48kHz) is fast enough to feel
// responsive but slow enough to stay inaudible as a pitch/time smear.
const SHIFT_SMOOTH_SAMPLES = 256;
const SHIFT_SMOOTH_COEFF = 1 - Math.exp(-1 / SHIFT_SMOOTH_SAMPLES);
// Ducks a layer's own output while its shift is actively catching up to a
// new target - the smoothed chase above is what makes a shift move at all
// audible-sounding (a real, if brief, pitch/time smear - "tape speed noise"
// as scrub artifacts always sound), so hiding it under a duck reads as a
// deliberate move rather than a technical artifact. Tied to
// SHIFT_SMOOTH_SAMPLES rather than an unrelated constant, so "how far
// behind is the read position" and "how much is that worth ducking for"
// scale together. Never fully silent (SHIFT_DUCK_MIN_GAIN) - a soft duck
// reads as intentional, a hard mute reads as a dropout.
const SHIFT_DUCK_FULL_ERROR_SAMPLES = SHIFT_SMOOTH_SAMPLES;
const SHIFT_DUCK_MIN_GAIN = 0.15;
// Fast enough to catch a shift that jumps instantly (a dragged slider/CV
// step can retarget between blocks with no ramp of its own) without itself
// clicking on the way down - independent of, and quicker than, the shift
// chase itself so the duck arrives before the pitch smear does, not after.
const SHIFT_DUCK_SMOOTH_SAMPLES = 64;
const SHIFT_DUCK_SMOOTH_COEFF = 1 - Math.exp(-1 / SHIFT_DUCK_SMOOTH_SAMPLES);
// Global playback-rate range - same 0.25x-4x (2 octaves either way) SamplePlayer's
// own Speed already uses (registry.js), so the two "speed" controls in this app
// feel consistent even though they're unrelated implementations underneath.
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

// Wraps (not clamps) a raw CV value into [0, length) - same convention
// cvMap.js's mapEnumIndex uses for SamplePlayer's markerIndex/Oscillator's
// wave input, duplicated here since worklets can't import from the app.
function wrapIndex(v, length) {
  if (length <= 0) return -1;
  const n = Math.round(v);
  return ((n % length) + length) % length;
}

// Downsampled min/max pairs per bucket, not the full-resolution buffer - a
// finalized layer can be several seconds of audio and never changes again,
// so this is computed once at finalize time rather than the UI recomputing
// peaks from a giant array on every render (SampleWaveform.jsx computes its
// own peaks from raw samples for a similar reason, just on the main thread
// where the full buffer is already available for a loaded file).
function computePeaks(float32, buckets) {
  const peaks = new Float32Array(buckets * 2);
  const bucketSize = float32.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * bucketSize);
    const end = Math.max(start + 1, Math.floor((b + 1) * bucketSize));
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end && i < float32.length; i++) {
      const v = float32[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) {
      min = 0;
      max = 0;
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

class AudioLooperProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'recordArm', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // Not 0-1 like most CV - a raw (possibly out-of-range) index value, same
      // convention as SamplePlayer's markerIndex (see wrapIndex above), so a
      // List/Step Sequencer can drive it directly.
      { name: 'layerSelect', defaultValue: 0, minValue: -1e6, maxValue: 1e6, automationRate: 'k-rate' },
      { name: 'layerMute', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'layerReverse', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'layerSolo', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'layerShift', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'layerVolume', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'recordAutomationArm', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'clock', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'trigger', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // Global "tape speed" - applies uniformly to the foundation and every
      // layer's playback (not recording - see readPos/recordPhase in
      // process()), so relative pitch/timing between them stays consistent.
      { name: 'speed', defaultValue: 1, minValue: SPEED_MIN, maxValue: SPEED_MAX, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.mode = 'free'; // 'free' | 'clock'
    this.clockTicksPerLoop = 16;
    // On by default (hear the live input mixed with the loop, same as a real
    // pedal's monitoring) - Inspector-only toggle to turn it off for setups
    // where the input is already monitored elsewhere and doubling it up would
    // just be a second, out-of-phase copy.
    this.passthrough = true;
    // Auto-rotate: each loop wrap, nudge one layer's shift by rotateInterval
    // (a fraction of loop length) in rotateDirection, cycling through
    // layerOrder one at a time rather than moving them all at once - see
    // onLoopWrap. rotateCursor is which position in layerOrder gets nudged
    // next; deliberately not reset on Clear/layer add/remove (resetAll
    // starts fresh anyway; a mid-rotation layer removal just means the
    // cursor lands on a different layer next wrap, not a bug worth guarding).
    this.rotateArm = false;
    this.rotateInterval = 1 / 16;
    this.rotateDirection = 1; // +1 forward, -1 backward
    this.rotateCursor = 0;
    // How many loop wraps to let pass between rotation nudges - 1 (default)
    // advances every pass, same as before this existed. Only increments
    // while armed (see advanceRotation's early return), so pausing/resuming
    // Auto-Rotate doesn't lose count mid-way through an interval.
    this.rotateEveryN = 1;
    this.rotateWrapCounter = 0;

    this.resetAll(false);

    this.lastRecordArm = 0;
    this.lastTrigger = 0;
    this.lastClock = 0;
    this.lastClockTickTime = null;
    this.clockPeriodSamples = null;
    this._statePostCounter = 0;
    this._livePeaksCounter = 0;
    // Counts each time readPos (the *audible* playhead) wraps - deliberately
    // not recordPhase/onLoopWrap below, which track the recording position at
    // native rate regardless of Speed, so the two diverge whenever Speed != 1.
    // A monotonic count (not a bare flag) so a message is never missed even
    // if the main thread happens to be busy for a block; the main thread only
    // cares that it changed, not by how much. See the postMessage below.
    this._eofPulseCount = 0;
    this._lastPostedEofCount = 0;

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (msg.type === 'setMode') this.mode = msg.mode;
    else if (msg.type === 'setClockTicksPerLoop') this.clockTicksPerLoop = msg.value;
    else if (msg.type === 'setPassthrough') this.passthrough = msg.value;
    // Mode/tick-count changes only take effect for the *next* loop (after a
    // Clear) - a loop already in progress keeps whatever length it started
    // with, since resizing foundation/layers mid-loop would corrupt them.
    else if (msg.type === 'clear') this.resetAll(true);
    else if (msg.type === 'clearLayer') this.clearSelectedLayer();
    else if (msg.type === 'setRotateArm') this.rotateArm = msg.value;
    else if (msg.type === 'setRotateInterval') this.rotateInterval = msg.value;
    else if (msg.type === 'setRotateDirection') this.rotateDirection = msg.value;
    else if (msg.type === 'setRotateEveryN') this.rotateEveryN = Math.max(1, Math.round(msg.value));
  }

  // Discards just the currently-selected layer (whatever layerSelect points
  // at), not baked into the foundation - the opposite of the rolling
  // mixdown's "assume it's a keeper" eviction. Leaves everything else (other
  // layers, foundation, loop length) untouched - unless that was the last
  // layer left, in which case there's no material left to justify the
  // established loop length either, so a full reset lets the next take (or
  // next clock tick, in Clock mode) define a fresh one instead of silently
  // keeping the old duration around for content that no longer exists.
  clearSelectedLayer() {
    // A mistake mid-take takes priority over whatever finalized layer
    // happens to be selected - Clear should always mean "get rid of
    // whatever's actually live/wrong right now," not silently discard some
    // other, already-good layer instead. Covers both an overdub pass in
    // progress (stagingLayer) and Free mode's very first take, before a
    // loop length even exists yet (firstTakeSamples) - either way, nothing
    // finalized is touched, and the next periodic state message naturally
    // reflects recording:false within ~40ms (see process()'s own
    // recording flag), no dedicated notification needed.
    if (this.stagingLayer) {
      this.stagingLayer = null;
      return;
    }
    if (this.firstTakeSamples) {
      this.firstTakeSamples = null;
      return;
    }
    if (this.selectedSlot == null) return;
    const slot = this.selectedSlot;
    const idx = this.layerOrder.indexOf(slot);
    if (idx === -1) return;
    this.layerOrder.splice(idx, 1);
    this.layers[slot] = null;
    this.port.postMessage({ type: 'layerRemoved', slot });
    if (this.layerOrder.length === 0) this.resetAll(true);
  }

  resetAll(notify) {
    this.loopLengthSamples = null;
    this.foundation = null;
    this.layers = Array.from({ length: MAX_LAYERS }, () => null);
    this.layerOrder = []; // slot indices, creation order, oldest first - drives rolling mixdown eviction
    this.stagingLayer = null; // the layer currently being recorded, not yet in layers[]/layerOrder
    this.firstTakeSamples = null; // Free mode only: growable capture buffer while the very first take's length is still unknown
    this.selectedSlot = null;
    // recordPhase: always advances by exactly 1 native sample per sample,
    // regardless of speed - drives writing into a staging layer and is the
    // sole trigger for onLoopWrap(), since "the loop wrapping" for recording
    // purposes is tied to real elapsed time, not to how fast old material is
    // currently being played back. readPos: the (possibly fractional)
    // position actually used to read the foundation/layers for output -
    // advances by `speed` per sample. See the speed handling in process()
    // for why these have to be two separate counters.
    this.recordPhase = 0;
    this.readPos = 0;
    // Soft-takeover state for layerShift/layerMute/layerReverse - see the
    // takeover block in process(). Reset here too so a fresh loop after
    // Clear doesn't inherit a stale "was live" flag or CV reading from
    // before.
    this.lastSelectedSlot = null;
    this.shiftTakeoverLive = false;
    this.lastShiftRaw = null;
    this.muteTakeoverLive = false;
    this.lastMuteRaw = false;
    this.reverseTakeoverLive = false;
    this.lastReverseRaw = false;
    if (notify) this.port.postMessage({ type: 'cleared' });
  }

  makeEmptyLayer() {
    const len = this.loopLengthSamples;
    return {
      audio: new Float32Array(len),
      envelope: new Float32Array(len).fill(1),
      muted: false,
      reversed: false,
      shiftSamples: 0,
      // The actually-read shift position, continuously chasing shiftSamples
      // (the target) one sample at a time - see SHIFT_SMOOTH_COEFF/
      // readLayerSample. Fractional (unlike shiftSamples itself), since a
      // smooth chase necessarily passes through non-integer positions.
      smoothedShiftSamples: 0,
      // This layer's own duck gain while shiftSamples/smoothedShiftSamples
      // disagree - see SHIFT_DUCK_* / readLayerSample.
      duckGain: 1,
    };
  }

  _shiftedPos(shiftSamples, reversed, pos, len) {
    const shifted = (pos + shiftSamples) % len;
    return reversed ? len - 1 - shifted : shifted;
  }

  effectiveReadPos(layer, pos) {
    return this._shiftedPos(layer.shiftSamples, layer.reversed, pos, this.loopLengthSamples);
  }

  // audio[effectiveReadPos]*envelope[effectiveReadPos], but read at a
  // continuously-smoothed fractional shift instead of the raw (possibly
  // just-jumped) target, linearly interpolating between the buffer's two
  // neighboring integer positions - see SHIFT_SMOOTH_COEFF for why a hard
  // jump needs hiding at all. Interpolating audio and envelope from the same
  // pair of positions keeps them in phase with each other.
  //
  // `pos` can itself be fractional now too (global speed != 1 - see
  // process()'s readPos), so this combines pos + the smoothed shift into one
  // continuous target and interpolates once, rather than nesting two
  // separate interpolations. That's not an approximation: _shiftedPos's own
  // formula is just (pos + shiftSamples) % len before the reversed flip, so
  // pos and shiftSamples were always additive - combining them first and
  // calling _shiftedPos(0, ...) on the combined floor/floor+1 lands on
  // exactly the same two buffer indices _shiftedPos(shiftFloor/shiftFloor+1,
  // ..., pos, ...) would have, for any integer pos (i.e. identical output to
  // before whenever speed is 1).
  readLayerSample(layer, pos) {
    const len = this.loopLengthSamples;
    const shiftError = layer.shiftSamples - layer.smoothedShiftSamples;
    layer.smoothedShiftSamples += shiftError * SHIFT_SMOOTH_COEFF;
    const duckTarget = 1 - (1 - SHIFT_DUCK_MIN_GAIN) * Math.min(1, Math.abs(shiftError) / SHIFT_DUCK_FULL_ERROR_SAMPLES);
    layer.duckGain += (duckTarget - layer.duckGain) * SHIFT_DUCK_SMOOTH_COEFF;
    const combined = pos + layer.smoothedShiftSamples;
    const combinedFloor = Math.floor(combined);
    const frac = combined - combinedFloor;
    const posA = this._shiftedPos(0, layer.reversed, combinedFloor, len);
    const posB = this._shiftedPos(0, layer.reversed, combinedFloor + 1, len);
    const sampleA = layer.audio[posA] * layer.envelope[posA];
    const sampleB = layer.audio[posB] * layer.envelope[posB];
    return (sampleA * (1 - frac) + sampleB * frac) * layer.duckGain;
  }

  // Foundation has no shift/reverse of its own - just a plain fractional
  // read for the same reason readLayerSample needs one: readPos advances by
  // `speed` per sample, so it's not always an integer index. No
  // anti-aliasing beyond this linear interpolation (same simplification as
  // the shift-smoothing above) - a cheap resampler, not a bandlimited one,
  // consistent with this project's "native nodes, no custom DSP" bias
  // (Design Decision #1) - audible roughness at extreme speeds is an
  // accepted tradeoff, not a bug.
  readFoundationSample(pos) {
    const len = this.loopLengthSamples;
    const floor = Math.floor(pos);
    const frac = pos - floor;
    const a = this.foundation[floor % len];
    const b = this.foundation[(floor + 1) % len];
    return a * (1 - frac) + b * frac;
  }

  establishClockLoopLength() {
    const len = Math.max(1, Math.round(this.clockTicksPerLoop * this.clockPeriodSamples));
    this.loopLengthSamples = len;
    this.foundation = new Float32Array(len);
    this.recordPhase = 0;
    this.readPos = 0;
    this.port.postMessage({ type: 'loopLengthSet', loopLengthSeconds: len / sampleRate });
  }

  finalizeFirstTake() {
    const len = Math.max(1, this.firstTakeSamples.length);
    this.loopLengthSamples = len;
    this.foundation = new Float32Array(len);
    const layer = {
      audio: Float32Array.from(this.firstTakeSamples),
      envelope: new Float32Array(len).fill(1),
      muted: false,
      reversed: false,
      shiftSamples: 0,
      smoothedShiftSamples: 0,
      duckGain: 1,
    };
    this.firstTakeSamples = null;
    this.recordPhase = 0;
    this.readPos = 0;
    this.port.postMessage({ type: 'loopLengthSet', loopLengthSeconds: len / sampleRate });
    this.placeNewLayer(layer);
  }

  // Bakes `layer` into the foundation at its current mute/reverse/shift/
  // envelope - frozen forever after (matches "assume the user's happy with
  // it"), then hands its slot back for reuse.
  bakeIntoFoundation(layer) {
    if (layer.muted) return;
    const len = this.loopLengthSamples;
    for (let i = 0; i < len; i++) {
      const pos = this.effectiveReadPos(layer, i);
      this.foundation[i] += layer.audio[pos] * layer.envelope[pos];
    }
  }

  // Slots a finished layer into layers[]/layerOrder, evicting+baking the
  // single oldest layer first if all 8 slots are already taken - the rolling
  // 1-in-1-out policy.
  placeNewLayer(layer) {
    let freeSlot;
    if (this.layerOrder.length >= MAX_LAYERS) {
      const oldestSlot = this.layerOrder.shift();
      this.bakeIntoFoundation(this.layers[oldestSlot]);
      this.layers[oldestSlot] = null;
      this.port.postMessage({ type: 'layerMixedDown', slot: oldestSlot });
      freeSlot = oldestSlot;
    } else {
      freeSlot = this.layers.findIndex((l) => l == null);
    }
    this.layers[freeSlot] = layer;
    this.layerOrder.push(freeSlot);
    const peaks = computePeaks(layer.audio, PEAK_BUCKETS);
    this.port.postMessage({ type: 'layerFinalized', slot: freeSlot, peaks }, [peaks.buffer]);
  }

  postState() {
    this.port.postMessage({
      type: 'state',
      playheadFraction: this.loopLengthSamples ? this.readPos / this.loopLengthSamples : 0,
      recording: !!this.stagingLayer || !!this.firstTakeSamples,
      selectedSlot: this.selectedSlot,
      layers: this.layerOrder.map((slot) => {
        const l = this.layers[slot];
        return { slot, muted: l.muted, reversed: l.reversed, shiftFraction: l.shiftSamples / this.loopLengthSamples };
      }),
    });
  }

  onLoopWrap() {
    if (this.stagingLayer) {
      const finished = this.stagingLayer;
      this.stagingLayer = null;
      this.placeNewLayer(finished);
      // recordArmOn is this block's latched value (set once per process()
      // call below) - still held down at the wrap means "keep going",
      // turning consecutive passes into consecutive layers.
      if (this.recordArmOn) this.stagingLayer = this.makeEmptyLayer();
    }
    this.advanceRotation();
  }

  // Nudges exactly one layer's shift every rotateEveryN wraps, cycling
  // through layerOrder in turn - "one after another each pass," not all
  // layers moving together. Jumps shiftSamples AND smoothedShiftSamples to
  // the same new value in one step (a hard cut, not the usual smoothed
  // chase readLayerSample does for a live-moved shift) - timed at the wrap
  // specifically because that's already the one moment a loop's own seam is
  // the least conspicuous place for a discontinuity to land, rather than an
  // arbitrary mid-loop instant. No duck engages either, since there's no
  // chase error to duck for (see readLayerSample) - a clean cut, not a
  // hidden scrub.
  advanceRotation() {
    if (!this.rotateArm || this.layerOrder.length === 0 || !this.loopLengthSamples) return;
    this.rotateWrapCounter++;
    if (this.rotateWrapCounter < this.rotateEveryN) return;
    this.rotateWrapCounter = 0;
    const slot = this.layerOrder[this.rotateCursor % this.layerOrder.length];
    const layer = this.layers[slot];
    if (layer) {
      const step = this.rotateDirection * this.rotateInterval * this.loopLengthSamples;
      const next = ((layer.shiftSamples + step) % this.loopLengthSamples + this.loopLengthSamples) % this.loopLengthSamples;
      layer.shiftSamples = next;
      layer.smoothedShiftSamples = next;
    }
    this.rotateCursor = (this.rotateCursor + 1) % MAX_LAYERS;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;

    const p = parameters;
    const recordArmOn = p.recordArm[0] >= 0.5;
    const recordAutomationOn = p.recordAutomationArm[0] >= 0.5;
    const layerMuteOn = p.layerMute[0] >= 0.5;
    const layerReverseOn = p.layerReverse[0] >= 0.5;
    const layerSoloOn = p.layerSolo[0] >= 0.5;
    const layerShift = Math.min(1, Math.max(0, p.layerShift[0]));
    const layerVolume = Math.min(1, Math.max(0, p.layerVolume[0]));
    const speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, p.speed[0]));
    const clockOn = p.clock[0] >= 0.5;
    const triggerOn = p.trigger[0] >= 0.5;
    const blockLen = output.length;

    // Clock-tick period tracking (Clock mode tempo), same technique
    // eventLooper.js's handleClock uses, in samples instead of audioCtx time
    // since that's what's available/precise inside a worklet's process().
    if (clockOn && !this.lastClock) {
      if (this.lastClockTickTime != null) this.clockPeriodSamples = this._sampleCounter - this.lastClockTickTime;
      this.lastClockTickTime = this._sampleCounter ?? 0;
      if (this.mode === 'clock' && this.loopLengthSamples == null && this.clockPeriodSamples) {
        this.establishClockLoopLength();
      }
    }
    this.lastClock = clockOn;

    if (triggerOn && !this.lastTrigger && this.loopLengthSamples != null) {
      this.recordPhase = 0;
      this.readPos = 0;
    }
    this.lastTrigger = triggerOn;

    if (recordArmOn && !this.lastRecordArm && this.mode === 'free' && this.loopLengthSamples == null) {
      this.firstTakeSamples = [];
    }
    if (!recordArmOn && this.lastRecordArm && this.firstTakeSamples) {
      this.finalizeFirstTake();
    }
    this.lastRecordArm = recordArmOn;
    this.recordArmOn = recordArmOn;
    // A layer already in progress (mid-pass engage) or freshly armed with an
    // established loop length both open/continue a staging layer here.
    if (recordArmOn && !this.stagingLayer && this.loopLengthSamples != null) {
      this.stagingLayer = this.makeEmptyLayer();
    }

    // Resolve which finalized layer the edit CVs act on this block - by
    // position in layerOrder (creation order), same wrap-not-clamp indexing
    // as SamplePlayer's markerIndex.
    const activeCount = this.layerOrder.length;
    const selPos = wrapIndex(p.layerSelect[0], activeCount);
    const selectedSlot = selPos >= 0 ? this.layerOrder[selPos] : null;
    this.selectedSlot = selectedSlot;

    // layerShift is one shared CV potentially steering a different layer
    // every time layerSelect moves (e.g. a single patched Fader stepping
    // through layers via a Step Sequencer) - each layer remembers its own
    // shift, so applying the CV's raw position the instant a new layer
    // becomes selected would yank that layer to wherever the CV physically
    // sits, even with nobody touching it. Soft takeover instead: the CV
    // doesn't touch shiftSamples again until it crosses (or lands exactly
    // on) the newly-selected layer's own value - same crossing test
    // fader.js's out/out2 modifier-switch soft takeover uses, just
    // evaluated per layer-selection-change instead of per modifier-toggle.
    // layerMute/layerReverse are latch-style gates, not continuous - the
    // equivalent of a jump for those is a latched Button that's already held
    // "on" from the previous layer immediately forcing that same on-state
    // onto whatever layer becomes selected next, even though the user never
    // touched it after switching. A real mixing console solves this the same
    // way when banking channels: the mute/solo button needs a fresh press
    // before it takes hold of the newly-banked channel - so
    // muteTakeoverLive/reverseTakeoverLive require a rising edge (off, then
    // on) observed *after* the switch, not just "currently on". If the CV's
    // already low post-switch (the common case - nothing was held), the very
    // next press is itself that rising edge, no separate release needed.
    if (selectedSlot !== this.lastSelectedSlot) {
      this.lastSelectedSlot = selectedSlot;
      this.shiftTakeoverLive = false;
      this.muteTakeoverLive = false;
      this.reverseTakeoverLive = false;
    }
    if (selectedSlot != null) {
      const layer = this.layers[selectedSlot];

      if (!this.muteTakeoverLive && layerMuteOn && !this.lastMuteRaw) this.muteTakeoverLive = true;
      if (this.muteTakeoverLive) layer.muted = layerMuteOn;

      if (!this.reverseTakeoverLive && layerReverseOn && !this.lastReverseRaw) this.reverseTakeoverLive = true;
      if (this.reverseTakeoverLive) layer.reversed = layerReverseOn;

      const currentFraction = this.loopLengthSamples ? layer.shiftSamples / this.loopLengthSamples : 0;
      if (!this.shiftTakeoverLive) {
        const crossed =
          this.lastShiftRaw == null
            ? layerShift === currentFraction
            : (this.lastShiftRaw < currentFraction) !== (layerShift < currentFraction) || layerShift === currentFraction;
        if (crossed) this.shiftTakeoverLive = true;
      }
      // Once live, just retargets - readLayerSample's smoothedShiftSamples
      // is what actually chases this, sample by sample, so retargeting
      // every block during a continuous drag (even mid-chase) never itself
      // creates a jump the way restarting an old crossfade used to.
      if (this.shiftTakeoverLive && this.loopLengthSamples) {
        layer.shiftSamples = Math.round(layerShift * this.loopLengthSamples);
      }
    }
    this.lastShiftRaw = layerShift;
    this.lastMuteRaw = layerMuteOn;
    this.lastReverseRaw = layerReverseOn;

    for (let i = 0; i < blockLen; i++) {
      const inSample = input ? input[i] : 0;
      this._sampleCounter = (this._sampleCounter ?? 0) + 1;

      if (this.loopLengthSamples == null) {
        // Free mode, first take still being captured (or nothing recorded
        // yet at all) - no loop to play back yet, so the live input itself
        // (if passthrough is on) is the only thing there is to hear.
        if (this.firstTakeSamples) this.firstTakeSamples.push(inSample);
        output[i] = this.passthrough ? inSample : 0;
        continue;
      }

      // Soloed: only the selected layer plays - not the foundation, not any
      // other layer, and its own mute is ignored (soloing it is an explicit
      // request to hear it, same as a mixing console's solo overriding
      // mute). Nothing selected while soloed means nothing to isolate, so
      // silence rather than falling back to the normal mix.
      let sample = 0;
      if (layerSoloOn) {
        if (selectedSlot != null) sample = this.readLayerSample(this.layers[selectedSlot], this.readPos);
      } else {
        sample = this.readFoundationSample(this.readPos);
        for (const slot of this.layerOrder) {
          const layer = this.layers[slot];
          if (layer.muted) continue;
          sample += this.readLayerSample(layer, this.readPos);
        }
      }
      if (this.passthrough) sample += inSample;
      output[i] = sample;

      // Recording (writing new audio into a staging layer, or riding
      // recordAutomationArm onto an already-playing layer's envelope) is
      // deliberately keyed off different positions than the line above:
      // - New audio always gets captured at native rate/position
      //   (recordPhase), regardless of playback speed - "the loop" is a
      //   fixed physical duration, speed just changes how fast existing
      //   material is being read, not how fast new material comes in.
      // - Riding volume onto an *existing* layer's envelope is a live
      //   performance synced to what's actually audible right now, so it
      //   follows readPos (rounded to the nearest sample) instead.
      if (this.stagingLayer) this.stagingLayer.audio[this.recordPhase] = inSample;
      if (recordAutomationOn && selectedSlot != null) {
        const envPos = Math.round(this.readPos) % this.loopLengthSamples;
        this.layers[selectedSlot].envelope[envPos] = layerVolume;
      }

      this.recordPhase++;
      if (this.recordPhase >= this.loopLengthSamples) {
        this.recordPhase = 0;
        this.onLoopWrap();
      }

      this.readPos += speed;
      while (this.readPos >= this.loopLengthSamples) {
        this.readPos -= this.loopLengthSamples;
        this._eofPulseCount++;
      }
    }

    this._statePostCounter += blockLen;
    if (this._statePostCounter >= STATE_POST_INTERVAL_SAMPLES) {
      this._statePostCounter = 0;
      this.postState();
    }

    // Posted every block (not throttled like postState above) rather than
    // batched - a loop wrap is a musically-timed event (e.g. driving a List
    // to the next scale degree once per repeat), where the ~2.7ms a block
    // costs at most is fine but STATE_POST_INTERVAL_SAMPLES's ~43ms would be
    // a noticeable lag. Only actually posts on change, so this costs nothing
    // between wraps.
    if (this._eofPulseCount !== this._lastPostedEofCount) {
      this._lastPostedEofCount = this._eofPulseCount;
      this.port.postMessage({ type: 'eofPulse' });
    }

    // Watch the currently-recording layer fill in as it happens, not just
    // once the pass finishes (see placeNewLayer's own layerFinalized message
    // for the final version) - unwritten samples are still genuinely zero,
    // so recomputing peaks over the whole buffer naturally reads as the
    // waveform "filling in" left to right as the playhead advances. Covers
    // both an overdub pass (stagingLayer, fixed length) and Free mode's very
    // first take (firstTakeSamples, still growing - computePeaks works on a
    // plain array just as well as a Float32Array, no separate case needed).
    const liveBuffer = this.stagingLayer?.audio ?? this.firstTakeSamples;
    if (liveBuffer) {
      this._livePeaksCounter += blockLen;
      if (this._livePeaksCounter >= LIVE_PEAKS_INTERVAL_SAMPLES && liveBuffer.length > 0) {
        this._livePeaksCounter = 0;
        const peaks = computePeaks(liveBuffer, PEAK_BUCKETS);
        this.port.postMessage({ type: 'liveLayerPeaks', peaks }, [peaks.buffer]);
      }
    } else {
      this._livePeaksCounter = 0;
    }

    return true;
  }
}

registerProcessor('audio-looper-processor', AudioLooperProcessor);
