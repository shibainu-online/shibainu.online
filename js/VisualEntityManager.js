import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AtlasManager } from './AtlasManager.js';

export class VisualEntityManager {
    constructor(scene, terrainManager, camera) {
        this.scene = scene;
        this.terrainManager = terrainManager;
        this.camera = camera;
        this.entities = {};
        this.showNamePlates = true;
        this.localPlayerId = null;

        this.gltfLoader = new GLTFLoader();
        
        // デバイスの最大テクスチャサイズを考慮してアトラス初期化
        const maxTexSize = this.getMaxTextureSize();
        const safeAtlasSize = Math.min(4096, maxTexSize);
        console.log(`[Visual] Atlas Size: ${safeAtlasSize}px (Device Max: ${maxTexSize}px)`);

        this.atlasManager = new AtlasManager(safeAtlasSize, 128);

        this.modelCache = {}; // GLBキャッシュ
        // PNGキャッシュはAtlasManagerが管理

        this.loadingAssets = {}; 
        this.pendingModelApplies = {};

        // ローディングアイコン情報 (アトラスのみで管理)
        this.loadingIconInfo = null;
        this.loadLoadingIcon();
        
        // アニメーション用クロック
        this.clock = new THREE.Clock();
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
        // ★修正: ImageLoaderのみを使用し、アトラス一本で管理する
        new THREE.ImageLoader().load('assets/loading_icon.png', (image) => {
            this.loadingIconInfo = this.atlasManager.add(image, 'system_loading_icon');
            console.log("[Visual] Loading icon added to Atlas.");
            this.applyLoadingIconToExisting();
        });
    }

    applyLoadingIconToExisting() {
        if (!this.loadingIconInfo) return;

        for (const id in this.entities) {
            const mesh = this.entities[id];
            // まだモデルがロードされていないエンティティに適用
            if (!mesh.userData.currentModelId) {
                this._applyLoadingLookToPrimitive(mesh);
            }
        }
    }

    setLocalPlayerId(id) { this.localPlayerId = id; }

    // --- Entity Update Flow ---

    updateEntity(id, x, y, z, colorHex, name, type, rotationY = 0, isVisible = true, moveSpeed = 300, 
                 modelType = "", modelDataId = "", primitiveType = "", 
                 scale = 1.0, rx = 0, ry = 0, rz = 0, attrs = {}) {
        
        let visibleState = isVisible;
        if (typeof isVisible === 'string') visibleState = (isVisible.toLowerCase() === 'true');

        let mesh = this.entities[id];
        
        // 新規作成
        if (!mesh) {
            mesh = this._createBaseMesh(id, x, y, z, colorHex, name, type, primitiveType);
            this.scene.add(mesh);
            this.entities[id] = mesh;
        } else {
            // プリミティブ形状の変更検知と再生成
            if (mesh.userData.primitiveType !== primitiveType && !mesh.userData.currentModelId) {
                this._rebuildPrimitive(mesh, primitiveType, colorHex, type);
            }
        }

        // 状態更新
        mesh.userData.moveSpeed = moveSpeed;
        mesh.userData.baseScale = scale || 1.0;
        
        // 座標更新
        if (id !== this.localPlayerId) {
            if (!mesh.userData.targetPos) mesh.userData.targetPos = new THREE.Vector3();
            mesh.userData.targetPos.set(x, y, z);
            
            if (!mesh.userData.isBillboard) {
                mesh.rotation.y = rotationY;
            }
        } else {
            mesh.visible = true;
        }
        
        if (id !== this.localPlayerId) mesh.visible = visibleState;

        mesh.scale.set(scale, scale, scale);

        // 色更新
        if (colorHex !== mesh.userData.colorHex) {
            mesh.userData.colorHex = colorHex;
            this._updatePrimitiveColor(mesh, colorHex);
        }

        // モデル/テクスチャ適用
        if (modelDataId) {
            if (mesh.userData.currentModelId !== modelDataId) {
                this.loadAndAttachModel(mesh, modelDataId, modelType, attrs);
            }
        } else if (mesh.userData.currentModelId) {
            // モデルIDが空になったら外す
            this.removeAttachedModel(mesh);
        }
    }

