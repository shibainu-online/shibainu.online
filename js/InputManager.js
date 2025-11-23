export class InputManager {
    constructor(canvas, camera, terrainManager) {
        this.canvas = canvas;
        this.camera = camera;
        this.terrainManager = terrainManager;
        
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        
        this.isActive = false;
        this.isMouseDown = false; 
        this.mouseX = 0;
        this.mouseY = 0;
        
        this.targetPos = null; 
        
        this.moveSpeed = 300;

        this.setupEvents();
    }

    setActive(active) {
        this.isActive = active;
    }
    
    setSpeed(speed) {
        this.moveSpeed = speed;
    }

    getSpeedFactor() {
        // C#側: 300のとき100msごとに0.5マス = 5.0マス/秒
        // JS側 (60fps): 5.0 / 60 = 約0.083
        // 係数: Speed 300 で 0.085 になるように調整
        return (this.moveSpeed / 300.0) * 0.085; 
    }

    isPressing() {
        return this.isActive && this.isMouseDown;
    }

    setupEvents() {
        this.canvas.addEventListener('mousedown', (e) => {
            if (!this.isActive) return;
            this.isMouseDown = true;
            this.updateMousePos(e);
            this.performRaycast(); 
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.isActive) return;
            this.updateMousePos(e);
        });

        window.addEventListener('mouseup', () => this.isMouseDown = false);
        window.addEventListener('blur', () => this.isMouseDown = false);
        window.addEventListener('mouseleave', () => this.isMouseDown = false);
    }

    updateMousePos(e) {
        this.mouseX = e.clientX;
        this.mouseY = e.clientY;
    }

    update() {
        if (this.isPressing()) {
            this.performRaycast();
        }
    }

    performRaycast() {
        this.mouse.x = (this.mouseX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(this.mouseY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        
        const meshes = this.terrainManager.getMeshes();
        if (meshes.length === 0) return;

        const intersects = this.raycaster.intersectObjects(meshes);
        if (intersects.length > 0) {
            const point = intersects[0].point;
            if (!this.targetPos) this.targetPos = new THREE.Vector3();
            this.targetPos.copy(point);
        }
    }

    getHeightAt(x, z) {
        const origin = new THREE.Vector3(x, 50, z);
        const direction = new THREE.Vector3(0, -1, 0);
        this.raycaster.set(origin, direction);
        
        const meshes = this.terrainManager.getMeshes();
        const intersects = this.raycaster.intersectObjects(meshes);
        
        if (intersects.length > 0) {
            return intersects[0].point.y;
        }
        return null;
    }
}