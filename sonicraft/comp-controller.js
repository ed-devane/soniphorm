// comp-controller.js — Comp page: place samples on their own timeline, drag
// to reposition, play back live, bounce to a slot, and modulate one sample
// with another (ring-mod/vocoder/FM, reusing rec-controller.js's cross-slot
// DSP).
//
// v1 slice: placement + drag + play/stop + bounce. Deferred to later sessions:
// true pinch time-stretch, a long-press-on-item menu (reverse/pan), and
// randomized live-variation-per-playback.
//
// Uses a second WaveformRenderer instance (app.compWaveform) bound to its
// own #comp-canvas, with only addTrack()/removeTrack() ever called on it --
// no primary buffer is ever set, so the renderer's own pointer handlers stay
// permanently inert (see waveform.js's `if (!this._mono...) return` guards).
// The renderer is switched into "fixed-scale" mode (setFixedScale()) so
// position is a direct, content-independent linear mapping from pixels to
// samples -- a sample lands exactly where the user long-pressed, rather than
// auto-fitting to whatever's already been placed (which would also make
// existing items visually shift every time a new, longer item is added).
//
// Sample-rate note: the app's AudioContext is created with a fixed
// sampleRate (audio-engine.js), and decodeAudioData() always resamples to
// match it -- so every slot's decoded audio (via slots.getSlotAudio) shares
// one common sample rate, which is what lets item offsets/durations be
// mixed directly as raw sample counts in the composition timeline below.

// Colors carry alpha so overlapping placements blend instead of one opaquely
// occluding another -- matches the "abstract/oceanic" rather than
// DAW-boxes-and-tracks design intent. Kept as {r,g,b,a} so the spectrogram
// renderer can do color math (brightness lerp) directly, not string-parse.
const COMP_COLORS = [
    { r: 249, g: 115, b: 22, a: 0.55 }, { r: 168, g: 85, b: 247, a: 0.55 },
    { r: 34, g: 197, b: 94, a: 0.55 }, { r: 234, g: 179, b: 8, a: 0.55 },
    { r: 236, g: 72, b: 153, a: 0.55 }, { r: 20, g: 184, b: 166, a: 0.55 },
    { r: 239, g: 68, b: 68, a: 0.55 }, { r: 14, g: 165, b: 233, a: 0.55 },
];
const LONG_PRESS_MS = 500;
const DRAG_THRESHOLD_PX = 15; // generous: a real hand can't hold a mouse perfectly still for 500ms
const SAMPLE_RATE = 48000; // fixed AudioContext rate, see audio-engine.js
const PIXELS_PER_SECOND = 120;

// Spectrogram analysis (see _computeSpectrogramBitmap). Column count is fixed
// regardless of sample duration -- longer samples get a larger hop between
// FFT frames, not more frames -- so total analysis cost is roughly constant
// no matter how long the underlying recording is.
const SPEC_FRAME_SIZE = 1024;
const SPEC_TIME_COLUMNS = 320;
const SPEC_FREQ_ROWS = 160;
const SPEC_DB_FLOOR = -60;
// Independent of the per-sample color's own alpha (which is tuned for the
// old peak-waveform fill blending nicely with overlaps) -- alpha here is the
// primary way a per-pixel heatmap reveals structure, so it needs more range.
const SPEC_MAX_ALPHA = 0.9;
// Relief/bump shading over the magnitude heightmap (see _computeSpectrogramBitmap).
const SPEC_SHADE_STRENGTH = 4;
const SPEC_AMBIENT = 0.45;

// Pitch-trace analysis (see detectPitchYIN/_computePitchTrace). Independent
// of and coarser than the spectrogram's time resolution -- pitch contours
// change more slowly than spectral detail needs. Parameters starting-point,
// tunable pending real measurement (see plan verification notes).
const PITCH_MIN_FREQ = 100;  // Hz -- floor; very low bass notes won't track
const PITCH_MAX_FREQ = 1000; // Hz -- ceiling
const PITCH_FRAME_SIZE = 1536;
const PITCH_COLUMNS = 40; // halved from an initial 80 after measuring ~160-210ms real cost at 80
const PITCH_YIN_THRESHOLD = 0.15;

