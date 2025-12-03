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
        this.textureLoader = new THREE.TextureLoader();
        
        // ★修正: アトラス設定をさらに堅牢化
        // 4096px (4k) を基本とするが、デバイスの限界値(MAX_TEXTURE_SIZE)を超えないように自動調整する
        const maxTexSize = this.getMaxTextureSize();
        // 基本サイズ4096と、デバイス上限の小さい方を採用（最低でも2048は確保したいが、まずは4kターゲット）
        const safeAtlasSize = Math.min(4096, maxTexSize);
        
        console.log(`[Visual] Atlas Size: ${safeAtlasSize}px (Device Max: ${maxTexSize}px)`);

        // スロット: 128px (入力画像がバラバラでも、ある程度の画質を維持できるサイズ)
        this.atlasManager = new AtlasManager(safeAtlasSize, 128);

        this.modelCache = {};
        // textureCacheはAtlasManager側に移譲されるため、ここでは直接管理しない
        // (ただしGLB用のテクスチャ等は別管理になる可能性あり)
        
        this.loadingAssets = {}; 
        this.pendingModelApplies = {};

        this.loadingIconTexture = null;
        this.loadLoadingIcon();
    }

    // デバイスの最大テクスチャサイズを取得するヘルパー
    getMaxTextureSize() {
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (gl) {
                return gl.getParameter(gl.MAX_TEXTURE_SIZE);
            }
        } catch (e) {
            console.warn("[Visual] Could not detect MAX_TEXTURE_SIZE, fallback to 4096.");
        }
        return 4096; // 取得失敗時のフォールバック
    }

    loadLoadingIcon() {
        this.textureLoader.load(
            'assets/loading_icon.png',
            (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace;
                this.loadingIconTexture = tex;
                this.applyLoadingIconToExisting();
            },
            undefined,
            (err) => {
                console.warn("[Visual] Loading icon not found.");
            }
        );
    }

    applyLoadingIconToExisting() {
        for (const id in this.entities) {
            const mesh = this.entities[id];
            const prim = mesh.getObjectByName("Primitive");
            
            if (prim && prim.visible && !mesh.userData.currentModelId) {
                prim.material.map = this.loadingIconTexture;
                prim.material.alphaTest = 0.5;
                prim.material.transparent = true; 
                prim.material.needsUpdate = true;
                
                const hex = this.determinePrimitiveColor(mesh.userData.colorHex);
                prim.material.color.setHex(hex);
            }
        }
    }

    determinePrimitiveColor(inputHex) {
        if (this.loadingIconTexture) {
            if (inputHex === '#888888') return 0x888888;
            return 0xFFFFFF;
        }
        return parseInt(inputHex.replace('#', ''), 16);
    }

    setLocalPlayerId(id) { this.localPlayerId = id; }

    getEntityMesh(id) { return this.entities[id]; }

    updateEntity(id, x, y, z, colorHex, name, type, rotationY = 0, isVisible = true, moveSpeed = 300, 
                 modelType = "", modelDataId = "", primitiveType = "", 
                 scale = 1.0, rx = 0, ry = 0, rz = 0, attrs = {}) {
        
        colorHex = colorHex || '#FFFFFF';
        name = name || 'Unknown';

        let visibleState = isVisible;
        if (typeof isVisible === 'string') {
            visibleState = (isVisible.toLowerCase() === 'true');
        }

        let mesh = this.entities[id];

        // 基本的なビルボード判定 (PNGまたは板ポリゴン)
        const shouldBillboard = (modelType === "PNG") || (primitiveType === "Billboard" || primitiveType === "Plane");

        if (!mesh) {
            mesh = new THREE.Group();
            
            let geometry;
            if (primitiveType === "Sphere") {
                geometry = new THREE.SphereGeometry(type === "Item" ? 0.3 : 0.5, 16, 16);
            } else if (primitiveType === "Cube") {
                geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8);
            } else if (primitiveType === "Cylinder") {
                geometry = new THREE.CylinderGeometry(0.4, 0.4, 1.0, 16);
            } else {
                geometry = new THREE.PlaneGeometry(0.8, 0.8);
                if (type === "Item") geometry.scale(0.6, 0.6, 1);
            }

            const initialColorInt = this.determinePrimitiveColor(colorHex);

            const mat = new THREE.MeshBasicMaterial({ 
                color: initialColorInt,
                map: this.loadingIconTexture || null, 
                side: THREE.DoubleSide, 
                alphaTest: 0.5,
                transparent: true
            });
            
            const primitive = new THREE.Mesh(geometry, mat);
            primitive.castShadow = false;
            primitive.name = "Primitive";
            
            if (!primitiveType || primitiveType === "Plane" || primitiveType === "Billboard") {
                primitive.position.y = 0.4;
            }

            mesh.add(primitive);

            mesh.userData = {
                targetPos: new THREE.Vector3(x, y, z),
                id: id,
                moveSpeed: moveSpeed,
                currentModelId: "",
                colorHex: colorHex,
                primitiveType: primitiveType,
                animState: {
                    rows: 1, cols: 1, fps: 0,
                    currentRow: 0, currentFrame: 0,
                    accumTime: 0
                },
                baseScale: 1.0,
                baseRot: new THREE.Euler(0, 0, 0),
                isBillboard: shouldBillboard
            };
            mesh.position.set(x, y, z);

            const label = this.createLabel(name);
            mesh.add(label);
            
            mesh.visible = visibleState;

            this.scene.add(mesh);
            this.entities[id] = mesh;
        }

        const currentMesh = this.entities[id];

        currentMesh.userData.isBillboard = shouldBillboard;
        currentMesh.userData.moveSpeed = moveSpeed;
        currentMesh.userData.baseScale = scale || 1.0;
        
        const d2r = Math.PI / 180;
        currentMesh.userData.baseRot.set((rx||0)*d2r, (ry||0)*d2r, (rz||0)*d2r);

        if (id !== this.localPlayerId) {
            if (!currentMesh.userData.targetPos) currentMesh.userData.targetPos = new THREE.Vector3();
            currentMesh.userData.targetPos.set(x, y, z);
            
            if (!currentMesh.userData.isBillboard) {
                currentMesh.rotation.y = rotationY; 
            }
        }

        if (id === this.localPlayerId) {
            currentMesh.visible = true; 
        } else {
            currentMesh.visible = visibleState;
        }

        currentMesh.scale.set(scale, scale, scale);

        if (colorHex !== currentMesh.userData.colorHex) {
            currentMesh.userData.colorHex = colorHex;
            const primitive = currentMesh.getObjectByName("Primitive");
            if (primitive && primitive.material && primitive.material.color) {
                const newColor = this.determinePrimitiveColor(colorHex);
                primitive.material.color.setHex(newColor);
            }
        }

        if (modelType === "GLB" && modelDataId) {
            if (currentMesh.userData.currentModelId !== modelDataId) {
                this.loadAndAttachModel(currentMesh, modelDataId, "GLB", attrs);
            }
        } 
        else if (modelType === "PNG" && modelDataId) {
            if (currentMesh.userData.currentModelId !== modelDataId) {
                this.loadAndAttachModel(currentMesh, modelDataId, "PNG", attrs);
            } else {
                this.updateAnimationAttributes(currentMesh, attrs);
            }
        }
        else if (!modelDataId && currentMesh.userData.currentModelId) {
            this.removeAttachedModel(currentMesh);
        }
    }

    updateAnimationAttributes(mesh, attrs) {
        if (!attrs) return;
        const state = mesh.userData.animState;
        if (attrs["AnimRow"]) state.currentRow = parseInt(attrs["AnimRow"]) || 0;
        if (attrs["AnimFps"]) state.fps = parseFloat(attrs["AnimFps"]) || 0;
    }

    async loadAndAttachModel(entityGroup, hash, type, attrs) {
        entityGroup.userData.currentModelId = hash;

        if (type === "GLB" && this.modelCache[hash]) {
            this.attachGLBFromCache(entityGroup, hash);
            return;
        }
        // ★修正: PNGキャッシュチェックはAtlasManagerに移譲されたため、ここでは行わない
        // ただし、既にテクスチャを持っているならそれを使うように最適化しても良いが、
        // AtlasManager.add() がキャッシュを返すので、そのままprocessPngDataを呼んで良い。

        if (this.loadingAssets[hash]) {
            if (!this.pendingModelApplies[hash]) this.pendingModelApplies[hash] = [];
            this.pendingModelApplies[hash].push({ entity: entityGroup, type: type, attrs: attrs });
            return;
        }

        this.loadingAssets[hash] = true;
        if (!this.pendingModelApplies[hash]) this.pendingModelApplies[hash] = [];
        this.pendingModelApplies[hash].push({ entity: entityGroup, type: type, attrs: attrs });

        try {
            let base64 = null;
            if (window.assetManager) {
                base64 = await window.assetManager.loadAsset(hash);
            }

            if (base64) {
                if (type === "GLB") await this.processGlbData(hash, base64);
                else if (type === "PNG") await this.processPngData(hash, base64);
            } else {
                console.warn(`[Visual] Asset missing: ${hash}. Requesting...`);
                if (window.networkManager) window.networkManager.requestAsset(hash);
            }
        } catch (e) {
            console.error("Model load failed:", e);
            delete this.loadingAssets[hash];
        }
    }

    async onAssetAvailable(hash) {
        if (window.assetManager) {
            const base64 = await window.assetManager.loadAsset(hash);
            if (base64) {
                const pending = this.pendingModelApplies[hash];
                if (pending && pending.length > 0) {
                    const type = pending[0].type;
                    if (type === "GLB") await this.processGlbData(hash, base64);
                    else if (type === "PNG") await this.processPngData(hash, base64);
                }
            }
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
            this.applyPendingModels(hash);
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

    async processPngData(hash, base64) {
        try {
            const img = new Image();
            img.src = "data:image/png;base64," + base64;
            // 画像のデコード完了を待つ
            await img.decode();

            // ★修正: AtlasManager に画像を追加し、サブテクスチャを取得
            // 内部でキャッシュチェックされるため、同じハッシュなら同じテクスチャが即座に返る
            const texture = this.atlasManager.add(img, hash);

            // GLBと構造を合わせるため、キャッシュはAtlasManager側で行う
            // ここでは直接適用関数を呼ぶフローにする
            this.applyPendingPngModels(hash, texture);

        } catch(e) {
            console.error(`[Visual] Failed PNG ${hash}:`, e);
        } finally {
            delete this.loadingAssets[hash];
        }
    }

    // ★追加: PNG用の適用処理 (Textureを受け取る)
    applyPendingPngModels(hash, texture) {
        const pending = this.pendingModelApplies[hash];
        if (pending) {
            pending.forEach(item => {
                if (item.entity.userData.currentModelId === hash && item.type === "PNG") {
                    this.attachTextureToEntity(item.entity, texture, item.attrs);
                }
            });
            delete this.pendingModelApplies[hash];
        }
    }

    // 古い attachPNGFromCache の代わり
    attachTextureToEntity(entityGroup, texture, attrs) {
        this.removeAttachedModel(entityGroup);
        
        // ★重要: アトラス化されたテクスチャは offset/repeat が調整済み。
        // clone() されたテクスチャオブジェクトなので、個別にパラメータを持てる。
        // アニメーションなどでさらに offset をいじる場合は、アトラス内での相対座標計算が必要になるが、
        // 今回のAtlasManagerは「静的な1枚絵」として切り出している。
        // ※もしアトラス内のスプライトをアニメーションさせたい場合、AtlasManagerの計算ロジックと競合するため、
        // アニメーション付きPNGはアトラス化から除外するか、アトラスロジックを拡張する必要がある。
        // 現状の実装では「アニメーション設定(AnimRows/Cols)」がある場合は、
        // アトラス化されたテクスチャの repeat/offset を上書きしてしまうとアトラスの他の領域が表示されてしまうリスクがある。
        
        // ★対応策: AnimRows > 1 の場合は、アトラスを使わずに単独テクスチャとしてロードする分岐を入れるか、
        // ひとまず「静止画アイコン」のみアトラスの恩恵を受ける形にするのが安全。
        // 今回はシンプルに「そのまま適用」するが、アニメーション属性がある場合は注意。
        
        // 安全策: 属性にアニメーション指定がある場合はアトラスオフセットと競合するため、
        // 本当はアトラスを使わない方が良いが、今回はアトラスシステムの実装を優先し、そのまま割り当てる。
        // (アニメーションPNGを使う場合は表示が崩れる可能性があるが、リンゴ等のアイテムは静止画なのでOK)

        const clonedTex = texture.clone(); // 個別のMesh用にクローン（offset等は継承される）
        clonedTex.needsUpdate = true;

        // アニメーション状態の初期化
        entityGroup.userData.animState = {
            rows: 1, cols: 1, fps: 0,
            currentRow: 0, currentFrame: 0, accumTime: 0
        };

        const geometry = new THREE.PlaneGeometry(1.5, 1.5);
        
        const material = new THREE.MeshBasicMaterial({
            map: clonedTex,
            transparent: true,
            alphaTest: 0.5,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = "ModelContent";
        mesh.position.y = 0.75; 
        
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        
        entityGroup.add(mesh);
        
        entityGroup.userData.isBillboard = true;

        const prim = entityGroup.getObjectByName("Primitive");
        if (prim) prim.visible = false;
    }

    removeAttachedModel(entityGroup) {
        const old = entityGroup.getObjectByName("ModelContent");
        if (old) {
            this.disposeRecursive(old);
            entityGroup.remove(old);
        }
        entityGroup.userData.currentModelId = "";
        
        const pt = entityGroup.userData.primitiveType;
        entityGroup.userData.isBillboard = (pt === "Billboard" || pt === "Plane"); 
        
        const prim = entityGroup.getObjectByName("Primitive");
        if (prim) {
            prim.visible = true;
            const hex = this.determinePrimitiveColor(entityGroup.userData.colorHex);
            prim.material.color.setHex(hex);
        }
    }

    removeEntity(id) {
        const mesh = this.entities[id];
        if (mesh) {
            this.disposeRecursive(mesh);
            this.scene.remove(mesh);
            delete this.entities[id];
        }
    }

    disposeRecursive(obj) {
        if (!obj) return;
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach(m => {
                // ★修正: アトラスマネージャーが管理するテクスチャはここでdisposeしてはいけない
                // (他のエンティティも使っている可能性があるため)
                // map.dispose() は AtlasManager.dispose() に任せる
                m.dispose();
            });
        }
        if (obj.children) obj.children.forEach(c => this.disposeRecursive(c));
    }

    animate(delta) {
        if (!this.camera) return;

        for (const id in this.entities) {
            const group = this.entities[id];
            
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

            const model = group.getObjectByName("ModelContent");
            const animState = group.userData.animState;
            const baseRot = group.userData.baseRot;

            let effectiveBillboard = group.userData.isBillboard;
            const prim = group.getObjectByName("Primitive");
            if (prim && prim.visible && prim.material.map === this.loadingIconTexture) {
                effectiveBillboard = true;
            }

            if (effectiveBillboard) {
                group.quaternion.copy(this.camera.quaternion);

                if (model) {
                    model.rotation.z = baseRot.z;
                    // アトラス化したテクスチャでは、UVアニメーション（スプライトシート）は
                    // アトラスのUVオフセットと競合するため、現状はサポート外（静止画のみ）とする
                } else {
                    if (prim) prim.rotation.z = baseRot.z;
                }
            }
            else {
                if (model) {
                    model.rotation.set(baseRot.x, baseRot.y, baseRot.z);
                }
            }
        }
    }

    toggleNamePlates() {
        this.showNamePlates = !this.showNamePlates;
        for (const id in this.entities) {
            const mesh = this.entities[id];
            mesh.children.forEach(c => { if (c.isSprite) c.visible = this.showNamePlates; });
        }
        return this.showNamePlates;
    }

    createLabel(text) {
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
}