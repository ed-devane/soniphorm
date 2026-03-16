/**
 * Soniphorm BLE MIDI Controller
 * Connects to ESP32-S3 "Soniphorm" device over BLE MIDI.
 */

// === BLE MIDI constants ===
const BLE_SERVICE  = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const BLE_CHAR     = '7772e5db-3868-4112-a1a9-f2669d106bf3';
const BLE_PATCH_SERVICE = '4f6e6950-686f-726d-5061-746368496e66';
const BLE_PATCH_CHAR    = '4f6e6950-686f-726d-4c61-62656c730000';
const MIDI_CHANNEL = 0; // Channel 1

// CC mapping: bank 0-5 → pots CC 20-43, buttons CC 44-47, bank select CC 48
const POT_CC_BASE = 20;   // Bank 0 pot 1 = CC20, pot 2 = CC21 ... bank 5 pot 4 = CC43
const BTN_CC = [44, 45, 46, 47];
const BTN_NOTES = [44, 45, 46, 47];
const BANK_SELECT_CC = 48;
const NUM_BANKS = 6;

// === State ===
let device = null;
let characteristic = null;
let connected = false;
let currentBank = 0;
let faderValues = new Array(NUM_BANKS * 4).fill(0); // 24 fader values (6 banks × 4)
let patchLabels = {};  // bank -> { p: [pot labels], b: [btn labels] }
let patchName = '';

// === DOM refs ===
const connectBtn  = document.getElementById('connect-btn');
const statusDot   = document.getElementById('status-dot');
const patchNameEl = document.getElementById('patch-name');
const controlsDiv = document.querySelector('.controls');
const bankBtns    = document.querySelectorAll('.bank-btn');
const faderChannels = document.querySelectorAll('.fader-channel');
const triggerBtns = document.querySelectorAll('.trigger-btn');
const compatWarn  = document.getElementById('compat-warning');
const installBtn  = document.getElementById('install-btn');

// === Compatibility check ===
if (!navigator.bluetooth) {
    compatWarn.classList.add('show');
}

// === BLE Connection ===

async function bleConnect() {
    if (connected) {
        bleDisconnect();
        return;
    }
    if (!navigator.bluetooth) {
        compatWarn.classList.add('show');
        return;
    }
    try {
        connectBtn.textContent = 'Connecting…';
        connectBtn.classList.add('connecting');

        device = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'Soniphorm' }],
            optionalServices: [BLE_SERVICE, BLE_PATCH_SERVICE]
        });

        device.addEventListener('gattserverdisconnected', onDisconnected);

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_SERVICE);
        characteristic = await service.getCharacteristic(BLE_CHAR);

        // Read patch info (name + labels) from custom service
        try {
            const patchService = await server.getPrimaryService(BLE_PATCH_SERVICE);
            const patchChar = await patchService.getCharacteristic(BLE_PATCH_CHAR);
            const value = await patchChar.readValue();
            const json = new TextDecoder().decode(value);
            const info = JSON.parse(json);
            patchName = info.name || '';
            patchLabels = info.labels || {};
            patchNameEl.textContent = patchName;
            applyLabels();
        } catch (e) {
            console.warn('Could not read patch info:', e);
            patchLabels = {};
            patchName = '';
            patchNameEl.textContent = '';
        }

        connected = true;
        connectBtn.textContent = 'Disconnect';
        connectBtn.classList.remove('connecting');
        connectBtn.classList.add('connected');
        statusDot.classList.add('connected');

        // Send current bank select so device is in sync
        sendBankSelect(currentBank);
        // Send current fader positions for this bank
        sendAllFadersForBank(currentBank);

    } catch (e) {
        console.warn('BLE connect failed:', e);
        connectBtn.textContent = 'Connect';
        connectBtn.classList.remove('connecting', 'connected');
        statusDot.classList.remove('connected');
        connected = false;
    }
}

function bleDisconnect() {
    if (device && device.gatt.connected) {
        device.gatt.disconnect();
    }
    onDisconnected();
}

function onDisconnected() {
    connected = false;
    characteristic = null;
    connectBtn.textContent = 'Connect';
    connectBtn.classList.remove('connecting', 'connected');
    statusDot.classList.remove('connected');
    patchNameEl.textContent = '';
}

connectBtn.addEventListener('click', bleConnect);

// === BLE MIDI packet send ===

function sendBLEMidi(status, data1, data2) {
    if (!characteristic || !connected) return;
    // BLE MIDI packet: [header, timestamp, status, data1, data2]
    const packet = new Uint8Array([0x80, 0x80, status, data1, data2]);
    characteristic.writeValueWithoutResponse(packet).catch((e) => {
        console.warn('BLE MIDI send error:', e);
    });
}

function sendCC(cc, value) {
    sendBLEMidi(0xB0 | MIDI_CHANNEL, cc & 0x7F, value & 0x7F);
}

