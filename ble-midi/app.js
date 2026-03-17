/**
 * Soniphorm MIDI Controller
 * Connects to ESP32-S3 via USB MIDI (cable) or BLE MIDI (wireless).
 * USB MIDI preferred for piezo patches (no RF interference with preamp).
 */

// === Constants ===
const BLE_SERVICE  = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const BLE_CHAR     = '7772e5db-3868-4112-a1a9-f2669d106bf3';
const BLE_PATCH_SERVICE = '4f6e6950-686f-726d-5061-746368496e66';
const BLE_PATCH_CHAR    = '4f6e6950-686f-726d-4c61-62656c730000';
const BLE_CTRL_STATE_CHAR = '4f6e6950-686f-726d-4374-726c53746174';
const MIDI_CHANNEL = 0;
const POT_CC_BASE = 20;
const BTN_CC = [44, 45, 46, 47];
const BTN_NOTE_BASE = 60;
const BANK_SELECT_CC = 48;
const NUM_BANKS = 6;

// === State ===
let connected = false;
let transport = null;  // 'usb' or 'ble'
let currentBank = 0;
let faderValues = new Array(NUM_BANKS * 4).fill(0);
let patchLabels = {};
let patchName = '';
let bleActive = true;
let muted = false;
let wakeLock = null;

// BLE state
let bleDevice = null;
let bleCharacteristic = null;
let ctrlStateChar = null;

// USB MIDI state
let midiOutput = null;
let midiAccess = null;

// === DOM refs ===
const connectBtn   = document.getElementById('connect-btn');
const muteBtn      = document.getElementById('mute-btn');
const deviceNameEl = document.getElementById('device-name');
const patchNameEl  = document.getElementById('patch-name');
const mainArea     = document.querySelector('.main-area');
const controlsDiv  = document.querySelector('.controls');
const bankBtns     = document.querySelectorAll('.bank-btn');
const faderChannels = document.querySelectorAll('.fader-channel');
const triggerBtns  = document.querySelectorAll('.trigger-btn');
const compatWarn   = document.getElementById('compat-warning');
const installBtn   = document.getElementById('install-btn');
const ctrlOverlay  = document.getElementById('ctrl-overlay');

// === Transport abstraction ===

function sendMidi(status, data1, data2) {
    if (!connected || !bleActive) return;
    if (transport === 'usb' && midiOutput) {
        midiOutput.send([status, data1, data2]);
    } else if (transport === 'ble' && bleCharacteristic) {
        const packet = new Uint8Array([0x80, 0x80, status, data1, data2]);
        bleCharacteristic.writeValueWithoutResponse(packet).catch(() => {});
    }
}

function sendMidi2(s1, d1a, d1b, s2, d2a, d2b) {
    if (!connected || !bleActive) return;
    if (transport === 'usb' && midiOutput) {
        midiOutput.send([s1, d1a, d1b]);
        midiOutput.send([s2, d2a, d2b]);
    } else if (transport === 'ble' && bleCharacteristic) {
        const packet = new Uint8Array([0x80, 0x80, s1, d1a, d1b, 0x80, s2, d2a, d2b]);
        bleCharacteristic.writeValueWithoutResponse(packet).catch(() => {});
    }
}

// Mute bypasses bleActive check
function sendMuteMsg(muteOn) {
    if (!connected) return;
    const msg = [0xB0 | MIDI_CHANNEL, 127, muteOn ? 127 : 0];
    if (transport === 'usb' && midiOutput) {
        midiOutput.send(msg);
    } else if (transport === 'ble' && bleCharacteristic) {
        const packet = new Uint8Array([0x80, 0x80, ...msg]);
        bleCharacteristic.writeValueWithoutResponse(packet).catch(() => {});
    }
}

function sendCC(cc, value) {
    sendMidi(0xB0 | MIDI_CHANNEL, cc & 0x7F, value & 0x7F);
}

function sendBankSelect(bank) { sendCC(BANK_SELECT_CC, bank); }

function sendAllFadersForBank(bank) {
    for (let i = 0; i < 4; i++) {
        sendCC(POT_CC_BASE + bank * 4 + i, faderValues[bank * 4 + i]);
    }
}