    _createBaseMesh(id, x, y, z, colorHex, name, type, primitiveType) {
        const group = new THREE.Group();
        group.position.set(x, y, z);

        // ネームプレート
        const label = this._createLabel(name);
        group.add(label);

        // ユーザーデータ初期化
        group.userData = {
            id: id,
            currentModelId: "",
            colorHex: colorHex,
            isBillboard: false,
            primitiveType: primitiveType,
            animState: { offset: Math.random() * 100 }
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
        group.userData.primitiveType = primitiveType;
        this._addPrimitiveToGroup(group, primitiveType, colorHex, type);
    }

    _addPrimitiveToGroup(group, primitiveType, colorHex, type) {
        let geometry;
        let isBillboard = (primitiveType === "Billboard" || primitiveType === "Plane");

        if (primitiveType === "Cube") geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);
        else if (primitiveType === "Cylinder") geometry = new THREE.CylinderGeometry(0.4, 0.4, 1.0, 16);
        else if (isBillboard) geometry = new THREE.PlaneGeometry(0.8, 0.8);
        else geometry = new THREE.SphereGeometry(type === "Item" ? 0.3 : 0.5, 16, 16);

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

        // ★修正: どの形状でもアトラス適用ロジックを通す
        this._applyLoadingLookToPrimitive(group);
    }

    _applyLoadingLookToPrimitive(group) {
        const prim = group.getObjectByName("Primitive");
        if (!prim) return;

        // まだロード中（モデルがない）かつ、ローディングアイコン準備済みなら適用
        if (!group.getObjectByName("ModelContent") && this.loadingIconInfo) {
            this._applyAtlasTextureToMesh(group, this.loadingIconInfo);
        }
    }

    _hexToInt(hex) {
        return parseInt(hex.replace('#', ''), 16);
    }

    _updatePrimitiveColor(mesh, hex) {
        const prim = mesh.getObjectByName("Primitive");
        if (prim) {
            if (!mesh.getObjectByName("ModelContent")) {
                // ロードアイコン適用中なら白、そうでなければ指定色
                if (this.loadingIconInfo && prim.material.map === this.loadingIconInfo.texture) {
                    prim.material.color.setHex(0xFFFFFF);
                } else {
                    prim.material.color.setHex(this._hexToInt(hex));
                }
            }
        }
    }

    _applyAtlasTextureToMesh(entityGroup, atlasInfo) {
        const prim = entityGroup.getObjectByName("Primitive");
        if (!prim) return;

        const geometry = prim.geometry;
        
        // ★修正: PlaneGeometry以外でもUVオフセットを適用する
        // BoxやSphereのUVも0-1に正規化されているため、同じ計算でアトラス上の領域にマッピングできる
        const { texture, uv, frameWidthUV } = atlasInfo;
        
        // geometry.attributes.uv が存在しない場合へのガード
        if (!geometry.attributes.uv) return;

        const uvs = geometry.attributes.uv;

        // UV書き換え (アトラスマッピング)
        for (let i = 0; i < uvs.count; i++) {
            const u = uvs.getX(i);
            const v = uvs.getY(i);
            
            const atlasU = uv.x + (u * frameWidthUV); 
            const atlasV = uv.y + (v * uv.h);
            
            uvs.setXY(i, atlasU, atlasV);
        }
        uvs.needsUpdate = true;

        prim.material.map = texture;
        prim.material.color.setHex(0xFFFFFF); 
        prim.material.needsUpdate = true;
    }

    // --- Asset Loading & Security Check ---

    async loadAndAttachModel(entityGroup, hash, hintType, attrs) {
        entityGroup.userData.currentModelId = hash;

        if (this.modelCache[hash]) {
            this.attachGLBFromCache(entityGroup, hash);
            return;
        }
        if (this.atlasManager.hashCache.has(hash)) {
            const info = this.atlasManager.hashCache.get(hash);
            const texture = this.atlasManager.pages[info.pageType][info.pageId].texture;
            const result = this.atlasManager._formatResult(texture, info);
            this.attachAtlasTexture(entityGroup, result, attrs);
            return;
        }

        if (!this.pendingModelApplies[hash]) this.pendingModelApplies[hash] = [];
        this.pendingModelApplies[hash].push({ entity: entityGroup, attrs: attrs });

        if (this.loadingAssets[hash]) return;
        this.loadingAssets[hash] = true;

        try {
            let base64 = null;
            if (window.assetManager) {
                base64 = await window.assetManager.loadAsset(hash);
            }

            if (base64) {
                const type = this._detectTypeFromBase64(base64);
                console.log(`[Visual] Detected type for ${hash.substr(0,8)}: ${type} (Hint: ${hintType})`);

                if (type === "GLB") {
                    await this.processGlbData(hash, base64);
                } else if (type === "PNG" || type === "JPG") {
                    await this.processImageData(hash, base64);
                } else {
                    console.warn(`[Visual] Unknown asset type for ${hash}`);
                }
            } else {
                console.warn(`[Visual] Asset missing: ${hash}. Requesting via Mesh...`);
                if (window.networkManager) window.networkManager.requestAsset(hash);
            }
        } catch (e) {
            console.error("Model load failed:", e);
            delete this.loadingAssets[hash];
        }
    }