/**
 * YIN pitch detection (de Cheveigne & Kawahara) on a single raw (unwindowed)
 * time-domain frame. Returns {freq, confidence} or null if no lag cleared
 * the threshold before maxLag (unvoiced/no clear pitch -- noise, silence,
 * percussive transients, polyphonic material).
 *
 * Computes the difference function and its cumulative-mean-normalized form
 * interleaved per-tau (not as two separate full passes), stopping as soon as
 * a qualifying tau is found -- both YIN's own stopping rule and meaningfully
 * faster in practice for typical tonal content, since most real notes are
 * found well before the search reaches maxLag; only genuinely unvoiced
 * frames pay the full O(maxLag * frameSize) cost.
 */
function detectPitchYIN(frame, sampleRate, minFreqHz, maxFreqHz, threshold) {
    const maxLag = Math.min(frame.length - 1, Math.floor(sampleRate / minFreqHz));
    const minLag = Math.max(2, Math.floor(sampleRate / maxFreqHz));
    if (maxLag <= minLag) return null;

    let runningSum = 0;

    for (let tau = 1; tau <= maxLag; tau++) {
        let sum = 0;
        const n = frame.length - tau;
        for (let i = 0; i < n; i++) {
            const d = frame[i] - frame[i + tau];
            sum += d * d;
        }
        runningSum += sum;

        if (tau < minLag) continue;

        const cmnd = sum / (runningSum / tau);
        if (cmnd < threshold) {
            // Confirm this is a local minimum (YIN's stopping rule) by
            // continuing only while cmnd keeps decreasing, then stop --
            // this is the early exit that skips the rest of maxLag.
            let bestTau = tau;
            let bestCmnd = cmnd;
            let t = tau + 1;
            while (t <= maxLag) {
                let s = 0;
                const nn = frame.length - t;
                for (let i = 0; i < nn; i++) {
                    const d = frame[i] - frame[i + t];
                    s += d * d;
                }
                const rs = runningSum + s;
                const c = s / (rs / t);
                if (c >= bestCmnd) break;
                bestTau = t;
                bestCmnd = c;
                runningSum = rs;
                t++;
            }

            // Integer-lag accuracy only (no sub-bin parabolic interpolation) --
            // simpler and safe given the interleaved early-exit search above
            // doesn't keep neighboring CMND values addressable for it, and
            // for a visual contour (not scientific pitch measurement) the
            // resulting few-Hz quantization is not visible.
            return { freq: sampleRate / bestTau, confidence: 1 - bestCmnd };
        }
    }
    return null;
}

class CompController {
    constructor(app) {
        this.app = app;

        this._items = []; // {id, waveformTrackId, slotIndex, offsetSamples, durationSamples, color, centerYFrac}
        this._nextItemId = 1;
        this._colorForSlot = new Map(); // slotIndex -> {r,g,b,a}
        this._spectrogramCache = {}; // slotIndex -> offscreen canvas
        this._pitchTraceCache = {}; // slotIndex -> array of {xFrac, rowFrac}

        this._longPressTimer = null;
        this._pressStartX = null;
        this._pressStartY = null;
        this._pressStartSample = null;
        this._pressMoved = false;
        this._dragItem = null; // {item, startClientX, startOffsetSamples}

        this._playingSources = [];
        this._playheadRAF = null;

        this._modulateSelection = null; // null when not selecting; else array of 0-2 picked items
    }

    // === Lifecycle (mirrors seq-controller.js / sample-controller.js) ===

    async enter() {
        this.app._compMode = true;
        requestAnimationFrame(() => {
            this.app.compWaveform.resize();
            this._updateEmptyHint();
        });
    }

    exit(targetMode) {
        this.app._compMode = false;
        this.stop();
        this._cancelModulateSelection();
    }

    // === One-time DOM/canvas wiring (called once from App.init()) ===

    _bindCanvasEvents() {
        const canvas = document.getElementById('comp-canvas');
        this.app.compWaveform.setFixedScale(PIXELS_PER_SECOND / SAMPLE_RATE);

        canvas.addEventListener('mousedown', (e) => this._onPointerDown(e.clientX, e.clientY));
        canvas.addEventListener('mousemove', (e) => this._onPointerMove(e.clientX));
        canvas.addEventListener('mouseup', (e) => this._onPointerUp(e.clientX));
        canvas.addEventListener('mouseleave', () => this._onPointerLeave());
        // Some trackpads map press-and-hold to a right-click; a native context
        // menu popping up mid-long-press would look like nothing happened.
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        document.getElementById('comp-play-btn').addEventListener('click', () => this.play());
        document.getElementById('comp-stop-btn').addEventListener('click', () => this.stop());
        document.getElementById('comp-clear-btn').addEventListener('click', () => this.clear());
        document.getElementById('comp-bounce-btn').addEventListener('click', () => this.bounceToSlot());
        document.getElementById('comp-modulate-btn').addEventListener('click', () => this._armModulateSelection());

        document.getElementById('comp-picker-cancel').addEventListener('click', () => {
            document.getElementById('comp-picker-dialog').hidden = true;
        });
        document.getElementById('comp-modulate-cancel').addEventListener('click', () => this._cancelModulateSelection());
        document.getElementById('comp-modulate-confirm').addEventListener('click', () => this._applyModulate());
    }

