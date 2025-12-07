import * as THREE from 'three';

const PAGE_SIZE = 4096;
const SLOT_SIZE = 128;

class AtlasPage {
    constructor(id, type) {
        this.id = id;
        this.type = type;
        
        this.canvas = document.createElement('canvas');
        this.canvas.width = PAGE_SIZE;
        this.canvas.height = PAGE_SIZE;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        
        this.ctx.clearRect(0, 0, PAGE_SIZE, PAGE_SIZE);

        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.magFilter = THREE.NearestFilter;
        this.texture.minFilter = THREE.NearestFilter;
        this.texture.generateMipmaps = false; 

        this.slotsPerRow = Math.floor(PAGE_SIZE / SLOT_SIZE);
        this.totalSlots = this.slotsPerRow * this.slotsPerRow;
        
        this.slots = new Array(this.totalSlots).fill(null);
        this.usedCount = 0;
    }

    update() {
        if (this.texture) this.texture.needsUpdate = true;
    }

    findSlot() {
        for (let i = 0; i < this.totalSlots; i++) {
            if (this.slots[i] === null) return i;
        }

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

    write(slotIndex, image, hash) {
        const col = slotIndex % this.slotsPerRow;
        const row = Math.floor(slotIndex / this.slotsPerRow);
        const x = col * SLOT_SIZE;
        const y = row * SLOT_SIZE;

        this.ctx.clearRect(x, y, SLOT_SIZE, SLOT_SIZE);
        
        let dw = SLOT_SIZE;
        let dh = SLOT_SIZE;
        
        if (image.width > image.height) {
            dh = dw * (image.height / image.width);
        } else {
            dw = dh * (image.width / image.height);
        }

        const dx = x;
        const dy = y;

        this.ctx.drawImage(image, 0, 0, image.width, image.height, dx, dy, dw, dh);

        const info = {
            hash: hash,
            lastAccess: Date.now(),
            pageId: this.id,
            slotIndex: slotIndex,
            uv: {
                x: dx / PAGE_SIZE,
                y: 1.0 - ((dy + dh) / PAGE_SIZE), 
                w: dw / PAGE_SIZE,
                h: dh / PAGE_SIZE
            },
            isStrip: (image.width >= image.height * 2) || (image.width % image.height === 0 && image.width > image.height),
            rawWidth: image.width,
            rawHeight: image.height
        };

        this.slots[slotIndex] = info;
        this.update();

        return info;
    }
}

export class AtlasManager {
    constructor(atlasSize = 4096, slotSize = 128) {
        this.ATLAS_SIZE = atlasSize;
        this.SLOT_SIZE = slotSize;

        this.pages = {
            opaque: [],
            transparent: []
        };

        this.hashCache = new Map();
        
        this.tempCanvas = document.createElement('canvas');
        this.tempCanvas.width = 64; 
        this.tempCanvas.height = 64;
        this.tempCtx = this.tempCanvas.getContext('2d', { willReadFrequently: true });
    }

    _hasAlpha(image) {
        const w = Math.min(image.width, 64);
        const h = Math.min(image.height, 64);
        
        this.tempCtx.clearRect(0,0,64,64);
        this.tempCtx.drawImage(image, 0, 0, image.width, image.height, 0, 0, w, h);
        
        const data = this.tempCtx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 250) return true; 
        }
        return false;
    }

    _getPage(type) {
        let pageList = this.pages[type];
        if (pageList.length === 0) {
            const newPage = new AtlasPage(0, type);
            pageList.push(newPage);
            return newPage;
        }
        
        return pageList[pageList.length - 1];
    }

    add(image, hash) {
        if (this.hashCache.has(hash)) {
            const info = this.hashCache.get(hash);
            const pageList = this.pages[info.pageType];
            const page = pageList[info.pageId];
            
            if (page && page.slots[info.slotIndex]) {
                page.slots[info.slotIndex].lastAccess = Date.now();
            }
            
            return this._formatResult(page.texture, info);
        }

        const hasAlpha = this._hasAlpha(image);
        const type = hasAlpha ? 'transparent' : 'opaque';
        const page = this._getPage(type);

        const slotIndex = page.findSlot();
        
        if (page.slots[slotIndex]) {
            const oldHash = page.slots[slotIndex].hash;
            this.hashCache.delete(oldHash);
            console.log(`[Atlas] LRU Overwrite: ${oldHash} -> ${hash}`);
        }

        const info = page.write(slotIndex, image, hash);
        info.pageType = type;

        if (info.isStrip) {
            info.frames = Math.round(info.rawWidth / info.rawHeight);
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
            });
            this.pages[type] = [];
        });
        this.hashCache.clear();
    }
}