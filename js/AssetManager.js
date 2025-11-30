// LocalStorageの代わりにIndexedDBを使用するアセット管理クラス
// P2Pスワーム配信（チャンク分割・再構築）機能 + inputインポート機能

export class AssetManager {
    constructor() {
        this.dbName = 'ShibainuAssetsDB';
        this.storeName = 'assets';
        this.version = 1;
        this.db = null;
        this.initPromise = this.initDB();
        
        this.CHUNK_SIZE = 1024 * 256; // 256KB per chunk
        this.tempChunks = {}; // 再構築中のチャンクキャッシュ
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log("[AssetManager] IndexedDB Initialized.");
                resolve();
            };

            request.onerror = (event) => {
                console.error("[AssetManager] DB Error:", event.target.error);
                reject(event.target.error);
            };
        });
    }

    async saveAsset(hash, base64Data) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(base64Data, hash);

            request.onsuccess = () => {
                console.log(`[AssetManager] Saved: ${hash.substring(0, 8)}... (${base64Data.length} bytes)`);
                resolve(true);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async loadAsset(hash) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);

            request.onsuccess = () => {
                resolve(request.result); // base64 string
            };
            request.onerror = () => reject(request.error);
        });
    }

    async hasAsset(hash) {
        const data = await this.loadAsset(hash);
        return !!data;
    }

    async deleteAsset(hash) {
        await this.initPromise;
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        store.delete(hash);
    }

    // --- P2P Swarm Support ---

    async getAssetMetadata(hash) {
        const base64 = await this.loadAsset(hash);
        if (!base64) return null;

        const totalLen = base64.length;
        const chunkCount = Math.ceil(totalLen / this.CHUNK_SIZE);
        
        return {
            hash: hash,
            size: totalLen,
            chunkCount: chunkCount
        };
    }

    async getChunk(hash, index) {
        const base64 = await this.loadAsset(hash);
        if (!base64) return null;

        const start = index * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, base64.length);
        const chunkData = base64.substring(start, end);

        return chunkData;
    }

    receiveChunk(hash, index, total, data) {
        if (!this.tempChunks[hash]) {
            this.tempChunks[hash] = {
                receivedCount: 0,
                totalChunks: total,
                parts: new Array(total).fill(null),
                lastUpdate: Date.now()
            };
        }

        const entry = this.tempChunks[hash];
        if (entry.parts[index] === null) {
            entry.parts[index] = data;
            entry.receivedCount++;
            entry.lastUpdate = Date.now();
        }

        if (entry.receivedCount >= total) {
            const fullBase64 = entry.parts.join('');
            this.saveAsset(hash, fullBase64).then(() => {
                console.log(`[AssetSwarm] Asset Reassembled & Saved: ${hash}`);
                delete this.tempChunks[hash];
                if (window.gameEngine && window.gameEngine.visualEntityManager) {
                    window.gameEngine.visualEntityManager.onAssetAvailable(hash);
                }
            });
            return true; 
        }
        return false; 
    }

    // --- JS Import (10MB Bypass) ---
    async importFromInput(inputId) {
        const input = document.getElementById(inputId);
        if (!input || !input.files || input.files.length === 0) return null;

        const file = input.files[0];
        console.log(`[AssetManager] Importing file via JS: ${file.name} (${file.size} bytes)`);

        try {
            const arrayBuffer = await file.arrayBuffer();
            
            // C#側の CryptoService.ComputeSha256 と互換性のあるハッシュ生成
            // (fileName + length + firstByte)
            const firstByte = arrayBuffer.byteLength > 0 ? new Uint8Array(arrayBuffer)[0] : 0;
            const metaString = file.name + arrayBuffer.byteLength + firstByte;
            const metaEncoder = new TextEncoder();
            const metaData = metaEncoder.encode(metaString);
            
            const hashBuffer = await crypto.subtle.digest('SHA-256', metaData);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

            const base64 = await this.bufferToBase64(arrayBuffer);

            await this.saveAsset(hashHex, base64);
            
            return hashHex;
        } catch (e) {
            console.error("[AssetManager] Import failed:", e);
            throw e;
        }
    }

    bufferToBase64(buffer) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([buffer]);
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result;
                const base64 = result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
}

window.assetManager = new AssetManager();