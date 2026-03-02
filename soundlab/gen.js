/**
 * Gen — Video/Camera-driven generative modulation engine for Soniphorm Soundlab.
 * Extracts visual metrics (brightness, hue, contrast, motion) from video regions
 * and maps them to sampler pad parameters in real time.
 */
class Gen {
    constructor() {
        this.source = 'file';       // 'file' | 'camera'
        this.running = false;
        this.enabled = false;       // master on/off
        this.videoEl = null;        // set by app.js
        this.cameraStream = null;
        this.sensors = [];
        this.analysisRate = 15;     // fps
        this._nextSensorId = 1;

        // Offscreen analysis canvas (never displayed)
        this._analysisCanvas = document.createElement('canvas');
        this._analysisCtx = this._analysisCanvas.getContext('2d', { willReadFrequently: true });
        this._prevFrameData = {};   // sensorId → Uint8ClampedArray (for motion)
        this._animFrame = null;
        this._lastAnalysisTime = 0;

        // Callbacks (set by app.js)
        this.onSensorUpdate = null;     // (sensorIndex, value) => void
        this.applyModulation = null;    // (padIndex, paramName, value) => void
    }

    // --- Video source ---

    loadVideoFile(file) {
        if (!this.videoEl) return;
        this.stopCamera();
        const url = URL.createObjectURL(file);
        this.videoEl.srcObject = null;
        this.videoEl.src = url;
        this.videoEl.onloadedmetadata = () => {
            this._sizeAnalysisCanvas();
        };
    }

    async startCamera(deviceId) {
        if (!this.videoEl) return;
        try {
            const constraints = deviceId
                ? { video: { deviceId: { exact: deviceId } } }
                : { video: { facingMode: 'environment' } };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.cameraStream = stream;
            this.videoEl.src = '';
            this.videoEl.srcObject = stream;
            this.videoEl.play();
            this.videoEl.onloadedmetadata = () => {
                this._sizeAnalysisCanvas();
            };
        } catch (e) {
            console.error('Camera access denied:', e);
            throw e;
        }
    }

    stopCamera() {
        if (this.cameraStream) {
            this.cameraStream.getTracks().forEach(t => t.stop());
            this.cameraStream = null;
        }
        if (this.videoEl) {
            this.videoEl.srcObject = null;
        }
    }

    _sizeAnalysisCanvas() {
        if (!this.videoEl) return;
        const vw = this.videoEl.videoWidth || 320;
        const vh = this.videoEl.videoHeight || 240;
        // Scale down for performance (max 320x240)
        const scale = Math.min(1, 320 / vw, 240 / vh);
        this._analysisCanvas.width = Math.round(vw * scale);
        this._analysisCanvas.height = Math.round(vh * scale);
    }

    // --- Analysis loop ---

    start() {
        if (this.running) return;
        this.running = true;
        this._lastAnalysisTime = 0;
        this._loop(performance.now());
    }

