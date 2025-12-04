import * as THREE from 'three';
import { VisualEntityManager } from './VisualEntityManager.js';
import { TerrainManager } from './TerrainManager.js';
import { MinimapManager } from './MinimapManager.js';
import { InputManager } from './InputManager.js';

export class GameEngine {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        
        this.terrainManager = null;
        this.visualEntityManager = null;
        this.minimapManager = null;
        this.inputManager = null;
        
        this.clock = new THREE.Clock();
        this.localPlayerId = null;
        this.dotNetRef = null;
        this.gameLogicRef = null;

        this.logicalPos = new THREE.Vector3(); 
        this.nextStepTime = 0;                 
        this.lastSentTime = 0;                 

        this.CAMERA_HEIGHT = 20;     
        this.CAMERA_Z_OFFSET = 20;   
        this.cameraLookAt = new THREE.Vector3(0, 0, 0);

        this._tempVec2_A = new THREE.Vector2();
        this._tempVec2_B = new THREE.Vector2();
        this._tempVec3 = new THREE.Vector3();
        
        this.animationFrameId = null;
        this.isDisposed = false;

        // ■ NBLM Fix: Performance Monitor (Op. Valve)
        this.frameCount = 0;
        this.timeAccumulator = 0;
    }

    init(canvasId) { this.initialize(canvasId); }

    initialize(canvasId) {
        if (this.isDisposed) return;
        
        if (!canvasId) canvasId = 'renderCanvas';
        console.log("[GameEngine] Initializing...");
        
        let canvas = document.getElementById(canvasId);
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = canvasId;
            document.body.appendChild(canvas);
        }

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB); 
        this.scene.fog = new THREE.Fog(0x87CEEB, 20, 100);

        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.updateCameraPosition();

        try {
            this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
        } catch (e) {
            console.warn("[GameEngine] WebGL Init failed with high settings, retrying with lower settings...", e);
            try {
                this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: "low-power" });
            } catch (e2) {
                console.error("[GameEngine] Critical: WebGL Init failed completely.", e2);
                alert("WebGLの初期化に失敗しました。ブラウザの設定やGPUドライバを確認してください。");
                return;
            }
        }

        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; 

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(50, 100, 50);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.width = 2048;
        dirLight.shadow.mapSize.height = 2048;
        dirLight.shadow.camera.near = 0.5;
        dirLight.shadow.camera.far = 500;
        this.scene.add(dirLight);

        this.terrainManager = new TerrainManager(this.scene, 32);
        this.visualEntityManager = new VisualEntityManager(this.scene, this.terrainManager, this.camera);
        this.inputManager = new InputManager(canvas, this.camera, this.terrainManager);
        this.inputManager.setActive(true);
        this.minimapManager = new MinimapManager(this);

        this._onResize = () => {
            if (this.camera && this.renderer) {
                this.camera.aspect = window.innerWidth / window.innerHeight;
                this.camera.updateProjectionMatrix();
                this.renderer.setSize(window.innerWidth, window.innerHeight);
            }
        };
        window.addEventListener('resize', this._onResize, false);

        this.animate();
        console.log("[GameEngine] Initialized (Robust Mode + Perf Monitor).");
    }

    startGame(logicRef, id, name, x, y, z, speed, colorHex, isVisible) {
        if (this.isDisposed) return;
        
        this.gameLogicRef = logicRef;
        this.localPlayerId = id;
        
        if (this.visualEntityManager) {
            this.visualEntityManager.setLocalPlayerId(id);
            this.visualEntityManager.updateEntity(id, x, y, z, colorHex, name, "Player", 0, isVisible, speed);
        }
        
        if (this.inputManager) {
            this.inputManager.setSpeed(speed);
        }

        this.logicalPos.set(Math.round(x * 2) / 2, y, Math.round(z * 2) / 2);
        
        this.cameraLookAt.set(x, 0, z);
        this.updateCameraPosition();
        
        if (this.minimapManager) this.minimapManager.show();
    }

    setPlayerSpeed(speed) {
        if (this.inputManager) {
            this.inputManager.setSpeed(speed);
        }
    }

    renderBox(hex) {
        if (!this.localPlayerId || !this.visualEntityManager) return;
        const mesh = this.visualEntityManager.entities[this.localPlayerId];
        if (mesh) {
            const primitive = mesh.getObjectByName("Primitive");
            if (primitive && primitive.material) {
                primitive.material.color.setHex(parseInt(hex.replace('#', ''), 16));
            }
            mesh.userData.colorHex = hex;
        }
    }
    
    stopMove() { if(this.inputManager) this.inputManager.targetPos = null; }
    
    warpLocalPlayer(x, y, z) {
        if (!this.localPlayerId || !this.visualEntityManager) return;
        const mesh = this.visualEntityManager.entities[this.localPlayerId];
        if (mesh) {
            this.logicalPos.set(Math.round(x * 2) / 2, y, Math.round(z * 2) / 2);
            mesh.position.set(x, y, z);
            if(this.inputManager) this.inputManager.targetPos = null;
            this.cameraLookAt.set(x, 0, z);
            this.updateCameraPosition();
        }
    }
    
    startPlacementMode(id) {
        this.isPlacementMode = true;
        if (this.visualEntityManager) {
            this.placementTargetMesh = this.visualEntityManager.entities[id];
        }
    }
    
    endPlacementMode() {
        this.isPlacementMode = false;
        if(this.placementTargetMesh) {
            return [
                this.placementTargetMesh.position.x, 
                this.placementTargetMesh.position.y,
                this.placementTargetMesh.position.z,
                this.placementTargetMesh.rotation.y
            ];
        }
        return null;
    }

    animate() {
        if (this.isDisposed) return;
        
        this.animationFrameId = requestAnimationFrame(() => this.animate());
        const delta = this.clock.getDelta();

        // ■ NBLM Fix: Performance Throttling
        this.updatePerformanceMonitor(delta);

        if (this.inputManager) this.inputManager.update();

        this.updateLocalPlayer(delta);
        this.updateCameraFollow(delta); 

        if (this.visualEntityManager) this.visualEntityManager.animate(delta);
        if (this.minimapManager) this.minimapManager.update();
        if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
    }

    updatePerformanceMonitor(delta) {
        this.frameCount++;
        this.timeAccumulator += delta;
        if (this.timeAccumulator >= 1.0) {
            const currentFps = this.frameCount / this.timeAccumulator;
            
            // 処理落ち検知: 24FPS未満 かつ 接続数が5人以上の場合
            // 低スペック端末の保護のため、これ以上の接続を拒否する
            if (currentFps < 24 && window.networkManager && window.networkManager.getPeerCount() > 5) {
                 console.warn(`[Performance] FPS dropped to ${currentFps.toFixed(1)}. Capping peers.`);
                 window.networkManager.capPeerCount();
            }
            this.frameCount = 0;
            this.timeAccumulator = 0;
        }
    }

    updateLocalPlayer(delta) {
        if (!this.localPlayerId || !this.inputManager || this.isPlacementMode || !this.visualEntityManager) return;
        
        const mesh = this.visualEntityManager.entities[this.localPlayerId];
        if (!mesh) return;

        const target = this.inputManager.targetPos;
        const now = Date.now();

        if (target && now >= this.nextStepTime) {
            this._tempVec2_A.set(this.logicalPos.x, this.logicalPos.z);
            this._tempVec2_B.set(target.x, target.z);
            
            const dist2D = this._tempVec2_A.distanceTo(this._tempVec2_B);
            
            if (dist2D >= 0.25) {
                const dir = this._tempVec2_B.sub(this._tempVec2_A).normalize();
                const stepSize = 0.5;
                
                const nextX = this.logicalPos.x + dir.x * stepSize;
                const nextZ = this.logicalPos.z + dir.y * stepSize;

                const snappedX = Math.round(nextX * 2) / 2;
                const snappedZ = Math.round(nextZ * 2) / 2;

                let nextY = this.logicalPos.y;
                if (this.terrainManager) {
                    const h = this.terrainManager.getHeightAt(snappedX, snappedZ);
                    if (h !== null) nextY = h + 0.5;
                }

                this.logicalPos.set(snappedX, nextY, snappedZ);
                
                const speed = this.inputManager.moveSpeed || 300;
                const unitsPerSec = speed / 60.0; 
                const stepTimeMs = (stepSize / unitsPerSec) * 1000;
                this.nextStepTime = now + stepTimeMs;

                mesh.lookAt(target.x, mesh.position.y, target.z);

                if (now - this.lastSentTime > 50 && this.gameLogicRef) {
                    this.gameLogicRef.invokeMethodAsync('UpdateMyPosition', this.logicalPos.x, this.logicalPos.y, this.logicalPos.z)
                        .catch(err => console.warn("Invoke failed (GameLogic may be disposed):", err));
                    this.lastSentTime = now;
                }
            }
        }

        const visualTarget = this.logicalPos;
        const visualDist = mesh.position.distanceTo(visualTarget);
        
        if (visualDist > 0.001) {
            const speedParam = this.inputManager.moveSpeed || 300;
            const visualSpeed = (speedParam / 60.0);
            const moveStep = visualSpeed * delta; 
            
            if (visualDist <= moveStep) {
                mesh.position.copy(visualTarget);
            } else {
                this._tempVec3.subVectors(visualTarget, mesh.position).normalize();
                mesh.position.add(this._tempVec3.multiplyScalar(moveStep));
            }
        } else {
            mesh.position.copy(visualTarget);
        }
        
        if(this.minimapManager) {
            this.minimapManager.playerPos = mesh.position;
        }
    }

    updateCameraFollow(delta) {
        if (!this.localPlayerId || !this.visualEntityManager) return;
        const mesh = this.visualEntityManager.entities[this.localPlayerId];
        
        if (mesh) {
            this.cameraLookAt.lerp(mesh.position, 0.5); 
            this.updateCameraPosition();
        }
    }

    updateCameraPosition() {
        if (!this.camera) return;
        this.camera.position.set(
            this.cameraLookAt.x, 
            this.cameraLookAt.y + this.CAMERA_HEIGHT, 
            this.cameraLookAt.z + this.CAMERA_Z_OFFSET
        );
        this.camera.lookAt(this.cameraLookAt.x, this.cameraLookAt.y, this.cameraLookAt.z);
    }

    dispose() {
        if (this.isDisposed) return;
        console.log("[GameEngine] Disposing...");
        
        this.isDisposed = true;
        
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }

        if (this._onResize) {
            window.removeEventListener('resize', this._onResize);
        }

        if (this.inputManager) {
            this.inputManager.dispose();
            this.inputManager = null;
        }

        if (this.minimapManager) {
            if (this.minimapManager.canvas && this.minimapManager.canvas.parentNode) {
                this.minimapManager.canvas.parentNode.removeChild(this.minimapManager.canvas);
            }
            this.minimapManager = null;
        }

        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
            this.renderer = null;
        }

        if (this.scene) {
            this.scene = null;
        }

        this.gameLogicRef = null;
        this.dotNetRef = null;
        console.log("[GameEngine] Disposed.");
    }
}