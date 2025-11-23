export class TerrainManager {
    constructor(scene, gridSize) {
        this.scene = scene;
        this.gridSize = gridSize;
        this.chunks = {}; 
        this.chunkData = {}; 
        
        this.material = new THREE.MeshStandardMaterial({ 
            color: 0x55aa55, 
            // ★修正: スムーズシェーディングにしてゼブラ柄を解消
            flatShading: false, 
            roughness: 0.8 
        });
    }

    loadChunk(gx, gz, heightMap) {
        const key = `${gx}_${gz}`;
        this.chunkData[key] = heightMap;

        if (this.chunks[key]) {
            this.scene.remove(this.chunks[key]);
            this.chunks[key].geometry.dispose();
            delete this.chunks[key];
        }

        const segments = 32;
        const geometry = new THREE.PlaneGeometry(this.gridSize, this.gridSize, segments, segments);
        geometry.rotateX(-Math.PI / 2);

        const positions = geometry.attributes.position.array;
        
        // スタッガード・グリッド
        for (let i = 0; i < positions.length / 3; i++) {
            const x = positions[i * 3];
            const z = positions[i * 3 + 2];
            
            const localZIndex = Math.round(z + this.gridSize / 2);
            const globalZ = gz * 32 + localZIndex;

            if (Math.abs(globalZ) % 2 === 1) {
                positions[i * 3] += 0.5;
            }

            if (i < heightMap.length) {
                positions[i * 3 + 1] = heightMap[i];
            }
        }
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.position.set(
            gx * this.gridSize + this.gridSize / 2, 
            0, 
            gz * this.gridSize + this.gridSize / 2
        );
        mesh.name = "terrain";
        
        this.scene.add(mesh);
        this.chunks[key] = mesh;
    }

    getMeshes() { return Object.values(this.chunks); }

    getHeightAt(x, z) {
        const gx = Math.floor(x / this.gridSize);
        const gz = Math.floor(z / this.gridSize);
        const key = `${gx}_${gz}`;
        const data = this.chunkData[key];
        if (!data) return null; 

        let lx = x - (gx * this.gridSize);
        let lz = z - (gz * this.gridSize);
        
        const globalZ = Math.round(gz * 32 + lz);
        if (Math.abs(globalZ) % 2 === 1) {
            lx -= 0.5; 
        }

        let ix = Math.round(lx);
        let iz = Math.round(lz);
        
        if (ix < 0) ix = 0; if (ix > 32) ix = 32;
        if (iz < 0) iz = 0; if (iz > 32) iz = 32;

        const index = iz * 33 + ix;
        if (index >= 0 && index < data.length) return data[index];
        return null;
    }
}