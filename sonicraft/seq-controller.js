/* seq-controller.js – Sequencer mode controller (extracted from App) */

class SeqController {
    constructor(app) {
        this.app = app;
        this._seqAnimFrame = null;
        this._seqPreMutatePattern = null;
        this._seqBankIndex = 0;
        this._seqPreviewBankIndex = null;
        this._seqQueuedBankIndex = null;
        this._seqBanks = null;
        this._seqLooperUndoStack = [];
        this._seqRecordingNotes = new Map();
        this._seqMutedSlots = new Set();
        this._seqSoloSlot = -1;
        this._seqStutterSlots = new Set();
        this._seqMutateSlots = new Set();
        this._seqModeMenuStep = -1;
        this._stepMenuCloseHandler = null;
    }

    // === Lifecycle ===

    async enter() {
        this.app._seqMode = true;
        if (this.app.audio.audioContext) {
            this.app.sequencer.audioContext = this.app.audio.audioContext;
            this.app.sequencer.outputNode = this.app.audio.getEffectsBus();
            // Also init sampler for live recording
            this.app.sampler.audioContext = this.app.audio.audioContext;
            this.app.sampler.outputNode = this.app.audio.getEffectsBus();
        }
        await this._seqPreloadBuffers();
        // Sync step count dropdown
        const stepSelect = document.getElementById('seq-step-count');
        if (stepSelect) stepSelect.value = this.app.sequencer.stepCount;
        this.app.buildSlotGrid();
        this.renderSeqGrid();
        this._updateBpmDisplay();
        document.getElementById('seq-mutate-btn').classList.toggle('mutate-on', this.app.sequencer.mutateEnabled);
        document.getElementById('seq-stutter-btn').classList.toggle('stutter-on', this.app.sequencer.stutterEnabled);
        document.getElementById('seq-rev-btn').classList.toggle('rev-on', this.app.sequencer.reverse);
        document.getElementById('seq-speed-btn').textContent = this.app.sequencer.speed + 'x';
        document.getElementById('seq-mutate-amount').value = Math.round(this.app.sequencer.mutateAmount * 100);
        document.getElementById('seq-stutter-amount').value = Math.round(this.app.sequencer.stutterAmount * 100);
        // Show sample list or drum grid in waveform area
        document.getElementById('waveform').style.display = 'none';
        document.getElementById('waveform-empty').hidden = true;
        if (this.app._kitMode) {
            document.getElementById('seq-sample-list').hidden = true;
            document.getElementById('drum-grid').hidden = false;
            this.app._drumGridView = true;
            this._renderDrumGrid();
        } else {
            document.getElementById('seq-sample-list').hidden = false;
            document.getElementById('drum-grid').hidden = true;
            this.app._drumGridView = false;
        }
        this._seqModeMenuStep = 0;
        if (!this.app._kitMode) this._renderSeqSampleList();
        this._updateBankDisplay();
    }

    exit(targetMode) {
        if (this.app.sequencer.playing && targetMode !== 'sample') {
            this.app.sequencer.stop();
            this._seqStopAnimation();
        }
        this.app._seqShowTransportInSample = (targetMode === 'sample');
        this._saveSeqPattern();
        this.app._seqMode = false;
        document.getElementById('waveform').style.display = '';
        document.getElementById('seq-sample-list').hidden = true;
        document.getElementById('drum-grid').hidden = true;
        this.app._drumGridView = false;
        document.getElementById('zoom-fit').textContent = '[ ]';
        if (this.app.channels) {
            document.getElementById('waveform-empty').hidden = true;
        } else {
            document.getElementById('waveform-empty').hidden = false;
        }
    }

    // === Sequencer ===

    _initSequencer() {
        this.app.sequencer = new Sequencer(null); // audioContext set later

        // Provide callbacks
        this.app.sequencer.getSlotBuffer = (slotIndex) => {
            return this.app._slotBuffers[slotIndex] || null;
        };
        this.app.sequencer.getKitSlotBuffer = (parentSlot, subIndex) => {
            // If we're in kit mode viewing this parent, use the cached kit buffers
            if (this.app._kitMode && this.app._kitParentSlot === parentSlot) {
                return this.app._kitSlotBuffers[subIndex] || null;
            }
            return null;
        };
        this.app.sequencer.getKitPadSettings = (subIndex) => {
            if (this.app._kitMode) {
                return this.app.sampler ? this.app.sampler.pads[subIndex] : null;
            }
            return null;
        };
        this.app.sequencer.getLoadedSlots = () => {
            const loaded = [];
            for (let i = 0; i < 16; i++) {
                if (this.app.slots.slots[i].hasAudio) loaded.push(i);
            }
            return loaded;
        };
        // Kit-aware version for sequencer features
        this._getLoadedKitSubs = () => {
            if (!this.app._kitMode) return [];
            const loaded = [];
            for (let j = 0; j < 16; j++) {
                const meta = this.app.slots.getKitSlotMeta(this.app._kitParentSlot, j);
                if (meta && meta.hasAudio) loaded.push(j);
            }
            return loaded;
        };
        this.app.sequencer.onStepChange = (step) => {
            this._seqHighlightStep(step);
            this._seqFlashSampleRows(step);
            this._seqFlashPads(step);
            if (this.app._drumGridView) this._updateDrumGridStep(step);
        };
        this.app.sequencer.onMutate = (step) => {
            this._seqFlashMutate(step);
            this.renderSeqGrid();
        };
        this.app.sequencer.onPatternLoop = () => {
            // Switch to queued pattern at loop boundary
            if (this._seqQueuedBankIndex !== null) {
                const queued = this._seqQueuedBankIndex;
                this._seqQueuedBankIndex = null;
                this._seqPreviewBankIndex = null;
                this.seqSwitchBank(queued);
            }
            if (this.app.sequencer.mutateEnabled) {
                this.renderSeqGrid();
            }
        };
        this.app.sequencer.getPadSettings = (slotIndex) => {
            return this.app.sampler ? this.app.sampler.pads[slotIndex] : null;
        };

        // MIDI output on step
        this.app.sequencer.onStepSchedule = (stepIndex, time) => this.app._midiSendStep(stepIndex, time);

        // Mute/Solo state
        this._seqMutedSlots = new Set();
        this._seqSoloSlot = -1; // -1 = no solo
        this.app.sequencer.shouldPlaySlot = (slotIndex) => {
            if (this._seqSoloSlot >= 0) return slotIndex === this._seqSoloSlot;
            return !this._seqMutedSlots.has(slotIndex);
        };

        // Per-slot stutter/mutate
        this._seqStutterSlots = new Set();
        this._seqMutateSlots = new Set();
        this.app.sequencer.shouldStutterSlot = (slotIndex) => {
            return this._seqStutterSlots.has(slotIndex);
        };
        this.app.sequencer.shouldMutateSlot = (slotIndex) => {
            return this._seqMutateSlots.has(slotIndex);
        };

        this.app._slotBuffers = {}; // slotIndex → AudioBuffer (shared by sequencer + sampler)
        this._seqModeMenuStep = -1;

        // Load persisted pattern
        this._loadSeqPattern();
    }

