// LocalStorageの代わりにIndexedDBを使用するアセット管理クラス
// P2Pスワーム配信（チャンク分割・再構築）機能 + inputインポート機能
// ★修正: メモリ最適化版 (Blob使用)

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

    // ★修正: dataはBlobまたはBase64文字列を受け入れる
    async saveAsset(hash, data) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(data, hash);

            request.onsuccess = () => {
                const size = (data instanceof Blob) ? data.size : data.length;
                console.log(`[AssetManager] Saved: ${hash.substring(0, 8)}... (${size} bytes)`);
                resolve(true);
            };
            request.onerror = () => reject(request.error);
        });
    }

    // ★修正: 戻り値はBase64文字列であることを保証する (VisualEntityManager互換性のため)
    async loadAsset(hash) {
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);

            request.onsuccess = () => {
                const result = request.result;
                
                // Blobの場合はBase64に変換して返す
                if (result instanceof Blob) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        // Data URL形式 "data:application/octet-stream;base64,..." から
                        // コンマ以降の純粋なBase64部分のみを抽出する
                        const base64 = reader.result.split(',')[1];
                        resolve(base64);
                    };
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(result);
                } else {
                    // 既に文字列(旧形式)ならそのまま返す
                    resolve(result); 
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    async hasAsset(hash) {
        // Blob対応版loadAssetを経由すると重いため、存在確認は簡易的に行う
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.count(hash); // countだけなら高速

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
    }

    // --- Helper for Memory Optimization ---
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
        // メタデータ取得のために全データをロードするのはコストが高いが、
        // Swarm配信元としての役割上やむなし。Blobならメモリ効率は多少マシ。
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);

            request.onsuccess = async () => {
                const data = request.result;
                if (!data) { resolve(null); return; }

                let size = 0;
                if (data instanceof Blob) {
                    size = data.size;
                } else {
                    size = data.length; // Base64 string length
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
        // 部分読み出し
        await this.initPromise;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(hash);

            request.onsuccess = async () => {
                const data = request.result;
                if (!data) { resolve(null); return; }

                const start = index * this.CHUNK_SIZE;
                
                if (data instanceof Blob) {
                    // Blob.slice() はメモリ効率が良い
                    const end = Math.min(start + this.CHUNK_SIZE, data.size);
                    const chunkBlob = data.slice(start, end);
                    // 転送用にBase64化して返す
                    const chunkBase64 = await this.blobToBase64(chunkBlob);
                    resolve(chunkBase64);
                } else {
                    // 旧形式(String)のフォールバック
                    const end = Math.min(start + this.CHUNK_SIZE, data.length);
                    const chunkData = data.substring(start, end);
                    resolve(chunkData);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    receiveChunk(hash, index, total, base64Data) {
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
            // ★修正: Base64文字列のまま保持せず、Uint8Array(バイナリ)に即変換して保持する
            // これによりメモリ使用量を削減 (Base64はバイナリより約33%大きい)
            entry.parts[index] = this.base64ToUint8Array(base64Data);
            entry.receivedCount++;
            entry.lastUpdate = Date.now();
        }

        if (entry.receivedCount >= total) {
            // ★修正: 文字列結合(join)ではなく、Blobを作成して保存する
            const blob = new Blob(entry.parts, { type: 'application/octet-stream' });
            
            this.saveAsset(hash, blob).then(() => {
                console.log(`[AssetSwarm] Asset Reassembled & Saved as Blob: ${hash}`);
                
                // メモリ解放
                entry.parts = null; 
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
            
            // C#互換ハッシュ生成 (fileName + length + firstByte)
            const firstByte = arrayBuffer.byteLength > 0 ? new Uint8Array(arrayBuffer)[0] : 0;
            const metaString = file.name + arrayBuffer.byteLength + firstByte;
            const metaEncoder = new TextEncoder();
            const metaData = metaEncoder.encode(metaString);
            
            const hashBuffer = await crypto.subtle.digest('SHA-256', metaData);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

            // ★修正: ファイル(Blob)をそのまま保存する (Base64変換を省略)
            // fileはBlobの一種なのでそのまま渡せる
            await this.saveAsset(hashHex, file);
            
            return hashHex;
        } catch (e) {
            console.error("[AssetManager] Import failed:", e);
            throw e;
        }
    }
}

window.assetManager = new AssetManager();