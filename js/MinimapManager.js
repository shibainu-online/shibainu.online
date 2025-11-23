export class MinimapManager {
    constructor(visualEntityManager, playerPos) {
        this.visualEntityManager = visualEntityManager;
        this.playerPos = playerPos;
        
        this.visible = false;

        // DOM作成
        this.canvas = document.createElement('canvas');
        this.canvas.width = 200;
        this.canvas.height = 200;
        this.canvas.style.position = 'fixed';
        this.canvas.style.bottom = '10px';
        this.canvas.style.right = '10px';
        this.canvas.style.border = '2px solid #333';
        this.canvas.style.borderRadius = '8px';
        this.canvas.style.backgroundColor = 'rgba(0, 50, 0, 0.7)'; 
        this.canvas.style.zIndex = '99';
        this.canvas.style.display = 'none'; 
        
        document.body.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d');
        
        this.range = 32 * 1.5; 
    }

    show() {
        this.visible = true;
        this.canvas.style.display = 'block';
    }

    toggle() {
        this.visible = !this.visible;
        this.canvas.style.display = this.visible ? 'block' : 'none';
        return this.visible;
    }

    update() {
        if (!this.visible) return;

        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        ctx.clearRect(0, 0, w, h);

        ctx.fillStyle = 'rgba(34, 139, 34, 0.5)';
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();

        const entities = this.visualEntityManager.entities;
        for (const id in entities) {
            const mesh = entities[id];
            
            // ★追加: 3D空間で見えていないものはミニマップにも描かない
            if (!mesh.visible) continue;

            this.drawDot(ctx, mesh.position, mesh.material.color.getHexString());
        }

        // 自分自身 (プレイヤー位置)
        // VisualEntityManager経由ですでに描画されている可能性もあるが、
        // 重なっても中心に白点を打つために残す
        this.drawDot(ctx, this.playerPos, 'FFFFFF', true); 

        ctx.restore();
    }

    drawDot(ctx, pos, colorHex, isSelf = false) {
        const scale = this.canvas.width / (this.range * 2);
        
        const dx = pos.x - this.playerPos.x;
        const dy = pos.z - this.playerPos.z; 

        const mx = dx * scale + 100;
        const my = dy * scale + 100;

        if (mx < 0 || mx > 200 || my < 0 || my > 200) return;

        ctx.beginPath();
        const radius = isSelf ? 4 : 3;
        ctx.arc(mx, my, radius, 0, Math.PI * 2);
        
        ctx.fillStyle = '#' + colorHex;
        ctx.fill();
        
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'black';
        ctx.stroke();
    }
}