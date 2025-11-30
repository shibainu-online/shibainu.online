import { GameEngine } from './GameEngine.js';
import { NetworkManager } from './NetworkManager.js';
import { InteropBridge } from './InteropBridge.js';
import './NetworkInterop.js';
// ★追加: AssetManagerを読み込み、window.assetManager を有効化する
import './AssetManager.js';

console.log("[Main] Loading Main.js (Genesis Fix / External Server / RenderBox Fix / Interop Update / AssetManager)");

// Initialize Global Managers
window.gameEngine = new GameEngine();
window.networkManager = new NetworkManager();

// Setup Interop Bridge (This ensures exports are ready for C#)
const bridge = new InteropBridge(window.gameEngine);

// Global Reset Logic
const handleGenesisRequest = (reason) => {
    console.warn(`[Main] System requested action. Reason: ${reason}`);

    const message = 
        "【世界データの確認】\n\n" +
        "ネットワーク上およびローカルストレージに有効な世界データが見つかりませんでした。\n" +
        "あなたはマスター権限を持っています。\n\n" +
        "この場所・この時間を起点として、新たに世界を「創造（Genesis）」しますか？\n\n" +
        "[OK] : はい、ここを新たな世界の始まりとします。（ゲーム開始）\n" +
        "[キャンセル] : いいえ、接続を再試行します。（リロード）";

    const shouldGenesis = confirm(message);

    if (shouldGenesis) {
        console.log("[Main] Genesis approved. Continuing execution WITHOUT reload.");
        const errorModal = document.getElementById('error-modal');
        if (errorModal) errorModal.remove();
        
    } else {
        console.log("[Main] Genesis rejected. Reloading...");
        window.location.reload(); 
    }
};

if (window.NetworkInterop) {
    window.NetworkInterop.restart = handleGenesisRequest;
} else {
    window.addEventListener('load', () => {
        if (window.NetworkInterop) window.NetworkInterop.restart = handleGenesisRequest;
    });
}
window.restart = handleGenesisRequest;

// Bootstrap
export function bootstrap() {
    console.log("[Main] Initializing Game Engine...");
    try {
        window.gameEngine.init('renderCanvas'); 
    } catch (e) {
        console.error("[Main] Game Engine Init Failed:", e);
    }
}

window.addEventListener('load', bootstrap);