import { GameEngine } from './GameEngine.js';
import { InteropBridge } from './InteropBridge.js';

async function bootstrap() {
    // 1. Load Three.js with Hash Cache-Busting
    let scriptSrc = 'three.module.js';
    try {
        const r = await fetch('js/Three.js_hash.txt');
        if (r.ok) {
            const h = await r.text();
            if (h.trim()) scriptSrc = `three.${h.trim()}.js`;
        }
    } catch (e) {
        console.warn("[Main] Hash load failed, using default.");
    }

    try {
        // Dynamic Import of Three.js
        const m = await import(`./${scriptSrc}`);
        window.THREE = m;

        // 2. Initialize Game Engine
        const gameEngine = new GameEngine();
        
        // 3. Initialize Interop (Connecting C# and JS)
        new InteropBridge(gameEngine);

        // 4. Start Engine Initialization
        gameEngine.init();

        console.log("[Main] ShibainuOnline Engine Started.");
    } catch (e) {
        console.error("[Main] Critical Error:", e);
    }
}

bootstrap();