function sendNoteOn(note, velocity) {
    sendBLEMidi(0x90 | MIDI_CHANNEL, note & 0x7F, velocity & 0x7F);
}

function sendNoteOff(note) {
    sendBLEMidi(0x80 | MIDI_CHANNEL, note & 0x7F, 0);
}

function sendBankSelect(bank) {
    sendCC(BANK_SELECT_CC, bank);
}

function sendAllFadersForBank(bank) {
    for (let i = 0; i < 4; i++) {
        const cc = POT_CC_BASE + bank * 4 + i;
        const val = faderValues[bank * 4 + i];
        sendCC(cc, val);
    }
}

// === Bank switching ===

function setBank(bank) {
    if (bank === currentBank) return;
    currentBank = bank;
    controlsDiv.setAttribute('data-bank', bank);

    bankBtns.forEach((btn) => {
        btn.classList.toggle('active', parseInt(btn.dataset.bank) === bank);
    });

    // Update fader display for new bank
    updateFaderUI();

    // Update CC labels and patch labels
    updateCCLabels();
    applyLabels();

    // Send bank select CC
    sendBankSelect(bank);
    // Send current fader values so device matches UI
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
        const cc = POT_CC_BASE + currentBank * 4 + idx;
        ch.querySelector('.fader-cc').textContent = 'CC ' + cc;
    });
}

function applyLabels() {
    // Labels keyed by firmware bank (1-6), app bank is 0-5
    const bankKey = String(currentBank + 1);
    const bankLabels = patchLabels[bankKey];

    faderChannels.forEach((ch) => {
        const idx = parseInt(ch.dataset.index);
        const label = bankLabels?.p?.[idx];
        ch.querySelector('.fader-label').textContent = label || ('Pot ' + (idx + 1));
    });

    triggerBtns.forEach((btn) => {
        const idx = parseInt(btn.dataset.index);
        const label = bankLabels?.b?.[idx];
        // Button text is the first text node; btn-cc span is separate
        const ccSpan = btn.querySelector('.btn-cc');
        btn.textContent = label || ('Btn ' + (idx + 1));
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

    // Update UI
    const pct = (val / 127) * 100;
    channel.querySelector('.fader-fill').style.height = pct + '%';
    channel.querySelector('.fader-thumb').style.bottom = 'calc(' + pct + '% - 3px)';
    channel.querySelector('.fader-value').textContent = val;

    // Send CC
    const cc = POT_CC_BASE + currentBank * 4 + idx;
    sendCC(cc, val);
}

// Pointer events for faders (mouse + touch unified)
faderChannels.forEach((ch) => {
    const track = ch.querySelector('.fader-track');
    let dragging = false;

    track.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragging = true;
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
        sendCC(BTN_CC[idx], 127);
        sendNoteOn(BTN_NOTES[idx], 127);
    }

    function release(e) {
        e.preventDefault();
        btn.classList.remove('pressed');
        sendCC(BTN_CC[idx], 0);
        sendNoteOff(BTN_NOTES[idx]);
    }

    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointerleave', (e) => {
        if (btn.classList.contains('pressed')) release(e);
    });
    btn.addEventListener('pointercancel', (e) => {
        if (btn.classList.contains('pressed')) release(e);
    });
});

// === Persistence ===

function saveState() {
    try {
        localStorage.setItem('soniphorm-ble-midi', JSON.stringify({
            bank: currentBank,
            faders: faderValues
        }));
    } catch (e) { /* ignore */ }
}

function loadState() {
    try {
        const json = localStorage.getItem('soniphorm-ble-midi');
        if (!json) return;
        const data = JSON.parse(json);
        if (data.faders && data.faders.length === NUM_BANKS * 4) {
            faderValues = data.faders;
        }
        if (typeof data.bank === 'number' && data.bank >= 0 && data.bank < NUM_BANKS) {
            currentBank = data.bank;
            controlsDiv.setAttribute('data-bank', currentBank);
            bankBtns.forEach((b) => {
                b.classList.toggle('active', parseInt(b.dataset.bank) === currentBank);
            });
        }
    } catch (e) { /* ignore */ }
}

// Save on fader/bank changes (debounced)
let saveTimer = null;
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
}

// Patch sendCC and setBank to trigger save
const _origSendCC = sendCC;
// We'll save via a MutationObserver-like approach — just hook into the interaction handlers
// Actually, simplest: save on pointerup and bank change
faderChannels.forEach((ch) => {
    ch.querySelector('.fader-track').addEventListener('pointerup', scheduleSave);
});
bankBtns.forEach((btn) => {
    btn.addEventListener('click', scheduleSave);
});

// === PWA install ===

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.style.display = 'inline-block';
});

installBtn.addEventListener('click', () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => {
        deferredInstallPrompt = null;
        installBtn.style.display = 'none';
    });
});

// === Service Worker ===

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

// === Init ===

loadState();
updateFaderUI();
updateCCLabels();