    stop() {
        this.running = false;
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
            this._animFrame = null;
        }
    }

    _loop(ts) {
        if (!this.running) return;
        this._animFrame = requestAnimationFrame((t) => this._loop(t));

        const interval = 1000 / this.analysisRate;
        if (ts - this._lastAnalysisTime < interval) return;
        this._lastAnalysisTime = ts;

        if (!this.videoEl || this.videoEl.readyState < 2) return;

        // Draw current frame to analysis canvas
        const ctx = this._analysisCtx;
        const cw = this._analysisCanvas.width;
        const ch = this._analysisCanvas.height;
        ctx.drawImage(this.videoEl, 0, 0, cw, ch);

        // Analyze each enabled sensor
        for (let i = 0; i < this.sensors.length; i++) {
            const sensor = this.sensors[i];
            if (!sensor.enabled) continue;

            const value = this._analyzeSensor(sensor, cw, ch);
            sensor._lastValue = value;

            if (this.onSensorUpdate) {
                this.onSensorUpdate(i, value);
            }

            if (this.enabled && this.applyModulation) {
                let processed = value;
                const thresh = sensor.threshold || 0;
                if (thresh > 0) {
                    if (sensor.targetParam === 'trigger') {
                        // Threshold is the direct activation point
                        const hysteresis = Math.max(0.02, thresh * 0.15);
                        if (value > thresh) processed = 1;
                        else if (value < thresh - hysteresis) processed = 0;
                        else processed = sensor._triggerActive ? 1 : 0;
                        sensor._triggerActive = processed > 0.5;
                    } else {
                        // Floor: values below threshold → 0, above → rescaled to 0-1
                        processed = value <= thresh ? 0 : (value - thresh) / (1 - thresh);
                    }
                }
                const scaled = this._scaleValue(processed, sensor.targetParam, sensor.scale);
                this.applyModulation(sensor.targetPad, sensor.targetParam, scaled);
            }
        }
    }

    // --- Sensor analysis ---

    _analyzeSensor(sensor, canvasW, canvasH) {
        // Convert normalized coords to pixel coords on analysis canvas
        const px = Math.round(sensor.x * canvasW);
        const py = Math.round(sensor.y * canvasH);
        const pw = Math.max(1, Math.round(sensor.w * canvasW));
        const ph = Math.max(1, Math.round(sensor.h * canvasH));

        // Clamp to canvas bounds
        const sx = Math.max(0, Math.min(px, canvasW - 1));
        const sy = Math.max(0, Math.min(py, canvasH - 1));
        const sw = Math.min(pw, canvasW - sx);
        const sh = Math.min(ph, canvasH - sy);
        if (sw <= 0 || sh <= 0) return 0;

        const imageData = this._analysisCtx.getImageData(sx, sy, sw, sh);
        const data = imageData.data;
        const pixelCount = sw * sh;

        switch (sensor.metric) {
            case 'brightness': return this._metricBrightness(data, pixelCount);
            case 'hue':        return this._metricHue(data, pixelCount);
            case 'contrast':   return this._metricContrast(data, pixelCount);
            case 'saturation': return this._metricSaturation(data, pixelCount);
            case 'motion':     return this._metricMotion(data, pixelCount, sensor.id);
            default:           return 0;
        }
    }

    _metricBrightness(data, pixelCount) {
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
            sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        }
        return sum / pixelCount;
    }

    _metricHue(data, pixelCount) {
        let rSum = 0, gSum = 0, bSum = 0;
        for (let i = 0; i < data.length; i += 4) {
            rSum += data[i];
            gSum += data[i + 1];
            bSum += data[i + 2];
        }
        const r = rSum / pixelCount / 255;
        const g = gSum / pixelCount / 255;
        const b = bSum / pixelCount / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        if (d === 0) return 0;
        let h;
        if (max === r)      h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else                h = (r - g) / d + 4;
        h = h / 6;
        if (h < 0) h += 1;
        return h;
    }

    _metricSaturation(data, pixelCount) {
        let satSum = 0;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i] / 255;
            const g = data[i + 1] / 255;
            const b = data[i + 2] / 255;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            satSum += max > 0 ? (max - min) / max : 0;
        }
        return satSum / pixelCount;
    }

    _metricContrast(data, pixelCount) {
        // Std deviation of luminance
        let sum = 0;
        const lums = new Float32Array(pixelCount);
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            const l = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
            lums[j] = l;
            sum += l;
        }
        const mean = sum / pixelCount;
        let variance = 0;
        for (let j = 0; j < pixelCount; j++) {
            const d = lums[j] - mean;
            variance += d * d;
        }
        variance /= pixelCount;
        // Std dev max is 0.5 (black and white checkerboard), clamp to 0-1
        return Math.min(1, Math.sqrt(variance) * 2);
    }

    _metricMotion(data, pixelCount, sensorId) {
        // Compute luminance array
        const lums = new Uint8Array(pixelCount);
        for (let i = 0, j = 0; i < data.length; i += 4, j++) {
            lums[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        }

        const prev = this._prevFrameData[sensorId];
        this._prevFrameData[sensorId] = lums;

        if (!prev || prev.length !== lums.length) return 0;

        let diffSum = 0;
        for (let j = 0; j < pixelCount; j++) {
            diffSum += Math.abs(lums[j] - prev[j]);
        }
        // Normalize: ~25% average pixel change = 1.0
        const avgDiff = diffSum / pixelCount / 255;
        return Math.min(1, avgDiff / 0.25);
    }

    // --- Value scaling ---

    _scaleValue(normalized, paramName, scale) {
        const range = Gen.PARAM_RANGES[paramName];
        if (!range) return normalized;

        const lo = range.min + (range.max - range.min) * scale.min;
        const hi = range.min + (range.max - range.min) * scale.max;

        if (paramName === 'filterFreq') {
            // Log scale for frequency
            const logLo = Math.log(Math.max(20, lo));
            const logHi = Math.log(Math.max(21, hi));
            return Math.exp(logLo + normalized * (logHi - logLo));
        }
        return lo + normalized * (hi - lo);
    }

    // --- Sensor CRUD ---

    addSensor(props) {
        const sensor = {
            id: this._nextSensorId++,
            x: 0.1,
            y: 0.1,
            w: 0.3,
            h: 0.3,
            metric: 'brightness',
            targetPad: 0,
            targetParam: 'volume',
            scale: { min: 0, max: 1 },
            threshold: 0,
            enabled: true,
            _lastValue: 0,
            ...props
        };
        this.sensors.push(sensor);
        return sensor;
    }

    removeSensor(id) {
        this.sensors = this.sensors.filter(s => s.id !== id);
        delete this._prevFrameData[id];
    }

    updateSensor(id, props) {
        const sensor = this.sensors.find(s => s.id === id);
        if (sensor) Object.assign(sensor, props);
    }

    // --- Persistence ---

    toJSON() {
        return {
            source: this.source,
            analysisRate: this.analysisRate,
            enabled: this.enabled,
            sensors: this.sensors.map(s => ({
                id: s.id,
                x: s.x, y: s.y, w: s.w, h: s.h,
                metric: s.metric,
                targetPad: s.targetPad,
                targetParam: s.targetParam,
                scale: { ...s.scale },
                threshold: s.threshold || 0,
                enabled: s.enabled
            }))
        };
    }

    fromJSON(data) {
        if (!data) return;
        this.source = data.source || 'file';
        this.analysisRate = data.analysisRate || 15;
        this.enabled = data.enabled || false;
        this.sensors = [];
        this._prevFrameData = {};
        let maxId = 0;
        if (data.sensors) {
            for (const s of data.sensors) {
                this.sensors.push({
                    id: s.id,
                    x: s.x, y: s.y, w: s.w, h: s.h,
                    metric: s.metric,
                    targetPad: s.targetPad,
                    targetParam: s.targetParam,
                    scale: { ...s.scale },
                    threshold: s.threshold || 0,
                    enabled: s.enabled,
                    _lastValue: 0
                });
                if (s.id >= maxId) maxId = s.id;
            }
        }
        this._nextSensorId = maxId + 1;
    }

    // --- Static ---

    static PARAM_RANGES = {
        trigger:    { min: 0,    max: 1 },
        volume:     { min: 0,    max: 1 },
        pitch:      { min: -24,  max: 24 },
        speed:      { min: 0.1,  max: 4 },
        position:   { min: 0,    max: 1 },
        loopSize:   { min: 0.005, max: 1 },
        filterFreq: { min: 20,   max: 20000 },
        filterQ:    { min: 0.1,  max: 20 },
        lfoRate:    { min: 0.1,  max: 20 },
        lfoDepth:   { min: 0,    max: 1 },
        videoPosition: { min: 0, max: 1 },
        videoLoopSize: { min: 0, max: 1 }
    };

    static SENSOR_COLORS = [
        '#ef4444', '#22c55e', '#3b82f6', '#eab308',
        '#a855f7', '#f97316', '#06b6d4', '#ec4899'
    ];
}
