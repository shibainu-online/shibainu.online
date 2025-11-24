export class VisualEntityManager {
    constructor(scene, terrainManager) {
        this.scene = scene;
        this.terrainManager = terrainManager; 
        this.entities = {}; 
        this.showNamePlates = true;
        this.gridMap = {};
        this.localPlayerId = null;
    }

    setLocalPlayerId(id) {
        this.localPlayerId = id;
    }

    updateEntity(id, x, y, z, colorHex, name, type, rotationY = 0, isVisible = true, moveSpeed = 300) {
        let mesh = this.entities[id];

        if (!mesh) {
            let geometry;
            if (type === "Item") {
                geometry = new THREE.SphereGeometry(0.3, 16, 16);
            } else {
                geometry = new THREE.SphereGeometry(0.5, 16, 16);
            }
            
            const mat = new THREE.MeshStandardMaterial({ color: parseInt(colorHex.replace('#',''), 16) });
            mesh = new THREE.Mesh(geometry, mat);
            mesh.castShadow = true;
            
            mesh.userData = { 
                targetPos: new THREE.Vector3(x, y, z),
                id: id,      
                gridKey: "",
                moveSpeed: moveSpeed
            };
            mesh.position.set(x, y, z); 

            const label = this.createLabel(name);
            mesh.add(label);
            
            // 初期可視性
            mesh.visible = isVisible;

            this.scene.add(mesh);
            this.entities[id] = mesh;
            
            this.updateGridPosition(mesh, x, z);
        }
        
        const currentMesh = this.entities[id];
        
        if (!currentMesh.userData.targetPos) currentMesh.userData.targetPos = new THREE.Vector3();
        currentMesh.userData.targetPos.set(x, y, z);
        currentMesh.rotation.y = rotationY;
        
        // 常に最新の可視性を適用
        currentMesh.visible = isVisible;
        currentMesh.userData.moveSpeed = moveSpeed;

        const newColor = parseInt(colorHex.replace('#',''), 16);
        if (currentMesh.material.color.getHex() !== newColor) {
            currentMesh.material.color.setHex(newColor);
        }
    }

    updateGridPosition(mesh, x, z) {
        const gx = Math.floor(x);
        const gz = Math.floor(z);
        const newKey = `${gx}_${gz}`;

        if (mesh.userData.gridKey === newKey) return;

        if (mesh.userData.gridKey && this.gridMap[mesh.userData.gridKey]) {
            const list = this.gridMap[mesh.userData.gridKey];
            const idx = list.indexOf(mesh);
            if (idx !== -1) list.splice(idx, 1);
            if (list.length === 0) delete this.gridMap[mesh.userData.gridKey];
        }

        if (!this.gridMap[newKey]) this.gridMap[newKey] = [];
        this.gridMap[newKey].push(mesh);
        mesh.userData.gridKey = newKey;
    }

    getEntitiesInGrid(gx, gz) {
        const key = `${gx}_${gz}`;
        return this.gridMap[key] || [];
    }

    removeEntity(id) {
        const mesh = this.entities[id];
        if (mesh) {
            if (mesh.userData.gridKey && this.gridMap[mesh.userData.gridKey]) {
                const list = this.gridMap[mesh.userData.gridKey];
                const idx = list.indexOf(mesh);
                if (idx !== -1) list.splice(idx, 1);
            }
            this.scene.remove(mesh);
            delete this.entities[id];
        }
    }

    animate(delta) {
        for (const id in this.entities) {
            // 自キャラはMain.jsで動かすので無視
            if (id === this.localPlayerId) continue;

            const entity = this.entities[id];
            const target = entity.userData.targetPos;
            if (!target) continue;

            const dist = entity.position.distanceTo(target);
            
            if (dist > 10.0) {
                entity.position.copy(target);
                this.updateGridPosition(entity, target.x, target.z);
            } else if (dist > 0.001) {
                // 等速移動 (他キャラ用)
                const speedParam = entity.userData.moveSpeed || 300;
                const visualSpeed = speedParam / 30.0; 
                const maxMove = visualSpeed * delta * 1.1;

                if (dist <= maxMove) {
                    entity.position.copy(target);
                } else {
                    const dir = new THREE.Vector3().subVectors(target, entity.position).normalize();
                    entity.position.add(dir.multiplyScalar(maxMove));
                }
                
                this.updateGridPosition(entity, entity.position.x, entity.position.z);
            }

            if (this.terrainManager) {
                const groundH = this.terrainManager.getHeightAt(entity.position.x, entity.position.z);
                if (groundH !== null) {
                    entity.position.y = groundH + 0.5;
                }
            }
        }
    }

    toggleNamePlates() {
        this.showNamePlates = !this.showNamePlates;
        for (const id in this.entities) {
            const mesh = this.entities[id];
            mesh.children.forEach(c => { if(c.isSprite) c.visible = this.showNamePlates; });
        }
        return this.showNamePlates;
    }

    createLabel(text) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 18;
        ctx.font = `bold ${fontSize}px Arial`;
        const textWidth = ctx.measureText(text).width;
        canvas.width = textWidth + 20;
        canvas.height = fontSize + 20;
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const x = canvas.width / 2;
        const y = canvas.height / 2;
        ctx.lineWidth = 5; 
        ctx.strokeStyle = "black";
        ctx.lineJoin = "round";
        ctx.strokeText(text, x, y);
        ctx.fillStyle = "white";
        ctx.fillText(text, x, y);
        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.scale.set(canvas.width / 20, canvas.height / 20, 1);
        sprite.position.y = 2.2; 
        sprite.visible = this.showNamePlates;
        return sprite;
    }
}