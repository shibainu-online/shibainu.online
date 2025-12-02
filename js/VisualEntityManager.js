import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
        
        this.modelCache = {};
        this.textureCache = {}; 
        
        this.loadingAssets = {}; 
        this.pendingModelApplies = {};

        this.loadingIconTexture = null;
        this.loadLoadingIcon();
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
        if (type === "PNG" && this.textureCache[hash]) {
            this.attachPNGFromCache(entityGroup, hash, attrs);
            return;
        }

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
            await img.decode();

            const texture = new THREE.Texture(img);
            texture.needsUpdate = true;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.NearestFilter;

            this.textureCache[hash] = texture;
            this.applyPendingModels(hash);
        } catch(e) {
            console.error(`[Visual] Failed PNG ${hash}:`, e);
        } finally {
            delete this.loadingAssets[hash];
        }
    }

    applyPendingModels(hash) {
        const pending = this.pendingModelApplies[hash];
        if (pending) {
            pending.forEach(item => {
                if (item.entity.userData.currentModelId === hash) {
                    if (item.type === "GLB") this.attachGLBFromCache(item.entity, hash);
                    else if (item.type === "PNG") this.attachPNGFromCache(item.entity, hash, item.attrs);
                }
            });
            delete this.pendingModelApplies[hash];
        }
    }

    attachPNGFromCache(entityGroup, hash, attrs) {
        this.removeAttachedModel(entityGroup);
        const texture = this.textureCache[hash].clone();
        texture.needsUpdate = true;

        const cols = parseInt(attrs?.["AnimCols"]) || 1;
        const rows = parseInt(attrs?.["AnimRows"]) || 1;
        const fps = parseFloat(attrs?.["AnimFps"]) || 0;
        
        if (cols > 1 || rows > 1) {
            texture.repeat.set(1 / cols, 1 / rows);
            texture.offset.x = 0;
            texture.offset.y = 1 - (1 / rows);
        }

        entityGroup.userData.animState = {
            rows: rows, cols: cols, fps: fps,
            currentRow: parseInt(attrs?.["AnimRow"]) || 0,
            currentFrame: 0, accumTime: 0
        };

        const geometry = new THREE.PlaneGeometry(1.5, 1.5);
        
        const material = new THREE.MeshBasicMaterial({
            map: texture,
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
                if (m.map) m.map.dispose();
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

            // ★修正: ローディングアイコンが表示されている場合は、強制的にビルボード化する
            // これにより、ロード中のSphere等が回転移動してしまうのを防ぐ
            let effectiveBillboard = group.userData.isBillboard;
            const prim = group.getObjectByName("Primitive");
            if (prim && prim.visible && prim.material.map === this.loadingIconTexture) {
                effectiveBillboard = true;
            }

            if (effectiveBillboard) {
                // Spherical Billboard: 常にカメラの方を向く
                group.quaternion.copy(this.camera.quaternion);

                if (model) {
                    model.rotation.z = baseRot.z;

                    if (model.material.map && animState && animState.cols > 1 && animState.fps > 0) {
                        animState.accumTime += delta;
                        const frameDuration = 1.0 / animState.fps;

                        if (animState.accumTime >= frameDuration) {
                            const steps = Math.floor(animState.accumTime / frameDuration);
                            animState.accumTime -= steps * frameDuration;
                            animState.currentFrame = (animState.currentFrame + steps) % animState.cols;
                            
                            const texture = model.material.map;
                            const col = animState.currentFrame;
                            const row = animState.currentRow;
                            const totalCols = animState.cols;
                            const totalRows = animState.rows;

                            texture.offset.x = col / totalCols;
                            texture.offset.y = 1 - ((row + 1) / totalRows);
                        }
                    }
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