    // === Pointer handling ===
    //
    // Items can deliberately overlap in time/space (that's the point of the
    // transparent fills), so hit-testing alone can't reliably decide
    // drag-vs-place -- a press over existing content should still be able to
    // add another item there. Intent is decided by movement instead:
    // press-and-hold-still opens the picker (add a new item, anywhere, even
    // over existing content); press-and-drag moves whatever item was under
    // the initial press, if any. A plain click with no movement on an
    // existing item was previously a no-op -- while a Modulate selection is
    // armed, that gesture picks the item instead (see _onPointerUp).

    _onPointerDown(clientX, clientY) {
        if (!this.app._compMode) return;

        this._pressStartX = clientX;
        this._pressStartY = clientY;
        this._pressStartSample = this.app.compWaveform.sampleAtX(clientX);
        this._pressMoved = false;
        this._dragItem = null;

        this._longPressTimer = setTimeout(() => {
            this._longPressTimer = null;
            if (!this._pressMoved && !this._modulateSelection) this._openPicker(this._pressStartX, this._pressStartY);
        }, LONG_PRESS_MS);
    }

    _onPointerMove(clientX) {
        if (this._pressStartX == null) return;

        if (!this._pressMoved && Math.abs(clientX - this._pressStartX) > DRAG_THRESHOLD_PX) {
            this._pressMoved = true;
            if (this._longPressTimer) {
                clearTimeout(this._longPressTimer);
                this._longPressTimer = null;
            }
            if (!this._modulateSelection) {
                const item = this._itemAt(this._pressStartSample, this._pressStartY);
                if (item) {
                    this._dragItem = { item, startClientX: this._pressStartX, startOffsetSamples: item.offsetSamples };
                }
            }
        }

        if (!this._dragItem) return;

        const { item, startClientX, startOffsetSamples } = this._dragItem;
        const rect = document.getElementById('comp-canvas').getBoundingClientRect();
        const visibleSamples = this.app.compWaveform.getVisibleSamples();
        const samplesPerPx = visibleSamples / rect.width;
        const deltaSamples = (clientX - startClientX) * samplesPerPx;
        const newOffset = Math.max(0, Math.round(startOffsetSamples + deltaSamples));

        item.offsetSamples = newOffset;
        this.app.compWaveform.setTrackOffset(item.waveformTrackId, newOffset);
    }

    _onPointerUp(clientX) {
        if (this._modulateSelection && !this._pressMoved && this._pressStartSample != null) {
            const item = this._itemAt(this._pressStartSample, this._pressStartY);
            if (item) this._handleModulatePick(item);
        }
        this._endPress();
    }

    _onPointerLeave() {
        this._endPress();
    }

