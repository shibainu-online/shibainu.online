import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class VisualEntityManager {
    constructor(scene, terrainManager) {
        this.scene = scene;
        this.terrainManager = terrainManager;
        this.entities = {};
        this.showNamePlates = true;
        this.localPlayerId = null;

        this.gltfLoader = new GLTFLoader();
        this.modelCache = {};
        this.loadingAssets = {}; 
        this.pendingModelApplies = {}; 
    }

    setLocalPlayerId(id) { this.localPlayerId = id; }

    getEntityMesh(id) { return this.entities[id]; }

    updateEntity(id, x, y, z, colorHex, name, type, rotationY = 0, isVisible = true, moveSpeed = 300, modelType = "", modelDataId = "") {
        colorHex = colorHex || '#FFFFFF';
        name = name || 'Unknown';

        let visibleState = isVisible;
        if (typeof isVisible === 'string') {
            visibleState = (isVisible.toLowerCase() === 'true');
        }

        let mesh = this.entities[id];

        if (!mesh) {
            mesh = new THREE.Group();
            let geometry;
            if (type === "Item") geometry = new THREE.SphereGeometry(0.3, 16, 16);
            else geometry = new THREE.SphereGeometry(0.5, 16, 16);

            const mat = new THREE.MeshStandardMaterial({ color: parseInt(colorHex.replace('#', ''), 16) });
            const primitive = new THREE.Mesh(geometry, mat);
            primitive.castShadow = true;
            primitive.name = "Primitive";
            mesh.add(primitive);

            mesh.userData = {
                targetPos: new THREE.Vector3(x, y, z),
                id: id,
                moveSpeed: moveSpeed,
                currentModelId: "",
                colorHex: colorHex
            };
            mesh.position.set(x, y, z);

            const label = this.createLabel(name);
            mesh.add(label);
            
            mesh.visible = visibleState;

            this.scene.add(mesh);
            this.entities[id] = mesh;
        }

        const currentMesh = this.entities[id];

        if (id !== this.localPlayerId) {
            if (!currentMesh.userData.targetPos) currentMesh.userData.targetPos = new THREE.Vector3();
            currentMesh.userData.targetPos.set(x, y, z);
            currentMesh.rotation.y = rotationY;
        }

        if (id === this.localPlayerId) {
            currentMesh.visible = true; 
        } else {
            currentMesh.visible = visibleState;
        }

        currentMesh.userData.moveSpeed = moveSpeed;
        
        if (colorHex !== currentMesh.userData.colorHex) {
            currentMesh.userData.colorHex = colorHex;
            const primitive = currentMesh.getObjectByName("Primitive");
            if (primitive) {
                primitive.material.color.setHex(parseInt(colorHex.replace('#', ''), 16));
            }
        }

        if (modelType === "GLB" && modelDataId) {
            if (currentMesh.userData.currentModelId !== modelDataId) {
                this.loadAndAttachModel(currentMesh, modelDataId);
            }
        } else if (!modelDataId && currentMesh.userData.currentModelId) {
            this.removeAttachedModel(currentMesh);
        }
    }

    async loadAndAttachModel(entityGroup, hash) {
        entityGroup.userData.currentModelId = hash;

        if (this.modelCache[hash]) {
            this.attachModelFromCache(entityGroup, hash);
            return;
        }

        if (this.loadingAssets[hash]) {
            if (!this.pendingModelApplies[hash]) this.pendingModelApplies[hash] = [];
            if (!this.pendingModelApplies[hash].includes(entityGroup)) {
                this.pendingModelApplies[hash].push(entityGroup);
            }
            return;
        }

        this.loadingAssets[hash] = true;
        this.pendingModelApplies[hash] = [entityGroup];

        try {
            let base64 = null;
            
            if (window.assetManager) {
                base64 = await window.assetManager.loadAsset(hash);
            }

            if (base64) {
                // ローカルDBにあった場合 -> ロード
                this.processGlbData(hash, base64);
            } else {
                // DBにない場合 -> P2Pスワームにリクエストを投げる
                console.warn(`[Visual] Asset missing: ${hash}. Requesting via P2P Swarm...`);
                if (window.networkManager) {
                    window.networkManager.requestAsset(hash);
                }
            }
        } catch (e) {
            console.error("Model load failed:", e);
            delete this.loadingAssets[hash];
        }
    }

    // P2P経由などでデータが届いたときに呼ばれるコールバック
    async onAssetAvailable(hash) {
        console.log(`[Visual] Asset became available: ${hash}. Processing pending entities...`);
        if (window.assetManager) {
            const base64 = await window.assetManager.loadAsset(hash);
            if (base64) {
                this.processGlbData(hash, base64);
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

            const pending = this.pendingModelApplies[hash];
            if (pending) {
                pending.forEach(ent => {
                    if (ent.userData.currentModelId === hash) {
                        this.attachModelFromCache(ent, hash);
                    }
                });
            }
        } catch(e) {
            console.error(`[Visual] Failed to parse GLB ${hash}:`, e);
        } finally {
            delete this.loadingAssets[hash];
            delete this.pendingModelApplies[hash];
        }
    }

    attachModelFromCache(entityGroup, hash) {
        if (!this.modelCache[hash]) return;

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

        const prim = entityGroup.getObjectByName("Primitive");
        if (prim) prim.visible = true;
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
            if (Array.isArray(obj.material)) {
                obj.material.forEach(m => this.disposeMaterial(m));
            } else {
                this.disposeMaterial(obj.material);
            }
        }
        if (obj.children) {
            for (const child of obj.children) this.disposeRecursive(child);
        }
    }

    disposeMaterial(m) {
        if (m.map) m.map.dispose();
        if (m.lightMap) m.lightMap.dispose();
        if (m.bumpMap) m.bumpMap.dispose();
        if (m.normalMap) m.normalMap.dispose();
        if (m.specularMap) m.specularMap.dispose();
        if (m.envMap) m.envMap.dispose();
        m.dispose();
    }

    animate(delta) {
        for (const id in this.entities) {
            if (id === this.localPlayerId) continue;

            const entity = this.entities[id];
            const target = entity.userData.targetPos;
            if (!target) continue;

            const dist = entity.position.distanceTo(target);

            if (dist > 10.0) {
                entity.position.copy(target);
            } else if (dist > 0.001) {
                const speedParam = entity.userData.moveSpeed || 300;
                const visualSpeed = speedParam / 40.0;
                const moveDist = visualSpeed * delta;

                const dir = new THREE.Vector3().subVectors(target, entity.position).normalize();
                entity.position.add(dir.multiplyScalar(Math.min(dist, moveDist)));

                const lookTarget = new THREE.Vector3(target.x, entity.position.y, target.z);
                entity.lookAt(lookTarget);

                if (this.terrainManager) {
                    const groundH = this.terrainManager.getHeightAt(entity.position.x, entity.position.z);
                    if (groundH !== null) entity.position.y = groundH + 0.5;
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