    async toggleSeqMode() {
        // Legacy — redirect to new switchMode
        await this.app.switchMode(this.app._seqMode ? 'rec' : 'seq');
    }

    async _seqPreloadBuffers() {
        for (let i = 0; i < 16; i++) {
            if (this.app.slots.slots[i].hasAudio && !this.app._slotBuffers[i]) {
                try {
                    const data = await this.app.slots.getSlotAudio(i);
                    if (data && this.app.audio.audioContext) {
                        const buf = this.app.audio.audioContext.createBuffer(
                            data.channels.length,
                            data.channels[0].length,
                            data.sampleRate
                        );
                        for (let ch = 0; ch < data.channels.length; ch++) {
                            buf.getChannelData(ch).set(data.channels[ch]);
                        }
                        this.app._slotBuffers[i] = buf;
                    }
                } catch (e) {
                    console.warn('Failed to preload slot', i, e);
                }
            }
        }
        // Also preload kit buffers if in kit mode
        if (this.app._kitMode) {
            await this.app._preloadKitBuffers(this.app._kitParentSlot);
        }
    }

    renderSeqGrid() {
        const grid = document.getElementById('slot-grid');
        const slotEls = grid.querySelectorAll('.slot');

        slotEls.forEach((el, i) => {
            if (i >= this.app.sequencer.pattern.length) return;
            const step = this.app.sequencer.pattern[i];
            const hasSound = step.slots.length > 0 && step.slots.some(
                e => this.app.slots.slots[e.slot] && this.app.slots.slots[e.slot].hasAudio
            );

            // Step number
            const numEl = el.querySelector('.slot-number');
            numEl.textContent = String(i + 1).padStart(2, '0');

            // Content
            const nameEl = el.querySelector('.slot-name');
            if (hasSound) {
                // Show slot numbers with per-slot pitch (e.g. "01+05" or "01(+3)")
                const labels = step.slots.map(e => {
                    let lbl = String(e.slot + 1).padStart(2, '0');
                    if (e.pitch !== 0) lbl += '(' + (e.pitch > 0 ? '+' : '') + e.pitch + ')';
                    return lbl;
                });
                nameEl.innerHTML = `<span class="step-slot-label">${labels.join('+')}</span>`;
                nameEl.className = 'slot-name';

                // Bank color based on step position (cycling 0-3)
                const bank = Math.floor(i / 4) % 4;
                el.className = 'slot step-bank-' + bank;
                el.dataset.bank = bank;

                // Mode icons (no step-level pitch any more)
                let icons = '';
                if (step.mode === 'loop') icons += 'L ';
                if (step.direction === 'reverse') icons += '\u25C0 ';
                let iconsEl = el.querySelector('.step-mode-icons');
                if (!iconsEl) {
                    iconsEl = document.createElement('span');
                    iconsEl.className = 'step-mode-icons';
                    el.appendChild(iconsEl);
                }
                iconsEl.textContent = icons.trim();
            } else {
                nameEl.innerHTML = '--';
                nameEl.className = 'slot-name empty';
                el.className = 'slot step-empty';
                el.dataset.bank = Math.floor(i / 4) % 4;

                const iconsEl = el.querySelector('.step-mode-icons');
                if (iconsEl) iconsEl.textContent = '';
            }
        });
    }

    seqStepTap(stepIndex) {
        this._seqModeMenuStep = stepIndex;
        this._renderSeqSampleList();
        this.renderSeqGrid();
        // Highlight selected step
        const slotEls = document.querySelectorAll('#slot-grid .slot');
        slotEls.forEach((el, i) => {
            el.classList.toggle('pad-selected', i === stepIndex);
        });
    }

    _renderSeqSampleList() {
        const container = document.getElementById('seq-sample-list');
        const stepIndex = this._seqModeMenuStep;
        const step = this.app.sequencer.pattern[stepIndex];
        container.innerHTML = '';

        // Header with step number and mode/direction controls
        const header = document.createElement('div');
        header.className = 'seq-sample-list-header';
        const modeBtn = document.createElement('button');
        modeBtn.className = 'seq-mode-btn' + (step.mode === 'loop' ? ' on' : '');
        modeBtn.textContent = step.mode === 'loop' ? 'LOOP' : 'ONE';
        modeBtn.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text2);font-family:var(--mono);font-size:10px;font-weight:700;padding:2px 8px;cursor:pointer;';
        if (step.mode === 'loop') modeBtn.style.color = 'var(--yellow)';
        modeBtn.addEventListener('click', () => {
            const newMode = step.mode === 'loop' ? 'oneshot' : 'loop';
            this.app.sequencer.setStepMode(stepIndex, newMode);
            this._renderSeqSampleList();
            this.renderSeqGrid();
            this._saveSeqPattern();
        });