    _endPress() {
        if (this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
        this._dragItem = null;
        this._pressStartX = null;
        this._pressStartY = null;
        this._pressStartSample = null;
        this._pressMoved = false;
    }

    /**
     * Items can deliberately overlap in time (transparent fills), so hit-testing
     * checks vertical proximity too, not just the time range -- otherwise a press
     * near an item placed higher/lower on the canvas could grab an unrelated
     * item that merely overlaps it in time. Most-recently-placed wins ties.
     */
    _itemAt(sample, clientY) {
        const rect = document.getElementById('comp-canvas').getBoundingClientRect();
        const yFrac = (clientY - rect.top) / rect.height;
        const yToleranceFrac = 0.2;
        for (let i = this._items.length - 1; i >= 0; i--) {
            const it = this._items[i];
            const inTime = sample >= it.offsetSamples && sample <= it.offsetSamples + it.durationSamples;
            const inY = Math.abs(yFrac - it.centerYFrac) <= yToleranceFrac;
            if (inTime && inY) return it;
        }
        return null;
    }

    // === Sample picker dialog ===

    _openPicker(clientX, clientY) {
        const slotsWithAudio = this.app.slots.slots.filter(s => s.hasAudio);
        if (slotsWithAudio.length === 0) {
            alert('No slots with audio yet -- record or load something in REC mode first');
            return;
        }

        const list = document.getElementById('comp-picker-list');
        list.innerHTML = '';

        // Show the dialog before drawing mini waveforms -- drawMiniFromPeaks reads
        // canvas.clientWidth/Height, which is 0 while the dialog's still [hidden].
        document.getElementById('comp-picker-dialog').hidden = false;

        for (const slot of slotsWithAudio) {
            const row = document.createElement('div');
            row.className = 'layer-slot-row comp-picker-row';

            const mini = document.createElement('canvas');
            mini.className = 'comp-picker-mini';
            const name = document.createElement('span');
            name.className = 'layer-slot-name';
            name.textContent = `${String(slot.index + 1).padStart(2, '0')} — ${slot.name || 'untitled'}`;

            row.appendChild(mini);
            row.appendChild(name);
            row.addEventListener('click', () => {
                document.getElementById('comp-picker-dialog').hidden = true;
                this._placeItem(slot.index, clientX, clientY);
            });

            list.appendChild(row);

            if (slot.peaks) {
                WaveformRenderer.drawMiniFromPeaks(mini, slot.peaks, this._rgbaString(this._resolveColorForSlot(slot.index)));
            }
        }
    }

    _resolveColorForSlot(slotIndex) {
        if (!this._colorForSlot.has(slotIndex)) {
            this._colorForSlot.set(slotIndex, COMP_COLORS[this._colorForSlot.size % COMP_COLORS.length]);
        }
        return this._colorForSlot.get(slotIndex);
    }

    _rgbaString(c) {
        return `rgba(${c.r},${c.g},${c.b},${c.a})`;
    }

    async _placeItem(slotIndex, clientX, clientY) {
        // Fixed-scale mode: position maps directly and linearly to where the
        // user long-pressed, independent of whatever's already been placed.
        const offsetSamples = this.app.compWaveform.sampleAtX(clientX);
        const bandFrac = this.app.compWaveform.trackBandHeightPx() / this.app.compWaveform.getHeight();
        const yMargin = Math.min(0.45, bandFrac / 2 + 0.05);
        const centerYFrac = Math.min(1 - yMargin, Math.max(yMargin, this.app.compWaveform.yFractionAtY(clientY)));
        await this._placeItemAt(slotIndex, offsetSamples, centerYFrac);
    }

    /** Shared by _placeItem (long-press position) and _applyModulate (target item's position). */
    async _placeItemAt(slotIndex, offsetSamples, centerYFrac) {
        await this.app.ensureAudioInit();
        const data = await this.app.slots.getSlotAudio(slotIndex);
        if (!data) return;

        const colorObj = this._resolveColorForSlot(slotIndex);
        const color = this._rgbaString(colorObj);
        const durationSamples = data.channels[0].length;

        const waveformTrackId = this.app.compWaveform.addTrack(data.channels, data.sampleRate, offsetSamples, color, centerYFrac);
        const bitmap = this._computeSpectrogramBitmap(slotIndex, data.channels[0], data.sampleRate, colorObj);
        this.app.compWaveform.setTrackImage(waveformTrackId, bitmap);
        const pitchTrace = this._computePitchTrace(slotIndex, data.channels[0], data.sampleRate);
        this.app.compWaveform.setTrackPitchTrace(waveformTrackId, pitchTrace);

        this._items.push({
            id: this._nextItemId++,
            waveformTrackId,
            slotIndex,
            offsetSamples,
            durationSamples,
            color,
            centerYFrac,
        });

        this._updateEmptyHint();
    }

    _updateEmptyHint() {
        document.getElementById('comp-empty').hidden = this._items.length > 0;
    }

    // === Spectral coloring ===
    //
    // Melodyne-style: frequency on the vertical axis (log-scaled, low at the
    // bottom / high at the top), color reveals where the energy is rather than
    // just an amplitude outline. Keeps this sample's own assigned color rather
    // than a universal energy colormap -- magnitude modulates brightness/alpha
    // within that color instead, so the existing "one color per distinct
    // sample" identity still holds at a glance.
    //
    // Column count is fixed (SPEC_TIME_COLUMNS) regardless of sample duration
    // -- longer samples get a bigger hop between FFT frames, not more frames --
    // so this is a small, roughly constant amount of work no matter how long
    // the underlying recording is; no chunking/async needed.

    _computeSpectrogramBitmap(slotIndex, channelData, sampleRate, colorObj) {
        if (this._spectrogramCache[slotIndex]) return this._spectrogramCache[slotIndex];

        const hannWindow = DSP.hannWindow(SPEC_FRAME_SIZE);
        const hop = channelData.length / SPEC_TIME_COLUMNS;
        const minFreq = sampleRate / SPEC_FRAME_SIZE; // lowest usable (non-DC) bin
        const maxFreq = sampleRate / 2; // Nyquist
        const nyquistBin = SPEC_FRAME_SIZE / 2;

        // magnitudes[col][row], plus running peak for per-sample dB normalization
        const magnitudes = [];
        let peakMag = 0;

        for (let col = 0; col < SPEC_TIME_COLUMNS; col++) {
            const start = Math.floor(col * hop);
            const real = new Float32Array(SPEC_FRAME_SIZE);
            const imag = new Float32Array(SPEC_FRAME_SIZE);
            for (let i = 0; i < SPEC_FRAME_SIZE; i++) {
                const s = start + i;
                real[i] = s < channelData.length ? channelData[s] * hannWindow[i] : 0;
            }
            DSP.fft(real, imag);

            const row = new Float32Array(SPEC_FREQ_ROWS);
            for (let r = 0; r < SPEC_FREQ_ROWS; r++) {
                // Log-scaled frequency for this row, mapped to the nearest FFT bin
                const t = r / (SPEC_FREQ_ROWS - 1);
                const freq = minFreq * Math.pow(maxFreq / minFreq, t);
                const bin = Math.min(nyquistBin - 1, Math.max(1, Math.round(freq / sampleRate * SPEC_FRAME_SIZE)));
                const mag = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]);
                row[r] = mag;
                if (mag > peakMag) peakMag = mag;
            }
            magnitudes.push(row);
        }

