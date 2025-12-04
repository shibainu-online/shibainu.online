import * as THREE from 'three';

// 定数
const PAGE_SIZE = 4096; // 4Kテクスチャ
const SLOT_SIZE = 128;  // 1スロットの基本サイズ (px)

class AtlasPage {
    constructor(id, type) {
        this.id = id;
        this.type = type; // 'opaque' or 'transparent'
        
        this.canvas = document.createElement('canvas');
        this.canvas.width = PAGE_SIZE;
        this.canvas.height = PAGE_SIZE;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        
        // クリア
        this.ctx.clearRect(0, 0, PAGE_SIZE, PAGE_SIZE);

        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.magFilter = THREE.NearestFilter;
        this.texture.minFilter = THREE.NearestFilter;
        this.texture.generateMipmaps = false; // 更新頻度が高いためOFF

        this.slotsPerRow = Math.floor(PAGE_SIZE / SLOT_SIZE);
        this.totalSlots = this.slotsPerRow * this.slotsPerRow;
        
        // スロット管理: index -> { hash, lastAccess, x, y }
        this.slots = new Array(this.totalSlots).fill(null);
        this.usedCount = 0;
    }

    update() {
        if (this.texture) this.texture.needsUpdate = true;
    }

    // 空きスロットを探す (LRU戦略)
    findSlot() {
        // 1. 完全な空きがあればそれを使う
        for (let i = 0; i < this.totalSlots; i++) {
            if (this.slots[i] === null) return i;
        }

        // 2. 空きがない場合、最も古くアクセスされたスロットを探す (LRU)
        // ※ 本来は全てのページを通して探すべきだが、簡易実装としてページ内で探す
        let oldestIndex = -1;
        let oldestTime = Date.now();

        for (let i = 0; i < this.totalSlots; i++) {
            if (this.slots[i].lastAccess < oldestTime) {
                oldestTime = this.slots[i].lastAccess;
                oldestIndex = i;
            }
        }

        return oldestIndex;
    }

    // 画像を描画
    write(slotIndex, image, hash) {
        const col = slotIndex % this.slotsPerRow;
        const row = Math.floor(slotIndex / this.slotsPerRow);
        const x = col * SLOT_SIZE;
        const y = row * SLOT_SIZE;

        // 領域をクリア
        this.ctx.clearRect(x, y, SLOT_SIZE, SLOT_SIZE);
        
        // 描画 (アスペクト比維持で中央配置...はせず、今回はスロットに合わせてストレッチまたは左上配置)
        // アニメーションストリップの場合は縮小して収める等の対応が必要だが、
        // 今回の要件では「横長を維持」なので、スロット内に収まるように縮小描画する。
        // ただし、スロットサイズ(128)を超えるアニメーション(例: 128x32が4枚=512px)の場合、
        // 1スロットには収まらない。
        // ★修正: 本格的なパッキングは複雑になるため、今回は
        // 「アニメーション画像も1スロット(128x128)に縮小して収める」方針とする。
        // UV計算でカバーする。
        
        // 画像のアスペクト比に合わせて描画サイズを調整
        // 横長(アニメーション)の場合、幅を128に合わせて高さを縮める
        let dw = SLOT_SIZE;
        let dh = SLOT_SIZE;
        
        if (image.width > image.height) {
            dh = dw * (image.height / image.width);
        } else {
            dw = dh * (image.width / image.height);
        }

        // 中央配置オフセット
        // const dx = x + (SLOT_SIZE - dw) / 2;
        // const dy = y + (SLOT_SIZE - dh) / 2;
        // シンプルに左上配置 (UV計算を簡単にするため)
        const dx = x;
        const dy = y;

        this.ctx.drawImage(image, 0, 0, image.width, image.height, dx, dy, dw, dh);

        // メタデータ記録
        const info = {
            hash: hash,
            lastAccess: Date.now(),
            pageId: this.id,
            slotIndex: slotIndex,
            uv: {
                x: dx / PAGE_SIZE,
                // Canvas(左上)とThree.js(左下)のY軸反転を考慮
                // Three.jsのUV: 下からどれくらいか
                y: 1.0 - ((dy + dh) / PAGE_SIZE), 
                w: dw / PAGE_SIZE,
                h: dh / PAGE_SIZE
            },
            // アニメーション情報の計算
            // 横長画像(例えば w >= h * 2)はアニメーションストリップとみなす
            // NBLM要件: framesを含める
            isStrip: (image.width >= image.height * 2) || (image.width % image.height === 0 && image.width > image.height),
            rawWidth: image.width,
            rawHeight: image.height
        };

        // スロット登録
        this.slots[slotIndex] = info;
        this.update();

        return info;
    }
}

