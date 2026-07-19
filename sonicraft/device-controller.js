/**
 * DeviceController — link to a Smart Contact Mic (GenRuntime firmware), over
 * either Web Serial or Web Bluetooth (whichever the browser supports).
 *
 * Protocol matches the desktop Soniphorm Patcher (PatchUploader.js / SerialTransport.js
 * / BLETransport.js): line-based commands, request/response matching by pattern.
 * Only the commands needed for remote record/name/monitor are used here — the same
 * commands already proven on desktop over both transports:
 *
 *   RECBTN 1        -> toggle AudioRecorder record (firmware decides start vs stop from
 *                       its own state). Unsolicited REC_STATE lines follow asynchronously:
 *                         REC_STATE RECORDING <path>   (recording started, file path known)
 *                         REC_STATE STOPPED            (stop requested, draining to SD)
 *                         REC_STATE IDLE (recorded N samples, X.Xs)  (finalize complete)
 *   RECBTN 2        -> play/pause the most recent recording (comes out SCM's headphone
 *                       output; ignored with "REC: play ignored" if still finalizing)
 *   FMOVE <src> <dst> -> rename a file already on SD (SD.rename), replies FMOVE_OK/FMOVE_ERROR
 *
 * Transport choice: Web Serial is preferred when available (desktop Chrome/Edge,
 * Android Chrome) since it's the more battle-tested path. Web Bluetooth is the
 * fallback -- and the only option on iOS (no browser there exposes navigator.serial,
 * WebKit doesn't implement it) via the Bluefy app, and on Android browsers other than
 * Chrome/Edge that support Web Bluetooth but not Web Serial. Both transports feed the
 * same line-buffered request/response layer below, so every command above works
 * identically regardless of which one is active. BLE talks to the same GATT service
 * GenRuntime already exposes for patch upload (BLE_PATCH_SERVICE_UUID) -- a writable
 * characteristic for commands out, a notify characteristic for responses in -- rather
 * than adding a second BLE service.
 */

const DEVICE_BAUD_RATE = 921600;
const DEVICE_USB_FILTERS = [
    { usbVendorId: 0x303A } // Espressif ESP32-S3 native USB
];
const DEVICE_COMMAND_TIMEOUT = 5000;

const DEVICE_BLE_SERVICE_UUID       = '4f6e6950-686f-726d-5061-746368496e66';
const DEVICE_BLE_UPLOAD_CHAR_UUID   = '4f6e6950-686f-726d-5061-746368557000';
const DEVICE_BLE_RESPONSE_CHAR_UUID = '4f6e6950-686f-726d-5061-744368527300';
const DEVICE_BLE_CHUNK_SIZE = 200; // MTU-safe write size, matches desktop BLETransport.js

class DeviceController {
    constructor() {
        this._transport = null; // 'serial' | 'ble' | null (not connected)

        this._port = null;
        this._reader = null;
        this._writer = null;
        this._readableStreamClosed = null;
        this._writableStreamClosed = null;

        this._bleDevice = null;
        this._bleServer = null;
        this._bleUploadChar = null;
        this._bleResponseChar = null;
        this._onBleDisconnect = null;

        // Line buffering + request/response matching (same scheme as PatchUploader.js),
        // shared by both transports -- _feedData() is fed raw text from whichever is active.
        this._responseBuffer = '';
        this._emitPos = 0;
        this._responseResolve = null;

        // Callbacks
        this.onConnect = null;      // () => void
        this.onDisconnect = null;   // () => void
        this.onError = null;        // (err) => void
        this.onState = null;        // (event) => void — see _handleLine for event shapes
    }

    isSupported() {
        return 'serial' in navigator || 'bluetooth' in navigator;
    }

    /** 'serial' | 'ble' | null -- which transport is currently active, if any. */
    getTransport() {
        return this._transport;
    }

    isConnected() {
        if (this._transport === 'ble') {
            return this._bleDevice !== null && this._bleServer !== null &&
                   this._bleServer.connected && this._bleUploadChar !== null;
        }
        return this._port !== null && this._reader !== null;
    }

    // === Connection ===

