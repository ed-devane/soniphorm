// AudioWorkletProcessor for the Grain Cloud module (see factories/grainCloud.js)
// - multi-source asynchronous granulation in the Curtis Roads sense. Each new
// grain independently picks a read position (jittered around its slot's own
// pointer), a duration, a pitch and a stereo pan; Density sets how fast
// grains are launched. Roads' fill factor
// (density x grain duration) is the useful mental model: below 1 grains are
// separate fragments with silence between them, around 1 they just touch,
// above 1 they overlap into a fused cloud where the sources lose identity.
//
// Same reason as Smudge for being a worklet: many independently-positioned,
// independently-pitched reads of several buffers at once, plus live rolling
// buffers - no stock-node combination can do it. Self-contained on purpose
// (no imports), since worklet modules load into their own global scope.
//
// Sources: SLOT_COUNT slots, each either a loaded sample (mono-mixed copy
// posted in via the port, played at its own sample rate) or a live input
// (inputs[i], continuously written into an 8s rolling buffer - Position then
// means how far behind "now" grains read from, like Smudge). A live slot
// only counts as available while something is actually patched into it, so
// an unpatched live slot launches nothing rather than silent grains that
// would still take up pool slots and pull down the overlap normalisation.
//
// Each slot runs its own grain stream: its density and duration are the
// master Density/Duration times that slot's Density x / Duration x
// multipliers, so moving a master control rescales every source together
// with their ratios intact (the whole cloud zooms as one), while the
// multipliers set each source's own character. Weight is that slot's level.
//
// Freeze (per slot) captures that source's current moment and sustains it:
// the slot's normal grain slices stop, replaced by one continuous held tone
// - an 8x-overlapped stream of Hann grains reading around the frozen spot
// (+/-20ms, enough to decorrelate them), at a fixed sustain grain length
// chosen at freeze time. A sample slot's pointer stops; a live slot copies
// the frozen moment out of its rolling buffer into its own small snippet
// (so recording carries on, and a long Release can't be overwritten). The
// held tone fades from wherever the level was to silence over that slot's
// Fade time, shaped by its own Fade Curve - unless its Hold is on, which
// sustains until unfrozen. When a fade completes, Freeze exits by itself:
// normal slices resume from where the source was, and a gate/param still
// held high has to go low and high again to re-freeze (reported back as
// `expired` so the UI can drop its toggle). Other sources' grains carry on
// underneath throughout. Unfreezing by hand before the fade is done brings
// slices back over ~20ms while the held tone keeps sustaining and fades out
// over that slot's Release time (same Freeze Curve shape), so it never ends
// abruptly - held tone tailing off as the source slices on underneath -
// unless the source's next slice is due within its Legato window, in which
// case the held tone holds until that slice starts and crossfades into it
// over the slice's attack (no gap). On expiry the held tone is already at 0.
// A whole sustain stream counts as one grain in the overlap normalisation,
// so holding a part doesn't duck the rest of the cloud.
//
// Space: one shared stereo reverb (Freeverb-style - 8 damped combs into 4
// allpasses per side, right side offset for decorrelation) that each source
// sends into. A source's send = its Space Send + Auto Space x sparseness,
// where sparseness comes from that source's own fill (density x duration):
// ~1 when its grains are far apart, 0.5 at fill 0.5, ~0 once it fuses - so
// zooming out opens the room up around the particles by itself, and pulls
// it back as the cloud thickens. Held (freeze) tones and their Release
// tails go through it too. Space Mix is the reverb's return level.
//
// Depth: every grain is given its own distance when it launches (that
// source's Depth offset + a random amount up to Depth Range) and keeps it
// for its whole life - no sweeping filters. One distance drives all the
// cues together, the way the ear judges it: level drops (to -12dB at the
// back), its own one-pole lowpass closes (air absorption, ~16kHz near to
// ~1.5kHz far), its reverb send rises (far grains are mostly room - the
// send is taken before the distance level drop, since a room's reverb
// doesn't get quieter as a source moves away), and its pan narrows toward
// centre. A frozen source's held tone sits at one depth, drawn at freeze.
//
// Mute (per source) silences that source over ~10ms but keeps its streams
// running, so unmuting drops straight back into the flow; muted grains
// don't count toward the overlap normalisation either.
//
// Range + Scan (per source): Start/End bound the part of the source grains
// read from (for a live slot, how far back: 0 = now, 1 = 8s ago). Scan sets
// how a sample slot's pointer moves through that range at Speed (1 = real
// time through the range; its sign is ignored - Scan alone sets direction): Forward wraps End ->
// Start, Backward wraps the other way, Ping-pong bounces, Random gives every
// slice its own random spot in the range (a live slot only uses Random - its
// audio already moves). Position offsets the pointer within the range and
// Position Jitter scatters around it, both as fractions of the range, and
// both wrap inside it.
//
// Output is stereo: grain pan is equal-power, spread by Width.

