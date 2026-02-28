/**
 * MidiManager — Web MIDI API wrapper for Soniphorm Soundlab.
 * Handles MIDI input/output, learn mode, CC mappings, and clock sync.
 */
class MidiManager {
    constructor() {
        this.midiAccess = null;
        this.inputs = [];       // [{id, name, port}]
        this.outputs = [];      // [{id, name, port}]
        this.activeInput = null;
        this.activeOutput = null;
        this.channel = 0;       // 0-15 (0 = omni)
        this.outChannel = 0;    // 0-15 output channel

        // CC Mappings: { [ccNumber]: { type: 'macro', index: 0-3 } }
        this.ccMappings = {};

        // MIDI Learn state
        this._learning = false;
        this._learnTarget = null; // { type: 'macro', index: 0-3 }

        // Clock
        this.clockMode = 'off'; // 'off' | 'send' | 'receive'
        this._clockTickTimes = [];
        this._clockTickCount = 0;

        // Callbacks
        this.onNoteOn = null;       // (note, velocity) => void
        this.onNoteOff = null;      // (note) => void
        this.onCC = null;           // (cc, value, mapping) => void
        this.onClockTick = null;    // () => void
        this.onClockStart = null;   // () => void
        this.onClockStop = null;    // () => void
        this.onPortsChanged = null; // () => void
        this.onLearnComplete = null; // (target, cc) => void
        this.onLearnCancel = null;  // () => void
        this.onBpmEstimate = null;  // (bpm) => void
    }

    async init() {
        if (!navigator.requestMIDIAccess) return false;
        try {
            this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
            this.midiAccess.onstatechange = () => {
                this._refreshPorts();
                if (this.onPortsChanged) this.onPortsChanged();
            };
            this._refreshPorts();
            this._loadSettings();
            return true;
        } catch (e) {
            console.warn('MIDI access denied:', e);
            return false;
        }
    }

    // === Port Management ===

    _refreshPorts() {
        if (!this.midiAccess) return;
        this.inputs = [];
        this.outputs = [];
        for (const [id, port] of this.midiAccess.inputs) {
            this.inputs.push({ id, name: port.name || id, port });
        }
        for (const [id, port] of this.midiAccess.outputs) {
            this.outputs.push({ id, name: port.name || id, port });
        }
        // Re-validate active ports
        if (this.activeInput && !this.inputs.find(p => p.id === this.activeInput.id)) {
            this.activeInput = null;
        }
        if (this.activeOutput && !this.outputs.find(p => p.id === this.activeOutput.id)) {
            this.activeOutput = null;
        }
    }

    selectInput(portId) {
        // Disconnect previous
        if (this.activeInput && this.activeInput.port) {
            this.activeInput.port.onmidimessage = null;
        }
        if (!portId) {
            this.activeInput = null;
            this._saveSettings();
            return;
        }
        const entry = this.inputs.find(p => p.id === portId);
        if (!entry) return;
        this.activeInput = entry;
        entry.port.onmidimessage = (e) => this._handleMessage(e);
        this._saveSettings();
    }

    selectOutput(portId) {
        if (!portId) {
            this.activeOutput = null;
            this._saveSettings();
            return;
        }
        const entry = this.outputs.find(p => p.id === portId);
        if (!entry) return;
        this.activeOutput = entry;
        this._saveSettings();
    }

    // === Message Parsing ===

    _handleMessage(event) {
        const data = event.data;
        if (!data || data.length === 0) return;
        const status = data[0];

        // System real-time messages (no channel)
        if (status >= 0xF8) {
            switch (status) {
                case 0xF8: // Clock tick
                    if (this.clockMode === 'receive') {
                        this._handleClockTick();
                    }
                    return;
                case 0xFA: // Start
                    if (this.clockMode === 'receive' && this.onClockStart) {
                        this.onClockStart();
                    }
                    return;
                case 0xFC: // Stop
                    if (this.clockMode === 'receive' && this.onClockStop) {
                        this.onClockStop();
                    }
                    return;
            }
            return;
        }

        // Channel messages
        const msgType = status & 0xF0;
        const msgChannel = status & 0x0F;

        // Channel filter (0 = omni, accept all)
        if (this.channel > 0 && msgChannel !== (this.channel - 1)) return;

        switch (msgType) {
            case 0x90: { // Note On
                const note = data[1];
                const velocity = data[2];
                if (velocity === 0) {
                    // Note On with vel 0 = Note Off
                    if (this.onNoteOff) this.onNoteOff(note);
                } else {
                    if (this.onNoteOn) this.onNoteOn(note, velocity);
                }
                break;
            }
            case 0x80: { // Note Off
                const note = data[1];
                if (this.onNoteOff) this.onNoteOff(note);
                break;
            }
            case 0xB0: { // Control Change
                const cc = data[1];
                const value = data[2];
                this._handleCC(cc, value);
                break;
            }
        }
    }