export class AtlasManager {
    constructor(atlasSize = 4096, slotSize = 128) {
        // 定数を上書き
        this.ATLAS_SIZE = atlasSize;
        this.SLOT_SIZE = slotSize;

        this.pages = {
            opaque: [],
            transparent: []
        };

        // キャッシュ: Hash -> SlotInfo
        this.hashCache = new Map();
        
        // アルファ判定用の作業用Canvas
        this.tempCanvas = document.createElement('canvas');
        this.tempCanvas.width = 64; 
        this.tempCanvas.height = 64;
        this.tempCtx = this.tempCanvas.getContext('2d', { willReadFrequently: true });
    }

    // 画像のアルファチャンネル有無を判定
    _hasAlpha(image) {
        // 画像が小さい場合は全体、大きい場合は中心付近をサンプリング
        const w = Math.min(image.width, 64);
        const h = Math.min(image.height, 64);
        
        this.tempCtx.clearRect(0,0,64,64);
        this.tempCtx.drawImage(image, 0, 0, image.width, image.height, 0, 0, w, h);
        
        const data = this.tempCtx.getImageData(0, 0, w, h).data;
        // アルファが255未満のピクセルを探す
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 250) return true; // マージンを持たせる
        }
        return false;
    }

    _getPage(type) {
        let pageList = this.pages[type];
        // 最後のページを取得、なければ作成
        if (pageList.length === 0) {
            const newPage = new AtlasPage(0, type);
            pageList.push(newPage);
            return newPage;
        }
        
        // 既存ページから空きを探す（簡易実装：最後のページのみチェック）
        // ※本格的なLRUなら全ページ走査が必要だが、今回は追記+LRU上書き
        return pageList[pageList.length - 1];
    }

    /**
     * 画像を追加し、テクスチャとUV情報を返す
     * @param {HTMLImageElement} image 
     * @param {string} hash 
     * @returns {Object} { texture, uv: {x,y,w,h}, frames, frameWidthUV }
     */
    add(image, hash) {
        // 1. キャッシュチェック
        if (this.hashCache.has(hash)) {
            const info = this.hashCache.get(hash);
            const pageList = this.pages[info.pageType];
            const page = pageList[info.pageId];
            
            // 最終アクセス更新
            if (page && page.slots[info.slotIndex]) {
                page.slots[info.slotIndex].lastAccess = Date.now();
            }
            
            return this._formatResult(page.texture, info);
        }

        // 2. アルファ判定 & ページ選択
        const hasAlpha = this._hasAlpha(image);
        const type = hasAlpha ? 'transparent' : 'opaque';
        const page = this._getPage(type);

        // 3. スロット確保 (LRU)
        const slotIndex = page.findSlot();
        
        // もし上書きする場合、古いハッシュをキャッシュから削除
        if (page.slots[slotIndex]) {
            const oldHash = page.slots[slotIndex].hash;
            this.hashCache.delete(oldHash);
            console.log(`[Atlas] LRU Overwrite: ${oldHash} -> ${hash}`);
        }

        // 4. 書き込み
        const info = page.write(slotIndex, image, hash);
        info.pageType = type; // 後で参照できるようにタイプも記録

        // 5. アニメーション情報の計算
        // NBLM要件: 横長画像はフレームアニメーションとみなす
        // (例: 32x32 が 4枚 = 128x32)
        if (info.isStrip) {
            // 高さを基準にフレーム数を推定 (正方形フレームと仮定)
            // もし高さより幅が大きければ、幅/高さ = 枚数
            info.frames = Math.round(info.rawWidth / info.rawHeight);
            // 1フレームあたりのUV幅 (全体のUV幅 / 枚数)
            info.frameWidthUV = info.uv.w / info.frames;
        } else {
            info.frames = 1;
            info.frameWidthUV = info.uv.w;
        }

        this.hashCache.set(hash, info);

        return this._formatResult(page.texture, info);
    }

    _formatResult(texture, info) {
        return {
            texture: texture,
            uv: info.uv,
            frames: info.frames,
            frameWidthUV: info.frameWidthUV,
            hash: info.hash
        };
    }

    dispose() {
        ['opaque', 'transparent'].forEach(type => {
            this.pages[type].forEach(p => {
                p.texture.dispose();
                // canvas等はGCに任せる
            });
            this.pages[type] = [];
        });
        this.hashCache.clear();
    }
}