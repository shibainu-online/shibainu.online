// LocalStorageの代わりにIndexedDBを使用するアセット管理クラス
// Adminツールでのモデル読み込み時のQuotaExceededエラーを回避します。

export class AssetManager {
    constructor() {
        this.dbName = 'ShibainuAssetsDB';
        this.storeName = 'assets';
        this.version = 1;
        this.db = null;
        this.initPromise = this.initDB();
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
            // 文字列またはBlobとして保存
            const request = store.put(base64Data, hash);

            request.onsuccess = () => {
                console.log(`[AssetManager] Saved: ${hash.substring(0, 8)}...`);
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
                resolve(request.result); // base64 string or undefined
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
}

// グローバルインスタンスとして公開
window.assetManager = new AssetManager();