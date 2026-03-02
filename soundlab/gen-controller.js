// GenController — owns all Gen mode UI logic
// Receives a reference to the App instance for shared state access

class GenController {
    constructor(app) {
        this.app = app;

        // Gen-specific state
        this._genSelectedPad = 0;
        this._genDragging = false;
        this._genDragSensorId = null;
        this._genDragType = null;
        this._genDragStart = null;
        this._genZoom = 1;
        this._genPanX = 0;
        this._genPanY = 0;
        this._genTriggerState = {};

        // Video loop state
        this._genLoopEnabled = false;
        this._genLoopIn = 0;
        this._genLoopOut = 0;   // 0 = not set (means end of video)
        this._genTimeRAF = null;
        this._genTimeLastUpdate = 0;

        // Camera recording state
        this._genRecorder = null;
        this._genRecChunks = [];
        this._genRecording = false;
        this._genRecStartTime = 0;
        this._genRecAutoLoad = false;
    }

    // Called by app.switchMode() when entering gen mode
    async enter() {
        this.app._genMode = true;
        if (this.app.audio.audioContext) {
            this.app.sampler.audioContext = this.app.audio.audioContext;
            this.app.sampler.outputNode = this.app.audio.getEffectsBus();
        }
        await this.app.seq._seqPreloadBuffers();
        // Hide waveform, show video area
        document.getElementById('waveform').style.display = 'none';
        document.getElementById('waveform-empty').hidden = true;
        document.getElementById('gen-video-wrap').hidden = false;
        // Build pad grid
        this.app.buildSlotGrid();
        this._genRenderGrid();
        this._genUpdatePadPanel();
        // Sync UI state
        document.getElementById('gen-toggle-btn').textContent = this.app.gen.enabled ? 'ON' : 'OFF';
        document.getElementById('gen-toggle-btn').classList.toggle('gen-active', this.app.gen.enabled);
        // Resize overlay after layout settles
        requestAnimationFrame(() => this._genResizeOverlay());
        // Resume video playback if it was playing when we left
        if (this._genWasPlaying) {
            this._genWasPlaying = false;
            const video = this.app.gen.videoEl;
            if (video && video.src && this.app.gen.source === 'file') {
                video.play();
                this.app.gen.start();
                document.getElementById('gen-play-btn').textContent = '\u275A\u275A';
                this._genStartTimeDisplay();
            }
        }
    }

    // Called by app.switchMode() when leaving gen mode
    exit() {
        if (this._genRecording) this._genStopRec(false);
        // Remember if video was playing so we can resume on re-enter
        const video = this.app.gen.videoEl;
        this._genWasPlaying = video && !video.paused && this.app.gen.source === 'file';
        this.app.gen.stop();
        this._genStopTimeDisplay();
        this.app._genMode = false;
        this._genTriggerState = {};
        this._genZoom = 1; this._genPanX = 0; this._genPanY = 0;
        this._genApplyZoom();
        document.getElementById('gen-video-wrap').hidden = true;
        document.getElementById('waveform').style.display = '';
        if (this.app.channels) {
            document.getElementById('waveform-empty').hidden = true;
        } else {
            document.getElementById('waveform-empty').hidden = false;
        }
    }

