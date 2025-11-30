import * as THREE from 'three';

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

        // イベントハンドラをバインドして保持（removeEventListener用）
        this._onMouseDown = this.onMouseDown.bind(this);
        this._onMouseMove = this.onMouseMove.bind(this);
        this._onMouseUp = this.onMouseUp.bind(this);
        this._onTouchStart = this.onTouchStart.bind(this);
        this._onTouchMove = this.onTouchMove.bind(this);
        this._onTouchEnd = this.onTouchEnd.bind(this);

        this.setupEvents();
    }

    setActive(active) { this.isActive = active; }
    setSpeed(speed) { this.moveSpeed = speed; }

    getSpeedFactor() {
        return (this.moveSpeed / 300.0) * 0.085; 
    }

    isPressing() {
        return this.isActive && this.isMouseDown;
    }

    setupEvents() {
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('mouseup', this._onMouseUp);
        
        // モバイル対応（パッシブ無効化が必要）
        this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
        window.addEventListener('touchend', this._onTouchEnd);
        
        window.addEventListener('blur', this._onMouseUp);
        window.addEventListener('mouseleave', this._onMouseUp);
    }

    dispose() {
        // イベントリスナーの完全解除
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
        
        this.canvas.removeEventListener('touchstart', this._onTouchStart);
        this.canvas.removeEventListener('touchmove', this._onTouchMove);
        window.removeEventListener('touchend', this._onTouchEnd);
        
        window.removeEventListener('blur', this._onMouseUp);
        window.removeEventListener('mouseleave', this._onMouseUp);
        
        console.log("[InputManager] Disposed and event listeners removed.");
    }

    // --- Event Handlers ---

    onMouseDown(e) {
        if (!this.isActive) return;
        this.isMouseDown = true;
        this.updateMousePos(e.clientX, e.clientY);
        this.performRaycast(); 
    }

    onMouseMove(e) {
        if (!this.isActive) return;
        this.updateMousePos(e.clientX, e.clientY);
    }

    onMouseUp() {
        this.isMouseDown = false;
        this.targetPos = null; // 即停止
    }

    onTouchStart(e) {
        if (!this.isActive) return;
        if (e.touches.length > 0) {
            e.preventDefault();
            this.isMouseDown = true;
            this.updateMousePos(e.touches[0].clientX, e.touches[0].clientY);
            this.performRaycast();
        }
    }

    onTouchMove(e) {
        if (!this.isActive) return;
        if (e.touches.length > 0) {
            e.preventDefault();
            this.updateMousePos(e.touches[0].clientX, e.touches[0].clientY);
        }
    }

    onTouchEnd() {
        this.isMouseDown = false;
        this.targetPos = null;
    }

    // --- Logic ---

    updateMousePos(x, y) {
        this.mouseX = x;
        this.mouseY = y;
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
            const rawPoint = intersects[0].point;
            
            if (!this.targetPos) this.targetPos = new THREE.Vector3();
            this.targetPos.copy(rawPoint);
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