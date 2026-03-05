/* rec-controller.js – Recording, editing, effects, cross-slot, layer & bounce */

class RecController {
    constructor(app) {
        this.app = app;
    }

    // === Recording ===

    async startRecording(index) {
        try {
            await this.app.audio.startRecording(this.app._selectedInputDeviceId);
        } catch (e) {
            alert('Could not access microphone. Check permissions.');
            return;
        }
        this.app.recordingSlotIndex = this.app._kitMode ? this.app._kitSelectedSub : index;
        this.app._recChunks = [];
        this.app._recTotalLen = 0;
        this.app._requestWakeLock();
        document.getElementById('rec-btn').classList.add('recording');
        document.getElementById('waveform-empty').hidden = true;
        this.app.renderSlotGrid();

        // Live waveform: collect chunks (flattened per animation frame, not per chunk)
        this.app.audio.onRecordChunk = (chunk) => {
            this.app._recChunks.push(chunk);
            this.app._recTotalLen += chunk.length;
        };

        // Animate recording time + live waveform
        const startTime = performance.now();
        const sampleRate = this.app.audio.sampleRate || 48000;
        const animate = () => {
            if (this.app.recordingSlotIndex < 0) return;
            const elapsed = (performance.now() - startTime) / 1000;
            document.getElementById('info-duration').textContent = this.app.formatTime(elapsed);

            // Flatten chunks for waveform display (O(n) per frame, not O(n²) per chunk)
            if (this.app._recChunks && this.app._recChunks.length > 0 && this.app.waveform) {
                const flat = new Float32Array(this.app._recTotalLen);
                let off = 0;
                for (const c of this.app._recChunks) {
                    flat.set(c, off);
                    off += c.length;
                }
                this.app.waveform.updateAudio([flat], sampleRate);
                // Auto-scroll to end so the latest audio is visible
                const totalSamples = this.app._recTotalLen;
                const visibleSamples = this.app.waveform.getVisibleSamples();
                if (totalSamples > visibleSamples) {
                    this.app.waveform.setScrollOffset(totalSamples - visibleSamples);
                }
                this.app.waveform.render();
            }

            // Gate visual feedback: dim REC button when gate is closed
            if (this.app._gateEnabled) {
                document.getElementById('rec-btn').classList.toggle('gate-closed', !this.app.audio.isGateOpen());
            }

            this.app.animFrameId = requestAnimationFrame(animate);
        };
        animate();
    }

    async stopRecording() {
        this.app.audio.onRecordChunk = null;
        this.app._recChunks = null;
        this.app._recTotalLen = 0;
        const result = this.app.audio.stopRecording();
        const index = this.app.recordingSlotIndex;
        this.app.recordingSlotIndex = -1;
        this.app._releaseWakeLock();
        this.cancelAnimationLoop();
        document.getElementById('rec-btn').classList.remove('recording');
        document.getElementById('rec-btn').classList.remove('gate-closed');

        if (!result || result.channels[0].length === 0) {
            this.app.renderSlotGrid();
            return;
        }

        this.app.channels = result.channels;
        this.app.bufferSampleRate = result.sampleRate;

        // Save to slot (kit sub-slot if in kit mode)
        if (this.app._kitMode) {
            const subIndex = this.app._kitSelectedSub;
            await this.app.slots.saveKitSlotAudio(this.app._kitParentSlot, subIndex, this.app.channels, this.app.bufferSampleRate);
            // Update buffer cache
            if (this.app.audio.audioContext) {
                const buf = this.app.audio.audioContext.createBuffer(
                    this.app.channels.length, this.app.channels[0].length, this.app.bufferSampleRate
                );
                for (let ch = 0; ch < this.app.channels.length; ch++) {
                    buf.getChannelData(ch).set(this.app.channels[ch]);
                }
                this.app._kitSlotBuffers[subIndex] = buf;
            }
            this.app.waveform.setAudio(this.app.channels, this.app.bufferSampleRate);
            document.getElementById('waveform-empty').hidden = true;
            this.app._showKitSlotRenameDialog(this.app._kitParentSlot, subIndex);
            this.app._renderKitGrid();
        } else {
            await this.app.slots.saveSlotAudio(index, this.app.channels, this.app.bufferSampleRate);
            this.app.waveform.setAudio(this.app.channels, this.app.bufferSampleRate);
            document.getElementById('waveform-empty').hidden = true;
            this.showRenameDialog(index);
            this.app.renderSlotGrid();
        }

        this.app.updateTransportInfo();
        this.app.updateToolbarState();
    }

    // === Rename ===

    showRenameDialog(index) {
        const dialog = document.getElementById('rename-dialog');
        const input = document.getElementById('rename-input');
        dialog._slotIndex = index;
        input.value = this.app.slots.slots[index].name || '';
        dialog.hidden = false;
        setTimeout(() => input.focus(), 50);
    }

    // === Playback ===

    playAudio(fromStart = false) {
        if (!this.app.channels) return;
        const sel = this.app.waveform.getSelection();
        const cursor = this.app.waveform.getCursor();
        const start = sel ? sel.start : (fromStart ? 0 : cursor);
        const end = sel ? sel.end : this.app.channels[0].length;

        this.app.audio.play(this.app.channels, this.app.bufferSampleRate, start, end, () => {
            this.cancelAnimationLoop();
            const pb = document.getElementById('play-btn');
            pb.classList.remove('playing');
            pb.innerHTML = '&#9654; PLAY';
            this.app.waveform.setCursor(start);
            this.app.waveform.render();
        });

        const pb = document.getElementById('play-btn');
        pb.classList.add('playing');
        pb.innerHTML = '&#9632; STOP';
        this.startCursorAnimation();
    }

    stopAudio() {
        this.app.audio.stop();
        this.cancelAnimationLoop();
        const pb = document.getElementById('play-btn');
        pb.classList.remove('playing');
        pb.innerHTML = '&#9654; PLAY';
    }

    toggleLoop() {
        const looping = !this.app.audio.isLooping;
        this.app.audio.setLoop(looping);
        document.getElementById('loop-btn').classList.toggle('loop-on', looping);

        // Store per-slot
        const slot = this.app.slots.getSelectedSlot();
        if (slot) slot._loop = looping;

        // If turning on loop while playing, restart to enable loop
        if (looping && this.app.audio.isPlaying) {
            this._restartLoop();
        }
    }

