// waveform.js — Canvas-based waveform renderer with zoom, scroll, selection, and playback cursor.
//
// Track model: the "primary" buffer (setAudio/updateAudio/clear, the _channels/
// _mono/_totalSamples fields) is what every existing REC/SAMPLE/SEQ page uses --
// one waveform, unchanged behavior. addTrack()/removeTrack() layer in additional
// waveforms at their own timeline offset+color+gain, purely for rendering, so a
// future multi-waveform view (e.g. a comp page) can reuse this renderer
// instead of needing its own. Selection/loop/cursor/interaction stay scoped to
// the primary buffer for now -- extra tracks are display-only until that's built.

const COLORS = {
    background: '#0a0e1a',
    deadZone: '#040609',
    deadZoneBorder: 'rgba(255, 255, 255, 0.12)',
    waveform: '#0ea5e9',
    centerLine: '#1e293b',
    selectionFill: 'rgba(14, 165, 233, 0.12)',
    selectionDim: 'rgba(0, 0, 0, 0.45)',
    selectionEdge: 'rgba(14, 165, 233, 0.7)',
    cursor: '#ffffff',
    miniWaveform: 'rgba(14, 165, 233, 0.6)',
    emptyText: 'rgba(255, 255, 255, 0.25)',
    loopFill: 'rgba(34, 197, 94, 0.12)',
    loopEdge: 'rgba(34, 197, 94, 0.7)',
    loopEdgeActive: 'rgba(34, 197, 94, 1.0)',
};

const DEAD_ZONE = 0.05;
const EMPTY_FONT = '14px "JetBrains Mono", monospace';
const MIN_DRAG_PX = 3;
const ZOOM_FACTOR = 1.15;
const MAX_ZOOM = 10000;

class WaveformRenderer {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
        this._canvas = canvas;
        this._ctx = canvas.getContext('2d');

        // Audio state
        this._channels = null;
        this._sampleRate = 44100;
        this._totalSamples = 0;
        this._mono = null; // first channel reference used for drawing

        // Extra display-only tracks layered on top of the primary buffer above
        // (see addTrack()). Each: {id, mono, totalSamples, offset, color, gain}.
        this._extraTracks = [];
        this._nextTrackId = 1;

        // View state
        this._zoom = 1;
        this._scrollOffset = 0;

        // Selection (always stored with start <= end internally)
        this._selStart = -1;
        this._selEnd = -1;

        // Loop markers (sample indices)
        this._loopStart = -1;
        this._loopEnd = -1;
        this._loopVisible = false;
        this._draggingLoopMarker = null; // 'start' | 'end' | null
        this._draggingSelMarker = null;  // 'start' | 'end' | null
        this._lastPointerDownTime = 0;
        this.onLoopChange = null;
        this.onLoopClear = null;

        // Playback cursor
        this._cursorSample = -1;

        // Interaction state
        this._dragging = false;
        this._dragStartX = 0;
        this._dragStartSample = 0;

        // Pinch-to-zoom state
        this._pinching = false;
        this._pinchStartDist = 0;
        this._pinchStartZoom = 1;
        this._pinchMidSample = 0;
        this._pinchMidFraction = 0.5;
        this._pinchStartMidX = 0;
        this._pinchStartScrollOffset = 0;

        // Chromatic mode: suppress all pointer/render when piano is drawn
        this.chromaticMode = false;

        // Fixed-scale mode (see setFixedScale()): a free-form canvas (the comp
        // page) where position is set directly by where the user places things,
        // rather than auto-fitting to whatever content exists. When set, this
        // replaces the dead-zone-remapped/auto-fit-zoom math everywhere below
        // with plain linear pixels-per-sample, and render() skips the dead-zone
        // decorations (they're a recording-view convention that doesn't apply here).
        this._fixedPxPerSample = null;

        // Callbacks
        this.onSelectionChange = null;
        this.onCursorSet = null;

        // Cached layout values (updated on resize)
        this._dpr = window.devicePixelRatio || 1;
        this._width = 0;
        this._height = 0;

