import * as THREE from 'three';

export class AtlasManager {
    constructor(atlasSize = 2048, slotSize = 64) {
        this.atlasSize = atlasSize;
        this.slotSize = slotSize;
        this.slotsPerRow = Math.floor(atlasSize / slotSize);
        this.maxSlotsPerPage = this.slotsPerRow * this.slotsPerRow;
        
        // ページ配列（キャンバスとテクスチャのペア）
        this.pages = []; 
        
        // 重複チェック用キャッシュ: Map<hash, THREE.Texture>
        this.hashCache = new Map(); 
    }

    // 新しいページ（キャンバス）を作成する内部関数
    _createNewPage() {
        const canvas = document.createElement('canvas');
        canvas.width = this.atlasSize;
        canvas.height = this.atlasSize;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        // 背景を透明にクリア（念のため）
        ctx.clearRect(0, 0, this.atlasSize, this.atlasSize);

        const texture = new THREE.CanvasTexture(canvas);
        // ピクセルアート/アイコン向きの設定
        texture.magFilter = THREE.NearestFilter; 
        texture.minFilter = THREE.NearestFilter;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = false; // アトラス更新頻度が高い場合、ミップマップ生成はコストになるためオフ推奨

        const page = {
            id: this.pages.length,
            canvas: canvas,
            ctx: ctx,
            texture: texture,
            currentSlot: 0
        };
        
        this.pages.push(page);
        console.log(`[AtlasManager] Created Page ${page.id} (Size: ${this.atlasSize}px, Slot: ${this.slotSize}px)`);
        return page;
    }

    // 画像を追加して、使えるテクスチャ（SubTexture）を返す
    // image: HTMLImageElement | HTMLCanvasElement | ImageBitmap
    // hash: string (重複チェック用)
    add(image, hash) {
        // 1. キャッシュチェック
        if (this.hashCache.has(hash)) {
            return this.hashCache.get(hash);
        }

        // 2. 書き込めるページを探す（最後のページに空きがあるか？）
        let page = this.pages[this.pages.length - 1];
        if (!page || page.currentSlot >= this.maxSlotsPerPage) {
            page = this._createNewPage();
        }

        // 3. 書き込み位置の計算
        const slotIndex = page.currentSlot;
        const col = slotIndex % this.slotsPerRow;
        const row = Math.floor(slotIndex / this.slotsPerRow);
        const x = col * this.slotSize;
        const y = row * this.slotSize;

        // 4. 描画
        // 画像がスロットより大きい場合は縮小、小さい場合は中央配置や引き伸ばしなど検討余地ありだが、
        // ここではシンプルにスロットサイズに合わせて描画する
        page.ctx.drawImage(image, 0, 0, image.width, image.height, x, y, this.slotSize, this.slotSize);
        
        // テクスチャの更新フラグを立てる (GPUへ転送)
        page.texture.needsUpdate = true;

        // 5. Three.js用の「切り抜きテクスチャ」を作成
        // 元のテクスチャを「クローン」して、オフセットだけ変える
        // (メモリ上の画像データは共有されるので軽量)
        const subTexture = page.texture.clone();
        subTexture.colorSpace = THREE.SRGBColorSpace;
        subTexture.magFilter = THREE.NearestFilter;
        subTexture.minFilter = THREE.NearestFilter;

        // UVのスケール（全体に対する1マスの割合）
        const scale = this.slotSize / this.atlasSize; 
        
        subTexture.repeat.set(scale, scale);
        
        // UVのオフセット（切り抜き開始位置）
        // Three.jsのUV座標系: 左下(0,0) 〜 右上(1,1)
        // Canvas座標系: 左上(0,0) 〜 右下
        // Y軸の計算が逆になる点に注意
        subTexture.offset.set(
            col * scale,             // x
            1 - (row + 1) * scale    // y (下からの位置)
        );
        
        // キャッシュ保存＆カウンタ更新
        this.hashCache.set(hash, subTexture);
        page.currentSlot++;

        return subTexture;
    }
    
    // リソース破棄
    dispose() {
        this.pages.forEach(p => {
            p.texture.dispose();
        });
        this.pages = [];
        this.hashCache.clear();
    }
}