    _initGen() {
        this.app.gen = new Gen();
        this.app.gen.videoEl = document.getElementById('gen-video');

        // Wire modulation callback
        this.app.gen.applyModulation = (padIndex, paramName, value) => {
            // Video modulation targets — don't need a pad
            if (paramName === 'videoPosition') {
                const video = this.app.gen.videoEl;
                if (!video || !video.duration) return;
                const lo = Math.min(this._genLoopIn, this._genLoopOut);
                const hi = Math.max(this._genLoopIn, this._genLoopOut);
                const size = hi - lo || video.duration * 0.1;
                const maxStart = Math.max(0, video.duration - size);
                const newIn = value * maxStart;
                this._genLoopIn = newIn;
                this._genLoopOut = newIn + size;
                this._genSyncSlidersFromState();
                return;
            }
            if (paramName === 'videoLoopSize') {
                const video = this.app.gen.videoEl;
                if (!video || !video.duration) return;
                const newSize = Math.max(0.05, value * video.duration);
                const lo = Math.min(this._genLoopIn, this._genLoopOut);
                this._genLoopIn = lo;
                this._genLoopOut = Math.min(lo + newSize, video.duration);
                this._genSyncSlidersFromState();
                return;
            }

            const pad = this.app.sampler.pads[padIndex];
            if (!pad) return;

            switch (paramName) {
                case 'trigger': {
                    const wasOn = !!this._genTriggerState[padIndex];
                    if (!wasOn && value > 0.5) {
                        this._genTriggerState[padIndex] = true;
                        if (this.app.slots.slots[padIndex].hasAudio) {
                            this.app.sampler.trigger(padIndex);
                        }
                    } else if (wasOn && value < 0.3) {
                        this._genTriggerState[padIndex] = false;
                        this.app.sampler.release(padIndex);
                    }
                    return;
                }
                case 'volume':
                    pad.volume = value;
                    if (this.app.sampler._voices[padIndex]) {
                        this.app.sampler._voices[padIndex].volumeGain.gain.setTargetAtTime(
                            value, this.app.sampler.audioContext.currentTime, 0.02
                        );
                    }
                    break;
                case 'pitch':
                    pad.pitchSemitones = value;
                    if (this.app.sampler._voices[padIndex]) {
                        this.app.sampler._voices[padIndex].source.playbackRate.setTargetAtTime(
                            Math.pow(2, value / 12), this.app.sampler.audioContext.currentTime, 0.02
                        );
                    }
                    break;
                case 'speed': {
                    const voice = this.app.sampler._voices[padIndex];
                    if (voice) {
                        voice.source.playbackRate.setTargetAtTime(
                            value, this.app.sampler.audioContext.currentTime, 0.02
                        );
                    }
                    break;
                }
                case 'position': {
                    const voice = this.app.sampler._voices[padIndex];
                    if (voice && voice.source.loop && voice.source.buffer) {
                        const buf = voice.source.buffer;
                        const loopLen = voice.source.loopEnd - voice.source.loopStart;
                        const windowSize = loopLen > 0 ? loopLen : buf.duration * 0.1;
                        const maxStart = Math.max(0, buf.duration - windowSize);
                        const newStart = value * maxStart;
                        voice.source.loopStart = newStart;
                        voice.source.loopEnd = newStart + windowSize;
                    }
                    break;
                }
                case 'loopSize': {
                    const voice = this.app.sampler._voices[padIndex];
                    if (voice && voice.source.loop && voice.source.buffer) {
                        const buf = voice.source.buffer;
                        const windowSize = value * buf.duration;
                        const curStart = voice.source.loopStart || 0;
                        const maxStart = Math.max(0, buf.duration - windowSize);
                        const clampedStart = Math.min(curStart, maxStart);
                        voice.source.loopStart = clampedStart;
                        voice.source.loopEnd = clampedStart + windowSize;
                    }
                    break;
                }
                case 'filterFreq':
                    pad.filterEnabled = true;
                    pad.filterFreq = value;
                    if (this.app.sampler._voices[padIndex] && this.app.sampler._voices[padIndex].filter) {
                        this.app.sampler._voices[padIndex].filter.frequency.setTargetAtTime(
                            value, this.app.sampler.audioContext.currentTime, 0.02
                        );
                    }
                    break;
                case 'filterQ':
                    pad.filterQ = value;
                    if (this.app.sampler._voices[padIndex] && this.app.sampler._voices[padIndex].filter) {
                        this.app.sampler._voices[padIndex].filter.Q.setTargetAtTime(
                            value, this.app.sampler.audioContext.currentTime, 0.02
                        );
                    }
                    break;
                case 'lfoRate':
                    pad.lfoRate = value;
                    if (this.app.sampler._voices[padIndex] && this.app.sampler._voices[padIndex].lfo) {
                        this.app.sampler._voices[padIndex].lfo.frequency.setTargetAtTime(
                            value, this.app.sampler.audioContext.currentTime, 0.02
                        );
                    }
                    break;
                case 'lfoDepth':
                    pad.lfoDepth = value;
                    if (this.app.sampler._voices[padIndex] && this.app.sampler._voices[padIndex].lfoGain) {
                        this.app.sampler._voices[padIndex].lfoGain.gain.setTargetAtTime(
                            value, this.app.sampler.audioContext.currentTime, 0.02
                        );
                    }
                    break;
            }

            // Highlight modulated pad
            if (this.app._genMode) this._genHighlightPad(padIndex);
        };

        // Wire sensor update callback
        this.app.gen.onSensorUpdate = (sensorIndex, value) => {
            this._genUpdateSensorDisplay(sensorIndex, value);
            if (this.app._genMode) this._genDrawOverlay();
        };

        this._loadGenConfig();
    }

    _genSetSource(src) {
        // Stop recording if switching away from camera
        if (this._genRecording && src !== 'camera') this._genStopRec(false);

        this.app.gen.source = src;
        document.getElementById('gen-source-file').classList.toggle('active', src === 'file');
        document.getElementById('gen-source-cam').classList.toggle('active', src === 'camera');
        document.getElementById('gen-load-btn').style.display = src === 'file' ? '' : 'none';
        // Camera controls only in camera mode
        document.getElementById('gen-rec-btn').style.display = src === 'camera' ? '' : 'none';
        document.getElementById('gen-cam-select').style.display = src === 'camera' ? '' : 'none';
        // Loop controls only apply to file mode
        const fileOnly = src === 'file' ? '' : 'none';
        document.getElementById('gen-loop-btn').style.display = fileOnly;
        document.getElementById('gen-in-wrap').style.display = fileOnly;
        document.getElementById('gen-out-wrap').style.display = fileOnly;
        document.getElementById('gen-time').style.display = fileOnly;

        if (src === 'camera') {
            this._genEnumCameras().then(() => {
                const sel = document.getElementById('gen-cam-select');
                const deviceId = sel.value || undefined;
                return this.app.gen.startCamera(deviceId);
            }).then(() => {
                this._genResizeOverlay();
            }).catch(() => {
                this._genSetSource('file');
            });
        } else {
            this.app.gen.stopCamera();
        }
        this._saveGenConfig();
    }