    _handleCC(cc, value) {
        // MIDI Learn mode: map first CC received to target
        if (this._learning && this._learnTarget) {
            // Remove any existing mapping for this CC
            delete this.ccMappings[cc];
            // Remove any existing mapping for this target
            for (const [key, mapping] of Object.entries(this.ccMappings)) {
                if (mapping.type === this._learnTarget.type && mapping.index === this._learnTarget.index) {
                    delete this.ccMappings[key];
                }
            }
            this.ccMappings[cc] = { ...this._learnTarget };
            const target = this._learnTarget;
            this._learning = false;
            this._learnTarget = null;
            this._saveSettings();
            if (this.onLearnComplete) this.onLearnComplete(target, cc);
            // Also route this first CC value
            if (this.onCC) this.onCC(cc, value, this.ccMappings[cc]);
            return;
        }

        // Route through existing mappings
        const mapping = this.ccMappings[cc];
        if (mapping && this.onCC) {
            this.onCC(cc, value, mapping);
        }
    }

    _handleClockTick() {
        this._clockTickCount++;
        if (this.onClockTick) this.onClockTick();

        // Estimate BPM from 24 PPQ ticks
        const now = performance.now();
        this._clockTickTimes.push(now);
        if (this._clockTickTimes.length > 48) {
            this._clockTickTimes.shift();
        }
        if (this._clockTickTimes.length >= 24) {
            const span = this._clockTickTimes[this._clockTickTimes.length - 1] - this._clockTickTimes[0];
            const ticks = this._clockTickTimes.length - 1;
            const msPerTick = span / ticks;
            const bpm = Math.round(60000 / (msPerTick * 24));
            if (bpm >= 20 && bpm <= 300 && this.onBpmEstimate) {
                this.onBpmEstimate(bpm);
            }
        }
    }

    // === MIDI Output ===

    _send(bytes) {
        if (!this.activeOutput || !this.activeOutput.port) return;
        this.activeOutput.port.send(bytes);
    }

    sendNoteOn(note, velocity) {
        const ch = this.outChannel > 0 ? (this.outChannel - 1) : 0;
        this._send([0x90 | ch, note & 0x7F, velocity & 0x7F]);
    }

    sendNoteOff(note) {
        const ch = this.outChannel > 0 ? (this.outChannel - 1) : 0;
        this._send([0x80 | ch, note & 0x7F, 0]);
    }

    sendCC(cc, value) {
        const ch = this.outChannel > 0 ? (this.outChannel - 1) : 0;
        this._send([0xB0 | ch, cc & 0x7F, value & 0x7F]);
    }

    sendClockTick() {
        this._send([0xF8]);
    }

    sendClockStart() {
        this._send([0xFA]);
    }

    sendClockStop() {
        this._send([0xFC]);
    }

    // === MIDI Learn ===

    startLearn(target) {
        this._learning = true;
        this._learnTarget = target;
    }

    cancelLearn() {
        this._learning = false;
        this._learnTarget = null;
        if (this.onLearnCancel) this.onLearnCancel();
    }

    isLearning() {
        return this._learning;
    }

    clearMappingForTarget(target) {
        for (const [cc, mapping] of Object.entries(this.ccMappings)) {
            if (mapping.type === target.type && mapping.index === target.index) {
                delete this.ccMappings[cc];
            }
        }
        this._saveSettings();
    }

    getMappingForTarget(target) {
        for (const [cc, mapping] of Object.entries(this.ccMappings)) {
            if (mapping.type === target.type && mapping.index === target.index) {
                return { cc: parseInt(cc), mapping };
            }
        }
        return null;
    }

    // === Persistence ===

    _saveSettings() {
        try {
            const data = {
                inputId: this.activeInput ? this.activeInput.id : null,
                outputId: this.activeOutput ? this.activeOutput.id : null,
                channel: this.channel,
                outChannel: this.outChannel,
                clockMode: this.clockMode,
                ccMappings: this.ccMappings
            };
            localStorage.setItem('soniphorm-midi', JSON.stringify(data));
        } catch (e) {
            console.warn('Failed to save MIDI settings:', e);
        }
    }

    _loadSettings() {
        try {
            const json = localStorage.getItem('soniphorm-midi');
            if (!json) return;
            const data = JSON.parse(json);
            if (data.channel !== undefined) this.channel = data.channel;
            if (data.outChannel !== undefined) this.outChannel = data.outChannel;
            if (data.clockMode) this.clockMode = data.clockMode;
            if (data.ccMappings) this.ccMappings = data.ccMappings;
            // Restore ports (may not be available yet on first load)
            if (data.inputId) this.selectInput(data.inputId);
            if (data.outputId) this.selectOutput(data.outputId);
        } catch (e) {
            console.warn('Failed to load MIDI settings:', e);
        }
    }
}
