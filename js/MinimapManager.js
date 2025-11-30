export class MinimapManager {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.isVisible = false;
        
        this.container = document.createElement('div');
        this.container.id = 'minimap-container';
        this.container.style.position = 'fixed';
        this.container.style.bottom = '10px';
        this.container.style.right = '10px';
        this.container.style.width = '200px';
        this.container.style.height = '200px';
        this.container.style.zIndex = '1000';
        this.container.style.display = 'none';
        document.body.appendChild(this.container);

        this.canvas = document.createElement('canvas');
        this.canvas.id = 'minimap';
        this.canvas.width = 200;
        this.canvas.height = 200;
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.borderRadius = '50%';
        this.canvas.style.background = 'rgba(0,0,0,0.5)';
        this.container.appendChild(this.canvas);

        this.frame = document.createElement('img');
        this.frame.src = 'assets/minimap_frame.png';
        this.frame.style.position = 'absolute';
        
        this.frame.style.top = '-20px';  
        this.frame.style.left = '-22px'; 
        this.frame.style.width = '240px'; 
        this.frame.style.height = '240px';
        
        this.frame.style.pointerEvents = 'none';
        this.frame.style.zIndex = '1001';
        this.container.appendChild(this.frame);

        this.ctx = this.canvas.getContext('2d');
        this.range = 32 * 1.5; 
        this.playerPos = { x:0, y:0, z:0 };
    }

    show() {
        this.isVisible = true;
        this.container.style.display = 'block';
    }

    toggle() {
        this.isVisible = !this.isVisible;
        this.container.style.display = this.isVisible ? 'block' : 'none';
        return this.isVisible;
    }

    update() {
        if (!this.isVisible) return;
        if (!this.gameEngine.visualEntityManager) return;

        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const radius = w / 2;

        ctx.clearRect(0, 0, w, h);

        ctx.save();
        ctx.beginPath();
        ctx.arc(radius, radius, radius, 0, Math.PI * 2);
        ctx.clip();
        
        ctx.fillStyle = 'rgba(30, 30, 30, 0.8)';
        ctx.fillRect(0, 0, w, h);

        const entities = this.gameEngine.visualEntityManager.entities;
        const px = this.playerPos.x;
        const pz = this.playerPos.z;

        for (const id in entities) {
            const mesh = entities[id];
            if (!mesh.visible) continue;

            const dx = mesh.position.x - px;
            const dz = mesh.position.z - pz;
            const scale = radius / this.range;
            const mx = radius + dx * scale;
            const my = radius + dz * scale;

            if (Math.sqrt(Math.pow(mx - radius, 2) + Math.pow(my - radius, 2)) > radius) continue;

            let color = '#CCCCCC';
            if (mesh.userData && mesh.userData.colorHex) color = mesh.userData.colorHex;
            
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(mx, my, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        let rotY = 0;
        if (this.gameEngine.localPlayerId && entities[this.gameEngine.localPlayerId]) {
            rotY = entities[this.gameEngine.localPlayerId].rotation.y;
        }

        ctx.translate(radius, radius);
        ctx.rotate(-rotY); 

        ctx.fillStyle = '#FF0000';
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.lineTo(6, 5);
        ctx.lineTo(0, 2);
        ctx.lineTo(-6, 5);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.restore();
    }
}