        // Height grid: the same normalized/perceptual brightness value used for
        // color, but kept as a 2D surface so relief shading (below) can read
        // neighbors -- reuses data already computed above, no new analysis pass.
        const peakDb = 20 * Math.log10(peakMag + 1e-9);
        const height = new Float32Array(SPEC_TIME_COLUMNS * SPEC_FREQ_ROWS);
        const heightAt = (col, r) => height[Math.min(SPEC_TIME_COLUMNS - 1, Math.max(0, col)) * SPEC_FREQ_ROWS + Math.min(SPEC_FREQ_ROWS - 1, Math.max(0, r))];
        for (let col = 0; col < SPEC_TIME_COLUMNS; col++) {
            for (let r = 0; r < SPEC_FREQ_ROWS; r++) {
                const db = 20 * Math.log10(magnitudes[col][r] + 1e-9) - peakDb;
                const norm = Math.min(1, Math.max(0, (db - SPEC_DB_FLOOR) / -SPEC_DB_FLOOR));
                height[col * SPEC_FREQ_ROWS + r] = Math.pow(norm, 0.6); // perceptual curve: keep mid-level detail visible
            }
        }

        // Simulated directional lighting over the height surface (standard
        // hillshade/bump-map technique) -- turns the flat energy wash into a
        // lit/shadowed relief using the same data, light from the upper-left.
        const lightLen = Math.hypot(-0.5, -0.7, 0.6);
        const light = { x: -0.5 / lightLen, y: -0.7 / lightLen, z: 0.6 / lightLen };

        const canvas = document.createElement('canvas');
        canvas.width = SPEC_TIME_COLUMNS;
        canvas.height = SPEC_FREQ_ROWS;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(SPEC_TIME_COLUMNS, SPEC_FREQ_ROWS);