// === Connection ===

connectBtn.addEventListener('click', handleConnect);

async function handleConnect() {
    if (connected) { disconnect(); return; }

    // Show transport picker
    const hasWebMidi = !!navigator.requestMIDIAccess;
    const hasWebBle = !!navigator.bluetooth;

    if (hasWebMidi && hasWebBle) {
        // Offer both options
        const choice = await showTransportPicker();
        if (choice === 'usb') await connectUSB();
        else if (choice === 'ble') await connectBLE();
    } else if (hasWebMidi) {
        await connectUSB();
    } else if (hasWebBle) {
        await connectBLE();
    } else {
        compatWarn.classList.add('show');
    }
}

function showTransportPicker() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'transport-picker';
        overlay.innerHTML = `
            <div class="transport-picker-inner">
                <div class="transport-title">Connect via</div>
                <button class="transport-option usb-option" data-transport="usb">
                    <span class="transport-icon">&#x1F50C;</span>
                    <span class="transport-label">USB Cable</span>
                    <span class="transport-desc">No interference with piezo</span>
                </button>
                <button class="transport-option ble-option" data-transport="ble">
                    <span class="transport-icon">&#x1F4F6;</span>
                    <span class="transport-label">Bluetooth</span>
                    <span class="transport-desc">Wireless (may affect preamp)</span>
                </button>
                <button class="transport-cancel">Cancel</button>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            const opt = e.target.closest('[data-transport]');
            if (opt) { document.body.removeChild(overlay); resolve(opt.dataset.transport); }
            if (e.target.classList.contains('transport-cancel') || e.target === overlay) {
                document.body.removeChild(overlay); resolve(null);
            }
        });
    });
}

// === USB MIDI Connection ===

async function connectUSB() {
    try {
        connectBtn.textContent = 'CONNECTING...';
        connectBtn.classList.add('connecting');

        midiAccess = await navigator.requestMIDIAccess({ sysex: false });

        // Find Soniphorm output
        midiOutput = null;
        for (const output of midiAccess.outputs.values()) {
            if (output.name && output.name.includes('Soniphorm')) {
                midiOutput = output;
                break;
            }
        }

        if (!midiOutput) {
            // No Soniphorm found, try first available
            const outputs = Array.from(midiAccess.outputs.values());
            if (outputs.length > 0) midiOutput = outputs[0];
        }

        if (!midiOutput) {
            throw new Error('No MIDI output device found. Is the USB cable connected?');
        }

        midiOutput.open();

        // Listen for disconnect
        midiAccess.onstatechange = (e) => {
            if (e.port === midiOutput && e.port.state === 'disconnected') {
                disconnect();
            }
        };

        transport = 'usb';
        connected = true;
        bleActive = true;  // USB always active (no patcher conflict)
        connectBtn.textContent = 'CONNECTED';
        connectBtn.classList.remove('connecting');
        connectBtn.classList.add('connected');
        deviceNameEl.textContent = 'USB: ' + (midiOutput.name || 'MIDI Device');
        deviceNameEl.classList.add('connected');
        updateActiveState();

        sendCC(BANK_SELECT_CC, currentBank);

    } catch (e) {
        console.warn('USB MIDI connect failed:', e);
        connectBtn.textContent = 'CONNECT';
        connectBtn.classList.remove('connecting', 'connected');
        alert(e.message || 'USB MIDI connection failed');
    }
}

// === BLE Connection ===

async function connectBLE() {
    if (!navigator.bluetooth) { compatWarn.classList.add('show'); return; }

    try {
        connectBtn.textContent = 'CONNECTING...';
        connectBtn.classList.add('connecting');

        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'SCM' }, { namePrefix: 'Eurorack' }],
            optionalServices: [BLE_SERVICE, BLE_PATCH_SERVICE]
        });
        bleDevice.addEventListener('gattserverdisconnected', disconnect);

        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(BLE_SERVICE);
        bleCharacteristic = await service.getCharacteristic(BLE_CHAR);

        // Read patch info
        try {
            const patchService = await server.getPrimaryService(BLE_PATCH_SERVICE);
            const patchChar = await patchService.getCharacteristic(BLE_PATCH_CHAR);
            const value = await patchChar.readValue();
            const info = JSON.parse(new TextDecoder().decode(value));
            patchName = info.name || '';
            patchLabels = info.labels || {};
            patchNameEl.textContent = patchName ? 'Patch: ' + patchName : '';
            applyLabels();

            // Control state
            ctrlStateChar = await patchService.getCharacteristic(BLE_CTRL_STATE_CHAR);
            const stateVal = await ctrlStateChar.readValue();
            bleActive = stateVal.getUint8(0) === 1;
            await ctrlStateChar.startNotifications();
            ctrlStateChar.addEventListener('characteristicvaluechanged', (event) => {
                bleActive = event.target.value.getUint8(0) === 1;
                updateActiveState();
            });
        } catch (e) {
            console.warn('Could not read patch info:', e);
            patchLabels = {};
            patchName = '';
            patchNameEl.textContent = '';
            bleActive = true;
        }

        transport = 'ble';
        connected = true;
        connectBtn.textContent = 'CONNECTED';
        connectBtn.classList.remove('connecting');
        connectBtn.classList.add('connected');
        deviceNameEl.textContent = 'BLE: ' + (bleDevice.name || 'Unknown');
        deviceNameEl.classList.add('connected');
        updateActiveState();

        sendCC(BANK_SELECT_CC, currentBank);

    } catch (e) {
        console.warn('BLE connect failed:', e);
        connectBtn.textContent = 'CONNECT';
        connectBtn.classList.remove('connecting', 'connected');
    }
}

// === Disconnect ===

function disconnect() {
    if (transport === 'ble' && bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
    }
    if (transport === 'usb' && midiOutput) {
        try { midiOutput.close(); } catch(e) {}
    }
    connected = false;
    transport = null;
    bleCharacteristic = null;
    ctrlStateChar = null;
    midiOutput = null;
    bleActive = true;
    connectBtn.textContent = 'CONNECT';
    connectBtn.classList.remove('connecting', 'connected');
    deviceNameEl.textContent = 'Not connected';
    deviceNameEl.classList.remove('connected');
    patchNameEl.textContent = '';
    updateActiveState();
}

// === Active/inactive state ===

async function updateActiveState() {
    const inactive = !bleActive && connected;
    ctrlOverlay.classList.toggle('show', inactive);
    mainArea.classList.toggle('inactive', inactive);

    const shouldWake = connected && bleActive;
    if (shouldWake && !wakeLock && 'wakeLock' in navigator) {
        try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    } else if (!shouldWake && wakeLock) {
        try { await wakeLock.release(); } catch (e) {}
        wakeLock = null;
    }
}

// === Mute ===

muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.classList.toggle('muted', muted);
    muteBtn.textContent = muted ? 'MUTED' : 'MUTE';
    sendMuteMsg(muted);
});

// === Bank switching ===

function setBank(bank) {
    if (bank === currentBank) return;
    currentBank = bank;
    controlsDiv.setAttribute('data-bank', bank);
    bankBtns.forEach((btn) => {
        btn.classList.toggle('active', parseInt(btn.dataset.bank) === bank);
    });
    updateFaderUI();
    updateCCLabels();
    applyLabels();
    sendBankSelect(bank);
    sendAllFadersForBank(bank);
}

bankBtns.forEach((btn) => {
    btn.addEventListener('click', () => setBank(parseInt(btn.dataset.bank)));
});

// === Fader interaction ===

function updateFaderUI() {
    faderChannels.forEach((ch) => {
        const idx = parseInt(ch.dataset.index);
        const val = faderValues[currentBank * 4 + idx];
        const pct = (val / 127) * 100;
        ch.querySelector('.fader-fill').style.height = pct + '%';
        ch.querySelector('.fader-thumb').style.bottom = 'calc(' + pct + '% - 3px)';
        ch.querySelector('.fader-value').textContent = val;
    });
}

function updateCCLabels() {
    faderChannels.forEach((ch) => {
        const idx = parseInt(ch.dataset.index);
        ch.querySelector('.fader-cc').textContent = 'CC ' + (POT_CC_BASE + currentBank * 4 + idx);
    });
}

function applyLabels() {
    const bankKey = String(currentBank + 1);
    const bankLabels = patchLabels[bankKey];
    faderChannels.forEach((ch) => {
        const idx = parseInt(ch.dataset.index);
        ch.querySelector('.fader-label').textContent = bankLabels?.p?.[idx] || ('Pot ' + (idx + 1));
    });
    triggerBtns.forEach((btn) => {
        const idx = parseInt(btn.dataset.index);
        const ccSpan = btn.querySelector('.btn-cc');
        btn.textContent = bankLabels?.b?.[idx] || ('Btn ' + (idx + 1));
        btn.appendChild(ccSpan);
    });
}

function handleFaderInput(channel, clientY) {
    const track = channel.querySelector('.fader-track');
    const rect = track.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
    const val = Math.round(y * 127);
    const idx = parseInt(channel.dataset.index);
    const storageIdx = currentBank * 4 + idx;
    if (faderValues[storageIdx] === val) return;
    faderValues[storageIdx] = val;
    const pct = (val / 127) * 100;
    channel.querySelector('.fader-fill').style.height = pct + '%';
    channel.querySelector('.fader-thumb').style.bottom = 'calc(' + pct + '% - 3px)';
    channel.querySelector('.fader-value').textContent = val;
    sendCC(POT_CC_BASE + currentBank * 4 + idx, val);
}

faderChannels.forEach((ch) => {
    const track = ch.querySelector('.fader-track');
    let dragging = false;
    track.addEventListener('pointerdown', (e) => {
        e.preventDefault(); dragging = true;
        track.setPointerCapture(e.pointerId);
        handleFaderInput(ch, e.clientY);
    });
    track.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        e.preventDefault();
        handleFaderInput(ch, e.clientY);
    });
    track.addEventListener('pointerup', () => { dragging = false; });
    track.addEventListener('pointercancel', () => { dragging = false; });
});

// === Button interaction ===

triggerBtns.forEach((btn) => {
    const idx = parseInt(btn.dataset.index);
    function press(e) {
        e.preventDefault();
        btn.classList.add('pressed');
        const note = BTN_NOTE_BASE + currentBank * 4 + idx;
        sendMidi2(0xB0 | MIDI_CHANNEL, BTN_CC[idx], 127, 0x90 | MIDI_CHANNEL, note, 127);
    }
    function release(e) {
        e.preventDefault();
        btn.classList.remove('pressed');
        const note = BTN_NOTE_BASE + currentBank * 4 + idx;
        sendMidi2(0xB0 | MIDI_CHANNEL, BTN_CC[idx], 0, 0x80 | MIDI_CHANNEL, note, 0);
    }
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', (e) => { if (btn.classList.contains('pressed')) release(e); });
    btn.addEventListener('pointercancel', (e) => { if (btn.classList.contains('pressed')) release(e); });
});

// === Persistence ===

function saveState() {
    try {
        localStorage.setItem('soniphorm-ble-midi', JSON.stringify({ bank: currentBank, faders: faderValues }));
    } catch (e) {}
}

function loadState() {
    try {
        const data = JSON.parse(localStorage.getItem('soniphorm-ble-midi'));
        if (!data) return;
        if (data.faders?.length === NUM_BANKS * 4) faderValues = data.faders;
        if (typeof data.bank === 'number' && data.bank >= 0 && data.bank < NUM_BANKS) {
            currentBank = data.bank;
            controlsDiv.setAttribute('data-bank', currentBank);
            bankBtns.forEach((b) => b.classList.toggle('active', parseInt(b.dataset.bank) === currentBank));
        }
    } catch (e) {}
}

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 500); }
faderChannels.forEach((ch) => ch.querySelector('.fader-track').addEventListener('pointerup', scheduleSave));
bankBtns.forEach((btn) => btn.addEventListener('click', scheduleSave));

// === PWA ===

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.style.display = 'inline-block';
});
installBtn.addEventListener('click', () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => { deferredInstallPrompt = null; installBtn.style.display = 'none'; });
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && connected && bleActive) updateActiveState();
});

// === Init ===
loadState();
updateFaderUI();
updateCCLabels();