        const dirBtn = document.createElement('button');
        dirBtn.className = 'seq-dir-btn' + (step.direction === 'reverse' ? ' on' : '');
        dirBtn.textContent = step.direction === 'reverse' ? 'REV' : 'FWD';
        dirBtn.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);color:var(--text2);font-family:var(--mono);font-size:10px;font-weight:700;padding:2px 8px;cursor:pointer;';
        if (step.direction === 'reverse') dirBtn.style.color = 'var(--red)';
        dirBtn.addEventListener('click', () => {
            const newDir = step.direction === 'reverse' ? 'forward' : 'reverse';
            this.app.sequencer.setStepDirection(stepIndex, newDir);
            for (const entry of step.slots) this.app.sequencer.invalidateBuffer(entry.slot);
            this._renderSeqSampleList();
            this.renderSeqGrid();
            this._saveSeqPattern();
        });

        header.textContent = '';
        header.appendChild(document.createTextNode('STEP ' + String(stepIndex + 1).padStart(2, '0')));
        header.appendChild(modeBtn);
        header.appendChild(dirBtn);
        container.appendChild(header);

        // Sample rows
        for (let i = 0; i < 16; i++) {
            const slot = this.app.slots.slots[i];
            if (!slot.hasAudio) continue;

            const entry = this.app.sequencer.getSlotEntry(stepIndex, i);
            const isOn = !!entry;
            const pitch = entry ? entry.pitch : 0;

            const row = document.createElement('div');
            const isMuted = this._seqMutedSlots.has(i);
            const isSolo = this._seqSoloSlot === i;
            const isSilenced = this._seqSoloSlot >= 0 ? !isSolo : isMuted;
            row.className = 'seq-sample-row' + (isOn ? ' on' : '') + (isSilenced ? ' muted' : '') + (isSolo ? ' solo' : '');
            row.dataset.slotIdx = i;

            // Trigger zone: wraps num + name for audition/recording
            const triggerZone = document.createElement('span');
            triggerZone.className = 'seq-trigger-zone';

            const numSpan = document.createElement('span');
            numSpan.className = 'slot-num';
            numSpan.textContent = String(i + 1).padStart(2, '0');
            triggerZone.appendChild(numSpan);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'slot-name';
            nameSpan.textContent = slot.name || 'untitled';
            triggerZone.appendChild(nameSpan);

            // Trigger zone: press to audition, record if in rec mode
            const slotIdx = i;
            let triggerUsedTouch = false;
            const triggerDown = (ev) => {
                ev.stopPropagation();
                this._seqTriggerFromList(slotIdx);
            };
            const triggerUp = (ev) => {
                ev.stopPropagation();
                this._seqTriggerRelease(slotIdx);
            };
            triggerZone.addEventListener('mousedown', (ev) => {
                if (triggerUsedTouch) return;
                triggerDown(ev);
            });
            triggerZone.addEventListener('mouseup', (ev) => {
                if (triggerUsedTouch) return;
                triggerUp(ev);
            });
            triggerZone.addEventListener('mouseleave', (ev) => {
                if (triggerUsedTouch) return;
                triggerUp(ev);
            });
            triggerZone.addEventListener('touchstart', (ev) => {
                triggerUsedTouch = true;
                ev.preventDefault();
                triggerDown(ev);
            });
            triggerZone.addEventListener('touchend', (ev) => {
                ev.preventDefault();
                triggerUp(ev);
                setTimeout(() => { triggerUsedTouch = false; }, 400);
            });
            triggerZone.addEventListener('touchcancel', () => {
                triggerUp({ stopPropagation: () => {} });
                setTimeout(() => { triggerUsedTouch = false; }, 400);
            });
            // Prevent click from bubbling to row toggle
            triggerZone.addEventListener('click', (ev) => ev.stopPropagation());

            row.appendChild(triggerZone);

            // Solo button
            const soloBtn = document.createElement('button');
            soloBtn.className = 'seq-solo-btn' + (this._seqSoloSlot === i ? ' on' : '');
            soloBtn.textContent = 'S';
            soloBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._seqSoloSlot = (this._seqSoloSlot === i) ? -1 : i;
                this._renderSeqSampleList();
            });
            row.appendChild(soloBtn);

            // Mute button
            const muteBtn = document.createElement('button');
            muteBtn.className = 'seq-mute-btn' + (this._seqMutedSlots.has(i) ? ' on' : '');
            muteBtn.textContent = 'M';
            muteBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (this._seqMutedSlots.has(i)) {
                    this._seqMutedSlots.delete(i);
                } else {
                    this._seqMutedSlots.add(i);
                }
                this._renderSeqSampleList();
            });
            row.appendChild(muteBtn);

            // Stutter button
            const stutterBtn = document.createElement('button');
            stutterBtn.className = 'seq-stutter-slot-btn' + (this._seqStutterSlots.has(i) ? ' on' : '');
            stutterBtn.textContent = 'ST';
            stutterBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (this._seqStutterSlots.has(i)) {
                    this._seqStutterSlots.delete(i);
                } else {
                    this._seqStutterSlots.add(i);
                }
                // Sync global flag
                this.app.sequencer.stutterEnabled = this._seqStutterSlots.size > 0;
                document.getElementById('seq-stutter-btn').classList.toggle('stutter-on', this._seqStutterSlots.size > 0);
                this._renderSeqSampleList();
            });
            row.appendChild(stutterBtn);

            // Mutate button
            const mutateBtn = document.createElement('button');
            mutateBtn.className = 'seq-mutate-slot-btn' + (this._seqMutateSlots.has(i) ? ' on' : '');
            mutateBtn.textContent = 'MT';
            mutateBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (this._seqMutateSlots.has(i)) {
                    this._seqMutateSlots.delete(i);
                } else {
                    this._seqMutateSlots.add(i);
                }
                // Sync global flag and pre-mutate snapshot
                const wasEnabled = this.app.sequencer.mutateEnabled;
                this.app.sequencer.mutateEnabled = this._seqMutateSlots.size > 0;
                if (this.app.sequencer.mutateEnabled && !wasEnabled) {
                    this._seqPreMutatePattern = this.app.sequencer.toJSON();
                } else if (!this.app.sequencer.mutateEnabled && wasEnabled && this._seqPreMutatePattern) {
                    this.app.sequencer.fromJSON(this._seqPreMutatePattern);
                    this.app.sequencer.mutateEnabled = false;
                    this._seqPreMutatePattern = null;
                    this.renderSeqGrid();
                }
                document.getElementById('seq-mutate-btn').classList.toggle('mutate-on', this._seqMutateSlots.size > 0);
                this._renderSeqSampleList();
                this._saveSeqPattern();
            });
            row.appendChild(mutateBtn);

            // ON/OFF indicator
            const toggleBtn = document.createElement('span');
            toggleBtn.className = 'seq-toggle-btn' + (isOn ? ' on' : '');
            toggleBtn.textContent = isOn ? 'ON' : 'OFF';
            row.appendChild(toggleBtn);

            // Click entire row to toggle
            row.addEventListener('click', (ev) => {
                // Don't toggle if clicking control buttons or trigger zone
                if (ev.target.closest('.seq-trigger-zone')) return;
                if (ev.target.closest('.seq-pitch-btn')) return;
                if (ev.target.closest('.seq-solo-btn') || ev.target.closest('.seq-mute-btn')) return;
                if (ev.target.closest('.seq-stutter-slot-btn') || ev.target.closest('.seq-mutate-slot-btn')) return;
                this.app.sequencer.toggleSlotOnStep(stepIndex, i);
                this._renderSeqSampleList();
                this.renderSeqGrid();
                this._saveSeqPattern();
            });

            // Pitch controls
            const pitchCtrl = document.createElement('div');
            pitchCtrl.className = 'seq-pitch-ctrl';
            const pitchDown = document.createElement('button');
            pitchDown.className = 'seq-pitch-btn';
            pitchDown.innerHTML = '&minus;';
            pitchDown.addEventListener('click', () => {
                const e = this.app.sequencer.getSlotEntry(stepIndex, i);
                if (!e) return;
                this.app.sequencer.setSlotPitch(stepIndex, i, e.pitch - 1);
                this._renderSeqSampleList();
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            const pitchVal = document.createElement('span');
            pitchVal.className = 'seq-pitch-val';
            pitchVal.textContent = pitch > 0 ? '+' + pitch : String(pitch);
            const pitchUp = document.createElement('button');
            pitchUp.className = 'seq-pitch-btn';
            pitchUp.textContent = '+';
            pitchUp.addEventListener('click', () => {
                const e = this.app.sequencer.getSlotEntry(stepIndex, i);
                if (!e) return;
                this.app.sequencer.setSlotPitch(stepIndex, i, e.pitch + 1);
                this._renderSeqSampleList();
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            pitchCtrl.appendChild(pitchDown);
            pitchCtrl.appendChild(pitchVal);
            pitchCtrl.appendChild(pitchUp);
            row.appendChild(pitchCtrl);

            // Gate length button (cycles through fractions of step duration, only when slot is on)
            if (isOn) {
                const gateLens   = [0, 0.25, 0.5, 0.75, 1.0];
                const gateLabels = ['—', '¼', '½', '¾', '1×'];
                const curDur = entry ? (entry.duration || 0) : 0;
                const curIdx = gateLens.findIndex(v => Math.abs(v - curDur) < 0.01);
                const gateBtn = document.createElement('button');
                gateBtn.className = 'seq-gate-btn';
                gateBtn.title = 'Gate length';
                gateBtn.textContent = 'G:' + gateLabels[curIdx >= 0 ? curIdx : 0];
                gateBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const e = this.app.sequencer.getSlotEntry(stepIndex, i);
                    if (!e) return;
                    const ci = gateLens.findIndex(v => Math.abs(v - (e.duration || 0)) < 0.01);
                    const next = gateLens[(ci + 1) % gateLens.length];
                    this.app.sequencer.setSlotDuration(stepIndex, i, next);
                    this._renderSeqSampleList();
                    this._saveSeqPattern();
                });
                row.appendChild(gateBtn);
            }

            container.appendChild(row);
        }
    }

    openStepModeMenu(stepIndex, e) {
        const step = this.app.sequencer.pattern[stepIndex];
        this._seqModeMenuStep = stepIndex;
        const menu = document.getElementById('step-mode-menu');

        // Remove any previous close handler so it doesn't immediately hide this menu
        if (this._stepMenuCloseHandler) {
            document.removeEventListener('click', this._stepMenuCloseHandler);
            this._stepMenuCloseHandler = null;
        }

        // Position: centered if from tap, or at pointer if from context menu
        if (e._useCentered) {
            const stepEl = document.querySelectorAll('#slot-grid .slot')[stepIndex];
            if (stepEl) {
                const rect = stepEl.getBoundingClientRect();
                menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
                menu.style.top = Math.max(0, rect.top - 200) + 'px';
            } else {
                menu.style.left = '50%';
                menu.style.top = '40%';
            }
        } else {
            const x = (e.clientX || e.pageX || 0);
            const y = (e.clientY || e.pageY || 0);
            menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
            menu.style.top = Math.min(y, window.innerHeight - 260) + 'px';
        }
        menu.hidden = false;

        // Populate slot picker with checkboxes + per-slot pitch
        const picker = document.getElementById('step-slot-picker');
        picker.innerHTML = '';
        for (let i = 0; i < 16; i++) {
            const slot = this.app.slots.slots[i];
            if (!slot.hasAudio) continue;
            const entry = this.app.sequencer.getSlotEntry(stepIndex, i);
            const checked = !!entry;
            const pitch = entry ? entry.pitch : 0;
            const row = document.createElement('div');
            row.className = 'step-slot-option' + (checked ? ' checked' : '');
            row.innerHTML = `
                <input type="checkbox" data-slot-idx="${i}" ${checked ? 'checked' : ''}>
                <span class="slot-opt-num">${String(i + 1).padStart(2, '0')}</span>
                <span class="slot-opt-name">${slot.name || 'untitled'}</span>
                <button class="step-pitch-btn slot-pitch-down" data-slot="${i}">&minus;</button>
                <span class="slot-pitch-val" data-slot="${i}">${pitch > 0 ? '+' + pitch : pitch}</span>
                <button class="step-pitch-btn slot-pitch-up" data-slot="${i}">+</button>
            `;
            const cb = row.querySelector('input');
            cb.addEventListener('change', (ev) => {
                this.app.sequencer.toggleSlotOnStep(stepIndex, i);
                row.classList.toggle('checked', ev.target.checked);
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            const pitchDown = row.querySelector('.slot-pitch-down');
            const pitchUp = row.querySelector('.slot-pitch-up');
            const pitchVal = row.querySelector('.slot-pitch-val');
            pitchDown.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const e = this.app.sequencer.getSlotEntry(stepIndex, i);
                if (!e) return;
                this.app.sequencer.setSlotPitch(stepIndex, i, e.pitch - 1);
                pitchVal.textContent = e.pitch > 0 ? '+' + e.pitch : e.pitch;
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            pitchUp.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const e = this.app.sequencer.getSlotEntry(stepIndex, i);
                if (!e) return;
                this.app.sequencer.setSlotPitch(stepIndex, i, e.pitch + 1);
                pitchVal.textContent = e.pitch > 0 ? '+' + e.pitch : e.pitch;
                this.renderSeqGrid();
                this._saveSeqPattern();
            });
            picker.appendChild(row);
        }

        // Update active states for mode/direction
        menu.querySelectorAll('button').forEach(btn => {
            if (btn.dataset.mode) {
                btn.classList.toggle('active', btn.dataset.mode === step.mode);
            }
            if (btn.dataset.dir) {
                btn.classList.toggle('active', btn.dataset.dir === step.direction);
            }
        });

        const close = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.hidden = true;
                document.removeEventListener('click', close);
                this._stepMenuCloseHandler = null;
            }
        };
        this._stepMenuCloseHandler = close;
        setTimeout(() => document.addEventListener('click', close), 10);
    }

    _setStepMode(mode) {
        if (this._seqModeMenuStep < 0) return;
        this.app.sequencer.setStepMode(this._seqModeMenuStep, mode);
        this.renderSeqGrid();
        this._saveSeqPattern();

        // Update menu active states
        document.querySelectorAll('#step-mode-menu button[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
    }

    _setStepDirection(dir) {
        if (this._seqModeMenuStep < 0) return;
        this.app.sequencer.setStepDirection(this._seqModeMenuStep, dir);
        // Invalidate reverse buffer cache for all slots on this step
        const step = this.app.sequencer.pattern[this._seqModeMenuStep];
        for (const entry of step.slots) {
            this.app.sequencer.invalidateBuffer(entry.slot);
        }
        this.renderSeqGrid();
        this._saveSeqPattern();

        document.querySelectorAll('#step-mode-menu button[data-dir]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.dir === dir);
        });
    }

    // Per-slot pitch is now handled inline in the step mode menu slot picker

    // Sequencer transport
    async seqPlayStop() {
        await this.app.ensureAudioInit();
        if (!this.app.audio.audioContext) return;
        this.app.sequencer.audioContext = this.app.audio.audioContext;
        this.app.sequencer.outputNode = this.app.audio.getEffectsBus();

        if (this.app.sequencer.playing) {
            this.app.sequencer.stop();
            this._seqStopAnimation();
            document.getElementById('seq-play-btn').innerHTML = '&#9654; PLAY';
            // Auto-disable recording
            if (this.app._seqRecording) {
                this.app._seqRecording = false;
                document.getElementById('seq-rec-btn').classList.remove('rec-on');
            }
            // MIDI: send stop + all notes off
            if (this.app.midi && this.app.midi.activeOutput) {
                this.app.midi.sendClockStop();
                this.app.midi.sendCC(123, 0); // All notes off
            }
        } else {
            // Stop main waveform playback if active
            this.app.rec.stopAudio();
            // Preload any new buffers
            await this._seqPreloadBuffers();
            this.app.sequencer.play();
            this._seqStartAnimation();
            document.getElementById('seq-play-btn').innerHTML = '&#9632; STOP';
            // MIDI: send start
            if (this.app.midi && this.app.midi.activeOutput && this.app.midi.clockMode === 'send') {
                this.app.midi.sendClockStart();
            }
            // Show seq transport if starting from sample mode
            if (this.app._sampleMode) {
                this.app._seqShowTransportInSample = true;
                document.getElementById('seq-transport').classList.add('active');
            }
        }
    }

    _seqStartAnimation() {
        const animate = () => {
            this._seqAnimFrame = requestAnimationFrame(animate);
        };
        this._seqAnimFrame = requestAnimationFrame(animate);
    }

    _seqStopAnimation() {
        if (this._seqAnimFrame) {
            cancelAnimationFrame(this._seqAnimFrame);
            this._seqAnimFrame = null;
        }
        // Clear step highlight
        document.querySelectorAll('#slot-grid .slot').forEach(el => {
            el.classList.remove('step-active');
        });
    }

    _seqHighlightStep(stepIndex) {
        const slotEls = document.querySelectorAll('#slot-grid .slot');
        slotEls.forEach((el, i) => {
            el.classList.toggle('step-active', i === stepIndex);
        });
    }

    _seqFlashSampleRows(stepIndex) {
        const step = this.app.sequencer.pattern[stepIndex];
        if (!step || step.slots.length === 0) return;
        const rows = document.querySelectorAll('#seq-sample-list .seq-sample-row');
        for (const entry of step.slots) {
            for (const row of rows) {
                if (parseInt(row.dataset.slotIdx) === entry.slot) {
                    row.classList.remove('seq-triggered');
                    void row.offsetWidth;
                    row.classList.add('seq-triggered');
                }
            }
        }
    }

    _seqFlashPads(stepIndex) {
        if (!this.app._sampleMode) return;
        const step = this.app.sequencer.pattern[stepIndex];
        if (!step || step.slots.length === 0) return;
        const slotEls = document.querySelectorAll('#slot-grid .slot');
        for (const entry of step.slots) {
            const el = slotEls[entry.slot];
            if (!el) continue;
            el.classList.add('pad-active');
            setTimeout(() => el.classList.remove('pad-active'), 150);
        }
    }

    _seqFlashMutate(stepIndex) {
        const el = document.querySelectorAll('#slot-grid .slot')[stepIndex];
        if (!el) return;
        el.classList.remove('step-mutated');
        // Force reflow
        void el.offsetWidth;
        el.classList.add('step-mutated');
    }

    seqAdjustBpm(delta) {
        this.app.sequencer.setBpm(this.app.sequencer.bpm + delta);
        this._updateBpmDisplay();
        this._saveSeqPattern();
    }

    seqEditBpm() {
        const input = prompt('BPM:', this.app.sequencer.bpm);
        if (input !== null) {
            const bpm = parseInt(input);
            if (!isNaN(bpm)) {
                this.app.sequencer.setBpm(bpm);
                this._updateBpmDisplay();
                this._saveSeqPattern();
            }
        }
    }

    seqTapTempo() {
        this.app.sequencer.tapTempo();
        this._updateBpmDisplay();
        this._saveSeqPattern();
    }

    _updateBpmDisplay() {
        document.getElementById('bpm-display').textContent = this.app.sequencer.bpm;
    }

    seqRandomise() {
        this.app.sequencer.stutterEnabled = false;
        this._seqPreMutatePattern = null;
        this.app.sequencer.mutateEnabled = false;
        this._seqStutterSlots.clear();
        this._seqMutateSlots.clear();
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
        document.getElementById('seq-mutate-btn').classList.remove('mutate-on');
        this.app.sequencer.randomise(0.75);
        this.renderSeqGrid();
        this._saveSeqPattern();
    }

    seqStutter() {
        // Global toggle: enable/disable stutter for ALL loaded slots
        const anyOn = this._seqStutterSlots.size > 0;
        if (anyOn) {
            this._seqStutterSlots.clear();
            this.app.sequencer.stutterEnabled = false;
        } else {
            for (let i = 0; i < 16; i++) {
                if (this.app.slots.slots[i].hasAudio) this._seqStutterSlots.add(i);
            }
            this.app.sequencer.stutterEnabled = true;
        }
        document.getElementById('seq-stutter-btn').classList.toggle('stutter-on', this._seqStutterSlots.size > 0);
        if (this._seqModeMenuStep >= 0) this._renderSeqSampleList();
    }

    seqToggleMutate() {
        // Global toggle: enable/disable mutate for ALL loaded slots
        const anyOn = this._seqMutateSlots.size > 0;
        if (anyOn) {
            this._seqMutateSlots.clear();
            this.app.sequencer.mutateEnabled = false;
            // Restore original pattern
            if (this._seqPreMutatePattern) {
                this.app.sequencer.fromJSON(this._seqPreMutatePattern);
                // fromJSON restores mutateEnabled from snapshot, force it off
                this.app.sequencer.mutateEnabled = false;
                this._seqPreMutatePattern = null;
                this.renderSeqGrid();
            }
        } else {
            for (let i = 0; i < 16; i++) {
                if (this.app.slots.slots[i].hasAudio) this._seqMutateSlots.add(i);
            }
            this.app.sequencer.mutateEnabled = true;
            this._seqPreMutatePattern = this.app.sequencer.toJSON();
        }
        document.getElementById('seq-mutate-btn').classList.toggle('mutate-on', this._seqMutateSlots.size > 0);
        if (this._seqModeMenuStep >= 0) this._renderSeqSampleList();
        this._saveSeqPattern();
    }

    seqClear() {
        this.app.sequencer.stutterEnabled = false;
        this._seqPreMutatePattern = null;
        this.app.sequencer.mutateEnabled = false;
        this._seqStutterSlots.clear();
        this._seqMutateSlots.clear();
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
        document.getElementById('seq-mutate-btn').classList.remove('mutate-on');
        this.app.sequencer.clearPattern();
        this.renderSeqGrid();
        this._saveSeqPattern();
    }

    async seqBounce() {
        if (!this.app.audio.audioContext) return;
        this.app.sequencer.audioContext = this.app.audio.audioContext;

        const numLoopsStr = prompt('Number of pattern loops to render:', '1');
        if (numLoopsStr === null) return;
        const numLoops = Math.max(1, Math.min(8, parseInt(numLoopsStr) || 1));

        // Preload buffers
        await this._seqPreloadBuffers();

        try {
            const result = await this.app.sequencer.bounce(numLoops);
            if (!result || !result.channels || result.channels[0].length === 0) {
                alert('Pattern is empty — nothing to bounce');
                return;
            }

            // Find empty slot
            const emptyIdx = this.app.slots.findEmptySlot();
            if (emptyIdx < 0) {
                alert('No empty slots — clear a slot first');
                return;
            }

            await this.app.slots.saveSlotAudio(emptyIdx, result.channels, result.sampleRate);
            this.app.slots.slots[emptyIdx].name = 'seq-bounce';
            await this.app.slots.renameSlot(emptyIdx, 'seq-bounce');

            // Also update sequencer buffer cache
            if (this.app.audio.audioContext) {
                const buf = this.app.audio.audioContext.createBuffer(
                    result.channels.length,
                    result.channels[0].length,
                    result.sampleRate
                );
                for (let ch = 0; ch < result.channels.length; ch++) {
                    buf.getChannelData(ch).set(result.channels[ch]);
                }
                this.app._slotBuffers[emptyIdx] = buf;
            }

            this.renderSeqGrid();
            alert(`Bounced to slot ${emptyIdx + 1}`);
        } catch (e) {
            console.error('Bounce failed:', e);
            alert('Bounce failed: ' + e.message);
        }
    }

    // === Live Recording into Sequencer (Looper) ===

    async seqToggleRecord() {
        this.app._seqRecording = !this.app._seqRecording;
        document.getElementById('seq-rec-btn').classList.toggle('rec-on', this.app._seqRecording);
        if (this.app._seqRecording) {
            // Snapshot pattern for undo before this recording pass
            this._seqLooperUndoStack.push(this.app.sequencer.toJSON());
            // Cap undo stack at 20 layers
            if (this._seqLooperUndoStack.length > 20) this._seqLooperUndoStack.shift();
            // If seq not playing, start playback
            if (!this.app.sequencer.playing) {
                await this.seqPlayStop();
            }
        }
    }

    seqLooperUndo() {
        if (this._seqLooperUndoStack.length === 0) return;
        const snapshot = this._seqLooperUndoStack.pop();
        this.app.sequencer.fromJSON(snapshot);
        if (this.app._seqMode) this.renderSeqGrid();
        this._saveSeqPattern();
    }

    _seqTriggerFromList(slotIndex) {
        // Audition the sound
        if (this.app.sampler) {
            this.app.sampler.trigger(slotIndex);
        }
        // Visual flash
        const rows = document.querySelectorAll('#seq-sample-list .seq-sample-row');
        for (const row of rows) {
            if (parseInt(row.dataset.slotIdx) === slotIndex) {
                row.classList.remove('seq-triggered');
                void row.offsetWidth;
                row.classList.add('seq-triggered');
            }
        }
        // Record if in recording mode and playing
        if (this.app._seqRecording && this.app.sequencer.playing) {
            this._recordPadToStep(slotIndex, 0, 'list:' + slotIndex);
        }
    }

    _seqTriggerRelease(slotIndex) {
        if (this.app.sampler) {
            this.app.sampler.release(slotIndex);
        }
        if (this.app._seqRecording) {
            this._recordNoteOff('list:' + slotIndex);
        }
    }

    _recordPadToStep(slotIndex, pitch, trackingKey) {
        if (!this.app._seqRecording || !this.app.sequencer.playing) return;
        const step = this.app.sequencer.currentStep;
        if (step < 0) return;
        if (pitch !== undefined) {
            // Chromatic recording: add with specific pitch, duration TBD on release
            this.app.sequencer.addSlotToStep(step, slotIndex, pitch, 0);
            // Track the note for duration calculation on release
            const entry = this.app.sequencer.pattern[step].slots[this.app.sequencer.pattern[step].slots.length - 1];
            if (trackingKey) {
                this._seqRecordingNotes.set(trackingKey, { step, entry });
            }
        } else {
            // Pad recording: add with duration TBD on release
            this.app.sequencer.addSlotToStep(step, slotIndex, 0, 0);
            const entry = this.app.sequencer.pattern[step].slots[this.app.sequencer.pattern[step].slots.length - 1];
            if (trackingKey) {
                this._seqRecordingNotes.set(trackingKey, { step, entry });
            }
        }
        if (this.app._seqMode) {
            this.renderSeqGrid();
            if (this._seqModeMenuStep === step) this._renderSeqSampleList();
        }
        this._saveSeqPattern();
    }

    _recordNoteOff(trackingKey) {
        if (!this._seqRecordingNotes.has(trackingKey)) return;
        const { step: startStep, entry } = this._seqRecordingNotes.get(trackingKey);
        this._seqRecordingNotes.delete(trackingKey);
        if (!this.app.sequencer.playing) return;
        const currentStep = this.app.sequencer.currentStep;
        // Calculate duration in steps (wrapping around pattern)
        const patLen = this.app.sequencer.pattern.length;
        let dur = currentStep - startStep;
        if (dur <= 0) dur += patLen;
        // Clamp to reasonable range (1 to pattern length)
        dur = Math.max(1, Math.min(patLen, dur));
        entry.duration = dur;
        this._saveSeqPattern();
    }

    // Persistence (with 16 banks)
    _saveSeqPattern() {
        try {
            // Ensure banks array exists
            if (!this._seqBanks) {
                this._seqBanks = new Array(16).fill(null);
            }
            // Save current pattern into current bank
            this._seqBanks[this._seqBankIndex] = this.app.sequencer.toJSON();
            const data = {
                currentBank: this._seqBankIndex,
                banks: this._seqBanks
            };
            localStorage.setItem('soniphorm-seq-banks', JSON.stringify(data));
        } catch (e) {
            console.warn('Failed to save seq pattern:', e);
        }
    }

    _loadSeqPattern() {
        try {
            // Try new bank format first
            const banksJson = localStorage.getItem('soniphorm-seq-banks');
            if (banksJson) {
                const data = JSON.parse(banksJson);
                this._seqBankIndex = data.currentBank || 0;
                this._seqBanks = data.banks || new Array(16).fill(null);
                // Ensure 16 banks
                while (this._seqBanks.length < 16) this._seqBanks.push(null);
                const bankData = this._seqBanks[this._seqBankIndex];
                if (bankData) {
                    this.app.sequencer.fromJSON(bankData);
                }
                return;
            }
            // Fall back to old single-pattern format (migration)
            const json = localStorage.getItem('soniphorm-seq-pattern');
            if (json) {
                this.app.sequencer.fromJSON(JSON.parse(json));
                // Migrate: save into bank 0
                this._seqBanks = new Array(16).fill(null);
                this._seqBanks[0] = this.app.sequencer.toJSON();
                this._seqBankIndex = 0;
                this._saveSeqPattern();
                // Remove old key
                localStorage.removeItem('soniphorm-seq-pattern');
            } else {
                this._seqBanks = new Array(16).fill(null);
            }
        } catch (e) {
            console.warn('Failed to load seq pattern:', e);
            this._seqBanks = new Array(16).fill(null);
        }
    }

    seqSwitchBank(newIndex) {
        // Clamp to 0-15
        newIndex = Math.max(0, Math.min(15, newIndex));
        if (newIndex === this._seqBankIndex) return;

        // Save current pattern to current bank
        if (!this._seqBanks) this._seqBanks = new Array(16).fill(null);
        this._seqBanks[this._seqBankIndex] = this.app.sequencer.toJSON();

        // Load new bank
        this._seqBankIndex = newIndex;
        const bankData = this._seqBanks[newIndex];
        if (bankData) {
            this.app.sequencer.fromJSON(bankData);
        } else {
            this.app.sequencer.clearPattern();
        }

        // Clear stutter/mutate state
        this.app.sequencer.stutterEnabled = false;
        this._seqPreMutatePattern = null;
        this.app.sequencer.mutateEnabled = false;
        this._seqStutterSlots.clear();
        this._seqMutateSlots.clear();
        document.getElementById('seq-stutter-btn').classList.remove('stutter-on');
        document.getElementById('seq-mutate-btn').classList.remove('mutate-on');
        document.getElementById('seq-rev-btn').classList.toggle('rev-on', this.app.sequencer.reverse);
        document.getElementById('seq-speed-btn').textContent = this.app.sequencer.speed + 'x';

        // Sync step count dropdown and rebuild grid for new bank's step count
        const stepSelect = document.getElementById('seq-step-count');
        if (stepSelect) stepSelect.value = this.app.sequencer.stepCount;
        this.app.buildSlotGrid();

        // Update display
        this.renderSeqGrid();
        this._updateBpmDisplay();
        this._updateBankDisplay();
        this._saveSeqPattern();
        if (this._seqModeMenuStep >= 0) this._renderSeqSampleList();
    }

    _seqPreviewBank(delta) {
        const current = this._seqPreviewBankIndex !== null ? this._seqPreviewBankIndex : this._seqBankIndex;
        const newIndex = Math.max(0, Math.min(15, current + delta));
        if (newIndex === this._seqBankIndex && this._seqPreviewBankIndex === null) {
            // Already on active bank, try to move
            const next = Math.max(0, Math.min(15, newIndex + delta));
            if (next === this._seqBankIndex) return;
            this._seqPreviewBankIndex = next;
        } else if (newIndex === this._seqBankIndex) {
            // Returned to active bank — cancel preview
            this._seqPreviewBankIndex = null;
        } else {
            this._seqPreviewBankIndex = newIndex;
        }
        this._updateBankDisplay();
        // Show previewed pattern in grid
        if (this._seqPreviewBankIndex !== null) {
            if (!this._seqBanks) this._seqBanks = new Array(16).fill(null);
            // Save current first
            this._seqBanks[this._seqBankIndex] = this.app.sequencer.toJSON();
            const bankData = this._seqBanks[this._seqPreviewBankIndex];
            if (bankData) {
                this.app.sequencer.fromJSON(bankData);
            } else {
                this.app.sequencer.clearPattern();
            }
            this.renderSeqGrid();
            this._renderSeqSampleList();
            // Restore active pattern back (preview is visual only)
            const activeData = this._seqBanks[this._seqBankIndex];
            if (activeData) {
                this.app.sequencer.fromJSON(activeData);
            } else {
                this.app.sequencer.clearPattern();
            }
        } else {
            this.renderSeqGrid();
            this._renderSeqSampleList();
        }
    }

    _seqConfirmBank() {
        if (this._seqPreviewBankIndex === null) return;
        if (this.app.sequencer && this.app.sequencer.playing) {
            // Queue: switch at end of current pattern loop
            this._seqQueuedBankIndex = this._seqPreviewBankIndex;
            this._updateBankDisplay();
        } else {
            // Not playing: switch immediately
            this.seqSwitchBank(this._seqPreviewBankIndex);
            this._seqPreviewBankIndex = null;
            this._seqQueuedBankIndex = null;
            this._updateBankDisplay();
        }
    }

    _updateBankDisplay() {
        const label = document.getElementById('zoom-fit');
        label.classList.remove('pat-active', 'pat-preview', 'pat-queued');
        if (this.app._seqMode) {
            if (this._seqQueuedBankIndex !== null) {
                // Confirmed but waiting for loop end — show queued pattern, green
                label.textContent = 'PAT ' + String(this._seqQueuedBankIndex + 1).padStart(2, '0');
                label.classList.add('pat-queued');
            } else if (this._seqPreviewBankIndex !== null) {
                // Browsing but not confirmed — orange
                label.textContent = '>' + String(this._seqPreviewBankIndex + 1).padStart(2, '0') + '<';
                label.classList.add('pat-preview');
            } else {
                // Showing active pattern — green
                label.textContent = 'PAT ' + String(this._seqBankIndex + 1).padStart(2, '0');
                label.classList.add('pat-active');
            }
            label.style.color = '';
        } else {
            label.textContent = '[ ]';
            label.style.color = '';
        }
    }

    // === Drum Grid ===

    _toggleDrumGrid() {
        this.app._drumGridView = !this.app._drumGridView;
        const drumGridEl = document.getElementById('drum-grid');
        const sampleList = document.getElementById('seq-sample-list');
        const btn = document.getElementById('seq-drum-grid-btn');

        if (this.app._drumGridView) {
            sampleList.hidden = true;
            drumGridEl.hidden = false;
            btn.classList.add('loop-on');
            this._renderDrumGrid();
        } else {
            sampleList.hidden = false;
            drumGridEl.hidden = true;
            btn.classList.remove('loop-on');
            this._renderSeqSampleList();
        }
    }

    _renderDrumGrid() {
        const container = document.getElementById('drum-grid');
        const stepCount = this.app.sequencer.stepCount;
        const parentSlot = this.app._kitParentSlot;

        container.style.gridTemplateColumns = `80px repeat(${stepCount}, 1fr)`;
        container.innerHTML = '';

        const GM_NOTE_NAMES = ['C2','C#2','D2','D#2','E2','F2','F#2','G2','G#2','A2','A#2','B2','C3','C#3','D3','D#3'];

        for (let sub = 0; sub < 16; sub++) {
            // Row label
            const label = document.createElement('div');
            label.className = 'drum-grid-label';
            const meta = this.app.slots.getKitSlotMeta(parentSlot, sub);
            const name = (meta && meta.name) || '';
            label.textContent = `${GM_NOTE_NAMES[sub]} ${name}`;
            container.appendChild(label);

            // Step cells
            for (let step = 0; step < stepCount; step++) {
                const cell = document.createElement('div');
                cell.className = 'drum-grid-cell';
                if (step % 4 === 0) cell.classList.add('beat-marker');

                const entry = this.app.sequencer.getKitSubEntry(step, parentSlot, sub);
                if (entry) {
                    const v = entry.velocity || 80;
                    if (v <= 40) cell.classList.add('active', 'vel-ghost');
                    else if (v <= 80) cell.classList.add('active', 'vel-med');
                    else if (v <= 100) cell.classList.add('active', 'vel-high');
                    else cell.classList.add('active', 'vel-max');
                }

                if (this.app.sequencer.currentStep === step) cell.classList.add('playing');

                cell.addEventListener('click', () => {
                    this.app.sequencer.toggleKitSubOnStep(step, parentSlot, sub);
                    this._renderDrumGrid();
                    this._saveSeqPattern();
                });

                container.appendChild(cell);
            }
        }
    }

    _updateDrumGridStep(stepIndex) {
        if (!this.app._drumGridView) return;
        const container = document.getElementById('drum-grid');
        const cells = container.querySelectorAll('.drum-grid-cell');
        const stepCount = this.app.sequencer.stepCount;

        cells.forEach((cell, idx) => {
            const step = idx % stepCount;
            cell.classList.toggle('playing', step === stepIndex);
        });
    }
}
