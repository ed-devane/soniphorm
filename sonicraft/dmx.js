/**
 * DmxController — Web Serial wrapper for the Enttec DMX USB Pro.
 *
 * Protocol: packets are framed as
 *   0x7E | label | len_lo | len_hi | data... | 0xE7
 * Label 0x06 = "Output Only Send DMX Packet". Data is the DMX start code
 * (0x00) followed by up to 512 channel bytes. The box's onboard MCU handles
 * the 250 kbit/s DMX timing (break, MAB, frame), so from the app side it's
 * just a USB serial write.
 */

const DMX_START = 0x7E;
const DMX_END = 0xE7;
const DMX_LABEL_OUTPUT = 0x06;
const DMX_UNIVERSE_SIZE = 512;
const DMX_REFRESH_HZ = 40;

class DmxController {
    constructor() {
        this.port = null;
        this.writer = null;
        this.connected = false;

        // 513-byte buffer: [0] = start code 0x00, [1..512] = channels.
        // Channel N (1-indexed DMX) lives at buffer[N].
        this._buffer = new Uint8Array(DMX_UNIVERSE_SIZE + 1);
        this._dirty = false;
        this._flushTimer = null;
        this._writing = false;

        // Callbacks
        this.onConnect = null;     // () => void
        this.onDisconnect = null;  // () => void
        this.onError = null;       // (err) => void
    }

    isSupported() {
        return 'serial' in navigator;
    }

    // === Connection ===

    /**
     * Prompt the user to pick a serial port and connect to it.
     * Filters for FTDI (Enttec uses FTDI chips) but user can override.
     */
    async connect() {
        if (!this.isSupported()) {
            throw new Error('Web Serial not supported — use Chrome or Edge on desktop.');
        }
        if (this.connected) return;

        const port = await navigator.serial.requestPort({
            filters: [{ usbVendorId: 0x0403 }] // FTDI
        });
        await this._openPort(port);
    }

    /**
     * Try to reconnect to a previously-authorized port without a user prompt.
     * Returns true if reconnected.
     */
    async tryAutoConnect() {
        if (!this.isSupported()) return false;
        const ports = await navigator.serial.getPorts();
        if (ports.length === 0) return false;
        // Prefer FTDI
        const ftdi = ports.find(p => {
            const info = p.getInfo();
            return info.usbVendorId === 0x0403;
        });
        const port = ftdi || ports[0];
        try {
            await this._openPort(port);
            return true;
        } catch (e) {
            console.warn('DMX auto-connect failed:', e);
            return false;
        }
    }

    async _openPort(port) {
        // 57600 is the documented Enttec USB baud. Since it's an FTDI bridge
        // over USB bulk, the rate is nominal — but we stick to spec.
        await port.open({ baudRate: 57600 });
        this.port = port;
        this.writer = port.writable.getWriter();
        this.connected = true;

        this._startFlushLoop();

        // Listen for physical disconnect
        navigator.serial.addEventListener('disconnect', this._onPortDisconnect = (e) => {
            if (e.target === this.port) this._handleDisconnect();
        });

        if (this.onConnect) this.onConnect();
        this._saveSettings();
    }

    async disconnect() {
        this._stopFlushLoop();
        try {
            if (this.writer) {
                try { await this.writer.close(); } catch (_) {}
                this.writer = null;
            }
            if (this.port) {
                try { await this.port.close(); } catch (_) {}
            }
        } finally {
            this.port = null;
            this.connected = false;
            if (this._onPortDisconnect) {
                navigator.serial.removeEventListener('disconnect', this._onPortDisconnect);
                this._onPortDisconnect = null;
            }
            if (this.onDisconnect) this.onDisconnect();
            this._saveSettings();
        }
    }

    _handleDisconnect() {
        this._stopFlushLoop();
        this.writer = null;
        this.port = null;
        this.connected = false;
        if (this.onDisconnect) this.onDisconnect();
    }

    // === Universe state ===

    /**
     * Set one DMX channel (1..512) to value (0..255).
     */
    setChannel(channel, value) {
        if (channel < 1 || channel > DMX_UNIVERSE_SIZE) return;
        const v = Math.max(0, Math.min(255, value | 0));
        if (this._buffer[channel] !== v) {
            this._buffer[channel] = v;
            this._dirty = true;
        }
    }

    /**
     * Read current universe value for a channel.
     */
    getChannel(channel) {
        if (channel < 1 || channel > DMX_UNIVERSE_SIZE) return 0;
        return this._buffer[channel];
    }

    /**
     * Blackout — zero all channels.
     */
    blackout() {
        this._buffer.fill(0);
        this._buffer[0] = 0; // start code stays 0
        this._dirty = true;
    }

    /**
     * Get a copy of the universe (513 bytes, index 0 = start code).
     */
    snapshot() {
        return this._buffer.slice();
    }

    // === Flush loop ===

    _startFlushLoop() {
        if (this._flushTimer) return;
        const interval = Math.round(1000 / DMX_REFRESH_HZ);
        this._flushTimer = setInterval(() => this._flush(), interval);
        this._dirty = true; // send once on connect
    }

    _stopFlushLoop() {
        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }
    }

    async _flush() {
        if (!this.connected || !this.writer || this._writing) return;
        // DMX should refresh continuously, but there's no harm in skipping
        // when nothing has changed at this tick. Send at least once when dirty.
        if (!this._dirty) return;

        this._writing = true;
        this._dirty = false;
        try {
            const packet = this._buildPacket();
            await this.writer.write(packet);
        } catch (e) {
            console.warn('DMX write failed:', e);
            if (this.onError) this.onError(e);
            this._handleDisconnect();
        } finally {
            this._writing = false;
        }
    }

    _buildPacket() {
        const dataLen = this._buffer.length; // 513
        const packet = new Uint8Array(5 + dataLen);
        packet[0] = DMX_START;
        packet[1] = DMX_LABEL_OUTPUT;
        packet[2] = dataLen & 0xFF;
        packet[3] = (dataLen >> 8) & 0xFF;
        packet.set(this._buffer, 4);
        packet[4 + dataLen] = DMX_END;
        return packet;
    }

    // === Persistence ===

    _saveSettings() {
        try {
            localStorage.setItem('soniphorm-dmx', JSON.stringify({
                autoConnect: this.connected
            }));
        } catch (_) {}
    }

    loadSettings() {
        try {
            const json = localStorage.getItem('soniphorm-dmx');
            if (!json) return {};
            return JSON.parse(json);
        } catch (_) {
            return {};
        }
    }
}