const SLOT_COUNT = 4;
const MAX_GRAINS = 128;
const LIVE_SECONDS = 8;
const WIN_SIZE = 512;
const WIN_HALF = WIN_SIZE / 2;
// How often grain-launch events + pointer positions get posted to the main
// thread for the on-canvas display, in render quanta (~43ms at 48kHz).
const REPORT_EVERY_BLOCKS = 16;
const MAX_REPORTED_EVENTS = 256;
const EVENT_STRIDE = 6; // slot, start, duration, pan, depth, fade level at launch
// Per-slot launch-rate ceiling, so x8 on an already-high master can't ask
// for more launches than the grain pool could ever hold anyway.
const MAX_SLOT_DENSITY = 2000;
const SCAN_FORWARD = 0;
const SCAN_BACKWARD = 1;
const SCAN_PINGPONG = 2;
const SCAN_RANDOM = 3;
const MIN_RANGE = 0.001;
// Freeverb tunings (at 44.1kHz - scaled to the real rate).
const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNINGS = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const REVERB_IN_GAIN = 0.015;
const REVERB_WET_SCALE = 2;
// Depth cue ranges (depth 0 = front, 1 = back).
const DEPTH_GAIN_K = 3; // level = 1 / (1 + K*depth): -12dB at the back
const DEPTH_LP_NEAR = 16000;
const DEPTH_LP_FAR = 1500;
const DEPTH_SEND = 1; // extra reverb send at the back
const DEPTH_NARROW = 0.7; // pan narrows by this much at the back
// Freeze sustain grains: length clamp (seconds), overlap, and read jitter.
const SUSTAIN_MIN_SEC = 0.08;
const SUSTAIN_MAX_SEC = 0.4;
const SUSTAIN_OVERLAP = 8;
// Spread over several waveform periods so overlapping copies are
// decorrelated (sum by power, a steady shimmer) rather than partly in phase
// (sum by amplitude, comb-filter dips and swells).
const SUSTAIN_JITTER_SEC = 0.02;
const SUSTAIN_MAX_RATIO = 4; // pitch ratio clamp, so a snippet always covers a grain's read
const SNIPPET_MAX = Math.ceil(sampleRate * (SUSTAIN_MAX_SEC * SUSTAIN_MAX_RATIO + 2 * SUSTAIN_JITTER_SEC)) + 128;