    /**
     * Serial preferred when available -- but 'serial' in navigator is a BROWSER
     * capability flag (always true on desktop Chrome/Edge), not a signal that a
     * device is actually reachable over serial right now. A device powered but
     * not USB-connected (e.g. phone-charger power, testing the wireless path) has
     * no serial port to find, and this generic entry point has no way to know
     * that in advance -- it'll always try Serial first on a Serial-capable
     * browser. Use connectSerial()/connectBle() directly for an explicit choice
     * (see the two buttons in the device menu); this generic connect() only
     * really auto-resolves correctly on browsers where just one transport exists
     * at all (e.g. iOS Bluefy, which has no navigator.serial to try first).
     */
    async connect() {
        if (this.isConnected()) return;
        if ('serial' in navigator) {
            await this.connectSerial();
        } else if ('bluetooth' in navigator) {
            await this.connectBle();
        } else {
            throw new Error('Neither Web Serial nor Web Bluetooth supported — use Chrome/Edge, or Bluefy on iOS.');
        }
    }

    async connectSerial() {
        if (this.isConnected()) return;
        const port = await navigator.serial.requestPort({ filters: DEVICE_USB_FILTERS });
        await this._openPort(port);
    }

    async connectBle() {
        if (this.isConnected()) return;
        if (!('bluetooth' in navigator)) {
            throw new Error('Web Bluetooth not supported in this browser.');
        }
        this._bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Soniphorm' }],
            optionalServices: [DEVICE_BLE_SERVICE_UUID]
        });
        this._bleDevice.addEventListener('gattserverdisconnected', this._onBleDisconnect = () => {
            this._handleDisconnect();
        });

        // Retry GATT connect/service-discovery -- Android in particular can drop the
        // GATT link between connect() and getPrimaryService() (same pattern as the
        // desktop BLETransport.js, already proven working from Android and Bluefy).
        let server = null;
        let service = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                server = await this._bleDevice.gatt.connect();
                await new Promise(r => setTimeout(r, 300));
                service = await server.getPrimaryService(DEVICE_BLE_SERVICE_UUID);
                break;
            } catch (e) {
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                } else {
                    throw e;
                }
            }
        }
        this._bleServer = server;
        this._bleUploadChar = await service.getCharacteristic(DEVICE_BLE_UPLOAD_CHAR_UUID);
        this._bleResponseChar = await service.getCharacteristic(DEVICE_BLE_RESPONSE_CHAR_UUID);

        await this._bleResponseChar.startNotifications();
        this._bleResponseChar.addEventListener('characteristicvaluechanged', (event) => {
            this._feedData(new TextDecoder().decode(event.target.value));
        });

        this._transport = 'ble';
        this._saveSettings(true);
        if (this.onConnect) this.onConnect();
    }

    /** Try to reconnect to a previously-authorized port without a user prompt. Serial only --
     *  Web Bluetooth has no equivalent permission-less re-list, especially not in Bluefy. */
    async tryAutoConnect() {
        if (!('serial' in navigator)) return false;
        const ports = await navigator.serial.getPorts();
        if (ports.length === 0) return false;
        const scm = ports.find(p => p.getInfo().usbVendorId === 0x303A);
        const port = scm || ports[0];
        try {
            await this._openPort(port);
            return true;
        } catch (e) {
            console.warn('Device auto-connect failed:', e);
            return false;
        }
    }

    async _openPort(port) {
        await port.open({ baudRate: DEVICE_BAUD_RATE });
        this._transport = 'serial';
        this._port = port;

        const textDecoder = new TextDecoderStream();
        this._readableStreamClosed = this._port.readable.pipeTo(textDecoder.writable);
        this._reader = textDecoder.readable.getReader();

        const textEncoder = new TextEncoderStream();
        this._writableStreamClosed = textEncoder.readable.pipeTo(this._port.writable);
        this._writer = textEncoder.writable.getWriter();

        this._readLoop();

        // OS-level signal that the port is gone, independent of the stream reader
        // (which can hang rather than reject when the device vanishes abruptly --
        // e.g. a firmware reflash resetting the USB device mid-session -- leaving
        // isConnected() stuck reporting stale true). Same pattern as dmx.js.
        navigator.serial.addEventListener('disconnect', this._onPortDisconnect = (e) => {
            if (e.target === this._port) this._handleDisconnect();
        });

        this._saveSettings(true);
        if (this.onConnect) this.onConnect();
    }

    async disconnect() {
        if (this._transport === 'ble') {
            await this._disconnectBle();
        } else {
            await this._disconnectSerial();
        }
    }

    async _disconnectSerial() {
        // Snapshot + clear fields before awaiting cancel/close, so a read-loop wakeup
        // racing this call can't null this._port out from under the close() below
        // (same ordering hazard as the desktop SerialTransport disconnect).
        const reader = this._reader, writer = this._writer, port = this._port;
        const readableStreamClosed = this._readableStreamClosed;
        const writableStreamClosed = this._writableStreamClosed;
        this._clearPortState();

        try {
            if (reader) {
                await reader.cancel();
                if (readableStreamClosed) await readableStreamClosed.catch(() => {});
            }
            if (writer) {
                await writer.close().catch(() => {});
                if (writableStreamClosed) await writableStreamClosed.catch(() => {});
            }
            if (port) await port.close();
        } catch (err) {
            console.warn('Device disconnect cleanup:', err.message);
        }
        this._saveSettings(false);
        if (this.onDisconnect) this.onDisconnect();
    }

    async _disconnectBle() {
        const server = this._bleServer, responseChar = this._bleResponseChar;
        this._clearBleState();

        try {
            if (responseChar) {
                try { await responseChar.stopNotifications(); } catch (e) { /* ignore */ }
            }
            if (server && server.connected) server.disconnect();
        } catch (err) {
            console.warn('Device BLE disconnect cleanup:', err.message);
        }
        this._saveSettings(false);
        if (this.onDisconnect) this.onDisconnect();
    }

    /** Shared by disconnect() and the automatic-disconnect paths below. */
    _clearPortState() {
        this._reader = null;
        this._writer = null;
        this._port = null;
        this._readableStreamClosed = null;
        this._writableStreamClosed = null;
        this._transport = null;
        if (this._onPortDisconnect) {
            navigator.serial.removeEventListener('disconnect', this._onPortDisconnect);
            this._onPortDisconnect = null;
        }
    }

    /** Shared by _disconnectBle() and the automatic-disconnect path below. */
    _clearBleState() {
        if (this._bleDevice && this._onBleDisconnect) {
            this._bleDevice.removeEventListener('gattserverdisconnected', this._onBleDisconnect);
        }
        this._onBleDisconnect = null;
        this._bleUploadChar = null;
        this._bleResponseChar = null;
        this._bleServer = null;
        this._bleDevice = null;
        this._transport = null;
    }

    /** Handles a disconnect the app didn't initiate itself (device vanished). */
    _handleDisconnect() {
        if (this._transport === 'ble') {
            if (!this._bleDevice) return; // already handled
            this._clearBleState();
            if (this.onDisconnect) this.onDisconnect();
            return;
        }
        if (!this._port) return; // already handled (e.g. by the read loop, or a manual disconnect())
        this._clearPortState();
        if (this.onDisconnect) this.onDisconnect();
    }

    async _readLoop() {
        let disconnected = false;
        try {
            while (this._reader) {
                const { value, done } = await this._reader.read();
                if (done) { disconnected = true; break; }
                if (value) this._feedData(value);
            }
        } catch (err) {
            disconnected = true;
            if (err.name !== 'TypeError' && !String(err.message).includes('cancelled')) {
                console.error('Device read error:', err);
                if (this.onError) this.onError(err);
            }
        }
        if (disconnected) this._handleDisconnect();
    }

    // === Line buffering + request/response (mirrors DeviceTransport.js on desktop) ===

    _feedData(text) {
        this._responseBuffer += text;
        this._emitLines();
        if (this._responseResolve) this._checkResponse();
    }

    _emitLines() {
        let searchFrom = this._emitPos;
        while (true) {
            const nlIdx = this._responseBuffer.indexOf('\n', searchFrom);
            if (nlIdx === -1) break;
            const line = this._responseBuffer.substring(searchFrom, nlIdx).replace(/\r$/, '').trim();
            if (line) this._handleLine(line);
            searchFrom = nlIdx + 1;
        }
        this._emitPos = searchFrom;
        // Trim a buffer that's only grown because nothing pending ever matched
        // (e.g. STATUS/diagnostic spam between commands) so it doesn't grow unbounded.
        if (!this._responseResolve && this._emitPos > 4096) {
            this._responseBuffer = this._responseBuffer.substring(this._emitPos);
            this._emitPos = 0;
        }
    }

    _checkResponse() {
        if (!this._responseResolve) return;
        const { patterns, resolve } = this._responseResolve;
        for (const pattern of patterns) {
            const idx = this._responseBuffer.indexOf(pattern);
            if (idx !== -1) {
                const endIdx = this._responseBuffer.indexOf('\n', idx);
                if (endIdx === -1) return; // wait for the complete line
                const matched = this._responseBuffer.substring(idx, endIdx).replace(/\r/g, '');
                this._responseBuffer = this._responseBuffer.substring(endIdx + 1);
                this._emitPos = Math.max(0, this._emitPos - (endIdx + 1));
                this._responseResolve = null;
                resolve(matched);
                return;
            }
        }
    }

    _waitForResponse(patterns, timeout) {
        if (typeof patterns === 'string') patterns = [patterns];
        for (const pattern of patterns) {
            const idx = this._responseBuffer.indexOf(pattern);
            if (idx !== -1) {
                const endIdx = this._responseBuffer.indexOf('\n', idx);
                if (endIdx === -1) continue;
                const matched = this._responseBuffer.substring(idx, endIdx).replace(/\r/g, '');
                this._responseBuffer = this._responseBuffer.substring(endIdx + 1);
                this._emitPos = Math.max(0, this._emitPos - (endIdx + 1));
                return Promise.resolve(matched);
            }
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => { this._responseResolve = null; resolve(null); }, timeout);
            this._responseResolve = { patterns, resolve: (val) => { clearTimeout(timer); resolve(val); } };
        });
    }

    async _send(str) {
        if (!this.isConnected()) throw new Error('Not connected to device');
        if (this._transport === 'ble') {
            // Split into MTU-safe chunks -- Web Bluetooth doesn't expose the negotiated
            // MTU, and firmware accumulates until newline regardless of chunk boundaries
            // (same approach as desktop BLETransport.js).
            const bytes = new TextEncoder().encode(str);
            for (let i = 0; i < bytes.length; i += DEVICE_BLE_CHUNK_SIZE) {
                const chunk = bytes.slice(i, Math.min(i + DEVICE_BLE_CHUNK_SIZE, bytes.length));
                await this._bleUploadChar.writeValueWithResponse(chunk);
            }
            return;
        }
        await this._writer.write(str);
    }

    // === Unsolicited state lines ===
    // REC_STATE IDLE (finalize done) arrives asynchronously from the SD writer task,
    // not as a direct reply to RECBTN — so state changes are pushed via onState,
    // separate from the request/response plumbing FMOVE etc. use.

    _handleLine(line) {
        // SDDBG lines (SD-writer batch/write timing, fires when a block write >50ms
        // or a batch >100ms -- see GenRuntime.ino's sdWriterTaskFunc) aren't turned
        // into an onState event anywhere; console passthrough is the only way to see
        // them from the app today, same pattern the old METER DIAG passthrough used
        // before that diagnostic was retired. Kept in -- this one's still live
        // firmware-side instrumentation, not dead scaffolding.
        if (line.startsWith('SDDBG')) console.log('[device]', line);
        let event = null;
        if (line.startsWith('MTR:')) {
            event = { type: 'meter', peak: parseFloat(line.substring(4)) || 0, raw: line };
        } else if (line.startsWith('PZR:')) {
            event = { type: 'piezoMeter', peak: parseFloat(line.substring(4)) || 0, raw: line };
        } else if (line.startsWith('MSC_MODE ON')) {
            event = { type: 'mscModeOn', raw: line };
        } else if (line.startsWith('MSC_MODE OFF')) {
            event = { type: 'mscModeOff', raw: line };
        } else if (line.startsWith('REC_STATE RECORDING')) {
            const parts = line.split(' ');
            event = { type: 'recording', path: parts.length > 2 ? parts.slice(2).join(' ') : null, raw: line };
        } else if (line.startsWith('REC_STATE STOPPED')) {
            event = { type: 'finalizing', raw: line };
        } else if (line.startsWith('REC_STATE IDLE')) {
            // Two different call sites emit this: sdWriterTaskFunc (recording just
            // finalized, always with the "(recorded N samples, X.Xs)" suffix) and
            // sdReaderTaskFunc (a playback session ended -- explicit stop, or natural
            // EOF now that that no longer gets stuck -- always bare, no suffix).
            // Conflating them previously meant a played-back file finishing would be
            // misread as "a recording just finished" and could pop the rename dialog
            // with a stale/null path. Distinguish on the suffix, the only signal available.
            const m = line.match(/recorded (\d+) samples, ([\d.]+)s/);
            if (m) {
                event = { type: 'idle', samples: parseInt(m[1], 10), seconds: parseFloat(m[2]), raw: line };
            } else {
                event = { type: 'playbackIdle', raw: line };
            }
        } else if (line.startsWith('REC_STATE PLAYING')) {
            event = { type: 'playing', raw: line };
        } else if (line.startsWith('REC_STATE PAUSED')) {
            event = { type: 'paused', raw: line };
        } else if (line.startsWith('REC: play ignored')) {
            event = { type: 'busy', raw: line };
        } else if (line.startsWith('REC: forcing IDLE from playback state')) {
            // Benign recovery step -- a REC_STATE RECORDING line follows right after
            // in the same button-press response, so this isn't itself a rejection.
        } else if (line.startsWith('REC ERR') || line.startsWith('REC WARN') ||
                   line.startsWith('REC: record disabled') || line.startsWith('REC: play failed') ||
                   line.startsWith('RECPLAY ERR')) {
            // Catches every other way a button press can be rejected without a
            // REC_STATE change following it -- no SD card, trigger-mode disables
            // RECBTN, no files to play, etc. Without this, the optimistic "recording"
            // UI (set before the firmware confirms) has nothing to correct it and
            // gets stuck forever, which is exactly what happened testing this: the
            // no-SD-card case was fixed explicitly, but "REC: record disabled in
            // trigger mode" (module has triggerMode=1, expects a CV/gate trigger
            // instead of RECBTN) hit the identical silent-stuck symptom because it
            // wasn't one of the two prefixes originally matched here.
            event = { type: 'error', raw: line };
        }
        if (event && this.onState) this.onState(event);
    }

    // === High-level device commands ===

    /** RECBTN 1 — toggles AudioRecorder record. Result arrives via onState, not a return value. */
    async toggleRecord() {
        await this._send('RECBTN 1\n');
    }

    /** RECBTN 2 — play/pause the most recently recorded take, out SCM's headphone output. */
    async play() {
        await this._send('RECBTN 2\n');
    }

    /**
     * MSCMODE ON — reboots the device into USB mass-storage mode (SD card mounts
     * as a normal drive on the host OS, works on iOS since it's OS-level, not
     * Web Serial). The device disconnects immediately after acking this -- expect
     * onDisconnect to fire shortly after, same as it would for a DOWNLOAD reboot.
     */
    async enterMassStorageMode() {
        await this._send('MSCMODE ON\n');
    }

    /**
     * MSCMODE OFF — reboots a device that's currently in MSC mode back to normal.
     * Only meaningful while connected to a device already in MSC mode (CDC stays
     * alive there specifically so this remains reachable -- see runMscMode()).
     */
    async exitMassStorageMode() {
        await this._send('MSCMODE OFF\n');
    }

    /**
     * RECPLAY <path> — play a specific file by path, instead of RECBTN 2's "always
     * plays the most recent recording". This is real slot-to-file linking: pass
     * the exact path a slot recorded (slot._devicePath) so tapping that slot plays
     * that take, not just whatever's newest on SD.
     */
    async playFile(path) {
        await this._send(`RECPLAY ${path}\n`);
    }

    /** METER ON — start streaming input-peak lines (MTR:x.xxx, ~20Hz) via onState. */
    async enableMeter() {
        await this._send('METER ON\n');
    }

    /** METER OFF — stop streaming meter lines (call when not recording, to save the traffic). */
    async disableMeter() {
        await this._send('METER OFF\n');
    }

    /** Rename a file already on SD (existing FMOVE command) — used after a take finalizes. */
    async renameFile(oldPath, newPath) {
        await this._send(`FMOVE ${oldPath} ${newPath}\n`);
        const result = await this._waitForResponse(['FMOVE_OK', 'FMOVE_ERROR'], DEVICE_COMMAND_TIMEOUT);
        if (!result || result.includes('FMOVE_ERROR')) {
            throw new Error(result || 'No response to FMOVE');
        }
        return result;
    }

    /**
     * SDSPACE — query current SD-card usage. Returns null if there's no card or
     * the device didn't respond (caller should treat that as "nothing to warn
     * about" rather than an error, same as every other best-effort device query).
     */
    async getSdSpace() {
        await this._send('SDSPACE\n');
        const result = await this._waitForResponse(['SDSPACE OK', 'SDSPACE_ERROR'], DEVICE_COMMAND_TIMEOUT);
        if (!result || result.includes('SDSPACE_ERROR')) return null;
        const m = result.match(/total=(\d+) used=(\d+) free=(\d+) pct=(\d+)/);
        if (!m) return null;
        return { totalBytes: parseInt(m[1], 10), usedBytes: parseInt(m[2], 10), freeBytes: parseInt(m[3], 10), pct: parseInt(m[4], 10) };
    }

    // === Persistence (auto-reconnect on next load, same pattern as DmxController) ===

    _saveSettings(autoConnect) {
        try {
            localStorage.setItem('soniphorm-device', JSON.stringify({ autoConnect }));
        } catch (_) {}
    }

    loadSettings() {
        try {
            const json = localStorage.getItem('soniphorm-device');
            if (!json) return {};
            return JSON.parse(json);
        } catch (_) {
            return {};
        }
    }
}
