// slot-manager.js — manages 16 audio slots with IndexedDB persistence

const DB_NAME = 'soniphorm-recorder';
const DB_VERSION = 2;
const STORE_NAME = 'slots';
const KIT_STORE_NAME = 'kit-slots';
const NUM_SLOTS = 16;
const KIT_SUB_COUNT = 16;

// --- IDB Promise helpers ---

function idbGet(store, key) {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbPut(store, value) {
    return new Promise((resolve, reject) => {
        const req = store.put(value);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

function idbDelete(store, key) {
    return new Promise((resolve, reject) => {
        const req = store.delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// --- SlotManager ---
// WAV encoding uses AudioEngine.encodeWAV (loaded before this file)

class SlotManager {
    constructor() {
        this.db = null;
        this.slots = [];
        this.selectedIndex = -1;
        this.onChange = null;
        this._sharedAudioContext = null;

        // Kit sub-slot metadata: keyed by parentSlot index
        this.kitSlots = {};

        for (let i = 0; i < NUM_SLOTS; i++) {
            this.slots.push({
                index: i,
                name: '',
                duration: 0,
                sampleRate: 0,
                hasAudio: false,
                type: 'normal',
                bank: Math.floor(i / 4),
            });
        }
    }

    async init() {
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (event) => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'index' });
                }
                if (!db.objectStoreNames.contains(KIT_STORE_NAME)) {
                    db.createObjectStore(KIT_STORE_NAME, { keyPath: ['parentSlot', 'subIndex'] });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        // Load metadata for each slot from IndexedDB
        const tx = this.db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        const needsPeaks = [];
        for (let i = 0; i < NUM_SLOTS; i++) {
            const record = await idbGet(store, i);
            if (record) {
                this.slots[i].name = record.name || '';
                this.slots[i].duration = record.duration || 0;
                this.slots[i].sampleRate = record.sampleRate || 0;
                this.slots[i].hasAudio = !!record.audio;
                this.slots[i].type = record.type || 'normal';
                this.slots[i].peaks = record.peaks || null;
                if (!record.peaks && record.audio) {
                    needsPeaks.push(i);
                }
            }
        }

        // Migrate: compute peaks for old recordings that don't have them
        for (const i of needsPeaks) {
            try {
                const data = await this.getSlotAudio(i);
                if (data) {
                    const peaks = WaveformRenderer.computePeaks(data.channels[0], 200);
                    this.slots[i].peaks = peaks;
                    const tx2 = this.db.transaction(STORE_NAME, 'readwrite');
                    const store2 = tx2.objectStore(STORE_NAME);
                    const rec = await idbGet(store2, i);
                    if (rec) {
                        rec.peaks = Array.from(peaks);
                        await idbPut(store2, rec);
                    }
                }
            } catch (e) {
                console.warn('Failed to compute peaks for slot', i, e);
            }
        }

        // Load kit sub-slot metadata
        await this._loadKitMetadata();
    }

    async _loadKitMetadata() {
        const kitParents = this.slots.filter(s => s.type === 'kit');
        if (kitParents.length === 0) return;

        const tx = this.db.transaction(KIT_STORE_NAME, 'readonly');
        const store = tx.objectStore(KIT_STORE_NAME);

        for (const slot of kitParents) {
            const subs = [];
            for (let j = 0; j < KIT_SUB_COUNT; j++) {
                subs.push({ name: '', duration: 0, sampleRate: 0, hasAudio: false, peaks: null });
            }
            for (let j = 0; j < KIT_SUB_COUNT; j++) {
                try {
                    const rec = await idbGet(store, [slot.index, j]);
                    if (rec && rec.audio) {
                        subs[j].name = rec.name || '';
                        subs[j].duration = rec.duration || 0;
                        subs[j].sampleRate = rec.sampleRate || 0;
                        subs[j].hasAudio = true;
                        subs[j].peaks = rec.peaks || null;
                    }
                } catch (e) {
                    // ignore individual sub-slot load errors
                }
            }
            this.kitSlots[slot.index] = subs;
        }
    }

    setAudioContext(ctx) {
        this._sharedAudioContext = ctx;
    }

    selectSlot(index) {
        this.selectedIndex = index;
    }

    getSelectedSlot() {
        if (this.selectedIndex < 0 || this.selectedIndex >= NUM_SLOTS) {
            return null;
        }
        return this.slots[this.selectedIndex];
    }

    async getSlotAudio(index) {
        const tx = this.db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const record = await idbGet(store, index);

        if (!record || !record.audio) {
            return null;
        }

        // Reuse shared context when available (avoids hitting mobile AudioContext limits)
        const ownContext = !this._sharedAudioContext;
        const audioContext = this._sharedAudioContext || new (window.AudioContext || window.webkitAudioContext)();
        try {
            const arrayBuffer = await record.audio.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            const channels = [];
            for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
                channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
            }
            return { channels, sampleRate: audioBuffer.sampleRate };
        } finally {
            if (ownContext) audioContext.close();
        }
    }

    async saveSlotAudio(index, channels, sampleRate) {
        const duration = channels[0].length / sampleRate;
        const audio = AudioEngine.encodeWAV(channels, sampleRate);
        const name = this.slots[index].name;
        const type = this.slots[index].type || 'normal';
        const peaks = WaveformRenderer.computePeaks(channels[0], 200);

        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await idbPut(store, { index, name, type, duration, sampleRate, audio, peaks: Array.from(peaks) });

        this.slots[index].duration = duration;
        this.slots[index].sampleRate = sampleRate;
        this.slots[index].hasAudio = true;
        this.slots[index].peaks = peaks;

        this.onChange?.();
    }

    async clearSlot(index) {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await idbDelete(store, index);

        this.slots[index].name = '';
        this.slots[index].duration = 0;
        this.slots[index].sampleRate = 0;
        this.slots[index].hasAudio = false;
        this.slots[index].peaks = null;

        this.onChange?.();
    }

    async renameSlot(index, name) {
        this.slots[index].name = name;

        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const record = await idbGet(store, index);

        if (record) {
            record.name = name;
            await idbPut(store, record);
        }

        this.onChange?.();
    }

    findEmptySlot() {
        for (let i = 0; i < NUM_SLOTS; i++) {
            if (!this.slots[i].hasAudio && this.slots[i].type !== 'kit') {
                return i;
            }
        }
        return -1;
    }

    // === Kit CRUD ===

    async makeKit(index) {
        this.slots[index].type = 'kit';
        this.slots[index].hasAudio = false;
        this.slots[index].name = this.slots[index].name || 'Kit';

        // Clear any existing normal audio from this slot
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const existing = await idbGet(store, index);
        const rec = {
            index,
            name: this.slots[index].name,
            type: 'kit',
            duration: 0,
            sampleRate: 0,
            peaks: null,
        };
        await idbPut(store, rec);

        // Initialize empty kit sub-slots in memory
        const subs = [];
        for (let j = 0; j < KIT_SUB_COUNT; j++) {
            subs.push({ name: '', duration: 0, sampleRate: 0, hasAudio: false, peaks: null });
        }
        this.kitSlots[index] = subs;

        this.onChange?.();
    }

    async unmakeKit(index) {
        await this.clearAllKitSlots(index);
        delete this.kitSlots[index];

        this.slots[index].type = 'normal';
        this.slots[index].name = '';
        this.slots[index].hasAudio = false;
        this.slots[index].duration = 0;
        this.slots[index].sampleRate = 0;
        this.slots[index].peaks = null;

        // Remove slot record from IDB
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await idbDelete(store, index);

        // Clean up kit pad settings
        try { localStorage.removeItem('soniphorm-kit-pads-' + index); } catch (e) {}

        this.onChange?.();
    }

    async getKitSlotAudio(parentSlot, subIndex) {
        const tx = this.db.transaction(KIT_STORE_NAME, 'readonly');
        const store = tx.objectStore(KIT_STORE_NAME);
        const record = await idbGet(store, [parentSlot, subIndex]);

        if (!record || !record.audio) return null;

        const ownContext = !this._sharedAudioContext;
        const audioContext = this._sharedAudioContext || new (window.AudioContext || window.webkitAudioContext)();
        try {
            const arrayBuffer = await record.audio.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            const channels = [];
            for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
                channels.push(new Float32Array(audioBuffer.getChannelData(ch)));
            }
            return { channels, sampleRate: audioBuffer.sampleRate };
        } finally {
            if (ownContext) audioContext.close();
        }
    }

    async saveKitSlotAudio(parentSlot, subIndex, channels, sampleRate) {
        const duration = channels[0].length / sampleRate;
        const audio = AudioEngine.encodeWAV(channels, sampleRate);
        const name = (this.kitSlots[parentSlot] && this.kitSlots[parentSlot][subIndex])
            ? this.kitSlots[parentSlot][subIndex].name : '';
        const peaks = WaveformRenderer.computePeaks(channels[0], 200);

        const tx = this.db.transaction(KIT_STORE_NAME, 'readwrite');
        const store = tx.objectStore(KIT_STORE_NAME);
        await idbPut(store, {
            parentSlot, subIndex, name, duration, sampleRate, audio, peaks: Array.from(peaks)
        });

        if (!this.kitSlots[parentSlot]) {
            const subs = [];
            for (let j = 0; j < KIT_SUB_COUNT; j++) {
                subs.push({ name: '', duration: 0, sampleRate: 0, hasAudio: false, peaks: null });
            }
            this.kitSlots[parentSlot] = subs;
        }
        this.kitSlots[parentSlot][subIndex].duration = duration;
        this.kitSlots[parentSlot][subIndex].sampleRate = sampleRate;
        this.kitSlots[parentSlot][subIndex].hasAudio = true;
        this.kitSlots[parentSlot][subIndex].peaks = peaks;

        this.onChange?.();
    }

    async clearKitSlot(parentSlot, subIndex) {
        const tx = this.db.transaction(KIT_STORE_NAME, 'readwrite');
        const store = tx.objectStore(KIT_STORE_NAME);
        await idbDelete(store, [parentSlot, subIndex]);

        if (this.kitSlots[parentSlot]) {
            this.kitSlots[parentSlot][subIndex] = {
                name: '', duration: 0, sampleRate: 0, hasAudio: false, peaks: null
            };
        }

        this.onChange?.();
    }

    async clearAllKitSlots(parentSlot) {
        const tx = this.db.transaction(KIT_STORE_NAME, 'readwrite');
        const store = tx.objectStore(KIT_STORE_NAME);
        for (let j = 0; j < KIT_SUB_COUNT; j++) {
            try { await idbDelete(store, [parentSlot, j]); } catch (e) {}
        }

        if (this.kitSlots[parentSlot]) {
            for (let j = 0; j < KIT_SUB_COUNT; j++) {
                this.kitSlots[parentSlot][j] = {
                    name: '', duration: 0, sampleRate: 0, hasAudio: false, peaks: null
                };
            }
        }
    }

    getKitSlotMeta(parentSlot, subIndex) {
        if (!this.kitSlots[parentSlot]) return null;
        return this.kitSlots[parentSlot][subIndex] || null;
    }

    async renameKitSlot(parentSlot, subIndex, name) {
        if (this.kitSlots[parentSlot]) {
            this.kitSlots[parentSlot][subIndex].name = name;
        }

        const tx = this.db.transaction(KIT_STORE_NAME, 'readwrite');
        const store = tx.objectStore(KIT_STORE_NAME);
        const record = await idbGet(store, [parentSlot, subIndex]);

        if (record) {
            record.name = name;
            await idbPut(store, record);
        }

        this.onChange?.();
    }
}