    _detectTypeFromBase64(base64) {
        if (base64.startsWith("gltT") || base64.startsWith("Z2x0")) return "GLB"; 
        if (base64.startsWith("iVBORw")) return "PNG";
        if (base64.startsWith("/9j/")) return "JPG";
        return "UNKNOWN";
    }

    async onAssetAvailable(hash) {
        if (this.pendingModelApplies[hash]) {
            const pending = this.pendingModelApplies[hash][0];
            this.loadAndAttachModel(pending.entity, hash, "UNKNOWN", pending.attrs);
        }
    }

    async processGlbData(hash, base64) {
        try {
            const bin = atob(base64);
            const len = bin.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
            const blob = new Blob([bytes.buffer], { type: 'model/gltf-binary' });
            const url = URL.createObjectURL(blob);
            
            const gltf = await this.gltfLoader.loadAsync(url);
            this.modelCache[hash] = gltf.scene;
            URL.revokeObjectURL(url);

            this._flushPending(hash, "GLB");
        } catch(e) {
            console.error(`[Visual] Failed GLB ${hash}:`, e);
        } finally {
            delete this.loadingAssets[hash];
        }
    }

    attachGLBFromCache(entityGroup, hash) {
        this.removeAttachedModel(entityGroup);
        const model = this.modelCache[hash].clone();
        model.name = "ModelContent";

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
            const scale = 1.5 / maxDim;
            model.scale.set(scale, scale, scale);
        }
        model.position.y = -0.5;
        entityGroup.add(model);

        entityGroup.userData.isBillboard = false;
        
        const prim = entityGroup.getObjectByName("Primitive");
        if (prim) prim.visible = false;
    }

    async processImageData(hash, base64) {
        try {
            const img = new Image();
            img.src = "data:image/png;base64," + base64;
            await img.decode();

            const result = this.atlasManager.add(img, hash);
            
            this._flushPending(hash, "ATLAS", result);
        } catch(e) {
            console.error(`[Visual] Failed Image ${hash}:`, e);
        } finally {
            delete this.loadingAssets[hash];
        }
    }

    attachAtlasTexture(entityGroup, atlasInfo, attrs) {
        this.removeAttachedModel(entityGroup);

        const { texture, uv, frames, frameWidthUV } = atlasInfo;
        
        // モデルコンテンツ用は常にPlaneGeometryを使用
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

        let material;
        
        if (frames > 1) {
            material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                alphaTest: 0.5,
                side: THREE.DoubleSide
            });

            const fps = (attrs && attrs.AnimFps) ? parseFloat(attrs.AnimFps) : 4.0;
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

        } else {
            material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                alphaTest: 0.5,
                side: THREE.DoubleSide
            });
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
        const list = this.pendingModelApplies[hash];
        if (!list) return;

        list.forEach(item => {
            if (item.entity.userData.currentModelId === hash) {
                if (type === "GLB") {
                    this.attachGLBFromCache(item.entity, hash);
                } else if (type === "ATLAS" && result) {
                    this.attachAtlasTexture(item.entity, result, item.attrs);
                }
            }
        });
        delete this.pendingModelApplies[hash];
    }

    removeAttachedModel(entityGroup) {
        const old = entityGroup.getObjectByName("ModelContent");
        if (old) {
            if (old.material && old.material.dispose) old.material.dispose();
            if (old.geometry && old.geometry.dispose) old.geometry.dispose();
            entityGroup.remove(old);
        }
        entityGroup.userData.currentModelId = "";
        
        // プリミティブ復帰
        const prim = entityGroup.getObjectByName("Primitive");
        if (prim) {
            prim.visible = true;
            this._updatePrimitiveColor(entityGroup, entityGroup.userData.colorHex);
            
            // ロードアイコンを再適用
            this._applyLoadingLookToPrimitive(entityGroup);
        }
    }

    removeEntity(id) {
        const mesh = this.entities[id];
        if (mesh) {
            this.scene.remove(mesh);
            delete this.entities[id];
        }
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
            const mesh = this.entities[id];
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
            const group = this.entities[id];
            
            if (id !== this.localPlayerId) {
                const target = group.userData.targetPos;
                if (target) {
                    const dist = group.position.distanceTo(target);
                    if (dist > 10.0) group.position.copy(target);
                    else if (dist > 0.001) {
                        const speedParam = group.userData.moveSpeed || 300;
                        const visualSpeed = speedParam / 40.0;
                        const moveDist = visualSpeed * delta;
                        const dir = new THREE.Vector3().subVectors(target, group.position).normalize();
                        group.position.add(dir.multiplyScalar(Math.min(dist, moveDist)));
                        
                        if (this.terrainManager) {
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
}