    async _genEnumCameras() {
        const sel = document.getElementById('gen-cam-select');
        if (!sel) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameras = devices.filter(d => d.kind === 'videoinput');
            sel.innerHTML = '';
            cameras.forEach((cam, i) => {
                const opt = document.createElement('option');
                opt.value = cam.deviceId;
                opt.textContent = cam.label || `Camera ${i + 1}`;
                sel.appendChild(opt);
            });
        } catch (e) {}
    }

    _genSwitchCamera() {
        if (this.app.gen.source !== 'camera') return;
        const sel = document.getElementById('gen-cam-select');
        if (!sel || !sel.value) return;
        this.app.gen.stopCamera();
        this.app.gen.startCamera(sel.value).then(() => {
            this._genResizeOverlay();
        });
    }

    _genLoadVideo(e) {
        const file = e.target.files[0];
        if (!file) return;
        this._genResetLoop();
        this.app.gen.loadVideoFile(file);
        // After gen.js sets its own onloadedmetadata, wrap it to also sync sliders
        const video = this.app.gen.videoEl;
        const genOnLoaded = video.onloadedmetadata;
        video.onloadedmetadata = () => {
            if (genOnLoaded) genOnLoaded.call(video);
            this._genSyncLoopSliders();
            this._genResizeOverlay();
        };
        e.target.value = '';
    }

    _genTogglePlay() {
        const video = this.app.gen.videoEl;
        if (!video) return;

        if (this.app.gen.source === 'camera') {
            // Camera is always playing, just toggle analysis
            if (this.app.gen.running) {
                this.app.gen.stop();
                document.getElementById('gen-play-btn').textContent = '\u25B6 PLAY';
            } else {
                this.app.gen.start();
                document.getElementById('gen-play-btn').textContent = '\u275A\u275A';
            }
            return;
        }

        if (video.paused) {
            video.play();
            this.app.gen.start();
            document.getElementById('gen-play-btn').textContent = '\u275A\u275A';
            this._genStartTimeDisplay();
        } else {
            video.pause();
            this.app.gen.stop();
            document.getElementById('gen-play-btn').textContent = '\u25B6 PLAY';
            this._genStopTimeDisplay();
        }
    }

    _genStop() {
        this.app.gen.stop();
        this._genStopTimeDisplay();
        const video = this.app.gen.videoEl;
        if (video && this.app.gen.source === 'file') {
            video.pause();
            video.currentTime = this._genLoopEnabled ? Math.min(this._genLoopIn, this._genLoopOut) : 0;
        }
        document.getElementById('gen-play-btn').textContent = '\u25B6 PLAY';
        this._genUpdateTimeText();
    }

    _genToggleMaster() {
        this.app.gen.enabled = !this.app.gen.enabled;
        if (!this.app.gen.enabled) this._genTriggerState = {};
        const btn = document.getElementById('gen-toggle-btn');
        btn.textContent = this.app.gen.enabled ? 'ON' : 'OFF';
        btn.classList.toggle('gen-active', this.app.gen.enabled);
        this._saveGenConfig();
    }

    _genSelectPad(index) {
        this._genSelectedPad = index;
        this._genRenderGrid();
        this._genUpdatePadPanel();
    }

    _genPadTrigger(index) {
        this._genSelectPad(index);
        if (this.app.slots.slots[index].hasAudio) {
            this.app.sampler.trigger(index);
        }
    }

    _genAddMapping() {
        const padIndex = this._genSelectedPad;
        // Count existing mappings for this pad to offset sensor position
        const existing = this.app.gen.sensors.filter(s => s.targetPad === padIndex);
        const off = existing.length;
        this.app.gen.addSensor({
            x: 0.05 + (off % 4) * 0.22,
            y: 0.05 + Math.floor(off / 4) * 0.35,
            w: 0.2,
            h: 0.3,
            targetPad: padIndex
        });
        this._genUpdatePadPanel();
        this._genRenderGrid();
        this._genDrawOverlay();
        this._saveGenConfig();
    }

    _genRemoveMapping(id) {
        this.app.gen.removeSensor(id);
        this._genUpdatePadPanel();
        this._genRenderGrid();
        this._genDrawOverlay();
        this._saveGenConfig();
    }

    _genClearPadMappings() {
        const padIndex = this._genSelectedPad;
        const toRemove = this.app.gen.sensors.filter(s => s.targetPad === padIndex).map(s => s.id);
        toRemove.forEach(id => this.app.gen.removeSensor(id));
        this._genUpdatePadPanel();
        this._genRenderGrid();
        this._genDrawOverlay();
        this._saveGenConfig();
    }

    _genClearAllSensors() {
        // Stop analysis and video
        this.app.gen.stop();
        this.app.gen.stopCamera();
        this._genStopTimeDisplay();
        const video = this.app.gen.videoEl;
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.srcObject = null;
            video.load();
        }
        document.getElementById('gen-play-btn').textContent = '\u25B6 PLAY';
        // Reset loop state
        this._genResetLoop();
        this._genWasPlaying = false;
        // Clear sensors
        this.app.gen.sensors = [];
        this.app.gen._prevFrameData = {};
        this.app.gen._nextSensorId = 1;
        this.app.gen.enabled = false;
        this._genTriggerState = {};
        document.getElementById('gen-toggle-btn').textContent = 'OFF';
        document.getElementById('gen-toggle-btn').classList.remove('gen-active');
        this._genUpdatePadPanel();
        this._genRenderGrid();
        this._genDrawOverlay();
        this._saveGenConfig();
    }

    _genUpdatePadPanel() {
        const padIndex = this._genSelectedPad;
        const slot = this.app.slots.slots[padIndex];
        const padName = slot.hasAudio ? (slot.name || 'untitled') : 'empty';
        const infoEl = document.getElementById('gen-pad-info');
        infoEl.innerHTML = `PAD ${String(padIndex + 1).padStart(2, '0')}: <span class="gen-pad-name">${padName}</span>`;

        // Show + MAP button
        document.getElementById('gen-add-mapping-btn').hidden = false;

        // Render mappings for this pad
        const container = document.getElementById('gen-mappings');
        container.innerHTML = '';

        const padSensors = this.app.gen.sensors.filter(s => s.targetPad === padIndex);

        // Show CLEAR button only when there are mappings for this pad
        document.getElementById('gen-clear-pad-maps-btn').hidden = padSensors.length === 0;

        padSensors.forEach((sensor) => {
            const sensorGlobalIndex = this.app.gen.sensors.indexOf(sensor);
            const color = Gen.SENSOR_COLORS[sensorGlobalIndex % Gen.SENSOR_COLORS.length];
            const row = document.createElement('div');
            row.className = 'gen-mapping-row';

            row.innerHTML = `
                <span class="gen-mapping-swatch" style="background:${color}"></span>
                <select class="gen-mapping-sel" data-field="metric">
                    <option value="brightness" ${sensor.metric === 'brightness' ? 'selected' : ''}>BRT</option>
                    <option value="hue" ${sensor.metric === 'hue' ? 'selected' : ''}>HUE</option>
                    <option value="saturation" ${sensor.metric === 'saturation' ? 'selected' : ''}>SAT</option>
                    <option value="contrast" ${sensor.metric === 'contrast' ? 'selected' : ''}>CTR</option>
                    <option value="motion" ${sensor.metric === 'motion' ? 'selected' : ''}>MOT</option>
                </select>
                <span class="gen-mapping-arrow">&rarr;</span>
                <select class="gen-mapping-sel" data-field="targetParam">
                    <option value="trigger" ${sensor.targetParam === 'trigger' ? 'selected' : ''}>TRIG</option>
                    <option value="volume" ${sensor.targetParam === 'volume' ? 'selected' : ''}>VOL</option>
                    <option value="pitch" ${sensor.targetParam === 'pitch' ? 'selected' : ''}>PIT</option>
                    <option value="speed" ${sensor.targetParam === 'speed' ? 'selected' : ''}>SPEED</option>
                    <option value="position" ${sensor.targetParam === 'position' ? 'selected' : ''}>POS</option>
                    <option value="loopSize" ${sensor.targetParam === 'loopSize' ? 'selected' : ''}>LOOP</option>
                    <option value="filterFreq" ${sensor.targetParam === 'filterFreq' ? 'selected' : ''}>FRQ</option>
                    <option value="filterQ" ${sensor.targetParam === 'filterQ' ? 'selected' : ''}>Q</option>
                    <option value="lfoRate" ${sensor.targetParam === 'lfoRate' ? 'selected' : ''}>LFO-R</option>
                    <option value="lfoDepth" ${sensor.targetParam === 'lfoDepth' ? 'selected' : ''}>LFO-D</option>
                    <option value="videoPosition" ${sensor.targetParam === 'videoPosition' ? 'selected' : ''}>V-POS</option>
                    <option value="videoLoopSize" ${sensor.targetParam === 'videoLoopSize' ? 'selected' : ''}>V-SIZE</option>
                </select>
                <span class="gen-mapping-value" id="gen-sv-${sensor.id}">${sensor._lastValue ? sensor._lastValue.toFixed(2) : '0.00'}</span>
                <label class="gen-thresh-label">TH <input type="range" class="gen-thresh-slider" min="0" max="0.99" step="0.01" value="${sensor.threshold || 0}"></label>
                <button class="gen-mapping-remove tb" title="Remove mapping">&times;</button>
            `;

            // Bind select changes
            row.querySelectorAll('select').forEach(sel => {
                sel.addEventListener('change', () => {
                    const field = sel.dataset.field;
                    this.app.gen.updateSensor(sensor.id, { [field]: sel.value });
                    this._genDrawOverlay();
                    this._saveGenConfig();
                });
            });

            // Threshold slider
            row.querySelector('.gen-thresh-slider').addEventListener('input', (e) => {
                this.app.gen.updateSensor(sensor.id, { threshold: parseFloat(e.target.value) });
                this._saveGenConfig();
            });

            // Remove button
            row.querySelector('.gen-mapping-remove').addEventListener('click', () => {
                this._genRemoveMapping(sensor.id);
            });

            container.appendChild(row);
        });
    }

    _genUpdateSensorDisplay(sensorIndex, value) {
        const sensor = this.app.gen.sensors[sensorIndex];
        if (!sensor) return;
        const el = document.getElementById('gen-sv-' + sensor.id);
        if (el) el.textContent = value.toFixed(2);
    }

    _genRenderGrid() {
        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');

        // Collect which pads are targeted by sensors
        const targeted = new Set();
        this.app.gen.sensors.forEach(s => { if (s.enabled) targeted.add(s.targetPad); });

        slotEls.forEach((el, i) => {
            const slot = this.app.slots.slots[i];
            const numEl = el.querySelector('.slot-number');
            numEl.textContent = String(i + 1).padStart(2, '0');

            const nameEl = el.querySelector('.slot-name');
            nameEl.textContent = slot.hasAudio ? (slot.name || 'untitled') : 'empty';
            nameEl.className = `slot-name ${slot.hasAudio ? '' : 'empty'}`;

            el.className = 'slot';
            el.dataset.bank = slot.bank;
            if (i === this._genSelectedPad) el.classList.add('pad-selected');
            if (targeted.has(i)) el.classList.add('gen-modulated');

            // Keyboard label
            const keyEl = el.querySelector('.slot-key');
            if (keyEl) keyEl.textContent = this.app.sampler.keyLabels[i] || '';
        });
    }

    _genHighlightPad(padIndex) {
        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');
        if (slotEls[padIndex]) {
            slotEls[padIndex].classList.add('gen-modulated');
        }
    }

    _genResizeOverlay() {
        const wrap = document.getElementById('gen-video-wrap');
        const video = document.getElementById('gen-video');
        const overlay = document.getElementById('gen-overlay');
        if (!wrap || !overlay || !video) return;

        overlay.width = wrap.clientWidth;
        overlay.height = wrap.clientHeight;
        this._genDrawOverlay();
    }

    _genDrawOverlay() {
        const overlay = document.getElementById('gen-overlay');
        if (!overlay) return;
        const ctx = overlay.getContext('2d');
        const w = overlay.width;
        const h = overlay.height;
        ctx.clearRect(0, 0, w, h);

        const selectedPad = this._genSelectedPad;

        this.app.gen.sensors.forEach((sensor, i) => {
            const isSelected = sensor.targetPad === selectedPad;
            const color = Gen.SENSOR_COLORS[i % Gen.SENSOR_COLORS.length];
            const sx = sensor.x * w;
            const sy = sensor.y * h;
            const sw = sensor.w * w;
            const sh = sensor.h * h;

            if (!isSelected) {
                // Dim ghost for other pads' sensors
                ctx.strokeStyle = color + '30';
                ctx.lineWidth = 1;
                ctx.strokeRect(sx, sy, sw, sh);
                return;
            }

            // Fill
            ctx.fillStyle = color + '20';
            ctx.fillRect(sx, sy, sw, sh);

            // Border
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.strokeRect(sx, sy, sw, sh);

            // Label — drawn above the box so it doesn't constrain min size
            ctx.fillStyle = color;
            ctx.font = '10px JetBrains Mono, monospace';
            const metricLabel = sensor.metric.substring(0, 3).toUpperCase();
            const paramLabels = { trigger: 'TRIG', volume: 'VOL', pitch: 'PIT', speed: 'SPD', position: 'POS', loopSize: 'LOOP', filterFreq: 'FRQ', filterQ: 'Q', lfoRate: 'LFO-R', lfoDepth: 'LFO-D', videoPosition: 'V-POS', videoLoopSize: 'V-SIZE' };
            const label = `P${sensor.targetPad + 1} ${metricLabel}\u2192${paramLabels[sensor.targetParam] || sensor.targetParam}`;
            const labelY = sy > 14 ? sy - 3 : sy + sh + 12;
            ctx.fillText(label, sx, labelY);

            // Value bar (bottom of sensor rect)
            if (sensor._lastValue > 0) {
                ctx.fillStyle = color + '80';
                const barH = Math.max(2, Math.min(4, sh * 0.2));
                ctx.fillRect(sx, sy + sh - barH, sw * sensor._lastValue, barH);
            }

            // Resize handle (bottom-right corner triangle for visibility)
            ctx.fillStyle = color + '60';
            const hx = sw * 0.3;
            const hy = sh * 0.3;
            ctx.beginPath();
            ctx.moveTo(sx + sw, sy + sh - hy);
            ctx.lineTo(sx + sw, sy + sh);
            ctx.lineTo(sx + sw - hx, sy + sh);
            ctx.closePath();
            ctx.fill();
        });
    }

    _genBindOverlayEvents() {
        const overlay = document.getElementById('gen-overlay');
        if (!overlay) return;

        const getPos = (e) => {
            const rect = overlay.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            return {
                x: (clientX - rect.left) / rect.width,
                y: (clientY - rect.top) / rect.height
            };
        };

        const findSensor = (pos) => {
            // Check in reverse order (top-most first), only selected pad's sensors
            for (let i = this.app.gen.sensors.length - 1; i >= 0; i--) {
                const s = this.app.gen.sensors[i];
                if (s.targetPad !== this._genSelectedPad) continue;
                if (pos.x >= s.x && pos.x <= s.x + s.w && pos.y >= s.y && pos.y <= s.y + s.h) {
                    // Check if in resize handle (bottom-right 30% of sensor for easier touch)
                    const inResizeX = pos.x > s.x + s.w * 0.7;
                    const inResizeY = pos.y > s.y + s.h * 0.7;
                    return { sensor: s, index: i, resize: inResizeX && inResizeY };
                }
            }
            return null;
        };

        const onDown = (e) => {
            e.preventDefault();
            const pos = getPos(e);
            const hit = findSensor(pos);

            if (hit) {
                this._genDragging = true;
                this._genDragSensorId = hit.sensor.id;
                this._genDragType = hit.resize ? 'resize' : 'move';
                this._genDragStart = {
                    px: pos.x, py: pos.y,
                    sx: hit.sensor.x, sy: hit.sensor.y,
                    sw: hit.sensor.w, sh: hit.sensor.h
                };
            } else {
                // Create new sensor by drag
                this._genDragging = true;
                this._genDragType = 'create';
                this._genDragStart = { px: pos.x, py: pos.y };
            }
        };

        const onMove = (e) => {
            if (!this._genDragging) return;
            e.preventDefault();
            const pos = getPos(e);

            if (this._genDragType === 'move') {
                const dx = pos.x - this._genDragStart.px;
                const dy = pos.y - this._genDragStart.py;
                this.app.gen.updateSensor(this._genDragSensorId, {
                    x: Math.max(0, Math.min(1 - this._genDragStart.sw, this._genDragStart.sx + dx)),
                    y: Math.max(0, Math.min(1 - this._genDragStart.sh, this._genDragStart.sy + dy))
                });
                this._genDrawOverlay();
            } else if (this._genDragType === 'resize') {
                const nw = Math.max(0.01, this._genDragStart.sw + (pos.x - this._genDragStart.px));
                const nh = Math.max(0.01, this._genDragStart.sh + (pos.y - this._genDragStart.py));
                this.app.gen.updateSensor(this._genDragSensorId, {
                    w: Math.min(nw, 1 - this._genDragStart.sx),
                    h: Math.min(nh, 1 - this._genDragStart.sy)
                });
                this._genDrawOverlay();
            }
        };

        const onUp = (e) => {
            if (!this._genDragging) return;

            if (this._genDragType === 'create') {
                const pos = getPos(e);
                const x = Math.min(this._genDragStart.px, pos.x);
                const y = Math.min(this._genDragStart.py, pos.y);
                const w = Math.abs(pos.x - this._genDragStart.px);
                const h = Math.abs(pos.y - this._genDragStart.py);
                if (w > 0.01 && h > 0.01) {
                    this.app.gen.addSensor({ x, y, w, h, targetPad: this._genSelectedPad });
                    this._genUpdatePadPanel();
                    this._genRenderGrid();
                    this._genDrawOverlay();
                    this._saveGenConfig();
                }
            } else {
                this._saveGenConfig();
            }

            this._genDragging = false;
            this._genDragSensorId = null;
            this._genDragType = null;
            this._genDragStart = null;
        };

        overlay.addEventListener('pointerdown', onDown);
        overlay.addEventListener('pointermove', onMove);
        overlay.addEventListener('pointerup', onUp);
        overlay.addEventListener('pointercancel', onUp);
    }

    _genApplyZoom() {
        const video = document.getElementById('gen-video');
        const overlay = document.getElementById('gen-overlay');
        if (!video || !overlay) return;
        const t = `scale(${this._genZoom}) translate(${this._genPanX}px, ${this._genPanY}px)`;
        video.style.transform = t;
        overlay.style.transform = t;
    }

    _genBindZoomEvents() {
        const wrap = document.getElementById('gen-video-wrap');
        if (!wrap) return;

        // Mouse wheel zoom
        wrap.addEventListener('wheel', (e) => {
            if (!this.app._genMode) return;
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this._genZoom = Math.max(1, Math.min(10, this._genZoom * delta));
            if (this._genZoom === 1) { this._genPanX = 0; this._genPanY = 0; }
            this._genApplyZoom();
        }, { passive: false });

        // Pinch-to-zoom (touch)
        let lastDist = 0;
        let lastMidX = 0;
        let lastMidY = 0;

        wrap.addEventListener('touchstart', (e) => {
            if (!this.app._genMode || e.touches.length !== 2) return;
            e.preventDefault();
            const dx = e.touches[1].clientX - e.touches[0].clientX;
            const dy = e.touches[1].clientY - e.touches[0].clientY;
            lastDist = Math.hypot(dx, dy);
            lastMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            lastMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        }, { passive: false });

        wrap.addEventListener('touchmove', (e) => {
            if (!this.app._genMode || e.touches.length !== 2) return;
            e.preventDefault();
            const dx = e.touches[1].clientX - e.touches[0].clientX;
            const dy = e.touches[1].clientY - e.touches[0].clientY;
            const dist = Math.hypot(dx, dy);
            const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

            if (lastDist > 0) {
                const scale = dist / lastDist;
                this._genZoom = Math.max(1, Math.min(10, this._genZoom * scale));

                // Pan while zoomed
                if (this._genZoom > 1) {
                    this._genPanX += (midX - lastMidX) / this._genZoom;
                    this._genPanY += (midY - lastMidY) / this._genZoom;
                } else {
                    this._genPanX = 0;
                    this._genPanY = 0;
                }

                this._genApplyZoom();
            }

            lastDist = dist;
            lastMidX = midX;
            lastMidY = midY;
        }, { passive: false });

        // Double-tap to reset zoom
        let lastTapTime = 0;
        wrap.addEventListener('touchend', (e) => {
            if (!this.app._genMode) return;
            if (e.touches.length === 0) {
                const now = Date.now();
                if (now - lastTapTime < 300 && this._genZoom > 1) {
                    this._genZoom = 1;
                    this._genPanX = 0;
                    this._genPanY = 0;
                    this._genApplyZoom();
                }
                lastTapTime = now;
                lastDist = 0;
            }
        });
    }

    // --- Camera recording ---

    _genToggleRec() {
        if (this._genRecording) {
            this._genStopRec(true);
        } else {
            this._genStartRec();
        }
    }

    _genStartRec() {
        if (this.app.gen.source !== 'camera' || !this.app.gen.cameraStream) return;
        if (typeof MediaRecorder === 'undefined') return;

        const mimeType = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4']
            .find(t => MediaRecorder.isTypeSupported(t)) || '';

        this._genRecChunks = [];
        this._genRecorder = new MediaRecorder(
            this.app.gen.cameraStream,
            mimeType ? { mimeType } : {}
        );

        this._genRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this._genRecChunks.push(e.data);
        };

        this._genRecorder.onstop = () => {
            const blob = new Blob(this._genRecChunks, {
                type: (this._genRecorder && this._genRecorder.mimeType) || 'video/webm'
            });
            this._genRecChunks = [];

            if (!this._genRecAutoLoad) return;

            const url = URL.createObjectURL(blob);
            this._genSetSource('file');

            const video = this.app.gen.videoEl;
            video.srcObject = null;
            video.src = url;
            video.onloadedmetadata = () => {
                this.app.gen._sizeAnalysisCanvas();
                this._genResizeOverlay();
                this._genSyncLoopSliders();
                this._genUpdateTimeText();
            };
        };

        this._genRecorder.start(100);
        this._genRecording = true;
        this._genRecStartTime = performance.now();

        // Show time display for recording counter
        document.getElementById('gen-time').style.display = '';
        document.getElementById('gen-rec-btn').classList.add('recording');
        this._genStartTimeDisplay();
    }

    _genStopRec(autoLoad = true) {
        if (!this._genRecorder || this._genRecorder.state === 'inactive') return;
        this._genRecAutoLoad = autoLoad;
        this._genRecording = false;
        this._genStopTimeDisplay();
        document.getElementById('gen-rec-btn').classList.remove('recording');
        this._genRecorder.stop();
    }

    _saveGenConfig() {
        try {
            localStorage.setItem('soniphorm-gen-config', JSON.stringify(this.app.gen.toJSON()));
        } catch (e) {}
    }

    _loadGenConfig() {
        try {
            const data = JSON.parse(localStorage.getItem('soniphorm-gen-config'));
            if (data) this.app.gen.fromJSON(data);
        } catch (e) {}
        // Bind overlay events (only once)
        this._genBindOverlayEvents();
        this._genBindZoomEvents();
    }

    // --- Video loop ---

    _genToggleLoop() {
        this._genLoopEnabled = !this._genLoopEnabled;
        document.getElementById('gen-loop-btn').classList.toggle('loop-active', this._genLoopEnabled);
        this._genUpdateTimeText();
    }

    _genOnInSlider(value) {
        const v = parseFloat(value);
        if (isNaN(v)) return;
        this._genLoopIn = v;
        const video = this.app.gen.videoEl;
        if (video && video.duration) video.currentTime = v;
        if (!this._genLoopEnabled) this._genToggleLoop();
        this._genUpdateTimeText();
    }

    _genOnOutSlider(value) {
        const v = parseFloat(value);
        if (isNaN(v)) return;
        this._genLoopOut = v;
        const video = this.app.gen.videoEl;
        if (video && video.duration) video.currentTime = v;
        if (!this._genLoopEnabled) this._genToggleLoop();
        this._genUpdateTimeText();
    }

    _genSyncLoopSliders() {
        const video = this.app.gen.videoEl;
        if (!video || !video.duration) return;
        const dur = video.duration;
        const inSlider = document.getElementById('gen-in-slider');
        const outSlider = document.getElementById('gen-out-slider');
        if (inSlider) { inSlider.max = dur; inSlider.value = 0; }
        if (outSlider) { outSlider.max = dur; outSlider.value = dur; }
        this._genLoopIn = 0;
        this._genLoopOut = dur;
    }

    _genSyncSlidersFromState() {
        const inSlider = document.getElementById('gen-in-slider');
        const outSlider = document.getElementById('gen-out-slider');
        if (inSlider) inSlider.value = this._genLoopIn;
        if (outSlider) outSlider.value = this._genLoopOut;
    }

    _genResetLoop() {
        this._genLoopEnabled = false;
        this._genLoopIn = 0;
        this._genLoopOut = 0;
        this._genStopTimeDisplay();
        document.getElementById('gen-loop-btn').classList.remove('loop-active');
        const inSlider = document.getElementById('gen-in-slider');
        const outSlider = document.getElementById('gen-out-slider');
        if (inSlider) { inSlider.value = 0; }
        if (outSlider) { outSlider.value = outSlider.max; }
        this._genUpdateTimeText();
    }

    _genStartTimeDisplay() {
        if (this._genTimeRAF) return;
        const tick = (ts) => {
            this._genTimeRAF = requestAnimationFrame(tick);
            // Throttle to ~15fps
            if (ts - this._genTimeLastUpdate < 66) return;
            this._genTimeLastUpdate = ts;

            const video = this.app.gen.videoEl;
            if (!video) return;

            // Enforce loop bounds (no order constraint — always forward between min/max)
            if (this._genLoopEnabled) {
                const lo = Math.min(this._genLoopIn, this._genLoopOut);
                const hi = Math.max(this._genLoopIn, this._genLoopOut);
                const end = hi > 0 ? hi : video.duration;
                if (video.currentTime >= end || video.currentTime < lo || video.ended) {
                    video.currentTime = lo;
                    if (video.paused) video.play();
                }
            }

            this._genUpdateTimeText();
        };
        this._genTimeRAF = requestAnimationFrame(tick);
    }

    _genStopTimeDisplay() {
        if (this._genTimeRAF) {
            cancelAnimationFrame(this._genTimeRAF);
            this._genTimeRAF = null;
        }
    }

    _genUpdateTimeText() {
        const el = document.getElementById('gen-time');
        if (!el) return;

        if (this._genRecording) {
            const elapsed = (performance.now() - this._genRecStartTime) / 1000;
            el.textContent = 'REC ' + this._genFmtTime(elapsed);
            return;
        }

        const video = this.app.gen.videoEl;
        const t = video ? video.currentTime : 0;
        let text = this._genFmtTime(t);
        if (this._genLoopEnabled) {
            const lo = Math.min(this._genLoopIn, this._genLoopOut);
            const hi = Math.max(this._genLoopIn, this._genLoopOut);
            const inStr = this._genFmtTime(lo);
            const outStr = hi > 0 ? this._genFmtTime(hi) : 'END';
            text += ` [${inStr}\u2013${outStr}]`;
        }
        el.textContent = text;
    }

    _genFmtTime(s) {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
    }
}