    toggleGate() {
        this.app._gateEnabled = !this.app._gateEnabled;
        this.app.audio.setGateEnabled(this.app._gateEnabled);
        document.getElementById('gate-btn').classList.toggle('gate-on', this.app._gateEnabled);
        document.getElementById('gate-threshold').hidden = !this.app._gateEnabled;
        document.getElementById('gate-db').hidden = !this.app._gateEnabled;

        // Send initial threshold when enabling
        if (this.app._gateEnabled) {
            const dB = parseInt(document.getElementById('gate-threshold').value);
            const linear = Math.pow(10, dB / 20);
            this.app.audio.setGateThreshold(linear);
        }
    }

    _restartLoop() {
        if (!this.app.channels) return;
        const sel = this.app.waveform.getSelection();
        const start = sel ? sel.start : 0;
        const end = sel ? sel.end : this.app.channels[0].length;

        this.app.audio.play(this.app.channels, this.app.bufferSampleRate, start, end, () => {
            this.cancelAnimationLoop();
            document.getElementById('play-btn').classList.remove('playing');
            this.app.waveform.setCursor(start);
            this.app.waveform.render();
        });
        this.cancelAnimationLoop();
        this.startCursorAnimation();
    }

    startCursorAnimation() {
        const animate = () => {
            if (!this.app.audio.isPlaying) return;
            const sample = this.app.audio.getPlaybackSample();
            this.app.waveform.setCursor(sample);
            this.app.waveform.render();
            this.app.animFrameId = requestAnimationFrame(animate);
        };
        animate();
    }

    cancelAnimationLoop() {
        if (this.app.animFrameId) {
            cancelAnimationFrame(this.app.animFrameId);
            this.app.animFrameId = null;
        }
    }

    // === Editing ===

    pushUndo() {
        if (!this.app.channels) return;
        this.app.undoStack.push(this.app.channels.map(ch => new Float32Array(ch)));
        if (this.app.undoStack.length > this.app.maxUndo) {
            this.app.undoStack.shift();
        }
        this.app.redoStack = [];
        this.updateUndoCount();
    }

    undo() {
        if (this.app.undoStack.length === 0) return;
        this.app.redoStack.push(this.app.channels.map(ch => new Float32Array(ch)));
        this.app.channels = this.app.undoStack.pop();
        this.refreshWaveform();
        this.updateUndoCount();
        if (this.app.undoStack.length === 0) {
            // Flash warning
            document.getElementById('undo-count').textContent = 'last undo!';
            setTimeout(() => this.updateUndoCount(), 2000);
        }
    }

    redo() {
        if (this.app.redoStack.length === 0) return;
        this.app.undoStack.push(this.app.channels.map(ch => new Float32Array(ch)));
        this.app.channels = this.app.redoStack.pop();
        this.refreshWaveform();
        this.updateUndoCount();
    }

    updateUndoCount() {
        const el = document.getElementById('undo-count');
        const n = this.app.undoStack.length;
        el.textContent = n > 0 ? `${n}/${this.app.maxUndo}` : '';
        document.getElementById('undo-btn').disabled = n === 0;
        document.getElementById('redo-btn').disabled = this.app.redoStack.length === 0;
    }

    applyEdit(operation) {
        if (!this.app.channels) return;
        const sel = this.app.waveform.getSelection();
        const total = this.app.channels[0].length;
        const start = sel ? sel.start : 0;
        const end = sel ? sel.end : total;

        if (start === end) return;

        this.pushUndo();
        let result;

        switch (operation) {
            case 'trim':
                result = AudioEngine.trim(this.app.channels, start, end);
                break;
            case 'cut':
                result = AudioEngine.cut(this.app.channels, start, end);
                break;
            case 'silence':
                result = AudioEngine.silence(this.app.channels, start, end);
                break;
            case 'fadeIn':
                result = AudioEngine.fadeIn(this.app.channels, start, end);
                break;
            case 'fadeOut':
                result = AudioEngine.fadeOut(this.app.channels, start, end);
                break;
            case 'reverse':
                result = AudioEngine.reverse(this.app.channels, start, end);
                break;
            case 'normalise':
                result = AudioEngine.normalise(this.app.channels, start, end);
                break;
            case 'paste':
                if (!this.app.clipboard) return;
                const pastePos = sel ? sel.start : this.app.waveform.getCursor();
                result = AudioEngine.paste(this.app.channels, this.app.clipboard, pastePos);
                break;
            default:
                return;
        }

        this.app.channels = result;
        this.saveCurrentSlot();
        this.refreshWaveform();

        // Clear selection for operations that change length
        if (['trim', 'cut', 'paste'].includes(operation)) {
            this.app.waveform.clearSelection();
        }
    }

    copySelection() {
        if (!this.app.channels) return;
        const sel = this.app.waveform.getSelection();
        if (!sel) return;
        this.app.clipboard = this.app.channels.map(ch => ch.slice(sel.start, sel.end));
    }

    refreshWaveform() {
        this.app.waveform.setAudio(this.app.channels, this.app.bufferSampleRate);
        this.app.updateTransportInfo();
        this.app.updateToolbarState();

        // If looping, restart playback with updated audio
        if (this.app.audio.isLooping && this.app.audio.isPlaying) {
            this._restartLoop();
        }
    }

    // === Save / Load ===

    async saveCurrentSlot() {
        if (!this.app.channels) return;
        if (this.app._kitMode) {
            const subIndex = this.app._kitSelectedSub;
            await this.app.slots.saveKitSlotAudio(this.app._kitParentSlot, subIndex, this.app.channels, this.app.bufferSampleRate);
            // Update buffer cache
            if (this.app.audio.audioContext) {
                const buf = this.app.audio.audioContext.createBuffer(
                    this.app.channels.length, this.app.channels[0].length, this.app.bufferSampleRate
                );
                for (let ch = 0; ch < this.app.channels.length; ch++) {
                    buf.getChannelData(ch).set(this.app.channels[ch]);
                }
                this.app._kitSlotBuffers[subIndex] = buf;
            }
            this.app._renderKitGrid();
            return;
        }
        const idx = this.app.slots.selectedIndex;
        if (idx < 0) return;
        await this.app.slots.saveSlotAudio(idx, this.app.channels, this.app.bufferSampleRate);
        // Invalidate cached AudioBuffer so sampler/sequencer/gen pick up the edit
        delete this.app._slotBuffers[idx];
        this.app.renderSlotGrid();
    }

    // === File I/O ===

    async saveCurrentToDevice() {
        if (!this.app.channels) return;
        const idx = this.app.slots.selectedIndex;
        const name = idx >= 0 ? this.app.slots.slots[idx].name : 'recording';
        await this.saveSlotToDevice(idx >= 0 ? idx : 0);
    }

