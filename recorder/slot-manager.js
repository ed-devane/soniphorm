// slot-manager.js — manages 16 audio slots with IndexedDB persistence

const DB_NAME = 'soniphorm-recorder';
const DB_VERSION = 1;
const STORE_NAME = 'slots';
const NUM_SLOTS = 16;

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

        for (let i = 0; i < NUM_SLOTS; i++) {
            this.slots.push({
                index: i,
                name: '',
                duration: 0,
                sampleRate: 0,
                hasAudio: false,
                bank: Math.floor(i / 4),
            });
        }
    }

    async init() {
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'index' });
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
                this.slots[i].hasAudio = true;
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
        const peaks = WaveformRenderer.computePeaks(channels[0], 200);

        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        await idbPut(store, { index, name, duration, sampleRate, audio, peaks: Array.from(peaks) });

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
            if (!this.slots[i].hasAudio) {
                return i;
            }
        }
        return -1;
    }
}