function slotParams() {
  const out = [];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    out.push({ name: `weight${i}`, defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    out.push({ name: `position${i}`, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    out.push({ name: `speed${i}`, defaultValue: 1, minValue: -2, maxValue: 2, automationRate: 'k-rate' });
    // Read range (0-1 of the source) and how the pointer scans it.
    out.push({ name: `start${i}`, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    out.push({ name: `end${i}`, defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    out.push({ name: `scan${i}`, defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' });
    out.push({ name: `densityMult${i}`, defaultValue: 1, minValue: 0.125, maxValue: 8, automationRate: 'k-rate' });
    out.push({ name: `durationMult${i}`, defaultValue: 1, minValue: 0.125, maxValue: 8, automationRate: 'k-rate' });
    out.push({ name: `freeze${i}`, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    out.push({ name: `fade${i}`, defaultValue: 8, minValue: 0, maxValue: 60, automationRate: 'k-rate' });
    // 1 = sustain indefinitely (no fade, no auto-exit). Fade <= 0 also holds,
    // for patches saved before Hold existed.
    out.push({ name: `hold${i}`, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    // Seconds the held tone takes to fade out after a manual unfreeze.
    out.push({ name: `release${i}`, defaultValue: 0.5, minValue: 0.005, maxValue: 30, automationRate: 'k-rate' });
    // ms: on unfreeze, a next slice due within this long gets a legato
    // handover instead of a Release fade. 0 = always Release.
    out.push({ name: `legato${i}`, defaultValue: 250, minValue: 0, maxValue: 2000, automationRate: 'k-rate' });
    // Reverb send: fixed amount, plus Auto Space x this source's sparseness.
    out.push({ name: `space${i}`, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    out.push({ name: `autoSpace${i}`, defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    // How far back this source's grains start (Depth Range adds randomly on top).
    out.push({ name: `depth${i}`, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    out.push({ name: `mute${i}`, defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' });
    // Fade shape: 0 linear, -1 holds near full then drops late, +1 drops
    // early then tails off long. Exponent 8^curve.
    out.push({ name: `fadeCurve${i}`, defaultValue: 0.3, minValue: -1, maxValue: 1, automationRate: 'k-rate' });
  }
  return out;
}

class GrainCloudProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'density', defaultValue: 8, minValue: 0.1, maxValue: 500, automationRate: 'k-rate' },
      { name: 'durationMs', defaultValue: 120, minValue: 1, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'durationJitter', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'positionJitter', defaultValue: 0.05, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // 0 = Poisson (fully asynchronous) launch times, 1 = an even clock.
      { name: 'regularity', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'semitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      // Fraction of +/-12 semitones of random per-grain detune.
      { name: 'pitchJitter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'width', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'reverseProb', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // 0 = symmetric Hann, 1 = sharp attack + long tail (percussive).
      { name: 'envShape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      // Shared reverb: return level, room size, high damping.
      { name: 'spaceMix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'spaceSize', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'spaceDamp', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // Random per-grain distance range (0 = every grain at its source's Depth).
      { name: 'depthRange', defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      ...slotParams(),
    ];
  }

  constructor() {
    super();
    this.liveLen = Math.round(sampleRate * LIVE_SECONDS);
    this.slots = Array.from({ length: SLOT_COUNT }, () => ({
      mode: 'sample',
      data: null, // Float32Array, mono, at srcRate
      srcStep: 1, // srcRate / sampleRate
      live: new Float32Array(this.liveLen),
      ptr: 0, // pointer phase through the range, 0-1 (0-2 in Ping-pong), accumulated by speed (sample slots)
      grainPos: -1, // where its latest slice read from (0-1, jitter included; -1 = none yet)
      frozen: false,
      freezeAge: 0, // seconds since this freeze began
      freezeStartGain: 1, // fade level at the moment of freezing
      fadeGain: 1, // level of this slot's normal slices
      sustainGain: 0, // level of its held (freeze) grains
      expired: false, // fade completed; waiting for the freeze gate to drop
      freezePos: 0, // buffer read position the sustain is held at
      sustainLen: 0, // sustain grain length in output samples, fixed per freeze
      releasing: false, // unfrozen by hand; held tone still fading out
      releaseAge: 0,
      releaseStartGain: 0,
      legatoWait: false, // unfrozen; held tone holding until the next slice
      legatoLeft: 0, // samples left in the held tone's crossfade into that slice
      // Live slots: the frozen moment, copied out of the rolling buffer.
      snippet: new Float32Array(SNIPPET_MAX),
      snippetLen: 0,
      freezeDepth: 0, // the held tone's one distance
      muteGain: 1, // smoothed mute
    }));
    this.writePos = 0;

    this.grains = Array.from({ length: MAX_GRAINS }, () => ({
      slot: 0,
      readPos: 0,
      step: 1,
      len: 0, // buffer length the read wraps around
      buf: null,
      duration: 1,
      elapsed: 0,
      attackEnd: 0.5,
      sustain: false, // part of a frozen slot's held tone
      depth: 0, // 0 front .. 1 back, fixed for the grain's life
      lpA: 1, // its own one-pole lowpass coefficient
      lp: 0, // ... and state
      panSum: 0, // cos+sin pan gains before the distance level drop (reverb send)
      gainL: 0,
      gainR: 0,
    }));
    // Indices of sounding grains, compacted by swap-remove when one ends.
    this.active = new Int32Array(MAX_GRAINS);
    this.activeCount = 0;
    this.free = [];
    for (let i = MAX_GRAINS - 1; i >= 0; i--) this.free.push(i);

    // Samples until each slot's next launch.
    this.counters = new Float64Array(SLOT_COUNT).fill(1);
    // Samples until each slot's next held (freeze) grain.
    this.sustainCounters = new Float64Array(SLOT_COUNT).fill(1);
    this.slotGain = new Float32Array(SLOT_COUNT);
    this.sustainSlotGain = new Float32Array(SLOT_COUNT);
    this.smoothNorm = 1;
    this.rngState = 0x2545f491;
    this.win = new Float32Array(WIN_SIZE + 1);
    for (let i = 0; i <= WIN_SIZE; i++) {
      this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN_SIZE);
    }

    this.events = [];
    this.blockCount = 0;

    // Shared reverb state.
    const rs = sampleRate / 44100;
    const comb = (n) => ({ buf: new Float32Array(Math.max(1, Math.round(n * rs))), idx: 0, store: 0 });
    const allpass = (n) => ({ buf: new Float32Array(Math.max(1, Math.round(n * rs))), idx: 0 });
    this.combsL = COMB_TUNINGS.map(comb);
    this.combsR = COMB_TUNINGS.map((n) => comb(n + STEREO_SPREAD));
    this.allpassL = ALLPASS_TUNINGS.map(allpass);
    this.allpassR = ALLPASS_TUNINGS.map((n) => allpass(n + STEREO_SPREAD));
    // Per-slot send, smoothed so a fill change doesn't zipper.
    this.sendSmooth = new Float32Array(SLOT_COUNT);
    this.sendTarget = new Float32Array(SLOT_COUNT);

    this.port.onmessage = (e) => {
      const msg = e.data;
      const slot = this.slots[msg.slot];
      if (!slot) return;
      if (msg.type === 'setSample') {
        slot.data = msg.data && msg.data.length > 1 ? msg.data : null;
        slot.srcStep = msg.data ? msg.sampleRate / sampleRate : 1;
        slot.ptr = 0;
      } else if (msg.type === 'setMode') {
        slot.mode = msg.mode === 'live' ? 'live' : 'sample';
      }
    };
  }

  _rand() {
    let x = this.rngState;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rngState = x;
    return x / 0x100000000;
  }

  // Recovery after a non-finite output sample: zero any grain filter state
  // and reverb memory that has gone bad.
  _clearNonFinite() {
    for (let a = 0; a < this.activeCount; a++) {
      const g = this.grains[this.active[a]];
      if (!Number.isFinite(g.lp)) g.lp = 0;
      if (!Number.isFinite(g.readPos)) g.readPos = 0;
    }
    for (const set of [this.combsL, this.combsR, this.allpassL, this.allpassR]) {
      for (const f of set) {
        if (f.store !== undefined && !Number.isFinite(f.store)) f.store = 0;
        if (f.buf.some((v) => !Number.isFinite(v))) f.buf.fill(0);
      }
    }
  }

  // One Freeverb channel: parallel damped combs, then series allpasses.
  _reverbChannel(input, combs, allpasses, feedback, damp1, damp2) {
    let out = 0;
    for (let c = 0; c < combs.length; c++) {
      const cb = combs[c];
      const y = cb.buf[cb.idx];
      cb.store = y * damp2 + cb.store * damp1;
      cb.buf[cb.idx] = input + cb.store * feedback;
      if (++cb.idx >= cb.buf.length) cb.idx = 0;
      out += y;
    }
    for (let a = 0; a < allpasses.length; a++) {
      const ap = allpasses[a];
      const b = ap.buf[ap.idx];
      ap.buf[ap.idx] = out + b * 0.5;
      if (++ap.idx >= ap.buf.length) ap.idx = 0;
      out = b - out;
    }
    return out;
  }

  _drawDepth(p, slotIndex) {
    return Math.min(1, p[`depth${slotIndex + 1}`][0] + p.depthRange[0] * this._rand());
  }

  // Distance cues for one grain from its depth + raw pan (-1..1).
  _applyDepth(g, depth, pan, amp) {
    g.depth = depth;
    const fc = DEPTH_LP_NEAR * (DEPTH_LP_FAR / DEPTH_LP_NEAR) ** depth;
    g.lpA = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
    g.lp = 0;
    const narrowed = pan * (1 - DEPTH_NARROW * depth);
    const angle = ((narrowed + 1) * Math.PI) / 4;
    const c = Math.cos(angle) * amp;
    const sn = Math.sin(angle) * amp;
    g.panSum = c + sn;
    const dist = 1 / (1 + DEPTH_GAIN_K * depth);
    g.gainL = c * dist;
    g.gainR = sn * dist;
    return narrowed;
  }

  _available(i, inputs) {
    const slot = this.slots[i];
    if (slot.mode === 'live') return !!(inputs[i] && inputs[i].length > 0);
    return !!slot.data;
  }

  _sustainRatio(p) {
    return Math.min(SUSTAIN_MAX_RATIO, Math.max(0.25, 2 ** (p.semitones[0] / 12)));
  }

  _range(p, i) {
    const a = p[`start${i + 1}`][0];
    const b = p[`end${i + 1}`][0];
    const w = Math.max(MIN_RANGE, Math.abs(a - b));
    // Keep lo + w inside the source even when Start/End sit at (or past) 1.
    return { lo: Math.max(0, Math.min(Math.min(a, b), 1 - w)), w };
  }

  _scanMode(p, i) {
    return Math.round(p[`scan${i + 1}`][0]);
  }

  // Pointer phase 0-1 through the range (Ping-pong folds its 0-2 back).
  _phase(slot, mode) {
    if (slot.mode === 'live') return 0;
    return mode === SCAN_PINGPONG && slot.ptr > 1 ? 2 - slot.ptr : slot.ptr;
  }

  // Where a slice reads, 0-1 of the source (a live slot's lag fraction):
  // range start + (Position + pointer phase + jitter, all in range units,
  // wrapped inside the range). Random scan replaces the pointer with a
  // fresh random phase.
  _readFrac(p, i, jitter) {
    const slot = this.slots[i];
    const { lo, w } = this._range(p, i);
    const mode = this._scanMode(p, i);
    const phase = mode === SCAN_RANDOM ? this._rand() : this._phase(slot, mode);
    let u = (p[`position${i + 1}`][0] + phase + jitter) % 1;
    if (u < 0) u += 1;
    return lo + w * u;
  }

  // Freeze edge: fix the sustain grain length and the exact read spot.
  _captureFreeze(p, i) {
    const slot = this.slots[i];
    const baseDur = (p.durationMs[0] / 1000) * p[`durationMult${i + 1}`][0];
    slot.sustainLen = Math.round(Math.min(SUSTAIN_MAX_SEC, Math.max(SUSTAIN_MIN_SEC, baseDur)) * sampleRate);
    const frac = this._readFrac(p, i, 0);
    if (slot.mode === 'live') {
      // Copy enough audio for a grain at the highest pitch ratio plus jitter
      // either side, ending no later than the write head (so nothing in it
      // is not-yet-written or 8s-old).
      const jitN = Math.ceil(SUSTAIN_JITTER_SEC * sampleRate);
      const len = Math.min(SNIPPET_MAX, slot.sustainLen * SUSTAIN_MAX_RATIO + 2 * jitN + 64);
      const L = this.liveLen;
      const lag = Math.round(Math.min(L - 1, Math.max(len, frac * L + len)));
      let r = (((this.writePos - lag) % L) + L) % L;
      for (let k = 0; k < len; k++) {
        slot.snippet[k] = slot.live[r];
        r = r + 1 >= L ? 0 : r + 1;
      }
      slot.snippetLen = len;
      slot.freezePos = jitN; // grain start, with room for jitter either side
    } else if (slot.data) {
      slot.freezePos = frac * slot.data.length;
    }
  }

  _setupSustainGrain(p, slot, g) {
    const ratio = this._sustainRatio(p);
    const jit = SUSTAIN_JITTER_SEC * sampleRate * (this._rand() * 2 - 1);
    if (slot.mode === 'live') {
      g.buf = slot.snippet;
      g.len = slot.snippetLen;
      g.step = ratio;
    } else {
      g.buf = slot.data;
      g.len = slot.data.length;
      g.step = ratio * slot.srcStep;
    }
    const srcJit = slot.mode === 'live' ? jit : jit * slot.srcStep;
    g.readPos = (((slot.freezePos + srcJit) % g.len) + g.len) % g.len;
    g.duration = Math.max(32, slot.sustainLen);
    g.elapsed = 0;
    g.attackEnd = 0.5;
    // Decorrelated grains add by power: Hann^2 at OVERLAP x sums to
    // 0.375*OVERLAP, so this keeps the held tone at the source's own level.
    const amp = 1 / Math.sqrt(0.375 * SUSTAIN_OVERLAP);
    this._applyDepth(g, slot.freezeDepth, p.width[0] * (this._rand() * 2 - 1), amp);
  }

  _spawn(p, slotIndex, frame, sustain) {
    const slot = this.slots[slotIndex];

    let gi = this.free.pop();
    if (gi === undefined) {
      // Pool full - steal whichever sounding grain is closest to finishing.
      let best = 0;
      let bestRemain = Infinity;
      for (let a = 0; a < this.activeCount; a++) {
        const g = this.grains[this.active[a]];
        const remain = g.duration - g.elapsed;
        if (remain < bestRemain) {
          bestRemain = remain;
          best = a;
        }
      }
      gi = this.active[best];
      this.active[best] = this.active[--this.activeCount];
    }
    const g = this.grains[gi];
    g.slot = slotIndex;
    g.sustain = sustain;
    if (sustain) {
      this._setupSustainGrain(p, slot, g);
      this.active[this.activeCount++] = gi;
      if (this.events.length < MAX_REPORTED_EVENTS * EVENT_STRIDE) {
        this.events.push(slotIndex, frame / sampleRate, g.duration / sampleRate, 0, g.depth, this.slots[slotIndex].sustainGain);
      }
      return g;
    }

    const baseDur = (p.durationMs[0] / 1000) * p[`durationMult${slotIndex + 1}`][0];
    const durJit = p.durationJitter[0];
    const dur = baseDur * (1 + durJit * 0.9 * (this._rand() * 2 - 1));
    g.duration = Math.max(32, Math.round(dur * sampleRate));
    g.elapsed = 0;

    const semis = p.semitones[0] + p.pitchJitter[0] * 12 * (this._rand() * 2 - 1);
    let ratio = Math.min(4, Math.max(0.25, 2 ** (semis / 12)));
    const reverse = this._rand() < p.reverseProb[0];

    const jitter = p.positionJitter[0] * (this._rand() * 2 - 1) * 0.5;
    const frac = this._readFrac(p, slotIndex, jitter);
    if (slot.mode === 'live') {
      g.buf = slot.live;
      g.len = this.liveLen;
      g.step = reverse ? -ratio : ratio;
      // Must start far enough back that a forward grain never overtakes the
      // write head, and a reverse one never reads into not-yet-written audio.
      const minLag = g.duration * Math.max(ratio, 1) + 64;
      const lag = Math.min(this.liveLen - 1, Math.max(minLag, frac * this.liveLen));
      g.readPos = (((this.writePos - lag) % this.liveLen) + this.liveLen) % this.liveLen;
      slot.grainPos = lag / this.liveLen;
    } else {
      g.buf = slot.data;
      g.len = slot.data.length;
      g.step = (reverse ? -ratio : ratio) * slot.srcStep;
      g.readPos = Math.min(g.len - 1, frac * g.len);
      slot.grainPos = frac;
    }

    const shape = p.envShape[0];
    g.attackEnd = 0.5 - 0.48 * shape;

    const pan = this._applyDepth(g, this._drawDepth(p, slotIndex), p.width[0] * (this._rand() * 2 - 1), 1);
    g.slot = slotIndex;

    this.active[this.activeCount++] = gi;

    if (this.events.length < MAX_REPORTED_EVENTS * EVENT_STRIDE) {
      this.events.push(slotIndex, frame / sampleRate, g.duration / sampleRate, pan, g.depth, this.slots[slotIndex].fadeGain);
    }
    return g;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const outL = out && out[0];
    const outR = out && out[1];
    if (!outL) return true;
    const p = parameters;

    const blockLen = outL.length;
    const density = Math.max(0.1, p.density[0]);
    const regularity = p.regularity[0];
    const slotGain = this.slotGain;
    const sustainSlotGain = this.sustainSlotGain;
    const meanIntervals = this._meanIntervals || (this._meanIntervals = new Float64Array(SLOT_COUNT));
    const availableNow = this._availableNow || (this._availableNow = new Uint8Array(SLOT_COUNT));
    const sustainNow = this._sustainNow || (this._sustainNow = new Uint8Array(SLOT_COUNT));
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this.slots[i];
      const frozenNow = p[`freeze${i + 1}`][0] > 0.5;
      if (!frozenNow) slot.expired = false;
      if (frozenNow && !slot.frozen && !slot.expired) {
        slot.frozen = true;
        slot.freezeAge = 0;
        slot.freezeStartGain = slot.fadeGain;
        slot.sustainGain = slot.fadeGain;
        slot.releasing = false;
        slot.legatoWait = false;
        slot.legatoLeft = 0;
        this._captureFreeze(p, i);
        slot.freezeDepth = this._drawDepth(p, i);
        this.sustainCounters[i] = 1; // start the held tone straight away
      } else if (!frozenNow && slot.frozen) {
        // Unfrozen by hand. Draw when this source's next slice lands: if
        // that's within its Legato window, the held tone holds until that
        // slice starts and crossfades into it (no gap); otherwise it fades
        // out over Release.
        slot.frozen = false;
        const slotDensity = Math.min(MAX_SLOT_DENSITY, density * p[`densityMult${i + 1}`][0]);
        const gap = Math.max(1, Math.round((sampleRate / slotDensity) * (regularity + (1 - regularity) * -Math.log(1 - this._rand()))));
        this.counters[i] = gap;
        const audible = slot.sustainGain > 0.0005;
        slot.legatoWait = audible && gap <= (p[`legato${i + 1}`][0] / 1000) * sampleRate;
        slot.releasing = audible && !slot.legatoWait;
        slot.releaseAge = 0;
        slot.releaseStartGain = slot.sustainGain;
      }
      if (slot.frozen) {
        slot.freezeAge += blockLen / sampleRate;
        const fade = p[`fade${i + 1}`][0];
        if (p[`hold${i + 1}`][0] <= 0.5 && fade > 0) {
          const t = Math.min(1, slot.freezeAge / fade);
          slot.fadeGain = slot.freezeStartGain * (1 - t) ** (8 ** p[`fadeCurve${i + 1}`][0]);
          slot.sustainGain = slot.fadeGain;
          if (t >= 1) {
            // Fade done - exit Freeze by itself. Never a legato handover (that's
            // only for a manual early exit), and the slice timer was stalled
            // while frozen - draw a fresh gap so the first slice back lands at
            // a normal time rather than straight on the end of the fade.
            slot.frozen = false;
            slot.expired = true;
            slot.releasing = false;
            slot.legatoWait = false;
            slot.legatoLeft = 0;
            slot.sustainGain = 0;
            const slotDensity = Math.min(MAX_SLOT_DENSITY, density * p[`densityMult${i + 1}`][0]);
            this.counters[i] = Math.max(1, Math.round((sampleRate / slotDensity) * (regularity + (1 - regularity) * -Math.log(1 - this._rand()))));
          }
        }
      } else {
        // Slices ~20ms back to full on unfreeze - quick, but not a click.
        if (slot.fadeGain < 1) slot.fadeGain = Math.min(1, slot.fadeGain + blockLen / (0.02 * sampleRate));
        if (slot.releasing) {
          slot.releaseAge += blockLen / sampleRate;
          const t = Math.min(1, slot.releaseAge / Math.max(0.005, p[`release${i + 1}`][0]));
          slot.sustainGain = slot.releaseStartGain * (1 - t) ** (8 ** p[`fadeCurve${i + 1}`][0]);
          if (t >= 1) {
            slot.releasing = false;
            slot.sustainGain = 0;
          }
        } else if (slot.legatoLeft > 0) {
          // Crossfading out under the slice it legato'd into.
          slot.sustainGain = Math.max(0, slot.sustainGain * (1 - blockLen / slot.legatoLeft));
          slot.legatoLeft = Math.max(0, slot.legatoLeft - blockLen);
          if (slot.legatoLeft === 0) slot.sustainGain = 0;
        } else if (!slot.legatoWait) {
          slot.sustainGain = 0;
        }
        // (legatoWait: holds at its level until the next slice launches.)
      }
      const muteTarget = p[`mute${i + 1}`][0] > 0.5 ? 0 : 1;
      const muteStep = blockLen / (0.01 * sampleRate);
      slot.muteGain = muteTarget > slot.muteGain ? Math.min(1, slot.muteGain + muteStep) : Math.max(0, slot.muteGain - muteStep);
      const weight = p[`weight${i + 1}`][0] * slot.muteGain;
      slotGain[i] = weight * slot.fadeGain;
      this.sustainSlotGain[i] = weight * slot.sustainGain;
      // Normal slices: not while frozen. Held tone: while frozen or releasing.
      availableNow[i] = !slot.frozen && this._available(i, inputs) && slot.fadeGain > 0.0005 ? 1 : 0;
      const held = slot.mode === 'live' ? slot.snippetLen > 0 : !!slot.data;
      sustainNow[i] = (slot.frozen || slot.releasing || slot.legatoWait || slot.legatoLeft > 0) && held && slot.sustainGain > 0.0005 ? 1 : 0;
      const slotDensity = Math.min(MAX_SLOT_DENSITY, density * p[`densityMult${i + 1}`][0]);
      meanIntervals[i] = sampleRate / slotDensity;
      // Sparseness from this source's own fill: ~1 far apart, 0.5 at fill
      // 0.5, ~0 once fused.
      const fill = slotDensity * (p.durationMs[0] / 1000) * p[`durationMult${i + 1}`][0];
      const sparse = 1 / (1 + (fill / 0.5) ** 2);
      this.sendTarget[i] = Math.min(1, p[`space${i + 1}`][0] + p[`autoSpace${i + 1}`][0] * sparse);
    }
    const level = p.level[0];
    const sendSmooth = this.sendSmooth;
    const sendTarget = this.sendTarget;
    const spaceMix = p.spaceMix[0];
    const runReverb = spaceMix > 0;
    const feedback = 0.7 + 0.28 * p.spaceSize[0];
    const damp1 = 0.4 * p.spaceDamp[0];
    const damp2 = 1 - damp1;
    // Comb energy grows as 1/(1-fb^2) - normalise to Size 0.7's, so Size
    // lengthens the tail rather than just making it louder.
    const wet = spaceMix * REVERB_WET_SCALE * Math.sqrt((1 - feedback * feedback) / (1 - 0.896 * 0.896));
    const { grains, active, win, liveLen } = this;

    // Pointer advance for sample slots: speed 1 = real time through the
    // range, in the Scan direction (Ping-pong runs 0-2 and folds).
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this.slots[i];
      if (!slot.data || slot.frozen) continue;
      const mode = this._scanMode(p, i);
      const lenSec = (slot.data.length * this._range(p, i).w) / (slot.srcStep * sampleRate);
      const dir = mode === SCAN_BACKWARD ? -1 : 1;
      const wrap = mode === SCAN_PINGPONG ? 2 : 1;
      slot.ptr = (slot.ptr + (dir * Math.abs(p[`speed${i + 1}`][0]) * blockLen) / sampleRate / lenSec) % wrap;
      if (slot.ptr < 0) slot.ptr += wrap;
    }

    for (let n = 0; n < blockLen; n++) {
      // Live inputs - every slot's rolling buffer shares one write head.
      for (let i = 0; i < SLOT_COUNT; i++) {
        const ch = inputs[i] && inputs[i][0];
        this.slots[i].live[this.writePos] = ch ? ch[n] : 0;
      }

      for (let i = 0; i < SLOT_COUNT; i++) {
        if (sustainNow[i] && --this.sustainCounters[i] <= 0) {
          this._spawn(p, i, currentFrame + n, true);
          // Held tone: an even overlap clock, lightly jittered so it can't buzz.
          const hop = this.slots[i].sustainLen / SUSTAIN_OVERLAP;
          this.sustainCounters[i] = Math.max(1, Math.round(hop * (0.85 + 0.3 * this._rand())));
        }
        if (this.slots[i].frozen || --this.counters[i] > 0) continue;
        const slice = availableNow[i] ? this._spawn(p, i, currentFrame + n, false) : null;
        if (this.slots[i].legatoWait) {
          // The slice the held tone was waiting for: crossfade out over its
          // attack (or a short default if it couldn't launch).
          this.slots[i].legatoWait = false;
          this.slots[i].legatoLeft = Math.max(256, slice ? Math.round(slice.attackEnd * slice.duration) : Math.round(0.02 * sampleRate));
        }
        // Blend an even clock toward exponential (Poisson) gaps - same mean
        // either way, so Density means the same thing at any Regularity.
        const expGap = -Math.log(1 - this._rand());
        this.counters[i] = Math.max(1, Math.round(meanIntervals[i] * (regularity + (1 - regularity) * expGap)));
      }

      let sumL = 0;
      let sumR = 0;
      let sendSum = 0;
      let uncounted = 0; // held grains (counted per stream below) + muted grains
      for (let i = 0; i < SLOT_COUNT; i++) sendSmooth[i] += (sendTarget[i] - sendSmooth[i]) * 0.0005;
      for (let a = 0; a < this.activeCount; ) {
        const g = grains[active[a]];
        if (g.sustain || this.slots[g.slot].muteGain === 0) uncounted++;
        const t = g.elapsed / g.duration;
        let wp;
        if (t < g.attackEnd) wp = (t / g.attackEnd) * WIN_HALF;
        else wp = WIN_HALF + ((t - g.attackEnd) / (1 - g.attackEnd)) * WIN_HALF;
        const wi = wp | 0;
        const env = win[wi] + (win[wi + 1] - win[wi]) * (wp - wi);

        const buf = g.buf;
        const len = g.len;
        const ri = g.readPos | 0;
        const rf = g.readPos - ri;
        const rn = ri + 1 >= len ? 0 : ri + 1;
        const x = (buf[ri] + (buf[rn] - buf[ri]) * rf) * env * (g.sustain ? sustainSlotGain[g.slot] : slotGain[g.slot]);
        g.lp += g.lpA * (x - g.lp);
        const s = g.lp;
        sumL += s * g.gainL;
        sumR += s * g.gainR;
        sendSum += s * g.panSum * Math.min(1.5, sendSmooth[g.slot] + DEPTH_SEND * g.depth);

        g.readPos += g.step;
        if (g.readPos >= len || g.readPos < 0) g.readPos = ((g.readPos % len) + len) % len;

        if (++g.elapsed >= g.duration) {
          this.free.push(active[a]);
          active[a] = active[--this.activeCount];
        } else {
          a++;
        }
      }

      // Smoothed 1/sqrt(overlap) - sparse grains play at full level, a dense
      // cloud doesn't just get louder as it fuses.
      let voices = this.activeCount - uncounted;
      for (let i = 0; i < SLOT_COUNT; i++) if (sustainNow[i] && this.slots[i].muteGain > 0) voices++;
      // Decorrelated grains add by power, and a Hann grain carries 0.375 of
      // its source's power - so a dense cloud lands near the source's own
      // level. Capped at 1 so sparse (1-2 voice) grains never boost.
      const target = Math.min(1, 1 / Math.sqrt(0.375 * Math.max(1, voices)));
      this.smoothNorm += (target - this.smoothNorm) * 0.001;
      const k = this.smoothNorm * level;
      let wetL = 0;
      let wetR = 0;
      if (runReverb) {
        const rin = sendSum * k * REVERB_IN_GAIN;
        wetL = this._reverbChannel(rin, this.combsL, this.allpassL, feedback, damp1, damp2) * wet;
        wetR = this._reverbChannel(rin, this.combsR, this.allpassR, feedback, damp1, damp2) * wet;
      }
      outL[n] = sumL * k + wetL;
      if (outR) outR[n] = sumR * k + wetR;
      if (!Number.isFinite(outL[n] + (outR ? outR[n] : 0))) {
        // Never let a bad value out - one NaN downstream silences the whole
        // master chain until reload. Drop it and clear whatever carried it.
        outL[n] = 0;
        if (outR) outR[n] = 0;
        this._clearNonFinite();
      }

      this.writePos = this.writePos + 1 >= liveLen ? 0 : this.writePos + 1;
    }

    if (++this.blockCount >= REPORT_EVERY_BLOCKS) {
      this.blockCount = 0;
      const pointers = new Float32Array(SLOT_COUNT);
      const grainPointers = new Float32Array(SLOT_COUNT);
      const gains = new Float32Array(SLOT_COUNT);
      const frozen = new Uint8Array(SLOT_COUNT);
      const expired = new Uint8Array(SLOT_COUNT);
      const sends = new Float32Array(SLOT_COUNT);
      for (let i = 0; i < SLOT_COUNT; i++) {
        sends[i] = sendSmooth[i];
        gains[i] = this.slots[i].fadeGain;
        frozen[i] = this.slots[i].frozen ? 1 : 0;
        expired[i] = this.slots[i].expired ? 1 : 0;
      }
      const available = new Uint8Array(SLOT_COUNT);
      for (let i = 0; i < SLOT_COUNT; i++) {
        const slot = this.slots[i];
        const { lo, w } = this._range(p, i);
        let u = (p[`position${i + 1}`][0] + this._phase(slot, this._scanMode(p, i))) % 1;
        if (u < 0) u += 1;
        pointers[i] = lo + w * u;
        grainPointers[i] = slot.grainPos;
        available[i] = availableNow[i] || sustainNow[i];
      }
      this.port.postMessage({
        type: 'report',
        events: this.events,
        activeCount: this.activeCount,
        pointers,
        grainPointers,
        available,
        gains,
        frozen,
        expired,
        sends,
        time: currentFrame / sampleRate,
      });
      this.events = [];
    }

    return true;
  }
}

registerProcessor('grain-cloud-processor', GrainCloudProcessor);