    async saveSlotToDevice(index) {
        let channels, sampleRate;
        if (index === this.app.slots.selectedIndex && this.app.channels) {
            channels = this.app.channels;
            sampleRate = this.app.bufferSampleRate;
        } else {
            const data = await this.app.slots.getSlotAudio(index);
            if (!data) return;
            channels = data.channels;
            sampleRate = data.sampleRate;
        }

        const blob = AudioEngine.encodeWAV(channels, sampleRate);
        const name = this.app.slots.slots[index].name || 'recording';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `soniphorm-${name}-${timestamp}.wav`;

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    async loadFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';

        await this.app.ensureAudioInit();

        // Kit mode: load into selected kit sub-slot
        if (this.app._kitMode) {
            try {
                const decoded = await AudioEngine.decodeBlob(file, this.app.audio.audioContext);
                const subIndex = this.app._kitSelectedSub;
                this.app.channels = decoded.channels;
                this.app.bufferSampleRate = decoded.sampleRate;
                this.app.undoStack = [];
                this.app.redoStack = [];

                const name = file.name.replace(/\.[^.]+$/, '').slice(0, 32);
                await this.app.slots.saveKitSlotAudio(this.app._kitParentSlot, subIndex, this.app.channels, this.app.bufferSampleRate);
                await this.app.slots.renameKitSlot(this.app._kitParentSlot, subIndex, name);

                // Update buffer cache
                if (this.app.audio.audioContext) {
                    const buf = this.app.audio.audioContext.createBuffer(
                        this.app.channels.length, this.app.channels[0].length, this.app.bufferSampleRate
                    );
                    for (let ch = 0; ch < this.app.channels.length; ch++) {
                        buf.getChannelData(ch).set(this.app.channels[ch]);
                    }
                    this.app._kitSlotBuffers[subIndex] = buf;
                }

                this.app.waveform.setAudio(this.app.channels, this.app.bufferSampleRate);
                document.getElementById('waveform-empty').hidden = true;

                this.app._renderKitGrid();
                this.app.updateTransportInfo();
                this.app.updateToolbarState();
            } catch (err) {
                alert('Could not decode audio file');
                console.error(err);
            }
            return;
        }

        let targetIndex = this.app.slots.selectedIndex;
        if (targetIndex < 0 || this.app.slots.slots[targetIndex].hasAudio) {
            targetIndex = this.app.slots.findEmptySlot();
        }
        if (targetIndex < 0) {
            alert('No empty slots available');
            return;
        }

        try {
            const decoded = await AudioEngine.decodeBlob(file, this.app.audio.audioContext);
            this.app.slots.selectSlot(targetIndex);
            this.app.channels = decoded.channels;
            this.app.bufferSampleRate = decoded.sampleRate;
            this.app.undoStack = [];
            this.app.redoStack = [];

            const name = file.name.replace(/\.[^.]+$/, '').slice(0, 32);
            await this.app.slots.saveSlotAudio(targetIndex, this.app.channels, this.app.bufferSampleRate);
            this.app.slots.renameSlot(targetIndex, name);

            this.app.waveform.setAudio(this.app.channels, this.app.bufferSampleRate);
            document.getElementById('waveform-empty').hidden = true;

            this.app.renderSlotGrid();
            this.app.updateTransportInfo();
            this.app.updateToolbarState();
        } catch (err) {
            alert('Could not decode audio file');
            console.error(err);
        }
    }

    // === Effects ===

    /** Load the active audio channels — pad buffer from IDB in sample mode, else rec view. */
    async _getActiveChannels() {
        if (this.app._sampleMode) {
            const slot = this.app.slots.slots[this.app._sampleSelectedPad];
            if (!slot || !slot.hasAudio) return null;
            const data = await this.app.slots.getSlotAudio(this.app._sampleSelectedPad);
            return data ? data.channels : null;
        }
        return this.app.channels;
    }

    /** Get sample rate for active audio. */
    _getActiveSampleRate() {
        if (this.app._sampleMode) {
            const slot = this.app.slots.slots[this.app._sampleSelectedPad];
            return (slot && slot.sampleRate) || (this.app.audio.audioContext && this.app.audio.audioContext.sampleRate) || 44100;
        }
        return this.app.bufferSampleRate;
    }

    openFxDialog(fxName) {
        if (this.app._sampleMode) {
            const slot = this.app.slots.slots[this.app._sampleSelectedPad];
            if (!slot || !slot.hasAudio) return;
        } else if (!this.app.channels) return;
        const fx = Effects.registry[fxName];
        if (!fx) return;

        this._currentFx = fxName;
        document.getElementById('fx-title').textContent = fx.label;

        // Build parameter controls
        const container = document.getElementById('fx-params');
        container.innerHTML = '';

        fx.params.forEach(p => {
            const div = document.createElement('div');
            div.className = 'fx-param';

            if (p.type === 'select') {
                div.innerHTML = `
                    <div class="fx-param-header">
                        <span class="fx-param-label">${p.label}</span>
                    </div>
                    <select data-key="${p.key}">
                        ${p.options.map(o => `<option value="${o}" ${o === p.default ? 'selected' : ''}>${o}</option>`).join('')}
                    </select>
                `;
            } else if (p.scale === 'log') {
                // Logarithmic slider: 0–1000 internal, mapped to log range
                const logMin = Math.log(p.min);
                const logMax = Math.log(p.max);
                const logDefault = Math.round(((Math.log(p.default) - logMin) / (logMax - logMin)) * 1000);
                const unit = p.unit || '';
                div.innerHTML = `
                    <div class="fx-param-header">
                        <span class="fx-param-label">${p.label}</span>
                        <span class="fx-param-value" data-value-for="${p.key}">${p.default}${unit}</span>
                    </div>
                    <input type="range" data-key="${p.key}" data-scale="log" data-log-min="${p.min}" data-log-max="${p.max}" min="0" max="1000" step="1" value="${logDefault}">
                `;
                setTimeout(() => {
                    const input = div.querySelector('input[type="range"]');
                    input.addEventListener('input', () => {
                        const t = input.value / 1000;
                        const val = Math.round(Math.exp(logMin + t * (logMax - logMin)));
                        div.querySelector('.fx-param-value').textContent = val + unit;
                    });
                }, 0);
            } else {
                const unit = p.unit || '';
                div.innerHTML = `
                    <div class="fx-param-header">
                        <span class="fx-param-label">${p.label}</span>
                        <span class="fx-param-value" data-value-for="${p.key}">${p.default}${unit}</span>
                    </div>
                    <input type="range" data-key="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}">
                `;
                // Live value display
                setTimeout(() => {
                    const input = div.querySelector('input[type="range"]');
                    input.addEventListener('input', () => {
                        div.querySelector('.fx-param-value').textContent = input.value + unit;
                    });
                }, 0);
            }
            container.appendChild(div);
        });

        // For reverb/delay, pre-populate from existing live effect settings
        const slot = this.app.slots.slots[this.app.slots.selectedIndex];
        const slotFx = slot && slot._liveEffects;
        if ((fxName === 'reverb' || fxName === 'delay') && slotFx && slotFx[fxName]) {
            const saved = slotFx[fxName];
            fx.params.forEach(p => {
                if (saved[p.key] !== undefined) {
                    const paramEl = document.querySelector(`#fx-params [data-key="${p.key}"]`);
                    if (paramEl) {
                        if (paramEl.dataset.scale === 'log') {
                            const logMin = Math.log(p.min);
                            const logMax = Math.log(p.max);
                            const logVal = Math.log(saved[p.key]);
                            paramEl.value = Math.round(((logVal - logMin) / (logMax - logMin)) * 1000);
                        } else {
                            paramEl.value = saved[p.key];
                        }
                        paramEl.dispatchEvent(new Event('input'));
                    }
                }
            });
            // Update Apply button to say "Set Live"
            document.getElementById('fx-apply').textContent = 'Set Live';
        } else if (fxName === 'reverb' || fxName === 'delay') {
            document.getElementById('fx-apply').textContent = 'Set Live';
        } else {
            document.getElementById('fx-apply').textContent = 'Apply';
        }

        document.getElementById('fx-dialog').hidden = false;
    }