        this._bindEvents();
        this.resize();
    }

    // ------------------------------------------------------------------ public

    /** Set audio data to display. First channel is used for drawing. */
    setAudio(channels, sampleRate) {
        this._channels = channels;
        this._sampleRate = sampleRate;
        this._totalSamples = channels && channels[0] ? channels[0].length : 0;
        this._mono = this._totalSamples > 0 ? channels[0] : null;

        // Reset view
        this._zoom = 1;
        this._scrollOffset = 0;
        this._selStart = -1;
        this._selEnd = -1;
        this._cursorSample = -1;
        this._loopStart = -1;
        this._loopEnd = -1;

        this.render();
    }

    /** Update audio data without resetting zoom/scroll/selection (for live recording). */
    updateAudio(channels, sampleRate) {
        this._channels = channels;
        this._sampleRate = sampleRate;
        this._totalSamples = channels && channels[0] ? channels[0].length : 0;
        this._mono = this._totalSamples > 0 ? channels[0] : null;
    }

    /** Clear display (no audio). */
    clear() {
        this._channels = null;
        this._mono = null;
        this._totalSamples = 0;
        this._selStart = -1;
        this._selEnd = -1;
        this._cursorSample = -1;
        this._loopStart = -1;
        this._loopEnd = -1;
        this._zoom = 1;
        this._scrollOffset = 0;
        this.render();
    }

    // -- Extra tracks (display-only, for multi-waveform views) ------------

    /**
     * Layer an additional waveform on top of the primary buffer at a given
     * sample offset in the shared timeline, vertically centered at centerYFrac
     * (0=top, 1=bottom, 0.5=middle -- independent per track, unlike the
     * primary buffer which always uses the canvas's vertical center). Returns
     * a track id for use with removeTrack()/setTrackOffset()/setTrackGain().
     */
    addTrack(channels, sampleRate, offset = 0, color = null, centerYFrac = 0.5) {
        const id = this._nextTrackId++;
        const totalSamples = channels && channels[0] ? channels[0].length : 0;
        this._extraTracks.push({
            id,
            sampleRate,
            totalSamples,
            mono: totalSamples > 0 ? channels[0] : null,
            offset,
            color: color || this._colorForTrack(id),
            gain: 1,
            centerYFrac,
            image: null,
        });
        this.render();
        return id;
    }

    /**
     * Give a track a precomputed image (e.g. a spectrogram bitmap) to draw
     * instead of the peak-envelope shape. Drawn stretched to the track's
     * offset/duration horizontally and to trackBandHeightPx() vertically,
     * centered at its centerYFrac -- same positioning as the peak path, just
     * a drawImage instead of a filled peak polygon.
     */
    setTrackImage(id, image) {
        const t = this._extraTracks.find(t => t.id === id);
        if (t) { t.image = image; this.render(); }
    }

    /**
     * Overlay a pitch contour on top of a track's image/peak shape -- kept as
     * vector points (not baked into the image bitmap) so it stays crisp
     * however much the underlying bitmap gets upscaled. `points` is an array
     * of {xFrac, rowFrac} (both 0-1, rowFrac null where unvoiced/no pitch
     * detected -- breaks the drawn line into separate segments there).
     */
    setTrackPitchTrace(id, points) {
        const t = this._extraTracks.find(t => t.id === id);
        if (t) { t.pitchTrace = points; this.render(); }
    }

    /** Pixel height reserved for an extra track's visual (peak shape or image). */
    trackBandHeightPx() {
        return Math.min(this._height * 0.35, 200);
    }

    getHeight() {
        return this._height;
    }

    removeTrack(id) {
        this._extraTracks = this._extraTracks.filter(t => t.id !== id);
        this.render();
    }

    clearTracks() {
        this._extraTracks = [];
        this.render();
    }

    setTrackOffset(id, offset) {
        const t = this._extraTracks.find(t => t.id === id);
        if (t) { t.offset = offset; this.render(); }
    }

    setTrackGain(id, gain) {
        const t = this._extraTracks.find(t => t.id === id);
        if (t) { t.gain = gain; this.render(); }
    }

    setTrackCenterY(id, centerYFrac) {
        const t = this._extraTracks.find(t => t.id === id);
        if (t) { t.centerYFrac = centerYFrac; this.render(); }
    }

    getTracks() {
        return this._extraTracks.map(t => ({ id: t.id, offset: t.offset, gain: t.gain, color: t.color, centerYFrac: t.centerYFrac, totalSamples: t.totalSamples }));
    }

    /**
     * Switch this renderer into fixed-scale mode: a free-form canvas where
     * pixel position maps directly and linearly to sample position (no
     * dead-zone margins, no auto-fit-to-content zoom). Pass pixels-per-sample
     * (i.e. desired-pixels-per-second / sampleRate). Pass null to restore the
     * normal dead-zone/auto-fit behavior used by the primary-buffer views.
     */
    setFixedScale(pxPerSample) {
        this._fixedPxPerSample = pxPerSample;
        this.render();
    }

    // -- Selection --------------------------------------------------------

    setSelection(startSample, endSample) {
        this._selStart = Math.min(startSample, endSample);
        this._selEnd = Math.max(startSample, endSample);
        this.render();
    }

    clearSelection() {
        this._selStart = -1;
        this._selEnd = -1;
        this.render();
    }

    /** @returns {{start: number, end: number} | null} start always <= end */
    getSelection() {
        if (this._selStart < 0 || this._selEnd < 0) return null;
        return { start: this._selStart, end: this._selEnd };
    }

    // -- Loop markers -----------------------------------------------------

    setLoopMarkers(startSample, endSample) {
        this._loopStart = Math.min(startSample, endSample);
        this._loopEnd = Math.max(startSample, endSample);
        this.render();
    }

    clearLoopMarkers() {
        this._loopStart = -1;
        this._loopEnd = -1;
        this._draggingLoopMarker = null;
        this.render();
    }

    getLoopMarkers() {
        if (this._loopStart < 0 || this._loopEnd < 0) return null;
        return { start: this._loopStart, end: this._loopEnd };
    }

    setLoopVisible(visible) {
        this._loopVisible = visible;
        this.render();
    }

    // -- Playback cursor --------------------------------------------------

    setCursor(sample) {
        this._cursorSample = sample;
        this.render();
    }

    getCursor() {
        return this._cursorSample >= 0 ? this._cursorSample : 0;
    }

    // -- Zoom & scroll ----------------------------------------------------

    setZoom(level) {
        const centerSample = this._scrollOffset + this.getVisibleSamples() / 2;
        this._zoom = Math.max(1, Math.min(MAX_ZOOM, level));
        const newVisible = this.getVisibleSamples();
        this._scrollOffset = centerSample - newVisible / 2;
        this._clampScroll();
        this.render();
    }

    getZoom() {
        return this._zoom;
    }

    setScrollOffset(samples) {
        this._scrollOffset = samples;
        this._clampScroll();
        this.render();
    }

    getScrollOffset() {
        return this._scrollOffset;
    }

    /**
     * Zoom/scroll so the given sample range fills the view with a small margin
     * around it (so the selection edges aren't flush against the dead-zone
     * boundary). Used by the zoom-fit toolbar button when a selection is active
     * (see app.js) -- same button falls back to fitting the whole file when
     * there isn't one, this is just the other half of that.
     */
    zoomToRange(startSample, endSample, marginFraction = 0.15) {
        const total = this._timelineLength();
        if (total <= 0) return;
        const rangeLen = Math.max(1, endSample - startSample);
        const margin = rangeLen * marginFraction;
        const visibleTarget = Math.min(total, rangeLen + margin * 2);
        this._zoom = Math.max(1, Math.min(MAX_ZOOM, total / visibleTarget));
        const newVisible = this.getVisibleSamples();
        this._scrollOffset = startSample - (newVisible - rangeLen) / 2;
        this._clampScroll();
        this.render();
    }

    /** How many samples are visible at the current zoom level. */
    getVisibleSamples() {
        if (this._fixedPxPerSample) return this._width / this._fixedPxPerSample;
        const total = this._timelineLength();
        if (total === 0) return 0;
        return total / this._zoom;
    }

    /** @returns {{start: number, end: number}} visible range in samples */
    getVisibleRange() {
        const vis = this.getVisibleSamples();
        return { start: this._scrollOffset, end: this._scrollOffset + vis };
    }

    /** Convert a clientX coordinate to a sample index (with dead zone remapping). */
    sampleAtX(clientX) {
        const rect = this._canvas.getBoundingClientRect();
        if (this._fixedPxPerSample) {
            return Math.round(this._scrollOffset + (clientX - rect.left) / this._fixedPxPerSample);
        }
        const rawFraction = (clientX - rect.left) / rect.width;
        // Remap: central 90% of canvas maps to full sample range; edges clamp
        let fraction;
        if (rawFraction <= DEAD_ZONE) {
            fraction = 0;
        } else if (rawFraction >= 1 - DEAD_ZONE) {
            fraction = 1;
        } else {
            fraction = (rawFraction - DEAD_ZONE) / (1 - 2 * DEAD_ZONE);
        }
        const vis = this.getVisibleSamples();
        return Math.round(this._scrollOffset + fraction * vis);
    }

    /** Convert a clientY coordinate to a 0-1 fraction of canvas height (for track vertical placement). */
    yFractionAtY(clientY) {
        const rect = this._canvas.getBoundingClientRect();
        return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    }

    // -- Layout -----------------------------------------------------------

    resize() {
        this._dpr = window.devicePixelRatio || 1;
        this._width = this._canvas.clientWidth;
        this._height = this._canvas.clientHeight;
        this._canvas.width = this._width * this._dpr;
        this._canvas.height = this._height * this._dpr;
        this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
        this.render();
    }

    // -- Render -----------------------------------------------------------

    render() {
        if (this.chromaticMode) return;
        const ctx = this._ctx;
        const w = this._width;
        const h = this._height;

        if (w === 0 || h === 0) return;

        // Background
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, w, h);

        if (this._timelineLength() === 0) {
            return;
        }

        const halfH = h / 2;
        const visibleSamples = this.getVisibleSamples();
        const startSample = this._scrollOffset;

        // Dead zone margins
        const dzLeft = Math.floor(DEAD_ZONE * w);
        const dzRight = Math.ceil((1 - DEAD_ZONE) * w);
        ctx.fillStyle = COLORS.deadZone;
        if (!this._fixedPxPerSample) {
            ctx.fillRect(0, 0, dzLeft, h);
            ctx.fillRect(dzRight, 0, w - dzRight, h);

            // Boundary lines at dead zone edges
            ctx.strokeStyle = COLORS.deadZoneBorder;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(dzLeft, 0);
            ctx.lineTo(dzLeft, h);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(dzRight, 0);
            ctx.lineTo(dzRight, h);
            ctx.stroke();

            // Center line
            ctx.strokeStyle = COLORS.centerLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, halfH);
            ctx.lineTo(w, halfH);
            ctx.stroke();
        }

        // --- Waveform (min/max peaks per pixel column) ---
        if (this._mono && this._totalSamples > 0) {
            this._drawWaveform(ctx, w, h, halfH, startSample, visibleSamples, this._mono, this._totalSamples, 0, COLORS.waveform, 1);
        }
        // Extra tracks get a fixed vertical band and their own position,
        // rather than stretching center-to-edge like the primary buffer --
        // see addTrack()'s centerYFrac. A track with a precomputed image
        // (e.g. a spectrogram bitmap, see setTrackImage()) draws that instead
        // of the peak-envelope shape.
        const bandHeight = this.trackBandHeightPx();
        for (const t of this._extraTracks) {
            const centerY = (t.centerYFrac != null ? t.centerYFrac : 0.5) * h;
            const x0 = this._sampleToX(t.offset, startSample, visibleSamples, w);
            const x1 = this._sampleToX(t.offset + t.totalSamples, startSample, visibleSamples, w);
            if (t.image) {
                ctx.drawImage(t.image, x0, centerY - bandHeight / 2, x1 - x0, bandHeight);
            } else if (t.mono && t.totalSamples > 0) {
                this._drawWaveform(ctx, w, h, centerY, startSample, visibleSamples, t.mono, t.totalSamples, t.offset, t.color, t.gain, bandHeight / 2);
            }
            if (t.pitchTrace) {
                this._drawPitchTrace(ctx, t.pitchTrace, x0, x1, centerY, bandHeight);
            }
        }

        // --- Selection overlay ---
        if (this._selStart >= 0 && this._selEnd >= 0) {
            this._drawSelection(ctx, w, h, startSample, visibleSamples);
        }

        // --- Loop markers ---
        if (this._loopVisible && this._loopStart >= 0 && this._loopEnd >= 0) {
            this._drawLoopMarkers(ctx, w, h, startSample, visibleSamples);
        }

        // --- Time ruler (bottom-edge gradations, superimposed on the waveform
        // rather than a separate strip -- see _drawTimeRuler()'s own comment) ---
        this._drawTimeRuler(ctx, w, h, startSample, visibleSamples);

        // --- Playback cursor ---
        if (this._cursorSample >= 0) {
            const x = this._sampleToX(this._cursorSample, startSample, visibleSamples, w);
            if (x >= 0 && x <= w) {
                ctx.strokeStyle = COLORS.cursor;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();
            }
        }
    }

    // -- Static mini waveform ---------------------------------------------

    /**
     * Draw a simple waveform thumbnail into a small canvas.
     * @param {HTMLCanvasElement} canvas
     * @param {Float32Array} channelData
     */
    static drawMini(canvas, channelData, color) {
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === 0 || h === 0) return;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.clearRect(0, 0, w, h);

        if (!channelData || channelData.length === 0) return;

        const halfH = h / 2;
        const samplesPerPx = channelData.length / w;

        ctx.fillStyle = color || COLORS.miniWaveform;
        ctx.beginPath();

        // Top edge (max values)
        for (let px = 0; px < w; px++) {
            const i0 = Math.floor(px * samplesPerPx);
            const i1 = Math.min(Math.floor((px + 1) * samplesPerPx), channelData.length);
            let max = 0;
            for (let i = i0; i < i1; i++) {
                const v = channelData[i];
                if (v > max) max = v;
            }
            const y = halfH - max * halfH;
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
        }

        // Bottom edge (min values) — walk backwards
        for (let px = w - 1; px >= 0; px--) {
            const i0 = Math.floor(px * samplesPerPx);
            const i1 = Math.min(Math.floor((px + 1) * samplesPerPx), channelData.length);
            let min = 0;
            for (let i = i0; i < i1; i++) {
                const v = channelData[i];
                if (v < min) min = v;
            }
            const y = halfH - min * halfH;
            ctx.lineTo(px, y);
        }

        ctx.closePath();
        ctx.fill();
    }

    /**
     * Downsample channel data to a small peaks array for thumbnail storage.
     */
    static computePeaks(channelData, numPeaks = 200) {
        if (!channelData || channelData.length === 0) return null;
        const peaks = new Float32Array(numPeaks * 2);
        const samplesPerPeak = channelData.length / numPeaks;
        for (let i = 0; i < numPeaks; i++) {
            const start = Math.floor(i * samplesPerPeak);
            const end = Math.min(Math.floor((i + 1) * samplesPerPeak), channelData.length);
            let min = 0, max = 0;
            for (let s = start; s < end; s++) {
                if (channelData[s] > max) max = channelData[s];
                if (channelData[s] < min) min = channelData[s];
            }
            peaks[i * 2] = max;
            peaks[i * 2 + 1] = min;
        }
        return peaks;
    }

    /**
     * Draw mini waveform from pre-computed peaks array (from computePeaks).
     */
    static drawMiniFromPeaks(canvas, peaks, color) {
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w === 0 || h === 0) return;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (!peaks || peaks.length === 0) return;

        const numPeaks = peaks.length / 2;
        const halfH = h / 2;
        const pxPerPeak = w / numPeaks;

        ctx.fillStyle = color || COLORS.miniWaveform;
        ctx.beginPath();
        for (let i = 0; i < numPeaks; i++) {
            const x = i * pxPerPeak;
            const y = halfH - peaks[i * 2] * halfH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        for (let i = numPeaks - 1; i >= 0; i--) {
            const x = i * pxPerPeak;
            const y = halfH - peaks[i * 2 + 1] * halfH;
            ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
    }

    // ----------------------------------------------------------- private

    /** Clamp scroll offset to valid range. */
    _clampScroll() {
        const vis = this.getVisibleSamples();
        const maxOffset = this._timelineLength() - vis;
        if (this._scrollOffset < 0) this._scrollOffset = 0;
        if (this._scrollOffset > maxOffset) this._scrollOffset = Math.max(0, maxOffset);
    }

    /** Full timeline extent in samples: primary buffer plus any extra track's offset+length. */
    _timelineLength() {
        let len = this._totalSamples;
        for (const t of this._extraTracks) {
            len = Math.max(len, t.offset + t.totalSamples);
        }
        return len;
    }

    /** Deterministic distinct color per extra track id (primary buffer keeps COLORS.waveform). */
    _colorForTrack(id) {
        const palette = ['#f97316', '#a855f7', '#22c55e', '#eab308', '#ec4899', '#14b8a6', '#ef4444', '#0ea5e9'];
        return palette[(id - 1) % palette.length];
    }

    /** Convert a sample index to an x-coordinate in CSS pixels (with dead zone mapping). */
    _sampleToX(sample, startSample, visibleSamples, canvasWidth) {
        if (this._fixedPxPerSample) return (sample - startSample) * this._fixedPxPerSample;
        if (visibleSamples === 0) return 0;
        const fraction = (sample - startSample) / visibleSamples;
        // Inverse of dead zone remap: 0-1 sample fraction maps to DEAD_ZONE..(1-DEAD_ZONE) canvas
        return (DEAD_ZONE + fraction * (1 - 2 * DEAD_ZONE)) * canvasWidth;
    }

    /**
     * Draw one waveform's shape. `centerY` is the vertical center in pixels
     * (halfH for the primary buffer; an independent per-track position in
     * fixed-scale/comp mode). `ampScale` is the pixel amplitude for a peak
     * of 1.0 -- defaults to `centerY` (the original center-to-edge behavior)
     * when not given, which is what the primary buffer call site relies on;
     * extra tracks pass a small fixed value so they read as compact shapes
     * rather than stretching to the canvas edges regardless of where they're
     * vertically placed. `trackOffset` shifts this track's own sample indices
     * into the shared timeline (0 for the primary buffer); `gain` scales
     * amplitude for tracks other than the primary.
     */
    _drawWaveform(ctx, w, h, centerY, startSample, visibleSamples, data, total, trackOffset, color, gain, ampScale) {
        const useDeadZone = !this._fixedPxPerSample;
        const drawLeft = useDeadZone ? Math.floor(DEAD_ZONE * w) : 0;
        const drawRight = useDeadZone ? Math.ceil((1 - DEAD_ZONE) * w) : w;
        const drawWidth = drawRight - drawLeft;
        if (drawWidth <= 0) return;
        const samplesPerPx = visibleSamples / drawWidth;
        const g = gain != null ? gain : 1;
        const scale = ampScale != null ? ampScale : centerY;

        ctx.fillStyle = color || COLORS.waveform;
        ctx.beginPath();

        // Top edge (max peaks left to right)
        for (let px = 0; px < drawWidth; px++) {
            const i0 = Math.max(0, Math.min(Math.floor(startSample + px * samplesPerPx - trackOffset), total - 1));
            const i1 = Math.max(0, Math.min(Math.floor(startSample + (px + 1) * samplesPerPx - trackOffset), total));
            let max = 0;
            for (let i = i0; i < i1; i++) {
                const v = data[i];
                if (v > max) max = v;
            }
            const y = centerY - max * g * scale;
            if (px === 0) ctx.moveTo(drawLeft + px, y);
            else ctx.lineTo(drawLeft + px, y);
        }

        // Bottom edge (min peaks right to left)
        for (let px = drawWidth - 1; px >= 0; px--) {
            const i0 = Math.max(0, Math.min(Math.floor(startSample + px * samplesPerPx - trackOffset), total - 1));
            const i1 = Math.max(0, Math.min(Math.floor(startSample + (px + 1) * samplesPerPx - trackOffset), total));
            let min = 0;
            for (let i = i0; i < i1; i++) {
                const v = data[i];
                if (v < min) min = v;
            }
            const y = centerY - min * g * scale;
            ctx.lineTo(drawLeft + px, y);
        }

        ctx.closePath();
        ctx.fill();
    }

    /**
     * Stroke a pitch contour over a track's [x0,x1] time span and
     * [centerY-bandHeight/2, centerY+bandHeight/2] band. `points` is an
     * array of {xFrac, rowFrac} (both 0-1 within the track's own span;
     * rowFrac null = unvoiced) -- breaks into separate subpaths at each
     * unvoiced gap rather than drawing a straight line across it.
     */
    _drawPitchTrace(ctx, points, x0, x1, centerY, bandHeight) {
        if (!points || points.length === 0) return;
        const top = centerY - bandHeight / 2;

        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let drawing = false;
        for (const p of points) {
            const x = x0 + p.xFrac * (x1 - x0);
            if (p.rowFrac == null) {
                drawing = false;
                continue;
            }
            const y = top + p.rowFrac * bandHeight;
            if (!drawing) {
                ctx.moveTo(x, y);
                drawing = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Bottom-edge time gradations -- ticks + labels superimposed directly on the
     * waveform canvas rather than a separate non-overlapping strip (per Ed's ask:
     * don't spend extra screen space on this). Uses the same _sampleToX() mapping
     * as everything else here, so it tracks zoom/scroll/dead-zone exactly like the
     * selection/loop/cursor overlays do -- no separate coordinate system to drift
     * out of sync with the actual waveform.
     */
    _drawTimeRuler(ctx, w, h, startSample, visibleSamples) {
        if (!this._sampleRate || this._sampleRate <= 0 || visibleSamples <= 0) return;
        const totalSecondsVisible = visibleSamples / this._sampleRate;
        if (totalSecondsVisible <= 0) return;
        const targetTicks = Math.max(2, Math.floor(w / 70)); // ~70px between labels
        const intervalSec = WaveformRenderer._niceTickInterval(totalSecondsVisible / targetTicks);
        const startSec = startSample / this._sampleRate;
        const firstTickSec = Math.ceil(startSec / intervalSec) * intervalSec;
        const endSec = startSec + totalSecondsVisible;

        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 1;
        for (let t = firstTickSec; t <= endSec + 1e-9; t += intervalSec) {
            const x = this._sampleToX(t * this._sampleRate, startSample, visibleSamples, w);
            if (x < 0 || x > w) continue;
            ctx.beginPath();
            ctx.moveTo(x, h);
            ctx.lineTo(x, h - 6);
            ctx.stroke();
            const label = intervalSec < 1 ? `${Math.round(t * 1000)}ms` : `${Math.round(t)}s`;
            ctx.fillText(label, Math.min(x + 2, w - 34), h - 2);
        }
        ctx.restore();
    }

    /**
     * Same bottom-edge tick style as _drawTimeRuler() above, but for a canvas
     * addressed linearly (0..totalSeconds across the full width, no dead-zone/
     * zoom/scroll mapping) -- used by the live device-recording view, which
     * paints straight onto the main canvas via drawMiniFromPeaks() rather than
     * through this instance's own render() pipeline (see _updateDeviceMeter() in
     * app.js). Static since there's no WaveformRenderer instance involved there.
     */
    static drawTimeRulerLinear(ctx, w, h, totalSeconds) {
        if (!totalSeconds || totalSeconds <= 0 || w <= 0) return;
        const targetTicks = Math.max(2, Math.floor(w / 70));
        const intervalSec = WaveformRenderer._niceTickInterval(totalSeconds / targetTicks);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 1;
        for (let t = 0; t <= totalSeconds + 1e-9; t += intervalSec) {
            const x = (t / totalSeconds) * w;
            ctx.beginPath();
            ctx.moveTo(x, h);
            ctx.lineTo(x, h - 6);
            ctx.stroke();
            const label = intervalSec < 1 ? `${Math.round(t * 1000)}ms` : `${Math.round(t)}s`;
            ctx.fillText(label, Math.min(x + 2, w - 34), h - 2);
        }
        ctx.restore();
    }

    /** Rounds a rough tick interval (seconds) to a "nice" 1/2/5 x 10^n step. */
    static _niceTickInterval(roughInterval) {
        if (!roughInterval || roughInterval <= 0) return 1;
        const exponent = Math.floor(Math.log10(roughInterval));
        const fraction = roughInterval / Math.pow(10, exponent);
        let niceFraction;
        if (fraction <= 1) niceFraction = 1;
        else if (fraction <= 2) niceFraction = 2;
        else if (fraction <= 5) niceFraction = 5;
        else niceFraction = 10;
        return niceFraction * Math.pow(10, exponent);
    }

    /** Draw selection overlay and edge lines. */
    _drawSelection(ctx, w, h, startSample, visibleSamples) {
        const x0 = this._sampleToX(this._selStart, startSample, visibleSamples, w);
        const x1 = this._sampleToX(this._selEnd, startSample, visibleSamples, w);
        const left = Math.max(0, Math.min(x0, x1));
        const right = Math.min(w, Math.max(x0, x1));

        if (right < 0 || left > w) return;

        // Dim unselected regions
        ctx.fillStyle = COLORS.selectionDim;
        if (left > 0) ctx.fillRect(0, 0, left, h);
        if (right < w) ctx.fillRect(right, 0, w - right, h);

        // Light tint on selected region
        ctx.fillStyle = COLORS.selectionFill;
        ctx.fillRect(left, 0, right - left, h);

        // Edge lines
        ctx.strokeStyle = COLORS.selectionEdge;
        ctx.lineWidth = 1;
        if (left >= 0 && left <= w) {
            ctx.beginPath();
            ctx.moveTo(left, 0);
            ctx.lineTo(left, h);
            ctx.stroke();
        }
        if (right >= 0 && right <= w) {
            ctx.beginPath();
            ctx.moveTo(right, 0);
            ctx.lineTo(right, h);
            ctx.stroke();
        }

        // Drag handles (triangles at bottom)
        const startActive = this._draggingSelMarker === 'start';
        const endActive   = this._draggingSelMarker === 'end';
        if (left >= 0 && left <= w) {
            ctx.fillStyle = startActive ? 'rgba(14,165,233,1)' : 'rgba(14,165,233,0.75)';
            ctx.beginPath();
            ctx.moveTo(left, h);
            ctx.lineTo(left + 10, h - 8);
            ctx.lineTo(left, h - 16);
            ctx.closePath();
            ctx.fill();
        }
        if (right >= 0 && right <= w) {
            ctx.fillStyle = endActive ? 'rgba(14,165,233,1)' : 'rgba(14,165,233,0.75)';
            ctx.beginPath();
            ctx.moveTo(right, h);
            ctx.lineTo(right - 10, h - 8);
            ctx.lineTo(right, h - 16);
            ctx.closePath();
            ctx.fill();
        }
    }

    /** Draw loop marker overlay: green fill + edge lines + triangular handles. */
    _drawLoopMarkers(ctx, w, h, startSample, visibleSamples) {
        const x0 = this._sampleToX(this._loopStart, startSample, visibleSamples, w);
        const x1 = this._sampleToX(this._loopEnd, startSample, visibleSamples, w);
        const left = Math.max(0, Math.min(x0, x1));
        const right = Math.min(w, Math.max(x0, x1));

        if (right < 0 || left > w) return;

        // Filled overlay
        ctx.fillStyle = COLORS.loopFill;
        ctx.fillRect(left, 0, right - left, h);

        // Edge lines
        const startActive = this._draggingLoopMarker === 'start';
        const endActive = this._draggingLoopMarker === 'end';

        // Start edge
        if (left >= 0 && left <= w) {
            ctx.strokeStyle = startActive ? COLORS.loopEdgeActive : COLORS.loopEdge;
            ctx.lineWidth = startActive ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(left, 0);
            ctx.lineTo(left, h);
            ctx.stroke();

            // Right-pointing triangle handle at top
            ctx.fillStyle = startActive ? COLORS.loopEdgeActive : COLORS.loopEdge;
            ctx.beginPath();
            ctx.moveTo(left, 0);
            ctx.lineTo(left + 8, 6);
            ctx.lineTo(left, 12);
            ctx.closePath();
            ctx.fill();
        }

        // End edge
        if (right >= 0 && right <= w) {
            ctx.strokeStyle = endActive ? COLORS.loopEdgeActive : COLORS.loopEdge;
            ctx.lineWidth = endActive ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(right, 0);
            ctx.lineTo(right, h);
            ctx.stroke();

            // Left-pointing triangle handle at top
            ctx.fillStyle = endActive ? COLORS.loopEdgeActive : COLORS.loopEdge;
            ctx.beginPath();
            ctx.moveTo(right, 0);
            ctx.lineTo(right - 8, 6);
            ctx.lineTo(right, 12);
            ctx.closePath();
            ctx.fill();
        }
    }

    // --------------------------------------------------------- event binding

    _bindEvents() {
        const c = this._canvas;

        // --- Mouse events ---
        c.addEventListener('mousedown', (e) => this._pointerDown(e.clientX));
        c.addEventListener('mousemove', (e) => {
            if (this._dragging || this._draggingLoopMarker || this._draggingSelMarker) {
                this._pointerMove(e.clientX);
            } else {
                c.style.cursor = this._selHandleAtX(e.clientX) ? 'ew-resize' : '';
            }
        });
        c.addEventListener('mouseup', (e) => this._pointerUp(e.clientX));
        // Handle mouse leaving the canvas while dragging
        c.addEventListener('mouseleave', (e) => {
            c.style.cursor = '';
            if (this._dragging || this._draggingLoopMarker || this._draggingSelMarker) this._pointerUp(e.clientX);
        });

        // --- Touch events (single-touch selection + two-finger pinch zoom) ---
        c.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (e.touches.length === 2) {
                // Start pinch — cancel any drag in progress
                this._dragging = false;
                this._pinching = true;
                this._pinchStartDist = this._touchDist(e.touches);
                this._pinchStartZoom = this._zoom;
                const mid = this._touchMid(e.touches);
                this._pinchMidFraction = (mid - c.getBoundingClientRect().left) / c.getBoundingClientRect().width;
                this._pinchMidSample = this.sampleAtX(mid);
                this._pinchStartMidX = mid;
                this._pinchStartScrollOffset = this._scrollOffset;
            } else if (e.touches.length === 1 && !this._pinching) {
                this._pointerDown(e.touches[0].clientX);
            }
        }, { passive: false });

        c.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 2 && this._pinching) {
                const dist = this._touchDist(e.touches);
                const scale = dist / this._pinchStartDist;
                this._zoom = Math.max(1, Math.min(MAX_ZOOM, this._pinchStartZoom * scale));
                // Keep the pinch midpoint anchored (zoom)
                const newVisible = this.getVisibleSamples();
                const rect = c.getBoundingClientRect();
                this._scrollOffset = this._pinchMidSample - this._pinchMidFraction * newVisible;
                // Pan: add delta from midpoint drag
                const currentMidX = this._touchMid(e.touches);
                const midDeltaPx = currentMidX - this._pinchStartMidX;
                const samplesPerPx = newVisible / rect.width;
                this._scrollOffset -= midDeltaPx * samplesPerPx;
                this._clampScroll();
                this.render();
            } else if (e.touches.length === 1 && (this._dragging || this._draggingLoopMarker) && !this._pinching) {
                this._pointerMove(e.touches[0].clientX);
            }
        }, { passive: false });

        c.addEventListener('touchend', (e) => {
            e.preventDefault();
            if (this._pinching) {
                if (e.touches.length < 2) {
                    this._pinching = false;
                }
            } else {
                this._pointerUp(e.changedTouches[0].clientX);
            }
        }, { passive: false });

        // --- Wheel zoom ---
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!this._mono || this._totalSamples === 0) return;

            const sampleUnderMouse = this.sampleAtX(e.clientX);
            const rect = c.getBoundingClientRect();
            const fraction = (e.clientX - rect.left) / rect.width;

            if (e.deltaY > 0) {
                // Zoom out
                this._zoom = Math.max(1, this._zoom / ZOOM_FACTOR);
            } else {
                // Zoom in
                this._zoom = Math.min(MAX_ZOOM, this._zoom * ZOOM_FACTOR);
            }

            // Keep the sample under the mouse at the same screen position
            const newVisible = this.getVisibleSamples();
            this._scrollOffset = sampleUnderMouse - fraction * newVisible;
            this._clampScroll();
            this.render();
        }, { passive: false });
    }

    /** Distance between two touch points. */
    _touchDist(touches) {
        const dx = touches[1].clientX - touches[0].clientX;
        const dy = touches[1].clientY - touches[0].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** Returns true if clientX is within 20px of a selection edge handle. */
    _selHandleAtX(clientX) {
        if (this._selStart < 0 || this._selEnd < 0) return false;
        const rect = this._canvas.getBoundingClientRect();
        const xS = this._sampleToX(this._selStart, this._scrollOffset, this.getVisibleSamples(), this._width);
        const xE = this._sampleToX(this._selEnd,   this._scrollOffset, this.getVisibleSamples(), this._width);
        const px = clientX - rect.left;
        return Math.abs(px - xS) <= 20 || Math.abs(px - xE) <= 20;
    }

    /** Midpoint clientX between two touch points. */
    _touchMid(touches) {
        return (touches[0].clientX + touches[1].clientX) / 2;
    }

    _pointerDown(clientX) {
        if (this.chromaticMode) return;
        if (!this._mono || this._totalSamples === 0) return;

        const now = Date.now();

        // Loop marker hit-test (if visible)
        if (this._loopVisible && this._loopStart >= 0 && this._loopEnd >= 0) {
            const rect = this._canvas.getBoundingClientRect();
            const w = this._width;
            const startSample = this._scrollOffset;
            const visibleSamples = this.getVisibleSamples();
            const xStart = this._sampleToX(this._loopStart, startSample, visibleSamples, w);
            const xEnd = this._sampleToX(this._loopEnd, startSample, visibleSamples, w);
            const px = clientX - rect.left;

            // Double-click to clear: inside loop region, within 300ms
            if (now - this._lastPointerDownTime < 300) {
                if (px >= xStart && px <= xEnd) {
                    this._lastPointerDownTime = 0;
                    if (this.onLoopClear) this.onLoopClear();
                    return;
                }
            }

            // Hit-test edges (20px tolerance)
            if (Math.abs(px - xStart) <= 20) {
                this._draggingLoopMarker = 'start';
                this._lastPointerDownTime = now;
                this.render();
                return;
            }
            if (Math.abs(px - xEnd) <= 20) {
                this._draggingLoopMarker = 'end';
                this._lastPointerDownTime = now;
                this.render();
                return;
            }
        }

        // Selection handle hit-test
        if (this._selStart >= 0 && this._selEnd >= 0) {
            const rect2 = this._canvas.getBoundingClientRect();
            const xS = this._sampleToX(this._selStart, this._scrollOffset, this.getVisibleSamples(), this._width);
            const xE = this._sampleToX(this._selEnd,   this._scrollOffset, this.getVisibleSamples(), this._width);
            const px2 = clientX - rect2.left;
            if (Math.abs(px2 - xS) <= 20) {
                this._draggingSelMarker = 'start';
                this.render();
                return;
            }
            if (Math.abs(px2 - xE) <= 20) {
                this._draggingSelMarker = 'end';
                this.render();
                return;
            }
        }

        this._lastPointerDownTime = now;
        this._dragging = true;
        this._dragStartX = clientX;
        this._dragStartSample = this.sampleAtX(clientX);
    }

    _pointerMove(clientX) {
        if (this.chromaticMode) return;

        // Selection handle dragging
        if (this._draggingSelMarker) {
            const sample = Math.max(0, Math.min(this.sampleAtX(clientX), this._totalSamples));
            if (this._draggingSelMarker === 'start') {
                this._selStart = Math.min(sample, this._selEnd - 1);
            } else {
                this._selEnd = Math.max(sample, this._selStart + 1);
            }
            this.render();
            if (this.onSelectionChange) this.onSelectionChange({ start: this._selStart, end: this._selEnd });
            return;
        }

        // Loop marker dragging
        if (this._draggingLoopMarker) {
            const sample = Math.max(0, Math.min(this.sampleAtX(clientX), this._totalSamples));
            if (this._draggingLoopMarker === 'start') {
                this._loopStart = Math.min(sample, this._loopEnd - 1);
            } else {
                this._loopEnd = Math.max(sample, this._loopStart + 1);
            }
            this.render();
            if (this.onLoopChange) {
                this.onLoopChange({ start: this._loopStart, end: this._loopEnd });
            }
            return;
        }

        if (!this._dragging) return;
        const currentSample = this.sampleAtX(clientX);

        const s = Math.max(0, Math.min(this._dragStartSample, currentSample));
        const e = Math.min(this._totalSamples, Math.max(this._dragStartSample, currentSample));
        this._selStart = s;
        this._selEnd = e;
        this.render();
    }

    _pointerUp(clientX) {
        if (this.chromaticMode) return;

        // Finalize selection handle drag
        if (this._draggingSelMarker) {
            const sample = Math.max(0, Math.min(this.sampleAtX(clientX), this._totalSamples));
            if (this._draggingSelMarker === 'start') {
                this._selStart = Math.min(sample, this._selEnd - 1);
            } else {
                this._selEnd = Math.max(sample, this._selStart + 1);
            }
            this._draggingSelMarker = null;
            this.render();
            if (this.onSelectionChange) this.onSelectionChange({ start: this._selStart, end: this._selEnd });
            return;
        }

        // Finalize loop marker drag
        if (this._draggingLoopMarker) {
            const sample = Math.max(0, Math.min(this.sampleAtX(clientX), this._totalSamples));
            if (this._draggingLoopMarker === 'start') {
                this._loopStart = Math.min(sample, this._loopEnd - 1);
            } else {
                this._loopEnd = Math.max(sample, this._loopStart + 1);
            }
            this._draggingLoopMarker = null;
            this.render();
            if (this.onLoopChange) {
                this.onLoopChange({ start: this._loopStart, end: this._loopEnd });
            }
            return;
        }

        if (!this._dragging) return;
        this._dragging = false;

        const dx = Math.abs(clientX - this._dragStartX);

        if (dx < MIN_DRAG_PX) {
            // Treat as click — set cursor
            this._selStart = -1;
            this._selEnd = -1;
            const sample = this.sampleAtX(clientX);
            this._cursorSample = Math.max(0, Math.min(sample, this._totalSamples));
            this.render();
            if (this.onCursorSet) {
                this.onCursorSet(this._cursorSample);
            }
        } else {
            // Finalize selection
            const currentSample = this.sampleAtX(clientX);
            const s = Math.max(0, Math.min(this._dragStartSample, currentSample));
            const e = Math.min(this._totalSamples, Math.max(this._dragStartSample, currentSample));
            this._selStart = s;
            this._selEnd = e;
            this.render();
            if (this.onSelectionChange) {
                this.onSelectionChange({ start: this._selStart, end: this._selEnd });
            }
        }
    }
}