        for (let col = 0; col < SPEC_TIME_COLUMNS; col++) {
            for (let r = 0; r < SPEC_FREQ_ROWS; r++) {
                const brightness = height[col * SPEC_FREQ_ROWS + r];

                const dx = (heightAt(col + 1, r) - heightAt(col - 1, r)) / 2;
                const dy = (heightAt(col, r + 1) - heightAt(col, r - 1)) / 2;
                const nx = -dx * SPEC_SHADE_STRENGTH, ny = -dy * SPEC_SHADE_STRENGTH, nz = 1;
                const nLen = Math.hypot(nx, ny, nz);
                const dot = (nx / nLen) * light.x + (ny / nLen) * light.y + (nz / nLen) * light.z;
                const shade = SPEC_AMBIENT + (1 - SPEC_AMBIENT) * Math.max(0, dot);

                // Row 0 = lowest frequency -> draw at the bottom of the bitmap
                const y = SPEC_FREQ_ROWS - 1 - r;
                const idx = (y * SPEC_TIME_COLUMNS + col) * 4;
                // Lerp this sample's color toward white as magnitude approaches 1 (a
                // soft "hot" highlight), then modulate by the lighting factor for relief.
                imageData.data[idx]     = (colorObj.r + (255 - colorObj.r) * brightness) * shade;
                imageData.data[idx + 1] = (colorObj.g + (255 - colorObj.g) * brightness) * shade;
                imageData.data[idx + 2] = (colorObj.b + (255 - colorObj.b) * brightness) * shade;
                imageData.data[idx + 3] = Math.round(brightness * SPEC_MAX_ALPHA * 255);
            }
        }
        ctx.putImageData(imageData, 0, 0);