    closeFxDialog() {
        document.getElementById('fx-dialog').hidden = true;
        this._currentFx = null;
    }

    _gatherFxParams() {
        const params = {};
        document.querySelectorAll('#fx-params [data-key]').forEach(el => {
            const key = el.dataset.key;
            if (el.tagName === 'SELECT') {
                params[key] = el.value;
            } else if (el.dataset.scale === 'log') {
                const t = parseFloat(el.value) / 1000;
                const logMin = Math.log(parseFloat(el.dataset.logMin));
                const logMax = Math.log(parseFloat(el.dataset.logMax));
                params[key] = Math.round(Math.exp(logMin + t * (logMax - logMin)));
            } else {
                params[key] = parseFloat(el.value);
            }
        });
        return params;
    }

    _getFxRegion(ch) {
        const channels = ch || this.app.channels;
        const sel = this.app.waveform.getSelection();
        const start = sel ? sel.start : 0;
        const end = sel ? sel.end : (channels ? channels[0].length : 0);
        return { start, end };
    }

    async previewFx() {
        const ch = await this._getActiveChannels();
        const sr = this._getActiveSampleRate();
        if (!ch || !this._currentFx) return;
        const fx = Effects.registry[this._currentFx];
        const params = this._gatherFxParams();
        const { start, end } = this._getFxRegion(ch);

        // Process a short preview section (max 3 seconds)
        const maxSamples = sr * 3;
        const previewEnd = Math.min(end, start + maxSamples);

        const previewBtn = document.getElementById('fx-preview');
        previewBtn.textContent = '...';
        previewBtn.disabled = true;

        try {
            const result = await fx.process(ch, sr, start, previewEnd, params);
            // Play the processed preview
            this.app.audio.stop();
            this.app.audio.play(result, sr, start, previewEnd, () => {
                document.getElementById('play-btn').classList.remove('playing');
            });
        } catch (e) {
            console.error('FX preview error:', e);
        } finally {
            previewBtn.textContent = 'Preview';
            previewBtn.disabled = false;
        }
    }

    async applyFx() {
        const ch = await this._getActiveChannels();
        const sr = this._getActiveSampleRate();
        if (!ch || !this._currentFx) return;
        const fxName = this._currentFx;
        const fx = Effects.registry[fxName];
        const params = this._gatherFxParams();

        // Reverb and delay: apply as live (non-destructive) per-slot effects
        if (fxName === 'reverb' || fxName === 'delay') {
            const slotIdx = this.app._sampleMode ? this.app._sampleSelectedPad : this.app.slots.selectedIndex;
            const slot = this.app.slots.slots[slotIdx];
            if (!slot._liveEffects) slot._liveEffects = {};
            slot._liveEffects[fxName] = Object.assign({}, params);
            this._applySlotLiveEffects();
            this.closeFxDialog();
            return;
        }

        const { start, end } = this._getFxRegion(ch);

        const applyBtn = document.getElementById('fx-apply');
        applyBtn.textContent = 'Processing...';
        applyBtn.disabled = true;
        document.getElementById('fx-preview').disabled = true;
        document.getElementById('fx-cancel').disabled = true;

        try {
            if (this.app._sampleMode) {
                // Apply destructively to the selected pad's slot
                const slotIdx = this.app._sampleSelectedPad;
                const result = await fx.process(ch, sr, start, end, params);
                await this.app.slots.saveSlotAudio(slotIdx, result, sr);
                // Rebuild sampler buffer cache
                await this.app.seq._seqPreloadBuffers();
                this.app.sample.renderSampleGrid();
                this.closeFxDialog();
            } else {
                this.pushUndo();
                const result = await fx.process(ch, sr, start, end, params);
                this.app.channels = result;
                this.saveCurrentSlot();
                this.refreshWaveform();
                this.closeFxDialog();
            }
        } catch (e) {
            console.error('FX apply error:', e);
            if (!this.app._sampleMode) this.undo();
            alert('Effect processing failed');
        } finally {
            applyBtn.textContent = 'Apply';
            applyBtn.disabled = false;
            document.getElementById('fx-preview').disabled = false;
            document.getElementById('fx-cancel').disabled = false;
        }
    }

    _applySlotLiveEffects() {
        const slot = this.app.slots.slots[this.app.slots.selectedIndex];
        const fx = slot && slot._liveEffects;

        if (fx && fx.reverb) {
            const p = fx.reverb;
            this.app.audio.enableLiveReverb(
                p.decay !== undefined ? p.decay : 2,
                p.mix !== undefined ? p.mix / 100 : 0.4
            );
        } else if (this.app.audio._liveReverb) {
            this.app.audio.disableLiveReverb();
        }

        if (fx && fx.delay) {
            const p = fx.delay;
            this.app.audio.enableLiveDelay(
                p.time !== undefined ? p.time / 1000 : 0.3,
                p.feedback !== undefined ? p.feedback / 100 : 0.4,
                p.mix !== undefined ? p.mix / 100 : 0.5
            );
        } else if (this.app.audio._liveDelay) {
            this.app.audio.disableLiveDelay();
        }
    }

