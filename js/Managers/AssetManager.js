import { Utils } from '../Utils/Utils.js';
export class AssetManager {
    constructor() {
        this.baseDbName = 'ShibainuAssetsDB';
        this.currentDbName = '';
        this.storeName = 'assets';
        this.version = 2;
        this.db = null;
        this._initResolver = null;
        this.initPromise = new Promise((resolve) => {
            this._initResolver = resolve;
        });
        this.CHUNK_SIZE = 1024 * 16;
        this.MAX_CHUNKS = 3200;
        this.tempChunks = {};
        this.MAX_ITEMS = 500;
        this.GC_INTERVAL = 60000; 
        this.CHUNK_TIMEOUT = 60000; 
        this.startGarbageCollector();
    }
    startGarbageCollector() {
        this.gcTimer = setInterval(() => {
            const now = Date.now();
            const keys = Object.keys(this.tempChunks);
            let removed = 0;
            keys.forEach(hash => {
                const entry = this.tempChunks[hash];
                if (now - entry.lastUpdate > this.CHUNK_TIMEOUT) {
                    delete this.tempChunks[hash];
                    removed++;
                }
            });
            if (removed > 0) {
                console.log(`[AssetManager] GC: Removed ${removed} stale temporary chunks.`);
            }
        }, this.GC_INTERVAL);
    }
    async setNetworkId(networkId) {
        const safeId = networkId.replace(/[^a-zA-Z0-9_-]/g, "");
        const newDbName = `${this.baseDbName}_${safeId}`;
        if (this.currentDbName === newDbName && this.db) return;
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.currentDbName = newDbName;
        console.log(`[AssetManager] Switching DB to: ${this.currentDbName}`);
        await this._openDB();
    }
    async _openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.currentDbName, this.version);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                let store;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    store = db.createObjectStore(this.storeName);
                } else {
                    store = request.transaction.objectStore(this.storeName);
                }
                if (!store.indexNames.contains('lastAccess')) {
                    store.createIndex('lastAccess', 'lastAccess', { unique: false });
                }
            };
            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log(`[AssetManager] IndexedDB (${this.currentDbName}) Ready.`);
                if (this._initResolver) {
                    this._initResolver();
                    this._initResolver = null;
                }
                resolve();
            };
            request.onerror = (event) => {
                console.error("[AssetManager] DB Error:", event.target.error);
                reject(event.target.error);
            };
        });
    }
    async saveAsset(hash, data) {
        await this.initPromise;
        if (!this.db) await this._openDB();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const countReq = store.count();
            countReq.onsuccess = () => {
                if (countReq.result >= this.MAX_ITEMS) {
                    this.performCleanup(store);
                }
            };
            const record = {
                content: data,
                lastAccess: Date.now()
            };
            const request = store.put(record, hash);
            request.onsuccess = () => {
                // ★FIX: Notify VisualEntityManager immediately after saving
                if (window.gameEngine && window.gameEngine.visualEntityManager) {
                    window.gameEngine.visualEntityManager.onAssetAvailable(hash);
                }
                resolve(true);
            };
            request.onerror = () => reject(request.error);
        });
    }
    performCleanup(store) {
        const index = store.index('lastAccess');
        const cursorReq = index.openKeyCursor();
        cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                console.log(`[AssetManager] Metabolism: Removing old asset ${cursor.primaryKey}`);
                store.delete(cursor.primaryKey);
            }
        };
    }
    async loadAsset(hash) {
        await this.initPromise;
        if (!this.db) return null;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);
            request.onsuccess = () => {
                const result = request.result;
                if (!result) { resolve(null); return; }
                let content = result;
                if (result.content && result.lastAccess) {
                    content = result.content;
                    result.lastAccess = Date.now();
                    store.put(result, hash);
                } else {
                    this.saveAsset(hash, result);
                }
                if (content instanceof Blob) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const base64 = reader.result.split(',')[ 1 ];
                        resolve(base64);
                    };
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(content);
                } else {
                    resolve(content);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    async hasAsset(hash) {
        await this.initPromise;
        if (!this.db) return false;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.count(hash);
            request.onsuccess = () => resolve(request.result > 0);
            request.onerror = () => reject(request.error);
        });
    }
    async deleteAsset(hash) {
        await this.initPromise;
        if (!this.db) return;
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        store.delete(hash);
    }
    async getAssetMetadata(hash) {
        await this.initPromise;
        if (!this.db) return null;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);
            request.onsuccess = async () => {
                const result = request.result;
                if (!result) { resolve(null); return; }
                let data = result.content || result;
                let size = (data instanceof Blob) ? data.size : data.length;
                const chunkCount = Math.ceil(size / this.CHUNK_SIZE);
                resolve({ hash: hash, size: size, chunkCount: chunkCount });
            };
            request.onerror = () => reject(request.error);
        });
    }
    async getChunk(hash, index) {
        await this.initPromise;
        if (!this.db) return null;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);
            request.onsuccess = async () => {
                const result = request.result;
                if (!result) { resolve(null); return; }
                let data = result.content || result;
                const start = index * this.CHUNK_SIZE;
                if (data instanceof Blob) {
                    const end = Math.min(start + this.CHUNK_SIZE, data.size);
                    const chunkBlob = data.slice(start, end);
                    const chunkBase64 = await Utils.blobToBase64(chunkBlob);
                    resolve(chunkBase64);
                } else {
                    const end = Math.min(start + this.CHUNK_SIZE, data.length);
                    resolve(data.substring(start, end));
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
    async receiveChunk(hash, index, total, base64Data) {
        if (total > this.MAX_CHUNKS) {
            console.error(`[AssetManager] Rejected oversize asset (${total} chunks > ${this.MAX_CHUNKS})`);
            return { status: 'rejected_oversize' };
        }
        if (index < 0 || index >= total) {
            console.error(`[AssetManager] Invalid chunk index ${index} (Total: ${total}). Possible attack.`);
            return { status: 'error' };
        }
        if (!this.tempChunks[hash]) {
            this.tempChunks[hash] = {
                receivedCount: 0,
                totalChunks: total,
                parts: new Array(total).fill(null),
                lastUpdate: Date.now()
            };
        }
        const entry = this.tempChunks[hash];
        if (entry.totalChunks !== total) {
            console.error(`[AssetManager] Inconsistent total chunks for ${hash}. Dropping.`);
            delete this.tempChunks[hash];
            return { status: 'error' };
        }
        if (entry.parts[index] === null) {
            entry.parts[index] = Utils.base64ToUint8Array(base64Data);
            entry.receivedCount++;
            entry.lastUpdate = Date.now();
        }
        if (entry.receivedCount >= total) {
            const blob = new Blob(entry.parts, { type: 'application/octet-stream' });
            try {
                const buffer = await blob.arrayBuffer();
                const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const calculatedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
                    console.error(`[AssetManager] Integrity Check Failed!`);
                    delete this.tempChunks[hash];
                    return { status: 'corrupted' };
                }
                await this.saveAsset(hash, blob);
                console.log(`[AssetManager] Asset Verified & Saved: ${hash}`);
                delete this.tempChunks[hash];
                // onAssetAvailable is now called inside saveAsset
                return { status: 'ok' };
            } catch (e) {
                console.error("[AssetManager] Verification Error:", e);
                return { status: 'error' };
            }
        }
        return { status: 'incomplete' };
    }
    async verifyLocalAsset(hash) {
        await this.initPromise;
        if (!this.db) return;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);
            request.onsuccess = async () => {
                const result = request.result;
                if (!result) { resolve(); return; }
                let content = result.content || result;
                let buffer;
                if (content instanceof Blob) {
                    buffer = await content.arrayBuffer();
                } else {
                    const enc = new TextEncoder();
                    buffer = enc.encode(content);
                }
                const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const calculatedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
                    console.warn(`[AssetManager] SELF-CHECK FAILED. Deleting ${hash}.`);
                    this.deleteAsset(hash);
                }
                resolve();
            };
            request.onerror = () => reject();
        });
    }
    async importFromInput(inputId) {
        const input = document.getElementById(inputId);
        if (!input || !input.files || input.files.length === 0) return null;
        const file = input.files[ 0 ];
        try {
            const arrayBuffer = await file.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            await this.saveAsset(hashHex, file);
            return hashHex;
        } catch (e) {
            console.error("[AssetManager] Import failed:", e);
            throw e;
        }
    }
}
window.assetManager = new AssetManager();