        this._spectrogramCache[slotIndex] = canvas;
        return canvas;
    }

    // === Pitch trace ===
    //
    // A Melodyne-style contour tracing the detected fundamental over time,
    // drawn on top of the spectral color fill (see waveform.js's
    // setTrackPitchTrace/_drawPitchTrace). Only meaningful for monophonic/
    // tonal material -- percussive or polyphonic samples will correctly come
    // back mostly/entirely unvoiced (no trace), not a bug.

    _computePitchTrace(slotIndex, channelData, sampleRate) {
        if (this._pitchTraceCache[slotIndex]) return this._pitchTraceCache[slotIndex];

        // Same log-frequency display range as the spectrogram's vertical axis
        // (not the pitch search range below) so the trace aligns with the
        // color fill beneath it.
        const displayMinFreq = sampleRate / SPEC_FRAME_SIZE;
        const displayMaxFreq = sampleRate / 2;
        const hop = channelData.length / PITCH_COLUMNS;
        const points = [];

        for (let col = 0; col < PITCH_COLUMNS; col++) {
            const start = Math.floor(col * hop);
            const frame = channelData.subarray(start, Math.min(start + PITCH_FRAME_SIZE, channelData.length));
            const xFrac = col / (PITCH_COLUMNS - 1);

            if (frame.length < PITCH_FRAME_SIZE * 0.5) {
                points.push({ xFrac, rowFrac: null });
                continue;
            }

            const result = detectPitchYIN(frame, sampleRate, PITCH_MIN_FREQ, PITCH_MAX_FREQ, PITCH_YIN_THRESHOLD);
            if (!result) {
                points.push({ xFrac, rowFrac: null });
                continue;
            }

            const t = Math.log(result.freq / displayMinFreq) / Math.log(displayMaxFreq / displayMinFreq);
            // 0=top(high freq)/1=bottom(low freq) -- matches the spectrogram's
            // low-frequency-at-bottom convention (waveform.js draws row 0 at
            // the bitmap bottom).
            const rowFrac = 1 - Math.min(1, Math.max(0, t));
            points.push({ xFrac, rowFrac });
        }

        this._pitchTraceCache[slotIndex] = points;
        return points;
    }

    // === Playback ===

    async play() {
        this.stop();
        if (this._items.length === 0) return;

        await this.app.ensureAudioInit();
        const ctx = this.app.audio.audioContext;
        const startTime = ctx.currentTime + 0.05; // small lead-in so the first source doesn't miss t=0
        let maxEndSamples = 0;

        for (const item of this._items) {
            const buf = await this._getOrBuildBuffer(item.slotIndex);
            if (!buf) continue;
            const source = ctx.createBufferSource();
            source.buffer = buf;
            source.connect(ctx.destination);
            source.start(startTime + item.offsetSamples / buf.sampleRate);
            this._playingSources.push(source);
            maxEndSamples = Math.max(maxEndSamples, item.offsetSamples + item.durationSamples);
        }

        if (this._playingSources.length === 0) return;

        const sampleRate = ctx.sampleRate;
        const tick = () => {
            const elapsedSamples = Math.round((ctx.currentTime - startTime) * sampleRate);
            if (elapsedSamples >= maxEndSamples) {
                this.stop();
                return;
            }
            this.app.compWaveform.setCursor(elapsedSamples);
            this._playheadRAF = requestAnimationFrame(tick);
        };
        this._playheadRAF = requestAnimationFrame(tick);
    }

    stop() {
        if (this._playheadRAF) {
            cancelAnimationFrame(this._playheadRAF);
            this._playheadRAF = null;
        }
        for (const source of this._playingSources) {
            try { source.stop(); } catch (e) { /* already stopped */ }
        }
        this._playingSources = [];
        if (this.app.compWaveform) this.app.compWaveform.setCursor(-1);
    }

    async _getOrBuildBuffer(slotIndex) {
        this.app._slotBuffers = this.app._slotBuffers || {};
        if (this.app._slotBuffers[slotIndex]) return this.app._slotBuffers[slotIndex];

        const data = await this.app.slots.getSlotAudio(slotIndex);
        if (!data) return null;
        const ctx = this.app.audio.audioContext;
        const buf = ctx.createBuffer(data.channels.length, data.channels[0].length, data.sampleRate);
        for (let ch = 0; ch < data.channels.length; ch++) {
            buf.getChannelData(ch).set(data.channels[ch]);
        }
        this.app._slotBuffers[slotIndex] = buf;
        return buf;
    }

    // === Clear ===

    clear() {
        this.stop();
        this._cancelModulateSelection();
        this._items = [];
        this._colorForSlot.clear();
        this.app.compWaveform.clearTracks();
        this._updateEmptyHint();
    }

    // === Bounce to slot (generalizes rec-controller.js's _renderLayerMix: per-item
    // start offset instead of every source starting at t=0) ===

    async _renderCompositionMix() {
        await this.app.ensureAudioInit();
        const sampleRate = this.app.audio.audioContext.sampleRate;

        const audioData = [];
        let maxLength = 0;
        for (const item of this._items) {
            const data = await this.app.slots.getSlotAudio(item.slotIndex);
            if (!data) continue;
            audioData.push({ data, item });
            maxLength = Math.max(maxLength, item.offsetSamples + data.channels[0].length);
        }
        if (audioData.length === 0) throw new Error('No audio to bounce');

        const offline = new OfflineAudioContext(2, maxLength, sampleRate);
        for (const { data, item } of audioData) {
            const buf = offline.createBuffer(data.channels.length, data.channels[0].length, data.sampleRate);
            for (let ch = 0; ch < data.channels.length; ch++) {
                buf.getChannelData(ch).set(data.channels[ch]);
            }
            const source = offline.createBufferSource();
            source.buffer = buf;
            source.connect(offline.destination);
            source.start(item.offsetSamples / sampleRate);
        }

        const rendered = await offline.startRendering();
        const channels = [];
        for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
            channels.push(new Float32Array(rendered.getChannelData(ch)));
        }
        return { channels, sampleRate: rendered.sampleRate };
    }

    async bounceToSlot() {
        if (this._items.length === 0) {
            alert('Nothing to bounce -- place at least one sample first');
            return;
        }

        const btn = document.getElementById('comp-bounce-btn');
        btn.textContent = 'Bouncing...';
        btn.disabled = true;

        try {
            const result = await this._renderCompositionMix();
            const emptySlot = this.app.slots.findEmptySlot();
            if (emptySlot < 0) {
                alert('No empty slots available');
                return;
            }

            const slotNums = this._items.map(it => String(it.slotIndex + 1).padStart(2, '0'));
            const compName = 'comp-' + slotNums.join('+');

            await this.app.slots.saveSlotAudio(emptySlot, result.channels, result.sampleRate);
            await this.app.slots.renameSlot(emptySlot, compName);

            const buf = this.app.audio.audioContext.createBuffer(
                result.channels.length, result.channels[0].length, result.sampleRate
            );
            for (let ch = 0; ch < result.channels.length; ch++) {
                buf.getChannelData(ch).set(result.channels[ch]);
            }
            this.app._slotBuffers = this.app._slotBuffers || {};
            this.app._slotBuffers[emptySlot] = buf;

            this.app.buildSlotGrid();
            this.app.renderSlotGrid();
            this.app.updateToolbarState();
        } catch (e) {
            console.error('Comp bounce error:', e);
            alert('Bounce failed');
        } finally {
            btn.textContent = 'BOUNCE';
            btn.disabled = false;
        }
    }

    // === Modulate: cross-process one placed item with another ===
    //
    // Reuses rec-controller.js's crossProcessBuffer (ring-mod/vocoder/FM/
    // convolve) -- the same DSP already proven in the REC-mode Cross-slot
    // dialog, just applied between two arbitrary placed items instead of
    // "current buffer + a picked source slot." Always bakes a new slot (see
    // the FM-feasibility discussion: live/real-time cross-modulation would
    // need an AudioWorklet -- a separate, bigger task, deferred).

    _armModulateSelection() {
        // Clicking MODULATE again while already armed cancels it -- a way to
        // back out without needing to pick two items first.
        if (this._modulateSelection) {
            this._cancelModulateSelection();
            return;
        }
        if (this._items.length < 2) {
            alert('Place at least 2 samples first');
            return;
        }
        this._modulateSelection = [];
        document.getElementById('comp-modulate-btn').classList.add('active');
        this._updateModulateHint();
    }

    _cancelModulateSelection() {
        this._modulateSelection = null;
        document.getElementById('comp-modulate-btn').classList.remove('active');
        document.getElementById('comp-modulate-dialog').hidden = true;
        this._updateModulateHint();
        if (this.app.compWaveform) this.app.compWaveform.render(); // erase any selection highlight
    }

    _updateModulateHint() {
        const hint = document.getElementById('comp-modulate-hint');
        if (!this._modulateSelection) {
            hint.hidden = true;
            return;
        }
        const remaining = 2 - this._modulateSelection.length;
        hint.textContent = remaining === 2
            ? 'Click a sample (source), then another (target) -- click MODULATE again to cancel'
            : 'Now click the target sample';
        hint.hidden = false;
    }

    _handleModulatePick(item) {
        if (this._modulateSelection.includes(item)) return;
        this._modulateSelection.push(item);
        this._drawSelectionHighlight(item);
        this._updateModulateHint();
        if (this._modulateSelection.length === 2) {
            document.getElementById('comp-modulate-dialog').hidden = false;
        }
    }

    /** Best-effort highlight: drawn directly on the canvas after the renderer's
     * own render() -- will be erased by the next unrelated render() call, which
     * is fine since the Modulate flow is a short, deliberate sequence with no
     * playback/dragging happening at the same time. */
    _drawSelectionHighlight(item) {
        const canvas = document.getElementById('comp-canvas');
        const ctx = canvas.getContext('2d');
        const pxPerSample = PIXELS_PER_SECOND / SAMPLE_RATE;
        const x0 = item.offsetSamples * pxPerSample;
        const x1 = (item.offsetSamples + item.durationSamples) * pxPerSample;
        const h = this.app.compWaveform.getHeight();
        const bandHeight = this.app.compWaveform.trackBandHeightPx();
        const centerY = item.centerYFrac * h;

        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0, centerY - bandHeight / 2, x1 - x0, bandHeight);
        ctx.restore();
    }

    async _applyModulate() {
        const [sourceItem, targetItem] = this._modulateSelection;
        const op = document.getElementById('comp-modulate-op').value;
        document.getElementById('comp-modulate-dialog').hidden = true;

        const sourceData = await this.app.slots.getSlotAudio(sourceItem.slotIndex);
        const targetData = await this.app.slots.getSlotAudio(targetItem.slotIndex);
        if (!sourceData || !targetData) {
            alert('Could not load one of the selected samples');
            this._cancelModulateSelection();
            return;
        }

        const sampleRate = targetData.sampleRate;
        const resultChannels = await crossProcessBuffer(
            targetData.channels, sourceData.channels[0], sampleRate, op, 0, targetData.channels[0].length
        );

        const emptySlot = this.app.slots.findEmptySlot();
        if (emptySlot < 0) {
            alert('No empty slots available');
            this._cancelModulateSelection();
            return;
        }

        const name = `mod-${op}-${String(sourceItem.slotIndex + 1).padStart(2, '0')}x${String(targetItem.slotIndex + 1).padStart(2, '0')}`;
        await this.app.slots.saveSlotAudio(emptySlot, resultChannels, sampleRate);
        await this.app.slots.renameSlot(emptySlot, name);

        // Auto-place the result at the target's position so the effect is
        // immediately visible/audible in the composition, not left stranded
        // in REC mode's grid.
        await this._placeItemAt(emptySlot, targetItem.offsetSamples, targetItem.centerYFrac);

        this.app.buildSlotGrid();
        this.app.renderSlotGrid();
        this._cancelModulateSelection();
    }
}
