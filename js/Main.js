import { TerrainManager } from './TerrainManager.js';
import { VisualEntityManager } from './VisualEntityManager.js';
import { InputManager } from './InputManager.js';
import { NetworkManager } from './NetworkManager.js';
import { MinimapManager } from './MinimapManager.js'; 

let scene, camera, renderer;
let terrainManager, visualEntityManager, inputManager, networkManager, minimapManager; 
let gameLogicRef;
let isGameActive = false;

let isPlacementMode = false;
let placementTargetMesh = null;
let placementYOffset = 0;
let placementRotation = 0;

const GRID_SIZE = 32;
// 論理座標（入力判定用）
const playerPos = { x: 0, y: 0, z: 0 };

let localPlayerId = "";
let cameraLookAt; 
let clock;

const CAMERA_HEIGHT = 30; 
const CAMERA_Z_OFFSET = 20; 
const CAMERA_FOLLOW_SPEED = 0.4; 
const CAMERA_DEADZONE = 0.5;
const GRAVITY = 0.8; 

async function initGame() {
    console.log("[Main] Initializing Game Engine...");
    cameraLookAt = new THREE.Vector3(0, 0, 0);
    clock = new THREE.Clock();

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x87CEEB, 40, 80);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    scene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(50, 100, 50);
    dirLight.castShadow = true;
    scene.add(dirLight);

    terrainManager = new TerrainManager(scene, GRID_SIZE);
    visualEntityManager = new VisualEntityManager(scene, terrainManager);
    inputManager = new InputManager(document.getElementById('canvas-container'), camera, terrainManager);
    networkManager = new NetworkManager();
    minimapManager = new MinimapManager(visualEntityManager, {x:0, y:0, z:0});

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
    
    window.addEventListener('keydown', (e) => {
        if (!isPlacementMode) return;
        if (e.key === 'ArrowUp') placementYOffset += 0.1;
        if (e.key === 'ArrowDown') placementYOffset -= 0.1;
        if (e.key === 'ArrowLeft') placementRotation += 0.1;
        if (e.key === 'ArrowRight') placementRotation -= 0.1;
    });

    // 50ms間隔で現在地を報告 (クライアント主導)
    setInterval(reportPositionToCSharp, 50);
    animate();
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if (isGameActive) {
        inputManager.update();

        if (!isPlacementMode) {
            // ★ファイナル版ロジック復活: 自キャラをローカルで動かす
            updateLocalPlayerMovement(delta);
            checkCollisions();
        } 
        else if (placementTargetMesh) {
            if (inputManager.targetPos) {
                const tx = inputManager.targetPos.x;
                const tz = inputManager.targetPos.z;
                const ty = (inputManager.getHeightAt(tx, tz) || 0) + 0.5 + placementYOffset;
                placementTargetMesh.position.set(tx, ty, tz);
                placementTargetMesh.rotation.y = placementRotation;
            }
        }
        
        updateVisuals();
        visualEntityManager.animate(delta);
        minimapManager.update();
    }
    renderer.render(scene, camera);
}

// ★復活: ローカル移動ロジック (滑らかなMoveTowards)
function updateLocalPlayerMovement(delta) {
    const myMesh = visualEntityManager.entities[localPlayerId];
    if (!myMesh) return;

    if (inputManager.targetPos && inputManager.isPressing()) {
        const target = inputManager.targetPos;
        const currentPos = myMesh.position;
        const dist = currentPos.distanceTo(target);

        if (dist > 0.1) {
            const speedParam = inputManager.moveSpeed || 300;
            const visualSpeed = speedParam / 30.0; 
            const maxMove = visualSpeed * delta;

            const dir = new THREE.Vector3().subVectors(target, currentPos).normalize();
            myMesh.position.add(dir.multiplyScalar(maxMove));
        }
    }

    const groundH = terrainManager.getHeightAt(myMesh.position.x, myMesh.position.z);
    if (groundH !== null) {
        myMesh.position.y = groundH + 0.5;
    }

    playerPos.x = myMesh.position.x;
    playerPos.y = myMesh.position.y;
    playerPos.z = myMesh.position.z;

    visualEntityManager.updateGridPosition(myMesh, playerPos.x, playerPos.z);
}

