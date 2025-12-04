// LocalStorageの代わりにIndexedDBを使用するアセット管理クラス
// Phase 10: Integrity Check, Metabolism (LRU), & Self-Healing

export class AssetManager {
    constructor() {
        this.dbName = 'ShibainuAssetsDB';
        this.storeName = 'assets';
        this.version = 2; // Phase 10: Schema Update for Metabolism
        this.db = null;
        this.initPromise = this.initDB();
        
        this.CHUNK_SIZE = 1024 * 256; // 256KB per chunk
        this.tempChunks = {}; // 再構築中のチャンクキャッシュ

        // Metabolism Config
        this.MAX_ITEMS = 500; // 最大保存ファイル数
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                let store;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    store = db.createObjectStore(this.storeName);
                } else {
                    store = request.transaction.objectStore(this.storeName);
                }

                // Phase 10: Create Index for LRU
                if (!store.indexNames.contains('lastAccess')) {
                    store.createIndex('lastAccess', 'lastAccess', { unique: false });
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

    // Phase 10: Metabolism & Metadata Wrapper
    async saveAsset(hash, data) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            // 1. 容量チェック (Metabolism)
            const countReq = store.count();
            countReq.onsuccess = () => {
                if (countReq.result >= this.MAX_ITEMS) {
                    this.performCleanup(store);
                }
            };

            // 2. ラッパー作成 (Metadata)
            const record = {
                content: data,
                lastAccess: Date.now()
            };

            // putはキー(hash)を指定して保存
            const request = store.put(record, hash);

            request.onsuccess = () => {
                const size = (data instanceof Blob) ? data.size : data.length;
                // console.log(`[AssetManager] Saved: ${hash.substring(0, 8)}... (${size} bytes)`);
                resolve(true);
            };
            request.onerror = () => reject(request.error);
        });
    }

    // 古いデータの削除 (LRU Strategy)
    performCleanup(store) {
        // lastAccessインデックスを使って古い順に検索
        const index = store.index('lastAccess');
        const cursorReq = index.openKeyCursor(); // キーのみ取得で高速化

        cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                console.log(`[AssetManager] Metabolism: Removing old asset ${cursor.primaryKey}`);
                store.delete(cursor.primaryKey);
                // 1つ消したら終了（頻繁に呼ばれるため少しずつ消せば良い）
            }
        };
    }

    async loadAsset(hash) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite'); // 更新のためreadwrite
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);

            request.onsuccess = () => {
                const result = request.result;
                if (!result) { resolve(null); return; }

                let content = result;
                
                // Phase 10: Unwrap Metadata & Update LastAccess
                if (result.content && result.lastAccess) {
                    content = result.content;
                    // アクセス時刻を更新して再保存 (非同期で良い)
                    result.lastAccess = Date.now();
                    store.put(result, hash); 
                } else {
                    // 旧形式データのマイグレーション (読み込みついでに形式変換)
                    this.saveAsset(hash, result);
                }
                
                // Blobの場合はBase64に変換して返す
                if (content instanceof Blob) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const base64 = reader.result.split(',')[1];
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
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.count(hash);

            request.onsuccess = () => {
                resolve(request.result > 0);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteAsset(hash) {
        await this.initPromise;
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        store.delete(hash);
        console.warn(`[AssetManager] Deleted asset: ${hash}`);
    }

    // --- Helper ---
    base64ToUint8Array(base64) {
        const binaryString = window.atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }

    async blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // --- P2P Swarm Support ---

    async getAssetMetadata(hash) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);

            request.onsuccess = async () => {
                const result = request.result;
                if (!result) { resolve(null); return; }

                let data = result;
                if (result.content) data = result.content; // Unwrap

                let size = 0;
                if (data instanceof Blob) {
                    size = data.size;
                } else {
                    size = data.length; 
                }
                
                const chunkCount = Math.ceil(size / this.CHUNK_SIZE);
                resolve({
                    hash: hash,
                    size: size,
                    chunkCount: chunkCount
                });
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getChunk(hash, index) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);

            request.onsuccess = async () => {
                const result = request.result;
                if (!result) { resolve(null); return; }

                let data = result;
                if (result.content) data = result.content; // Unwrap

                const start = index * this.CHUNK_SIZE;
                
                if (data instanceof Blob) {
                    const end = Math.min(start + this.CHUNK_SIZE, data.size);
                    const chunkBlob = data.slice(start, end);
                    const chunkBase64 = await this.blobToBase64(chunkBlob);
                    resolve(chunkBase64);
                } else {
                    const end = Math.min(start + this.CHUNK_SIZE, data.length);
                    const chunkData = data.substring(start, end);
                    resolve(chunkData);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    // Phase 10: Integrity Check
    async receiveChunk(hash, index, total, base64Data) {
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
            entry.parts[index] = this.base64ToUint8Array(base64Data);
            entry.receivedCount++;
            entry.lastUpdate = Date.now();
        }

        if (entry.receivedCount >= total) {
            // 全チャンク結合
            const blob = new Blob(entry.parts, { type: 'application/octet-stream' });
            
            // --- Integrity Check ---
            try {
                const buffer = await blob.arrayBuffer();
                const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const calculatedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

                // ハッシュ不一致チェック (大文字小文字を区別しない)
                if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
                    console.error(`[AssetManager] Integrity Check Failed! Expected: ${hash}, Got: ${calculatedHash}`);
                    // メモリ解放
                    entry.parts = null; 
                    delete this.tempChunks[hash];
                    return { status: 'corrupted' };
                }

                // 合格なら保存
                await this.saveAsset(hash, blob);
                console.log(`[AssetManager] Asset Verified & Saved: ${hash}`);
                
                entry.parts = null; 
                delete this.tempChunks[hash];
                
                if (window.gameEngine && window.gameEngine.visualEntityManager) {
                    window.gameEngine.visualEntityManager.onAssetAvailable(hash);
                }
                return { status: 'ok' };

            } catch (e) {
                console.error("[AssetManager] Verification Error:", e);
                return { status: 'error' };
            }
        }
        return { status: 'incomplete' }; 
    }

    // Phase 10: Self-Check Logic (The Osekkai Protocol)
    // 外部から「お前のデータ壊れてるぞ」と言われた時に実行
    async verifyLocalAsset(hash) {
        console.log(`[AssetManager] Self-verifying asset: ${hash}...`);
        await this.initPromise;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);

            request.onsuccess = async () => {
                const result = request.result;
                if (!result) { console.log("[AssetManager] Asset not found locally."); resolve(); return; }

                let content = result;
                if (result.content) content = result.content;

                let buffer;
                if (content instanceof Blob) {
                    buffer = await content.arrayBuffer();
                } else {
                    // String data fallback (less likely for assets but possible)
                    const enc = new TextEncoder();
                    buffer = enc.encode(content);
                }

                const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const calculatedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

                if (calculatedHash.toLowerCase() !== hash.toLowerCase()) {
                    console.warn(`[AssetManager] SELF-CHECK FAILED. I am corrupted. Deleting ${hash}.`);
                    this.deleteAsset(hash);
                } else {
                    console.log(`[AssetManager] Self-check passed for ${hash}. I am clean.`);
                }
                resolve();
            };
            request.onerror = () => reject();
        });
    }

    // --- JS Import (10MB Bypass) ---
    async importFromInput(inputId) {
        const input = document.getElementById(inputId);
        if (!input || !input.files || input.files.length === 0) return null;

        const file = input.files[0];
        console.log(`[AssetManager] Importing file via JS: ${file.name} (${file.size} bytes)`);

        try {
            const arrayBuffer = await file.arrayBuffer();
            
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

            console.log(`[AssetManager] Computed SHA-256: ${hashHex}`);

            await this.saveAsset(hashHex, file);
            
            return hashHex;
        } catch (e) {
            console.error("[AssetManager] Import failed:", e);
            throw e;
        }
    }
}

window.assetManager = new AssetManager();