    async bounceToSlot() {
        // In sample mode with morph, bounce the morphed buffer
        if (this.app._sampleMode) {
            const padIdx = this.app._sampleSelectedPad;
            const pad = this.app.sampler.pads[padIdx];
            if (pad.mode === 'morph') {
                const morphBuf = this.app.sampler._getMorphBuffer(padIdx);
                if (!morphBuf) { alert('No morph buffer to bounce'); return; }
                const emptySlot = this.app.slots.findEmptySlot();
                if (emptySlot < 0) { alert('No empty slots available'); return; }
                const channels = [];
                for (let ch = 0; ch < morphBuf.numberOfChannels; ch++) {
                    channels.push(new Float32Array(morphBuf.getChannelData(ch)));
                }
                await this.app.slots.saveSlotAudio(emptySlot, channels, morphBuf.sampleRate);
                const srcName = this.app.slots.slots[padIdx]?.name || 'morph';
                await this.app.slots.renameSlot(emptySlot, srcName + '-mrp');
                this.app.renderSlotGrid();
                if (this.app._sampleMode) this.app.sample.renderSampleGrid();
                // Refresh slot buffer cache for the new slot
                await this.app.seq._seqPreloadBuffers();
                return;
            }
        }

        if (!this.app.channels) return;
        const sel = this.app.waveform.getSelection();
        const start = sel ? sel.start : 0;
        const end = sel ? sel.end : this.app.channels[0].length;

        const emptySlot = this.app.slots.findEmptySlot();
        if (emptySlot < 0) {
            alert('No empty slots available');
            return;
        }

        const bounced = this.app.channels.map(ch => ch.slice(start, end));
        await this.app.slots.saveSlotAudio(emptySlot, bounced, this.app.bufferSampleRate);

        const srcName = this.app.slots.slots[this.app.slots.selectedIndex]?.name || 'bounce';
        await this.app.slots.renameSlot(emptySlot, srcName + '-b');

        this.app.renderSlotGrid();
    }

    // === Batch Export ===

