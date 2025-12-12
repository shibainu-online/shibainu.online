import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AtlasManager } from './AtlasManager.js';
import { Utils } from '../Utils/Utils.js';

export class VisualEntityManager {
    constructor(scene, terrainManager, camera) {
        this.scene = scene;
        this.terrainManager = terrainManager;
        this.camera = camera;
        this.entities = {};
        this.showNamePlates = true;
        this.localPlayerId = null;
        this.gltfLoader = new GLTFLoader();
        
        const maxTexSize = this.getMaxTextureSize();
        const safeAtlasSize = Math.min(4096, maxTexSize);
        console.log(`[Visual] Atlas Size: ${safeAtlasSize}px (Device Max: ${maxTexSize}px)`);
        
        this.atlasManager = new AtlasManager(safeAtlasSize, 128);
        
        this.modelCache = {}; 
        this.modelCacheLRU = []; 
        this.MAX_CACHE_SIZE = 50;
        
        this.loadingAssets = {};
        this.pendingModelApplies = {}; 
        this.pendingSourceWaits = {}; 
        
        this.loadingIconInfo = null;
        this.loadLoadingIcon();
        
        this.clock = new THREE.Clock();
        
        // ガーベジコレクタ: タイムアウトしたリクエストを掃除
        this.startGarbageCollector();
    }

    startGarbageCollector() {
        setInterval(() => {
            const now = Date.now();
            const TIMEOUT = 60000; 
            
            Object.keys(this.pendingModelApplies).forEach(hash => {
                const list = this.pendingModelApplies[hash];
                // 1分以上待たされているリクエストは破棄
                this.pendingModelApplies[hash] = list.filter(item => (now - item.timestamp) < TIMEOUT);
                if (this.pendingModelApplies[hash].length === 0) {
                    delete this.pendingModelApplies[hash];
                    // ロードフラグも解除して、再リクエスト可能な状態にする
                    if (this.loadingAssets[hash]) delete this.loadingAssets[hash];
                }
            });
            
            Object.keys(this.pendingSourceWaits).forEach(hash => {
                const list = this.pendingSourceWaits[hash];
                this.pendingSourceWaits[hash] = list.filter(item => (now - item.timestamp) < TIMEOUT);
                if (this.pendingSourceWaits[hash].length === 0) {
                    delete this.pendingSourceWaits[hash];
                }
            });
        }, 10000);
    }

