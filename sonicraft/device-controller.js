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
 *   FILE_SEND <path> -> download a file from SD: FSEND_START -> FSCHUNK:<base64> (repeated)
 *                       -> FSEND_END. See downloadFile() below.
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
        this._pendingWaiters = []; // see _waitForResponse()/_checkResponses()

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
        this._sendQueue = null;
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
        this._sendQueue = null;
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
        this._checkResponses();
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
        // Suspended during downloadFile() (see _streamConsuming): that loop mostly
        // matches chunks through _waitForResponse()'s *synchronous* fast path (data
        // already sitting in the buffer), which never registers a pending waiter at
        // all -- this trim was designed for spam nobody's waiting on, not a consumer
        // that's actively pulling a long stream of chunks just slightly slower than
        // they arrive. Without the guard, any burst of chunks arriving faster than
        // the loop's own await/re-entry overhead gets silently discarded here before
        // downloadFile() ever sees it (confirmed live: a 509996-byte download only
        // ever saw its last 44-byte partial chunk survive the trim).
        if ((!this._pendingWaiters || this._pendingWaiters.length === 0) && !this._streamConsuming && this._emitPos > 4096) {
            this._responseBuffer = this._responseBuffer.substring(this._emitPos);
            this._emitPos = 0;
        }
    }

    /**
     * Checks every currently pending _waitForResponse() call against the buffer,
     * not just the most recent one. Used to be a single `_responseResolve` slot --
     * a second call() while a first was still pending (e.g. downloadFile()'s chunk
     * loop and the rename dialog's FMOVE wait, both able to be active around the
     * same recording-finalize event) silently overwrote the first's tracking,
     * orphaning it: its resolve callback was gone, so that await just hung forever
     * with no error, while the second wait raced the first for the same incoming
     * lines. Confirmed live as a real failure ("no response to FMOVE" while a
     * download's resume loop was active). Multiple independent waiters, each
     * resolved (and removed) only when its own pattern matches, fixes this for
     * every current and future caller, not just these two.
     */
    _checkResponses() {
        if (!this._pendingWaiters || this._pendingWaiters.length === 0) return;
        for (let i = this._pendingWaiters.length - 1; i >= 0; i--) {
            const waiter = this._pendingWaiters[i];
            for (const pattern of waiter.patterns) {
                const idx = this._responseBuffer.indexOf(pattern);
                if (idx === -1) continue;
                const endIdx = this._responseBuffer.indexOf('\n', idx);
                if (endIdx === -1) continue; // wait for the complete line
                const matched = this._responseBuffer.substring(idx, endIdx).replace(/\r/g, '');
                this._responseBuffer = this._responseBuffer.substring(endIdx + 1);
                this._emitPos = Math.max(0, this._emitPos - (endIdx + 1));
                this._pendingWaiters.splice(i, 1);
                waiter.resolve(matched);
                break;
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
            if (!this._pendingWaiters) this._pendingWaiters = [];
            const waiter = { patterns, resolve: null };
            const timer = setTimeout(() => {
                const idx = this._pendingWaiters.indexOf(waiter);
                if (idx !== -1) this._pendingWaiters.splice(idx, 1);
                resolve(null);
            }, timeout);
            waiter.resolve = (val) => { clearTimeout(timer); resolve(val); };
            this._pendingWaiters.push(waiter);
        });
    }

    /**
     * Serializes every _send() call onto a single chain -- Web Bluetooth throws
     * "GATT operation already in progress" if two writes to the same
     * characteristic overlap, and several call sites fire commands without
     * awaiting each other (e.g. the recording-finalize handler in app.js calls
     * disableMeter(), getSdSpace(), and now downloadFile()'s FILE_SEND all from
     * the same synchronous event, none of them awaited by the caller). Chaining
     * here means it doesn't matter how many callers do that -- only one write is
     * ever in flight. `.catch(() => {})` on the tail keeps the chain alive after
     * a failed send instead of wedging every _send() call after it forever.
     */
    async _send(str) {
        if (!this.isConnected()) throw new Error('Not connected to device');
        const run = () => this._doSend(str);
        const queued = (this._sendQueue || Promise.resolve()).then(run, run);
        this._sendQueue = queued.catch(() => {});
        return queued;
    }

    async _doSend(str) {
        // Re-check here, not just in _send()'s eager check before queueing -- _sendQueue
        // can now defer this call for seconds behind other queued traffic (confirmed
        // live: a RECBTN queued behind background download resume/retry activity). If
        // the connection drops during that wait, _bleUploadChar/etc. go null via
        // _clearBleState()/_clearPortState(), and without this check the code below
        // would throw a raw "Cannot read properties of null" instead of the clean
        // "Not connected to device" _send()'s own check was supposed to guarantee.
        if (!this.isConnected()) throw new Error('Not connected to device');
        if (this._transport === 'ble') {
            // Split into MTU-safe chunks -- Web Bluetooth doesn't expose the negotiated
            // MTU, and firmware accumulates until newline regardless of chunk boundaries
            // (same approach as desktop BLETransport.js).
            const bytes = new TextEncoder().encode(str);
            for (let i = 0; i < bytes.length; i += DEVICE_BLE_CHUNK_SIZE) {
                const chunk = bytes.slice(i, Math.min(i + DEVICE_BLE_CHUNK_SIZE, bytes.length));
                await this._bleWriteWithTimeout(chunk);
            }
            return;
        }
        await this._writer.write(str);
    }

    /**
     * writeValueWithResponse() has no built-in timeout and no delivery guarantee
     * if it never resolves -- confirmed live: a write hung with zero error/output,
     * and since every _send() call chains onto _sendQueue (see above), that one
     * hung write silently wedged every future command (including the cancel a
     * download retry needed to recover) with no way out short of a page reload.
     * Racing a timeout means a hung write rejects instead, which _send()'s
     * `.catch(() => {})` on the queue tail already unblocks for whatever's next.
     */
    async _bleWriteWithTimeout(chunk, timeoutMs = 8000) {
        const MAX_BUSY_RETRIES = 10; // 5 attempts (~2.25s total backoff) wasn't enough, confirmed live
        for (let attempt = 1; attempt <= MAX_BUSY_RETRIES; attempt++) {
            let timer;
            try {
                await Promise.race([
                    this._bleUploadChar.writeValueWithResponse(chunk),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('BLE write timed out')), timeoutMs);
                    }),
                ]);
                return;
            } catch (err) {
                // "GATT operation already in progress" is a known Web Bluetooth quirk on
                // multiple platforms (confirmed live on Windows here, not Android as
                // originally assumed when this was written) -- the OS's own BLE stack can
                // report this independent of any app-level write ordering (background
                // MTU/connection housekeeping, not something _sendQueue's serialization
                // above controls). Standard handling is a short retry, not treating it as
                // fatal -- it usually clears on its own within milliseconds. Windows'
                // Bluetooth LE stack (especially over a generic dongle/onboard adapter) is
                // plausibly a rougher environment for a sustained high-chunk-count transfer
                // like this than a phone's radio -- still needs confirming on real Android/
                // iOS hardware before assuming this is equally bad everywhere.
                const isBusy = err && err.name === 'NetworkError' && /already in progress/i.test(err.message || '');
                if (!isBusy || attempt === MAX_BUSY_RETRIES) throw err;
                await new Promise(r => setTimeout(r, 150 * attempt));
            } finally {
                clearTimeout(timer);
            }
        }
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
        // BLEDBG: confirms the actual negotiated connection interval/PHY resulting
        // from the requests in BLEMIDIServerCallbacks::onConnect() (GenRuntime.ino) --
        // both are negotiated, not mandatory, so this is the only way to tell
        // "request declined" apart from "honored but something else is the bottleneck".
        if (line.startsWith('BLEDBG')) console.log('[device]', line);
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

    /**
     * TEMP (27/07): relays one console line to the SCM's USB-serial monitor via
     * the existing BLE connection -- see the matching APPLOG handler in
     * GenRuntime.ino for why this reaches a different machine's serial monitor
     * without any new transport. Fire-and-forget by design (caller doesn't await
     * a response) and deliberately silent on failure -- this is called from
     * inside the console.log/warn/error wrapper itself (app.js initDebugConsole),
     * so letting a failure here call console.* to report itself would recurse.
     */
    async sendAppLog(text) {
        if (!this.isConnected()) return;
        // Single BLE command line -- strip newlines (multi-line stack traces) so
        // this can't be mistaken for multiple commands, and cap length well under
        // what a single _send() chunk run needs to stay lightweight (this shares
        // the same queue real recordings/downloads depend on).
        const oneLine = String(text).replace(/[\r\n]+/g, ' | ').slice(0, 240);
        try {
            await this._send('APPLOG ' + oneLine + '\n');
        } catch (_) {}
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

    /**
     * FILE_SEND <path> -> FSCHUNK:<base64> (repeated) -> FSEND_END. Downloads a
     * file from the device's SD card over the existing connection (Serial or
     * BLE) -- works on every platform including iOS/Bluefy, unlike MSC mode +
     * showDirectoryPicker (File System Access API, desktop-Chromium-only, see
     * app.js's _importRecordingsFromDrive). Same protocol as desktop's
     * PatchUploader.js.
     *
     * Firmware (serviceFileSendTransfer() in GenRuntime.ino) pauses between
     * chunks on its own while an AudioRecorder is actively recording or
     * finalizing, and resumes once it's done -- there's no way to know in
     * advance how long that pause might last, so the per-chunk wait below
     * retries on timeout (as long as the device is still connected) rather
     * than failing. This is what lets a download run safely in the background
     * while the user records the next take.
     */
    async downloadFile(path, onProgress) {
        if (!this.isConnected()) throw new Error('Not connected to device');
        const progress = onProgress || (() => {});

        // See _emitLines()'s trim guard -- must stay set for the whole call (not just
        // the chunk loop) so a burst arriving right after FSEND_START can't get
        // trimmed before the loop below even starts.
        this._streamConsuming = true;
        try {
            const chunks = [];
            let receivedBytes = 0;
            let expectedSize = 0;
            const CHUNK_WAIT = 5000; // per-attempt only -- the inner loop retries past this, not a hard cap
            // BLE notifications have no delivery guarantee at the protocol level --
            // even at a safe chunk size and paced sends, the controller's TX queue can
            // still occasionally drop a burst under real radio conditions (confirmed
            // live). Restarting the whole file from scratch on every drop doesn't scale
            // -- bigger files mean more chunks, more chances to hit a drop, and every
            // restart throws away all progress already made. Resuming from the last
            // known-good byte offset (firmware seeks there -- see FILE_SEND's optional
            // startOffset in GenRuntime.ino) means each segment only has to survive
            // until the *next* drop, not the whole file, so overall reliability doesn't
            // degrade with file size the way whole-file retry does.
            const MAX_RESUMES = 20;

            for (let resumeNum = 0; resumeNum <= MAX_RESUMES; resumeNum++) {
                if (resumeNum > 0) {
                    // Firmware's transfer for the broken segment is still marked active
                    // (it doesn't know the client saw a gap) -- cancel it or the resume's
                    // FILE_SEND just gets "transfer already in progress".
                    await this.cancelDownload();
                    // Settle delay -- confirmed live that sending the resume's FILE_SEND
                    // immediately after cancelling still hits GATT operation already in
                    // progress even with write-level retry in place. Likely cause: the
                    // broken segment's already-queued notifications are still draining
                    // through the OS BLE stack right after cancel, and the new write lands
                    // in that backlog rather than a genuinely transient busy state. Give it
                    // real time to drain before trying.
                    await new Promise(r => setTimeout(r, 400));
                    console.log(`[device] resuming ${path} from byte ${receivedBytes} (attempt ${resumeNum}/${MAX_RESUMES})`);
                }
                const cmd = receivedBytes > 0 ? `FILE_SEND ${path} ${receivedBytes}\n` : `FILE_SEND ${path}\n`;
                await this._send(cmd);
                const start = await this._waitForResponse(['FSEND_START', 'FSEND_ERROR'], DEVICE_COMMAND_TIMEOUT * 2);
                if (!start || start.includes('FSEND_ERROR')) {
                    throw new Error(start || 'No response to FILE_SEND command');
                }
                const startParts = start.replace(/\r/g, '').split(':');
                expectedSize = parseInt(startParts[2], 10) || expectedSize;

                let expectedChunkNum = 0; // this segment's own numbering always restarts at 0
                let gapBroke = false;

                while (true) {
                    if (!this.isConnected()) throw new Error('Device disconnected during download');
                    const line = await this._waitForResponse(['FSCHUNK:', 'FSEND_END'], CHUNK_WAIT);
                    if (!line) continue; // no chunk yet -- likely paused for an active recording, keep waiting
                    if (line.includes('FSEND_END')) {
                        // Firmware only ever emits this at true EOF (serviceFileSendTransfer()
                        // always reads through to the real end once started) -- so reaching
                        // it cleanly means the whole file is done, not just this segment.
                        console.log(`[device] FSEND_END after ${chunks.length} total chunks, ${receivedBytes}/${expectedSize} bytes`);
                        break;
                    }

                    // FSCHUNK:<chunkNum>:<base64> -- verify sequencing explicitly rather than
                    // just trusting the final byte total, so a dropped/duplicated/reordered
                    // chunk is caught precisely instead of surfacing as a vague mismatch.
                    const firstColon = line.indexOf(':');
                    const secondColon = line.indexOf(':', firstColon + 1);
                    const chunkNum = parseInt(line.substring(firstColon + 1, secondColon), 10);
                    const b64Data = line.substring(secondColon + 1);
                    if (chunkNum !== expectedChunkNum) {
                        console.warn(`[device] chunk gap in ${path}: expected #${expectedChunkNum}, got #${chunkNum} -- will resume from byte ${receivedBytes}`);
                        gapBroke = true;
                        break;
                    }
                    expectedChunkNum++;
                    const binStr = atob(b64Data);
                    const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
                    chunks.push(bytes);
                    receivedBytes += bytes.length;
                    if (expectedSize > 0) {
                        progress(Math.min(100, Math.round((receivedBytes / expectedSize) * 100)));
                    }
                }

                if (!gapBroke) break; // clean FSEND_END -- whole file done, exit the resume loop
                if (resumeNum === MAX_RESUMES) {
                    throw new Error(`Download incomplete after ${MAX_RESUMES} resumes: got ${receivedBytes}/${expectedSize} bytes`);
                }
            }

            const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
            if (expectedSize > 0 && totalLength !== expectedSize) {
                throw new Error(`Download incomplete: got ${totalLength} bytes in ${chunks.length} chunks, expected ${expectedSize}`);
            }
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            progress(100);
            return result.buffer;
        } finally {
            this._streamConsuming = false;
        }
    }

    // === Persistence (auto-reconnect on next load, same pattern as DmxController) ===

    /**
     * FILE_SEND_CANCEL -- abandons an in-progress download on the firmware side.
     * Needed before retrying downloadFile() after it throws (e.g. a chunk sequence
     * break): firmware has no other way to learn the app gave up, so without this
     * a retry's fresh FILE_SEND just gets FSEND_ERROR:transfer already in progress
     * against the old, still-active-on-device transfer. Best-effort -- swallows
     * errors/timeout since the caller is about to retry regardless.
     */
    async cancelDownload() {
        try {
            await this._send('FILE_SEND_CANCEL\n');
            await this._waitForResponse('FSEND_CANCELLED', 2000);
        } catch (_) { /* best-effort */ }
    }

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