    async exportAllSlots() {
        const filled = this.app.slots.slots.filter(s => s.hasAudio);
        if (filled.length === 0) {
            alert('No recordings to export');
            return;
        }

        for (const slot of filled) {
            let channels, sampleRate;
            if (slot.index === this.app.slots.selectedIndex && this.app.channels) {
                channels = this.app.channels;
                sampleRate = this.app.bufferSampleRate;
            } else {
                const data = await this.app.slots.getSlotAudio(slot.index);
                if (!data) continue;
                channels = data.channels;
                sampleRate = data.sampleRate;
            }

            const blob = AudioEngine.encodeWAV(channels, sampleRate);
            const name = slot.name || `slot-${slot.index + 1}`;
            const filename = `soniphorm-${name}.wav`;

            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);

            // Small delay between downloads so browser doesn't block them
            await new Promise(r => setTimeout(r, 300));
        }
    }

    // === Cross-slot Processing ===

    openCrossDialog() {
        if (!this.app.channels) return;

        // Populate source slot dropdown (exclude current slot)
        const select = document.getElementById('cross-source');
        select.innerHTML = '';
        this.app.slots.slots.forEach(s => {
            if (s.hasAudio && s.index !== this.app.slots.selectedIndex) {
                const opt = document.createElement('option');
                opt.value = s.index;
                opt.textContent = `${String(s.index + 1).padStart(2, '0')} — ${s.name || 'untitled'}`;
                select.appendChild(opt);
            }
        });

        if (select.options.length === 0) {
            alert('Need at least one other slot with audio');
            return;
        }

        document.getElementById('cross-dialog').hidden = false;
    }

    async _getCrossSourceAudio() {
        const sourceIndex = parseInt(document.getElementById('cross-source').value);
        return await this.app.slots.getSlotAudio(sourceIndex);
    }

    async _processCross(channels, sampleRate, start, end) {
        const op = document.getElementById('cross-op').value;
        const sourceData = await this._getCrossSourceAudio();
        if (!sourceData) throw new Error('Could not load source slot');

        const sourceChannel = sourceData.channels[0];
        const numChannels = channels.length;
        const regionLen = end - start;

        if (op === 'convolve') {
            // Use source audio as impulse response via OfflineAudioContext
            const offline = new OfflineAudioContext(numChannels, regionLen + sourceChannel.length, sampleRate);
            const buffer = offline.createBuffer(numChannels, regionLen, sampleRate);
            for (let ch = 0; ch < numChannels; ch++) {
                buffer.getChannelData(ch).set(channels[ch].subarray(start, end));
            }

            // Trim source to max 3 seconds for IR
            const maxIRLen = Math.min(sourceChannel.length, sampleRate * 3);
            const irBuffer = offline.createBuffer(1, maxIRLen, sampleRate);
            irBuffer.getChannelData(0).set(sourceChannel.subarray(0, maxIRLen));

            const source = offline.createBufferSource();
            source.buffer = buffer;
            const convolver = offline.createConvolver();
            convolver.buffer = irBuffer;
            source.connect(convolver);
            convolver.connect(offline.destination);
            source.start();

            const rendered = await offline.startRendering();
            const result = channels.map(ch => new Float32Array(ch));
            for (let ch = 0; ch < numChannels; ch++) {
                const data = rendered.getChannelData(Math.min(ch, rendered.numberOfChannels - 1));
                // Normalise convolution output
                let peak = 0;
                for (let i = 0; i < regionLen; i++) {
                    peak = Math.max(peak, Math.abs(data[i]));
                }
                const gain = peak > 0 ? 0.9 / peak : 1;
                for (let i = 0; i < regionLen; i++) {
                    result[ch][start + i] = data[i] * gain;
                }
            }
            return result;

        } else if (op === 'ringmod') {
            const result = channels.map(ch => new Float32Array(ch));
            for (let ch = 0; ch < numChannels; ch++) {
                for (let i = 0; i < regionLen; i++) {
                    const srcSample = sourceChannel[i % sourceChannel.length];
                    result[ch][start + i] = channels[ch][start + i] * srcSample;
                }
            }
            return result;

        } else if (op === 'vocoder') {
            // Simple spectral envelope transfer using FFT
            const fSize = 2048;
            const hop = fSize / 4;
            const result = channels.map(ch => new Float32Array(ch));

            for (let ch = 0; ch < numChannels; ch++) {
                const carrier = channels[ch].subarray(start, end);
                const modulator = sourceChannel;

                const processed = DSP.ola(carrier, fSize, hop, hop, (real, imag, frameIdx) => {
                    // Get modulator frame at same position
                    const modStart = (frameIdx * hop) % Math.max(1, modulator.length - fSize);
                    const modReal = new Float32Array(fSize);
                    const modImag = new Float32Array(fSize);
                    const win = DSP.hannWindow(fSize);

                    for (let i = 0; i < fSize; i++) {
                        const idx = modStart + i;
                        modReal[i] = (idx < modulator.length ? modulator[idx] : 0) * win[i];
                        modImag[i] = 0;
                    }
                    DSP.fft(modReal, modImag);

                    // Transfer spectral envelope: use modulator magnitudes with carrier phases
                    for (let i = 0; i < fSize; i++) {
                        const modMag = Math.sqrt(modReal[i] * modReal[i] + modImag[i] * modImag[i]);
                        const carMag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
                        if (carMag > 1e-10) {
                            const scale = modMag / carMag;
                            real[i] *= scale;
                            imag[i] *= scale;
                        }
                    }
                });

                // Normalise
                let peak = 0;
                for (let i = 0; i < processed.length; i++) {
                    peak = Math.max(peak, Math.abs(processed[i]));
                }
                const gain = peak > 0 ? 0.9 / peak : 1;
                const len = Math.min(processed.length, regionLen);
                for (let i = 0; i < len; i++) {
                    result[ch][start + i] = processed[i] * gain;
                }
            }
            return result;
        }

        throw new Error('Unknown cross-slot operation: ' + op);
    }

    async previewCross() {
        if (!this.app.channels) return;
        const { start, end } = this._getFxRegion();
        const maxSamples = this.app.bufferSampleRate * 3;
        const previewEnd = Math.min(end, start + maxSamples);

        const btn = document.getElementById('cross-preview');
        btn.textContent = '...';
        btn.disabled = true;

        try {
            const result = await this._processCross(this.app.channels, this.app.bufferSampleRate, start, previewEnd);
            this.app.audio.stop();
            this.app.audio.play(result, this.app.bufferSampleRate, start, previewEnd, () => {
                document.getElementById('play-btn').classList.remove('playing');
            });
        } catch (e) {
            console.error('Cross-slot preview error:', e);
        } finally {
            btn.textContent = 'Preview';
            btn.disabled = false;
        }
    }

    async applyCross() {
        if (!this.app.channels) return;
        const { start, end } = this._getFxRegion();

        const applyBtn = document.getElementById('cross-apply');
        applyBtn.textContent = 'Processing...';
        applyBtn.disabled = true;

        try {
            this.pushUndo();
            const result = await this._processCross(this.app.channels, this.app.bufferSampleRate, start, end);
            this.app.channels = result;
            this.saveCurrentSlot();
            this.refreshWaveform();
            document.getElementById('cross-dialog').hidden = true;
        } catch (e) {
            console.error('Cross-slot apply error:', e);
            this.undo();
            alert('Cross-slot processing failed');
        } finally {
            applyBtn.textContent = 'Apply';
            applyBtn.disabled = false;
        }
    }

    // === Layer & Bounce ===

    openLayerDialog() {
        const slotsWithAudio = this.app.slots.slots.filter(s => s.hasAudio);
        if (slotsWithAudio.length < 2) {
            alert('Need at least 2 slots with audio to layer');
            return;
        }

        const container = document.getElementById('layer-slot-list');
        container.innerHTML = '';

        for (const slot of this.app.slots.slots) {
            if (!slot.hasAudio) continue;
            const row = document.createElement('div');
            row.className = 'layer-slot-row';
            row.dataset.slotIndex = slot.index;

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'layer-cb';

            const name = document.createElement('span');
            name.className = 'layer-slot-name';
            name.textContent = `${String(slot.index + 1).padStart(2, '0')} — ${slot.name || 'untitled'}`;

            const volCtrl = document.createElement('span');
            volCtrl.className = 'layer-slot-ctrl';
            const volLabel = document.createElement('label');
            volLabel.textContent = 'VOL';
            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.className = 'layer-vol';
            volSlider.min = '0';
            volSlider.max = '100';
            volSlider.value = '100';
            const volVal = document.createElement('span');
            volVal.className = 'layer-val';
            volVal.textContent = '100%';
            volSlider.addEventListener('input', () => {
                volVal.textContent = volSlider.value + '%';
            });
            volCtrl.appendChild(volLabel);
            volCtrl.appendChild(volSlider);
            volCtrl.appendChild(volVal);

            const panCtrl = document.createElement('span');
            panCtrl.className = 'layer-slot-ctrl';
            const panLabel = document.createElement('label');
            panLabel.textContent = 'PAN';
            const panSlider = document.createElement('input');
            panSlider.type = 'range';
            panSlider.className = 'layer-pan';
            panSlider.min = '-100';
            panSlider.max = '100';
            panSlider.value = '0';
            const panVal = document.createElement('span');
            panVal.className = 'layer-val';
            panVal.textContent = 'C';
            panSlider.addEventListener('input', () => {
                const v = parseInt(panSlider.value);
                panVal.textContent = v < 0 ? Math.abs(v) + 'L' : v > 0 ? v + 'R' : 'C';
            });
            panCtrl.appendChild(panLabel);
            panCtrl.appendChild(panSlider);
            panCtrl.appendChild(panVal);

            row.appendChild(cb);
            row.appendChild(name);
            row.appendChild(volCtrl);
            row.appendChild(panCtrl);
            container.appendChild(row);
        }

        document.getElementById('layer-dialog').hidden = false;
    }

    _getLayerSelections() {
        const rows = document.querySelectorAll('#layer-slot-list .layer-slot-row');
        const selections = [];
        for (const row of rows) {
            const cb = row.querySelector('.layer-cb');
            if (!cb.checked) continue;
            selections.push({
                slotIndex: parseInt(row.dataset.slotIndex),
                volume: parseInt(row.querySelector('.layer-vol').value) / 100,
                pan: parseInt(row.querySelector('.layer-pan').value) / 100
            });
        }
        return selections;
    }

    async _renderLayerMix(selections) {
        await this.app.ensureAudioInit();
        const sampleRate = this.app.audio.audioContext.sampleRate;

        // Load all selected slot audio
        const audioData = [];
        let maxLength = 0;
        for (const sel of selections) {
            const data = await this.app.slots.getSlotAudio(sel.slotIndex);
            if (!data) continue;
            audioData.push({ data, sel });
            maxLength = Math.max(maxLength, data.channels[0].length);
        }

        if (audioData.length === 0) throw new Error('No audio to mix');

        const offline = new OfflineAudioContext(2, maxLength, sampleRate);

        for (const { data, sel } of audioData) {
            const buf = offline.createBuffer(
                data.channels.length,
                data.channels[0].length,
                data.sampleRate
            );
            for (let ch = 0; ch < data.channels.length; ch++) {
                buf.getChannelData(ch).set(data.channels[ch]);
            }

            const source = offline.createBufferSource();
            source.buffer = buf;

            const gain = offline.createGain();
            gain.gain.setValueAtTime(sel.volume, 0);

            const panner = offline.createStereoPanner();
            panner.pan.setValueAtTime(sel.pan, 0);

            source.connect(gain);
            gain.connect(panner);
            panner.connect(offline.destination);
            source.start(0);
        }

        const rendered = await offline.startRendering();
        const channels = [];
        for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
            channels.push(new Float32Array(rendered.getChannelData(ch)));
        }
        return { channels, sampleRate: rendered.sampleRate };
    }

    async previewLayer() {
        const selections = this._getLayerSelections();
        if (selections.length < 2) {
            alert('Select at least 2 slots to layer');
            return;
        }

        const btn = document.getElementById('layer-preview');
        btn.textContent = 'Mixing...';
        btn.disabled = true;

        try {
            const result = await this._renderLayerMix(selections);
            // Play the preview
            const ctx = this.app.audio.audioContext;
            const buf = ctx.createBuffer(result.channels.length, result.channels[0].length, result.sampleRate);
            for (let ch = 0; ch < result.channels.length; ch++) {
                buf.getChannelData(ch).set(result.channels[ch]);
            }
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start();
        } catch (e) {
            console.error('Layer preview error:', e);
            alert('Preview failed');
        } finally {
            btn.textContent = 'Preview';
            btn.disabled = false;
        }
    }

    async bounceLayer() {
        const selections = this._getLayerSelections();
        if (selections.length < 2) {
            alert('Select at least 2 slots to layer');
            return;
        }

        const btn = document.getElementById('layer-bounce');
        btn.textContent = 'Bouncing...';
        btn.disabled = true;

        try {
            const result = await this._renderLayerMix(selections);
            const emptySlot = this.app.slots.findEmptySlot();
            if (emptySlot < 0) {
                alert('No empty slots available');
                return;
            }

            // Auto-name: layer-01+03+05
            const slotNums = selections.map(s => String(s.slotIndex + 1).padStart(2, '0'));
            const layerName = 'layer-' + slotNums.join('+');

            await this.app.slots.saveSlotAudio(emptySlot, result.channels, result.sampleRate);
            this.app.slots.slots[emptySlot].name = layerName;
            await this.app.slots.renameSlot(emptySlot, layerName);

            // Update buffer cache for sequencer/sampler
            if (this.app.audio.audioContext) {
                const buf = this.app.audio.audioContext.createBuffer(
                    result.channels.length,
                    result.channels[0].length,
                    result.sampleRate
                );
                for (let ch = 0; ch < result.channels.length; ch++) {
                    buf.getChannelData(ch).set(result.channels[ch]);
                }
                this.app._slotBuffers[emptySlot] = buf;
            }

            document.getElementById('layer-dialog').hidden = true;
            this.app.buildSlotGrid();
            this.app.renderSlotGrid();
            this.app.updateToolbarState();
        } catch (e) {
            console.error('Layer bounce error:', e);
            alert('Bounce failed');
        } finally {
            btn.textContent = 'Bounce';
            btn.disabled = false;
        }
    }

    // === Project Save/Load ===

    _showProgress(msg) {
        let overlay = document.getElementById('project-progress');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'project-progress';
            overlay.className = 'project-progress-overlay';
            overlay.innerHTML = '<div class="project-progress-msg"></div>';
            document.body.appendChild(overlay);
        }
        overlay.querySelector('.project-progress-msg').textContent = msg;
        overlay.hidden = false;
    }

    _hideProgress() {
        const overlay = document.getElementById('project-progress');
        if (overlay) overlay.hidden = true;
    }

    async saveProject() {
        const slots = this.app.slots;

        // Prompt for project name
        const defaultName = 'sonicraft-project';
        const projectName = prompt('Project name:', defaultName);
        if (projectName === null) return; // cancelled
        const safeName = (projectName.trim() || defaultName).replace(/[<>:"/\\|?*]/g, '-');

        try {
            this._showProgress('Preparing project...');

            const zip = new JSZip();
            const manifest = {
                version: 1,
                created: new Date().toISOString(),
                slots: [],
                config: {}
            };

            // Iterate all 16 slots
            for (let i = 0; i < 16; i++) {
                const meta = slots.slots[i];
                if (!meta.hasAudio && meta.type !== 'kit') continue;

                const slotEntry = {
                    index: i,
                    name: meta.name,
                    type: meta.type || 'normal',
                    duration: meta.duration,
                    sampleRate: meta.sampleRate,
                    peaks: meta.peaks ? Array.from(meta.peaks) : null
                };

                if (meta.type === 'kit') {
                    // Kit slot — save sub-slots
                    slotEntry.kitSubs = [];
                    const subs = slots.kitSlots[i];
                    if (subs) {
                        for (let j = 0; j < 16; j++) {
                            if (!subs[j] || !subs[j].hasAudio) continue;
                            this._showProgress(`Saving kit ${i + 1} sub ${j + 1}...`);

                            const rec = await slots.getRawKitSlotRecord(i, j);
                            if (rec && rec.audio) {
                                const padStr = String(i + 1).padStart(2, '0');
                                const subStr = String(j).padStart(2, '0');
                                const subName = subs[j].name || `sub${j}`;
                                const filename = `kits/${padStr}-${subStr}-${subName}.wav`;

                                zip.file(filename, rec.audio);
                                slotEntry.kitSubs.push({
                                    subIndex: j,
                                    name: subs[j].name,
                                    file: filename,
                                    duration: subs[j].duration,
                                    sampleRate: subs[j].sampleRate,
                                    peaks: subs[j].peaks ? Array.from(subs[j].peaks) : null
                                });
                            }
                        }
                    }
                } else {
                    // Normal slot — save WAV
                    this._showProgress(`Saving slot ${i + 1}...`);

                    const rec = await slots.getRawSlotRecord(i);
                    if (rec && rec.audio) {
                        const padStr = String(i + 1).padStart(2, '0');
                        const slotName = meta.name || `slot${i + 1}`;
                        const filename = `slots/${padStr}-${slotName}.wav`;

                        zip.file(filename, rec.audio);
                        slotEntry.file = filename;
                    }
                }

                manifest.slots.push(slotEntry);
            }

            // Gather localStorage configs
            const configKeys = {
                sampler: 'soniphorm-sampler',
                seqBanks: 'soniphorm-seq-banks',
                gen: 'soniphorm-gen-config'
            };
            for (const [key, lsKey] of Object.entries(configKeys)) {
                try {
                    const val = localStorage.getItem(lsKey);
                    if (val) manifest.config[key] = JSON.parse(val);
                } catch (e) {}
            }

            // Kit pad configs
            manifest.config.kitPads = {};
            for (let i = 0; i < 16; i++) {
                try {
                    const val = localStorage.getItem('soniphorm-kit-pads-' + i);
                    if (val) manifest.config.kitPads[String(i)] = JSON.parse(val);
                } catch (e) {}
            }

            // Store project name in manifest
            manifest.name = safeName;

            zip.file('project.json', JSON.stringify(manifest, null, 2));

            this._showProgress('Compressing...');
            const blob = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 1 }
            });

            // Use File System Access API if available (lets user pick save location)
            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: `${safeName}.sonicraft`,
                        types: [{
                            description: 'SoniCraft Project',
                            accept: { 'application/zip': ['.sonicraft'] }
                        }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    this._hideProgress();
                    return;
                } catch (err) {
                    // User cancelled the picker — abort silently
                    if (err.name === 'AbortError') { this._hideProgress(); return; }
                    // Other error — fall through to legacy download
                }
            }

            // Fallback: trigger download via <a> click
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${safeName}.sonicraft`;
            a.click();
            URL.revokeObjectURL(a.href);

            this._hideProgress();
        } catch (e) {
            this._hideProgress();
            console.error('Save project error:', e);
            alert('Failed to save project: ' + e.message);
        }
    }

    async loadProject(e) {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;

        if (!confirm('Load project? This will replace ALL current slots, patterns, and settings.')) return;

        try {
            await this.app.ensureAudioInit();

            // Stop all playback
            this.app.audio.stop();
            this.cancelAnimationLoop();
            if (this.app.sequencer && this.app.sequencer.playing) {
                this.app.sequencer.stop();
                this.app.seq._seqStopAnimation();
            }
            if (this.app.sampler) this.app.sampler.stopAll();

            // Exit kit mode if active
            if (this.app._kitMode) {
                this.app._exitKitMode();
            }

            this._showProgress('Reading project file...');

            const zip = await JSZip.loadAsync(file);
            const manifestFile = zip.file('project.json');
            if (!manifestFile) {
                throw new Error('Invalid project file: missing project.json');
            }
            const manifest = JSON.parse(await manifestFile.async('string'));

            if (!manifest.version || !manifest.slots) {
                throw new Error('Invalid project manifest');
            }

            // Clear everything
            this._showProgress('Clearing current data...');
            await this.app.slots.clearAllData();

            // Clear localStorage configs
            localStorage.removeItem('soniphorm-sampler');
            localStorage.removeItem('soniphorm-seq-banks');
            localStorage.removeItem('soniphorm-seq-pattern');
            localStorage.removeItem('soniphorm-gen-config');
            for (let i = 0; i < 16; i++) {
                localStorage.removeItem('soniphorm-kit-pads-' + i);
            }

            // Restore slots
            for (const slotEntry of manifest.slots) {
                const idx = slotEntry.index;

                if (slotEntry.type === 'kit') {
                    // Restore kit slot
                    this._showProgress(`Restoring kit slot ${idx + 1}...`);

                    this.app.slots.slots[idx].name = slotEntry.name || '';
                    await this.app.slots.makeKit(idx);
                    if (slotEntry.name) {
                        await this.app.slots.renameSlot(idx, slotEntry.name);
                    }

                    // Restore kit sub-slots
                    if (slotEntry.kitSubs) {
                        for (const sub of slotEntry.kitSubs) {
                            this._showProgress(`Restoring kit ${idx + 1} sub ${sub.subIndex + 1}...`);

                            const zipEntry = zip.file(sub.file);
                            if (!zipEntry) continue;

                            const wavBlob = await zipEntry.async('blob');
                            const decoded = await AudioEngine.decodeBlob(wavBlob, this.app.audio.audioContext);

                            // Set name before save
                            if (!this.app.slots.kitSlots[idx]) {
                                const subs = [];
                                for (let j = 0; j < 16; j++) {
                                    subs.push({ name: '', duration: 0, sampleRate: 0, hasAudio: false, peaks: null });
                                }
                                this.app.slots.kitSlots[idx] = subs;
                            }
                            this.app.slots.kitSlots[idx][sub.subIndex].name = sub.name || '';

                            await this.app.slots.saveKitSlotAudio(idx, sub.subIndex, decoded.channels, decoded.sampleRate);
                        }
                    }
                } else {
                    // Restore normal slot
                    if (!slotEntry.file) continue;

                    this._showProgress(`Restoring slot ${idx + 1}...`);

                    const zipEntry = zip.file(slotEntry.file);
                    if (!zipEntry) continue;

                    const wavBlob = await zipEntry.async('blob');
                    const decoded = await AudioEngine.decodeBlob(wavBlob, this.app.audio.audioContext);

                    this.app.slots.slots[idx].name = slotEntry.name || '';
                    await this.app.slots.saveSlotAudio(idx, decoded.channels, decoded.sampleRate);
                    if (slotEntry.name) {
                        await this.app.slots.renameSlot(idx, slotEntry.name);
                    }
                }
            }

            // Restore localStorage configs
            this._showProgress('Restoring settings...');
            const cfg = manifest.config || {};
            if (cfg.sampler) localStorage.setItem('soniphorm-sampler', JSON.stringify(cfg.sampler));
            if (cfg.seqBanks) localStorage.setItem('soniphorm-seq-banks', JSON.stringify(cfg.seqBanks));
            if (cfg.gen) localStorage.setItem('soniphorm-gen-config', JSON.stringify(cfg.gen));
            if (cfg.kitPads) {
                for (const [slotIdx, padCfg] of Object.entries(cfg.kitPads)) {
                    localStorage.setItem('soniphorm-kit-pads-' + slotIdx, JSON.stringify(padCfg));
                }
            }

            // Reload live configs
            if (this.app.sample) this.app.sample._loadSamplerConfig();
            if (this.app.seq) this.app.seq._loadSeqPattern();
            if (this.app.genCtrl) this.app.genCtrl._loadGenConfig();

            // Reset app state
            this.app.channels = null;
            this.app.clipboard = null;
            this.app.undoStack = [];
            this.app.redoStack = [];
            this.app._slotBuffers = {};

            // Switch to REC mode and refresh UI
            this.app.switchMode('rec');
            this.app.buildSlotGrid();
            this.app.renderSlotGrid();
            this.app.waveform.clear();
            document.getElementById('waveform-empty').hidden = false;
            this.app.updateTransportInfo();
            this.app.updateToolbarState();

            this._hideProgress();
        } catch (e) {
            this._hideProgress();
            console.error('Load project error:', e);
            alert('Failed to load project: ' + e.message);
        }
    }
}