    getMaxTextureSize() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (gl) return gl.getParameter(gl.MAX_TEXTURE_SIZE);
        } catch (e) {}
        return 4096;
    }

    loadLoadingIcon() {
        new THREE.ImageLoader().load('assets/loading_icon.png', (image) => {
            this.loadingIconInfo = this.atlasManager.add(image, 'system_loading_icon');
            this.applyLoadingIconToExisting();
        });
    }

    applyLoadingIconToExisting() {
        if (!this.loadingIconInfo) return;
        for (const id in this.entities) {
            this._applyLoadingLookToPrimitive(this.entities[ id ]);
        }
    }

    setLocalPlayerId(id) { this.localPlayerId = id; }

    updateEntity(id, x, y, z, colorHex, name, type, rotationY = 0, isVisible = true, moveSpeed = 300,
                 modelType = "", modelDataId = "", primitiveType = "",
                 scale = 1.0, rx = 0, ry = 0, rz = 0, attrs = {}) {
        
        let visibleState = isVisible;
        if (typeof isVisible === 'string') visibleState = (isVisible.toLowerCase() === 'true');

        let mesh = this.entities[ id ];
        if (!colorHex) colorHex = "#FFFFFF";

        if (!mesh) {
            mesh = this._createBaseMesh(id, x, y, z, colorHex, name, type, primitiveType);
            this.scene.add(mesh);
            this.entities[ id ] = mesh;
        } else {
            const targetPrimType = primitiveType || "Cube";
            if (mesh.userData.primitiveType !== targetPrimType && !mesh.userData.currentModelId) {
                this._rebuildPrimitive(mesh, targetPrimType, colorHex, type);
            }
        }

        mesh.userData.moveSpeed = moveSpeed;
        mesh.userData.baseScale = scale || 1.0;

        if (id !== this.localPlayerId) {
            if (!mesh.userData.targetPos) mesh.userData.targetPos = new THREE.Vector3();
            mesh.userData.targetPos.set(x, y, z);
            
            const isStatic = (type === "Item" || (attrs && attrs.IsStatic === "true"));
            mesh.userData.snapToGround = !isStatic; // アイテムは地面に吸着しない（浮遊などありうる）

            if (!mesh.userData.isBillboard) {
                mesh.rotation.y = rotationY;
            }
        } else {
            // 自機は常に見える
            mesh.visible = true;
        }

        if (id !== this.localPlayerId) mesh.visible = visibleState;
        
        mesh.scale.set(scale, scale, scale);

        if (colorHex !== mesh.userData.colorHex) {
            mesh.userData.colorHex = colorHex;
            this._updatePrimitiveColor(mesh, colorHex);
        }
        
        // モデル適用処理
        if (modelDataId) {
            if (mesh.userData.currentModelId !== modelDataId) {
                mesh.userData.currentModelId = modelDataId;
                // まずLoading表示にする
                this._applyLoadingLookToPrimitive(mesh);
                // ロード開始
                this.loadAndAttachModel(mesh, modelDataId, modelType, attrs);
            }
        } else {
            // モデル指定が解除された場合
            if (mesh.userData.currentModelId) {
                mesh.userData.currentModelId = "";
                this.removeAttachedModel(mesh);
                this._applyLoadingLookToPrimitive(mesh); // プリミティブに戻す
            }
        }
    }

    _createBaseMesh(id, x, y, z, colorHex, name, type, primitiveType) {
        const group = new THREE.Group();
        group.position.set(x, y, z);

        // Nameplate
        const label = this._createLabel(name);
        group.add(label);

        group.userData = {
            id: id,
            currentModelId: "",
            colorHex: colorHex,
            isBillboard: false,
            primitiveType: primitiveType || "Cube",
            animState: { offset: Math.random() * 100 },
            snapToGround: true
        };

        this._addPrimitiveToGroup(group, primitiveType, colorHex, type);
        return group;
    }

    _rebuildPrimitive(group, primitiveType, colorHex, type) {
        const oldPrim = group.getObjectByName("Primitive");
        if (oldPrim) {
            if(oldPrim.geometry) oldPrim.geometry.dispose();
            if(oldPrim.material) oldPrim.material.dispose();
            group.remove(oldPrim);
        }
        group.userData.primitiveType = primitiveType || "Cube";
        this._addPrimitiveToGroup(group, primitiveType, colorHex, type);
    }

    _addPrimitiveToGroup(group, primitiveType, colorHex, type) {
        let geometry;
        let isBillboard = (primitiveType === "Billboard" || primitiveType === "Plane");

        if (!primitiveType || primitiveType === "Cube") geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);
        else if (primitiveType === "Cylinder") geometry = new THREE.CylinderGeometry(0.4, 0.4, 1.0, 16);
        else if (isBillboard) geometry = new THREE.PlaneGeometry(0.8, 0.8);
        else if (primitiveType === "Sphere") geometry = new THREE.SphereGeometry(type === "Item" ? 0.3 : 0.5, 16, 16);
        else geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);

        const material = new THREE.MeshBasicMaterial({
            color: this._hexToInt(colorHex),
            side: THREE.DoubleSide,
            transparent: true,
            alphaTest: 0.5
        });

        const primitive = new THREE.Mesh(geometry, material);
        primitive.name = "Primitive";
        primitive.position.y = isBillboard ? 0.4 : 0;
        
        group.add(primitive);
        group.userData.isBillboard = isBillboard;

        // 初期状態でLoadingチェック
        this._applyLoadingLookToPrimitive(group);
    }

    _applyLoadingLookToPrimitive(group) {
        const prim = group.getObjectByName("Primitive");
        if (!prim) return;

        const expectingModel = !!group.userData.currentModelId;
        const hasModel = !!group.getObjectByName("ModelContent");

        if (expectingModel && !hasModel && this.loadingIconInfo) {
            // モデル待ち状態 -> Loadingアイコンを表示
            this._applyAtlasTextureToMesh(group, this.loadingIconInfo);
            prim.material.color.setHex(0xFFFFFF); // テクスチャが見えるように白に
        } 
        else if (!expectingModel) {
            // モデル不要 -> 元の色に戻す
            if (prim.material.map === this.loadingIconInfo.texture) {
                prim.material.map = null;
                prim.material.needsUpdate = true;
            }
            const hex = group.userData.colorHex || '#FFFFFF';
            prim.material.color.setHex(this._hexToInt(hex));
        }
    }

    _hexToInt(hex) {
        return parseInt(hex.replace('#', ''), 16);
    }

    _updatePrimitiveColor(mesh, hex) {
        const prim = mesh.getObjectByName("Primitive");
        if (!prim) return;
        // Loading中は色を変えない
        this._applyLoadingLookToPrimitive(mesh);
    }

    _applyAtlasTextureToMesh(entityGroup, atlasInfo) {
        const prim = entityGroup.getObjectByName("Primitive");
        if (!prim) return;

        const geometry = prim.geometry;
        const { texture, uv, frameWidthUV } = atlasInfo;

        if (!geometry.attributes.uv) return;

        const uvs = geometry.attributes.uv;
        for (let i = 0; i < uvs.count; i++) {
            const u = uvs.getX(i);
            const v = uvs.getY(i);
            const atlasU = uv.x + (u * frameWidthUV);
            const atlasV = uv.y + (v * uv.h);
            uvs.setXY(i, atlasU, atlasV);
        }
        uvs.needsUpdate = true;
        
        prim.material.map = texture;
        prim.material.needsUpdate = true;
    }

    async loadAndAttachModel(entityGroup, hash, hintType, attrs) {
        entityGroup.userData.currentModelId = hash;
        
        // 1. キャッシュチェック
        if (this.modelCache[ hash ]) {
            this._touchCache(hash);
            this.attachGLBFromCache(entityGroup, hash);
            return;
        }
        
        if (this.atlasManager.hashCache.has(hash)) {
            const info = this.atlasManager.hashCache.get(hash);
            const texture = this.atlasManager.pages[ info.pageType ][ info.pageId ].texture;
            const result = this.atlasManager._formatResult(texture, info);
            this.attachAtlasTexture(entityGroup, result, attrs, info.meta || {});
            return;
        }

        // 2. ペンディングリスト登録
        if (!this.pendingModelApplies[ hash ]) this.pendingModelApplies[ hash ] = [];
        this.pendingModelApplies[ hash ].push({ entity: entityGroup, attrs: attrs, timestamp: Date.now() });

        // 3. ロード中の場合は待機
        if (this.loadingAssets[ hash ]) return;
        this.loadingAssets[ hash ] = true;

        try {
            // DBから取得試行
            let content = null;
            if (window.assetManager) {
                content = await window.assetManager.loadAsset(hash);
            }

            if (!content) {
                // ない場合はネットワークに要求して終了（届いたら onAssetAvailable が呼ばれる）
                if (window.networkManager) window.networkManager.requestAsset(hash);
                return;
            }

            // ★修正ポイント: コンテンツタイプの判定強化
            let metadata = null;
            let isJson = false;
            let textContent = "";

            if (typeof content === 'string') {
                try {
                    const bin = atob(content);
                    // 単純な { チェックだけでなく、JSONらしい特徴を探す
                    if (bin.includes('sourceHash') && bin.includes('type')) {
                        let cleanBin = bin.trim();
                        // BOM削除
                        if (cleanBin.charCodeAt(0) === 0xFEFF) cleanBin = cleanBin.slice(1);
                        
                        if (cleanBin.startsWith('{')) {
                            const len = bin.length;
                            const bytes = new Uint8Array(len);
                            for (let i = 0; i < len; i++) bytes[ i ] = bin.charCodeAt(i);
                            textContent = new TextDecoder().decode(bytes);
                            
                            metadata = JSON.parse(textContent);
                            isJson = true;
                        }
                    }
                } catch(e) {
                    console.warn(`[Visual] JSON Parse Attempt Failed for ${hash}:`, e);
                }
            } else if (content instanceof Blob) {
                try {
                    const text = await content.text();
                    const json = JSON.parse(text);
                    if (json.sourceHash) {
                        metadata = json;
                        isJson = true;
                    }
                } catch(e) {}
            }

            if (isJson && metadata && metadata.sourceHash) {
                console.log(`[Visual] Metadata Loaded: ${metadata.name} (${metadata.type})`);
                await this.processMetadataFlow(hash, metadata);
            } else {
                // JSONでなければ画像かGLBとして処理
                if (content instanceof Blob) {
                    content = await Utils.blobToBase64(content);
                }
                
                const type = this._detectTypeFromBase64(content);
                if (type === "GLB") {
                    await this.processGlbData(hash, content, {});
                } else if (type === "PNG" || type === "JPG") {
                    await this.processImageData(hash, content, {});
                } else {
                    console.warn(`[Visual] Unknown format for ${hash}. Header: ${content.substring(0, 15)}`);
                    // 不明なデータならLoadingを解除しないとスタックする
                    delete this.loadingAssets[ hash ];
                }
            }

        } catch (e) {
            console.error(`[Visual] Load Error ${hash}:`, e);
            delete this.loadingAssets[ hash ];
        }
    }

    async processMetadataFlow(metaHash, metadata) {
        const sourceHash = metadata.sourceHash;
        
        // ソースデータの取得試行
        let sourceData = await window.assetManager.loadAsset(sourceHash);
        
        if (!sourceData) {
            console.log(`[Visual] Metadata loaded but Source ${sourceHash} missing. Requesting...`);
            
            // ソース待ちリストへ
            if (!this.pendingSourceWaits[ sourceHash ]) this.pendingSourceWaits[ sourceHash ] = [];
            this.pendingSourceWaits[ sourceHash ].push({
                metaHash: metaHash,
                metadata: metadata,
                timestamp: Date.now()
            });
            
            if (window.networkManager) window.networkManager.requestAsset(sourceHash);
            return;
        }

        if (sourceData instanceof Blob) {
            sourceData = await Utils.blobToBase64(sourceData);
        }

        if (metadata.type === 'Model') {
            await this.processGlbData(metaHash, sourceData, metadata);
        } else if (metadata.type === 'Texture') {
            await this.processImageData(metaHash, sourceData, metadata);
        }
    }

    // アセット受信時に呼ばれる
    async onAssetAvailable(hash) {
        // ロードフラグをクリアして再入可能にする
        if (this.loadingAssets[hash]) delete this.loadingAssets[hash];

        // 保留中の適用処理があれば実行
        if (this.pendingModelApplies[ hash ]) {
            const list = this.pendingModelApplies[ hash ];
            if (list.length > 0) {
                // 先頭の1つに対して実行すれば、完了時に _flushPending で全員に適用される
                this.loadAndAttachModel(list[ 0 ].entity, hash, "UNKNOWN", list[ 0 ].attrs);
            }
        }

        // メタデータ待機中のソースであれば、フローを再開
        if (this.pendingSourceWaits[ hash ]) {
            const waits = this.pendingSourceWaits[ hash ];
            console.log(`[Visual] Source ${hash} arrived. Resuming ${waits.length} metadata flows.`);
            for (const wait of waits) {
                await this.processMetadataFlow(wait.metaHash, wait.metadata);
            }
            delete this.pendingSourceWaits[ hash ];
        }
    }

    _detectTypeFromBase64(base64) {
        if (base64.startsWith("gltT") || base64.startsWith("Z2x0")) return "GLB";
        if (base64.startsWith("iVBORw")) return "PNG";
        if (base64.startsWith("/9j/")) return "JPG";
        return "UNKNOWN";
    }

    async processGlbData(hash, base64, metadata) {
        try {
            const bin = atob(base64);
            const len = bin.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[ i ] = bin.charCodeAt(i);
            const blob = new Blob([bytes.buffer], { type: 'model/gltf-binary' });
            const url = URL.createObjectURL(blob);
            
            const gltf = await this.gltfLoader.loadAsync(url);
            
            if (metadata.scaleCorrection) {
                gltf.scene.userData.scaleCorrection = metadata.scaleCorrection;
            }
            
            this._addToCache(hash, gltf.scene);
            URL.revokeObjectURL(url);
            
            this._flushPending(hash, "GLB");
        } catch(e) {
            console.error(`[Visual] Failed GLB ${hash}:`, e);
        } finally {
            delete this.loadingAssets[ hash ];
        }
    }

    _touchCache(hash) {
        const index = this.modelCacheLRU.indexOf(hash);
        if (index > -1) {
            this.modelCacheLRU.splice(index, 1);
            this.modelCacheLRU.push(hash);
        }
    }

    _addToCache(hash, sceneCloneable) {
        if (this.modelCache[ hash ]) return;
        
        if (this.modelCacheLRU.length >= this.MAX_CACHE_SIZE) {
            const oldestHash = this.modelCacheLRU.shift();
            this._disposeCacheItem(oldestHash);
        }
        
        this.modelCache[ hash ] = sceneCloneable;
        this.modelCacheLRU.push(hash);
    }

    _disposeCacheItem(hash) {
        if (!this.modelCache[ hash ]) return;
        console.log(`[Visual] LRU Eviction: Disposing model ${hash}`);
        const scene = this.modelCache[ hash ];
        this._disposeRecursively(scene);
        delete this.modelCache[ hash ];
    }

    attachGLBFromCache(entityGroup, hash) {
        this.removeAttachedModel(entityGroup);
        
        if (!this.modelCache[ hash ]) return;
        
        const model = this.modelCache[ hash ].clone();
        model.name = "ModelContent";
        
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        let scale = 1.0;
        if (maxDim > 0) {
            scale = 1.5 / maxDim;
        }
        
        if (model.userData.scaleCorrection) {
            scale *= model.userData.scaleCorrection;
        }
        
        model.scale.set(scale, scale, scale);
        model.position.y = -0.5;
        
        entityGroup.add(model);
        entityGroup.userData.isBillboard = false;
        
        const prim = entityGroup.getObjectByName("Primitive");
        if (prim) prim.visible = false;
    }

    async processImageData(hash, base64, metadata) {
        try {
            const img = new Image();
            img.src = "data:image/png;base64," + base64;
            await img.decode();
            
            const result = this.atlasManager.add(img, hash);
            if (metadata) {
                result.meta = metadata;
                if (metadata.fps) result.fps = metadata.fps;
                if (metadata.frames) {
                    result.frames = metadata.frames;
                    result.frameWidthUV = result.uv.w / result.frames;
                }
            }
            
            this._flushPending(hash, "ATLAS", result);
        } catch(e) {
            console.error(`[Visual] Failed Image ${hash}:`, e);
        } finally {
            delete this.loadingAssets[ hash ];
        }
    }

    attachAtlasTexture(entityGroup, atlasInfo, attrs, metadata = {}) {
        this.removeAttachedModel(entityGroup);
        
        const { texture, uv, frames, frameWidthUV } = atlasInfo;
        const fps = metadata.fps || (attrs && attrs.AnimFps ? parseFloat(attrs.AnimFps) : 4.0);
        
        const geometry = new THREE.PlaneGeometry(1.5, 1.5);
        const uvs = geometry.attributes.uv;
        for (let i = 0; i < uvs.count; i++) {
            const u = uvs.getX(i);
            const v = uvs.getY(i);
            const atlasU = uv.x + (u * frameWidthUV);
            const atlasV = uv.y + (v * uv.h);
            uvs.setXY(i, atlasU, atlasV);
        }
        uvs.needsUpdate = true;
        
        let material = new THREE.MeshBasicMaterial({ 
            map: texture, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide 
        });

        if (frames > 1) {
            const randomOffset = entityGroup.userData.animState.offset;
            material.onBeforeCompile = (shader) => {
                shader.uniforms.uTime = { value: 0 };
                shader.uniforms.uFrames = { value: frames };
                shader.uniforms.uFrameWidth = { value: frameWidthUV };
                shader.uniforms.uFps = { value: fps };
                shader.uniforms.uOffset = { value: randomOffset };
                
                shader.fragmentShader = `
                    uniform float uTime;
                    uniform float uFrames;
                    uniform float uFrameWidth;
                    uniform float uFps;
                    uniform float uOffset;
                ` + shader.fragmentShader;
                
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <map_fragment>',
                    `
                    #ifdef USE_MAP
                        float currentFrame = floor(mod((uTime * uFps) + uOffset, uFrames));
                        vec2 animUv = vMapUv;
                        animUv.x += currentFrame * uFrameWidth;
                        vec4 sampledDiffuseColor = texture2D( map, animUv );
                        diffuseColor *= sampledDiffuseColor;
                    #endif
                    `
                );
                material.userData.shader = shader;
            };
            if (!this.animatedMaterials) this.animatedMaterials = [];
            this.animatedMaterials.push(material);
        }

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = "ModelContent";
        mesh.position.y = 0.75;
        mesh.castShadow = false;
        
        entityGroup.add(mesh);
        entityGroup.userData.isBillboard = true;
        
        const prim = entityGroup.getObjectByName("Primitive");
        if (prim) prim.visible = false;
    }

    _flushPending(hash, type, result = null) {
        const list = this.pendingModelApplies[ hash ];
        if (!list) return;
        
        let cachedInfo = null;
        if (type === "ATLAS" && this.atlasManager.hashCache.has(hash)) {
            const info = this.atlasManager.hashCache.get(hash);
            const texture = this.atlasManager.pages[ info.pageType ][ info.pageId ].texture;
            cachedInfo = this.atlasManager._formatResult(texture, info);
            if (result && result.meta) cachedInfo.meta = result.meta;
        }

        list.forEach(item => {
            if (item.entity.userData.currentModelId === hash) {
                if (type === "GLB") {
                    this._touchCache(hash);
                    this.attachGLBFromCache(item.entity, hash);
                } else if (type === "ATLAS" && cachedInfo) {
                    this.attachAtlasTexture(item.entity, cachedInfo, item.attrs, cachedInfo.meta || {});
                }
            }
        });
        
        delete this.pendingModelApplies[ hash ];
    }

    removeAttachedModel(entityGroup) {
        const old = entityGroup.getObjectByName("ModelContent");
        if (old) {
            this._disposeRecursively(old);
            entityGroup.remove(old);
        }
        const prim = entityGroup.getObjectByName("Primitive");
        if (prim) {
            prim.visible = true;
            this._applyLoadingLookToPrimitive(entityGroup);
        }
    }

    removeEntity(id) {
        const mesh = this.entities[ id ];
        if (mesh) {
            this._disposeRecursively(mesh);
            this.scene.remove(mesh);
            delete this.entities[ id ];
        }
    }

    _disposeRecursively(object) {
        if (!object) return;
        
        if (object.children) {
            for (let i = object.children.length - 1; i >= 0; i--) {
                this._disposeRecursively(object.children[ i ]);
            }
        }
        
        if (object.skeleton) {
            object.skeleton.dispose();
            object.skeleton = null;
        }
        if (object.geometry) {
            object.geometry.dispose();
            object.geometry = null;
        }
        if (object.material) {
            if (Array.isArray(object.material)) {
                object.material.forEach(mat => this._disposeMaterial(mat));
            } else {
                this._disposeMaterial(object.material);
            }
            object.material = null;
        }
        
        if (this.animatedMaterials && object.material) {
            const idx = this.animatedMaterials.indexOf(object.material);
            if (idx > -1) this.animatedMaterials.splice(idx, 1);
        }
    }

    _disposeMaterial(material) {
        if (!material) return;
        if (material.map) material.map.dispose();
        if (material.lightMap) material.lightMap.dispose();
        if (material.bumpMap) material.bumpMap.dispose();
        if (material.normalMap) material.normalMap.dispose();
        if (material.specularMap) material.specularMap.dispose();
        if (material.envMap) material.envMap.dispose();
        
        if (material.userData) material.userData.shader = null;
        material.dispose();
    }

    _createLabel(text) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 24;
        ctx.font = `bold ${fontSize}px Arial`;
        
        const textWidth = ctx.measureText(text).width + 10;
        canvas.width = textWidth;
        canvas.height = fontSize + 10;
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        
        ctx.strokeStyle = "black";
        ctx.lineWidth = 4;
        ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
        
        ctx.fillStyle = "white";
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);
        
        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(spriteMaterial);
        
        sprite.position.y = 1.5;
        sprite.scale.set(canvas.width / 40, canvas.height / 40, 1);
        sprite.visible = this.showNamePlates;
        
        return sprite;
    }

    toggleNamePlates() {
        this.showNamePlates = !this.showNamePlates;
        for (const id in this.entities) {
            const mesh = this.entities[ id ];
            mesh.children.forEach(c => { if (c.isSprite) c.visible = this.showNamePlates; });
        }
        return this.showNamePlates;
    }

    animate(delta) {
        const time = this.clock.getElapsedTime();
        
        if (this.animatedMaterials) {
            this.animatedMaterials.forEach(mat => {
                if (mat.userData.shader) {
                    mat.userData.shader.uniforms.uTime.value = time;
                }
            });
        }

        if (!this.camera) return;

        for (const id in this.entities) {
            const group = this.entities[ id ];
            
            if (id !== this.localPlayerId) {
                const target = group.userData.targetPos;
                if (target) {
                    const dist = group.position.distanceTo(target);
                    if (dist > 10.0) {
                        group.position.copy(target);
                    } else if (dist > 0.001) {
                        const speedParam = group.userData.moveSpeed || 300;
                        const visualSpeed = speedParam / 40.0;
                        const moveDist = visualSpeed * delta;
                        const dir = new THREE.Vector3().subVectors(target, group.position).normalize();
                        group.position.add(dir.multiplyScalar(Math.min(dist, moveDist)));
                        
                        if (group.userData.snapToGround && this.terrainManager) {
                            const groundH = this.terrainManager.getHeightAt(group.position.x, group.position.z);
                            if (groundH !== null) group.position.y = groundH + 0.5;
                        }
                        
                        if (!group.userData.isBillboard) {
                            const lookTarget = new THREE.Vector3(target.x, group.position.y, target.z);
                            group.lookAt(lookTarget);
                        }
                    }
                }
            }
            
            if (group.userData.isBillboard) {
                group.quaternion.copy(this.camera.quaternion);
            }
        }
    }

    dispose() {
        console.log("[Visual] Disposing VisualEntityManager...");
        for (const id in this.entities) {
            this._disposeRecursively(this.entities[ id ]);
            this.scene.remove(this.entities[ id ]);
        }
        this.entities = {};
        
        for (const hash in this.modelCache) {
            this._disposeRecursively(this.modelCache[ hash ]);
        }
        this.modelCache = {};
        this.modelCacheLRU = [];
        
        if (this.atlasManager) this.atlasManager.dispose();
        console.log("[Visual] Disposed.");
    }
}