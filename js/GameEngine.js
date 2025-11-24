import { TerrainManager } from './TerrainManager.js';
import { VisualEntityManager } from './VisualEntityManager.js';
import { InputManager } from './InputManager.js';
import { NetworkManager } from './NetworkManager.js';
import { MinimapManager } from './MinimapManager.js';

export class GameEngine {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.clock = null;
        
        this.terrainManager = null;
        this.visualEntityManager = null;
        this.inputManager = null;
        this.networkManager = null;
        this.minimapManager = null;

        this.gameLogicRef = null;
        this.isGameActive = false;

        this.isPlacementMode = false;
        this.placementTargetMesh = null;
        this.placementYOffset = 0;
        this.placementRotation = 0;

        this.localPlayerId = "";
        this.cameraLookAt = new THREE.Vector3(0, 0, 0);
        this.playerPos = { x: 0, y: 0, z: 0 };

        // Constants
        this.GRID_SIZE = 32;
        this.CAMERA_HEIGHT = 30;
        this.CAMERA_Z_OFFSET = 20;
        this.CAMERA_FOLLOW_SPEED = 0.4;
        this.CAMERA_DEADZONE = 0.5;
    }

    init() {
        console.log("[GameEngine] Initializing...");
        this.clock = new THREE.Clock();

        // Scene Setup
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x87CEEB, 40, 80);

        // Camera Setup
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);

        // Renderer Setup
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        document.getElementById('canvas-container').appendChild(this.renderer.domElement);

        // Lights
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
        this.scene.add(hemiLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(50, 100, 50);
        dirLight.castShadow = true;
        this.scene.add(dirLight);

        // Managers
        this.terrainManager = new TerrainManager(this.scene, this.GRID_SIZE);
        this.visualEntityManager = new VisualEntityManager(this.scene, this.terrainManager);
        this.inputManager = new InputManager(document.getElementById('canvas-container'), this.camera, this.terrainManager);
        this.networkManager = new NetworkManager();
        this.minimapManager = new MinimapManager(this.visualEntityManager, {x:0, y:0, z:0});

        // Event Listeners
        window.addEventListener('resize', () => this.onWindowResize());
        window.addEventListener('keydown', (e) => this.onKeyDown(e));

        // Start Loop
        setInterval(() => this.reportPositionToCSharp(), 50);
        this.animate();
    }

    startGame(logicRef, id, name, x, y, z, speed, colorHex, isVisible) {
        this.gameLogicRef = logicRef;
        this.localPlayerId = id;
        this.isGameActive = true;
        
        this.inputManager.setActive(true);
        this.inputManager.setSpeed(speed);
        document.body.classList.add('game-active');

        this.playerPos.x = x; this.playerPos.y = y; this.playerPos.z = z;
        if (!this.inputManager.targetPos) this.inputManager.targetPos = new THREE.Vector3();
        this.inputManager.targetPos.set(x, y, z);

        this.cameraLookAt.set(x, 0, z);
        if (this.minimapManager) this.minimapManager.show();

        this.visualEntityManager.setLocalPlayerId(id);
        this.visualEntityManager.updateEntity(id, x, y, z, colorHex, name, "Player", 0, true, speed);

        this.updateVisuals();
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        const delta = this.clock.getDelta();

        if (this.isGameActive) {
            this.inputManager.update();

            if (!this.isPlacementMode) {
                this.updateLocalPlayerMovement(delta);
                this.checkCollisions();
            } else if (this.placementTargetMesh) {
                this.updatePlacementMode();
            }

            this.updateVisuals();
            this.visualEntityManager.animate(delta);
            this.minimapManager.update();
        }
        this.renderer.render(this.scene, this.camera);
    }

    updateLocalPlayerMovement(delta) {
        const myMesh = this.visualEntityManager.entities[this.localPlayerId];
        if (!myMesh) return;

        if (this.inputManager.targetPos && this.inputManager.isPressing()) {
            const target = this.inputManager.targetPos;
            const currentPos = myMesh.position;
            const dist = currentPos.distanceTo(target);

            if (dist > 0.1) {
                const speedParam = this.inputManager.moveSpeed || 300;
                const visualSpeed = speedParam / 30.0;
                const maxMove = visualSpeed * delta;
                const dir = new THREE.Vector3().subVectors(target, currentPos).normalize();
                myMesh.position.add(dir.multiplyScalar(maxMove));
            }
        }

        const groundH = this.terrainManager.getHeightAt(myMesh.position.x, myMesh.position.z);
        if (groundH !== null) {
            myMesh.position.y = groundH + 0.5;
        }

        this.playerPos.x = myMesh.position.x;
        this.playerPos.y = myMesh.position.y;
        this.playerPos.z = myMesh.position.z;

        this.visualEntityManager.updateGridPosition(myMesh, this.playerPos.x, this.playerPos.z);
    }

    updatePlacementMode() {
        if (this.inputManager.targetPos) {
            const tx = this.inputManager.targetPos.x;
            const tz = this.inputManager.targetPos.z;
            const ty = (this.inputManager.getHeightAt(tx, tz) || 0) + 0.5 + this.placementYOffset;
            this.placementTargetMesh.position.set(tx, ty, tz);
            this.placementTargetMesh.rotation.y = this.placementRotation;
        }
    }

    checkCollisions() {
        if (!this.visualEntityManager || !this.gameLogicRef) return;
        const gx = Math.floor(this.playerPos.x);
        const gz = Math.floor(this.playerPos.z);
        
        if (typeof this.visualEntityManager.getEntitiesInGrid === 'function') {
            const nearbyEntities = this.visualEntityManager.getEntitiesInGrid(gx, gz);
            for (const mesh of nearbyEntities) {
                if (mesh.userData.id === this.localPlayerId) continue;
                if (Math.abs(this.playerPos.y - mesh.position.y) < 3.0) {
                    this.gameLogicRef.invokeMethodAsync('OnTouchEntity', mesh.userData.id);
                }
            }
        }
    }

    updateVisuals() {
        const myRealMesh = this.visualEntityManager.entities[this.localPlayerId];
        
        if (myRealMesh && this.minimapManager) {
            this.minimapManager.playerPos.x = myRealMesh.position.x;
            this.minimapManager.playerPos.y = myRealMesh.position.y;
            this.minimapManager.playerPos.z = myRealMesh.position.z;
        }

        if (this.camera) {
            let targetPos = null;
            if (this.isPlacementMode && this.placementTargetMesh) targetPos = this.placementTargetMesh.position;
            else if (myRealMesh) targetPos = myRealMesh.position;
            else targetPos = this.cameraLookAt;

            if (targetPos) {
                const dx = targetPos.x - this.cameraLookAt.x;
                const dz = targetPos.z - this.cameraLookAt.z;
                const dist = Math.sqrt(dx*dx + dz*dz);

                if (dist > this.CAMERA_DEADZONE) {
                    if (dist <= this.CAMERA_FOLLOW_SPEED) {
                        this.cameraLookAt.x = targetPos.x; this.cameraLookAt.z = targetPos.z;
                    } else {
                        const angle = Math.atan2(dz, dx);
                        this.cameraLookAt.x += Math.cos(angle) * this.CAMERA_FOLLOW_SPEED;
                        this.cameraLookAt.z += Math.sin(angle) * this.CAMERA_FOLLOW_SPEED;
                    }
                }
                this.camera.position.set(this.cameraLookAt.x, this.CAMERA_HEIGHT, this.cameraLookAt.z + this.CAMERA_Z_OFFSET);
                this.camera.lookAt(this.cameraLookAt.x, 0, this.cameraLookAt.z);
            }
        }
    }

    reportPositionToCSharp() {
        if (this.isGameActive && !this.isPlacementMode && this.gameLogicRef) {
            this.gameLogicRef.invokeMethodAsync('UpdateMyPosition', this.playerPos.x, this.playerPos.y, this.playerPos.z);
        }
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    onKeyDown(e) {
        if (!this.isPlacementMode) return;
        if (e.key === 'ArrowUp') this.placementYOffset += 0.1;
        if (e.key === 'ArrowDown') this.placementYOffset -= 0.1;
        if (e.key === 'ArrowLeft') this.placementRotation += 0.1;
        if (e.key === 'ArrowRight') this.placementRotation -= 0.1;
    }

    // --- Exposed Methods for Interop ---

    syncLocalPosition(x, y, z) {
        const dist = Math.sqrt(Math.pow(x - this.playerPos.x, 2) + Math.pow(z - this.playerPos.z, 2));
        if (dist > 5.0) this.warpLocalPlayer(x, y, z);
    }

    renderBox(hex) {
        const myRealMesh = this.visualEntityManager.entities[this.localPlayerId];
        if (myRealMesh) myRealMesh.material.color.setHex(parseInt(hex.replace('#', ''), 16));
    }

    setPlayerSpeed(speed) {
        if (this.inputManager) this.inputManager.setSpeed(speed);
    }

    warpLocalPlayer(x, y, z) {
        this.playerPos.x = x; this.playerPos.y = y; this.playerPos.z = z;
        if (this.inputManager.targetPos) this.inputManager.targetPos.set(x, y, z);
        this.cameraLookAt.set(x, 0, z);
        
        const myRealMesh = this.visualEntityManager.entities[this.localPlayerId];
        if (myRealMesh) {
            myRealMesh.position.set(x, y, z);
            myRealMesh.userData.targetPos.set(x, y, z);
        }
        this.updateVisuals();
    }

    startPlacementMode(id) {
        this.isPlacementMode = true;
        this.placementTargetMesh = this.visualEntityManager.entities[id];
        this.placementYOffset = 0;
        this.placementRotation = 0;
    }

    endPlacementMode() {
        this.isPlacementMode = false;
        let result = null;
        if (this.placementTargetMesh) {
            result = [
                this.placementTargetMesh.position.x,
                this.placementTargetMesh.position.y,
                this.placementTargetMesh.position.z,
                this.placementTargetMesh.rotation.y
            ];
        }
        this.placementTargetMesh = null;
        return result;
    }
}