// ★復活: C#への現在地報告 (GameLogic.UpdateMyPositionへ)
function reportPositionToCSharp() {
    if (isGameActive && !isPlacementMode && gameLogicRef) {
        gameLogicRef.invokeMethodAsync('UpdateMyPosition', playerPos.x, playerPos.y, playerPos.z);
    }
}

function checkCollisions() {
    if (!visualEntityManager || !gameLogicRef) return;
    const gx = Math.floor(playerPos.x);
    const gz = Math.floor(playerPos.z);
    if (typeof visualEntityManager.getEntitiesInGrid === 'function') {
        const nearbyEntities = visualEntityManager.getEntitiesInGrid(gx, gz);
        for (const mesh of nearbyEntities) {
            if (mesh.userData.id === localPlayerId) continue;
            if (Math.abs(playerPos.y - mesh.position.y) < 3.0) {
                gameLogicRef.invokeMethodAsync('OnTouchEntity', mesh.userData.id);
            }
        }
    }
}

function updateVisuals() {
    const myRealMesh = visualEntityManager.entities[localPlayerId];
    
    if (myRealMesh && minimapManager) {
        minimapManager.playerPos.x = myRealMesh.position.x;
        minimapManager.playerPos.y = myRealMesh.position.y;
        minimapManager.playerPos.z = myRealMesh.position.z;
    }

    if (camera) {
        let targetPos = null;
        if (isPlacementMode && placementTargetMesh) targetPos = placementTargetMesh.position;
        else if (myRealMesh) targetPos = myRealMesh.position;
        else targetPos = cameraLookAt;

        if (targetPos) {
            const dx = targetPos.x - cameraLookAt.x;
            const dz = targetPos.z - cameraLookAt.z;
            const dist = Math.sqrt(dx*dx + dz*dz);

            if (dist > CAMERA_DEADZONE) {
                if (dist <= CAMERA_FOLLOW_SPEED) {
                    cameraLookAt.x = targetPos.x; cameraLookAt.z = targetPos.z;
                } else {
                    const angle = Math.atan2(dz, dx);
                    cameraLookAt.x += Math.cos(angle) * CAMERA_FOLLOW_SPEED;
                    cameraLookAt.z += Math.sin(angle) * CAMERA_FOLLOW_SPEED;
                }
            }
            camera.position.set(cameraLookAt.x, CAMERA_HEIGHT, cameraLookAt.z + CAMERA_Z_OFFSET);
            camera.lookAt(cameraLookAt.x, 0, cameraLookAt.z);
        }
    }
}

window.initNetwork = (ref) => { 
    if (!networkManager) networkManager = new NetworkManager();
    networkManager.init(ref); 
};

// ★追加: 新機能のネットワーク設定
window.NetworkInterop = {
    addSignalingUrl: (url) => { if (networkManager) networkManager.addSignalingUrl(url); },
    setForceLocal: (enabled) => { if (networkManager) networkManager.setForceLocal(enabled); },
    restart: () => { if (networkManager) networkManager.connect(); }
};

window.StartGame = (logicRef, id, name, x, y, z, speed, colorHex, isVisible) => {
    gameLogicRef = logicRef;
    localPlayerId = id; 
    isGameActive = true;
    inputManager.setActive(true);
    inputManager.setSpeed(speed); 
    document.body.classList.add('game-active');
    
    playerPos.x = x; playerPos.y = y; playerPos.z = z;
    if (!inputManager.targetPos) inputManager.targetPos = new THREE.Vector3();
    inputManager.targetPos.set(x, y, z);

    if (cameraLookAt) cameraLookAt.set(x, 0, z);
    if (minimapManager) minimapManager.show();

    // ★重要: setLocalPlayerId を呼ぶ (これによりVisualEntityManagerでの二重移動を防ぐ)
    visualEntityManager.setLocalPlayerId(id);
    visualEntityManager.updateEntity(id, x, y, z, colorHex, name, "Player", 0, true, speed);

    updateVisuals();
};

// 同期用（ワープのみ対応し、普段は無視する）
window.SyncLocalPosition = (x, y, z) => {
    const dist = Math.sqrt(Math.pow(x - playerPos.x, 2) + Math.pow(z - playerPos.z, 2));
    if (dist > 5.0) {
        WarpLocalPlayer(x, y, z);
    }
};

window.renderBox = (hex) => { 
    const myRealMesh = visualEntityManager.entities[localPlayerId];
    if (myRealMesh) myRealMesh.material.color.setHex(parseInt(hex.replace('#', ''), 16)); 
};
window.SetPlayerSpeed = (speed) => { if (inputManager) inputManager.setSpeed(speed); };
window.TerrainInterop = { loadChunk: (gx, gz, heightMap) => terrainManager.loadChunk(gx, gz, heightMap) };
window.VisualEntityInterop = {
    updateEntity: (id, x, y, z, colorHex, name, type, rot, isVisible, moveSpeed) => { 
        // ★重要: 自分自身の更新はスキップ (Main.jsで制御しているため)
        if (id === localPlayerId) return; 
        if(visualEntityManager) visualEntityManager.updateEntity(id, x, y, z, colorHex, name, type, rot, isVisible, moveSpeed); 
    },
    removeEntity: (id) => { if(visualEntityManager) visualEntityManager.removeEntity(id); }
};
window.ToggleMinimap = () => { if(minimapManager) return minimapManager.toggle(); return false; };
window.WarpLocalPlayer = (x, y, z) => { playerPos.x = x; playerPos.y = y; playerPos.z = z; if (inputManager.targetPos) inputManager.targetPos.set(x, y, z); if (cameraLookAt) cameraLookAt.set(x, 0, z); const myRealMesh = visualEntityManager.entities[localPlayerId]; if (myRealMesh) { myRealMesh.position.set(x, y, z); myRealMesh.userData.targetPos.set(x, y, z); } updateVisuals(); };
window.UpdateRemotePlayer = (id, x, y, z, colorHex) => { if(visualEntityManager) visualEntityManager.updateEntity(id, x, y, z, colorHex, id, "Player"); };
window.StartPlacementMode = (id) => { isPlacementMode = true; placementTargetMesh = visualEntityManager.entities[id]; placementYOffset = 0; placementRotation = 0; };
window.EndPlacementMode = () => { isPlacementMode = false; let result = null; if (placementTargetMesh) { result = [ placementTargetMesh.position.x, placementTargetMesh.position.y, placementTargetMesh.position.z, placementTargetMesh.rotation.y ]; } placementTargetMesh = null; return result; };
window.ToggleNamePlates = () => { if(!visualEntityManager) return; const visible = visualEntityManager.toggleNamePlates(); if(visualEntityManager.entities) for(let id in visualEntityManager.entities) { let mesh = visualEntityManager.entities[id]; mesh.children.forEach(c => { if(c.isSprite) c.visible = visible; }); } }; 
window.broadcastMessage = (m) => networkManager.broadcast(m);
window.verifyMasterKey = (p, pub) => networkManager.verifyMasterKey(p, pub);

async function loadThreeJs() {
    let scriptSrc = 'three.module.js';
    try { const r = await fetch('js/Three.js_hash.txt'); if (r.ok) { const h = await r.text(); if (h.trim()) scriptSrc = `three.${h.trim()}.js`; } } catch {}
    try { const m = await import(`./${scriptSrc}`); window.THREE = m; initGame(); } catch (e) { console.error("Three.js Load Error:", e); }
}
loadThreeJs();