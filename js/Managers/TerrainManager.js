import * as THREE from 'three';
export class TerrainManager {
    constructor(scene, gridSize) {
        this.scene = scene;
        this.gridSize = gridSize || 32;
        this.chunks = {};
        this.chunkData = {}; // HeightMap cache { "gx_gz": [floats...] }
        
        // Material reused for all chunks
        this.material = new THREE.MeshStandardMaterial({ 
            color: 0x55aa55, 
            flatShading: true,
            roughness: 0.8,
            metalness: 0.1,
            side: THREE.DoubleSide
        });
        this.createBaseGround();
    }
    createBaseGround() {
        const planeGeometry = new THREE.PlaneGeometry(2000, 2000);
        const planeMaterial = new THREE.MeshStandardMaterial({ color: 0x55aa55, roughness: 0.9, metalness: 0.1 });
        this.baseGround = new THREE.Mesh(planeGeometry, planeMaterial);
        this.baseGround.rotation.x = -Math.PI / 2;
        this.baseGround.position.y = -0.1;
        this.baseGround.receiveShadow = true;
        this.scene.add(this.baseGround);
    }
    loadChunk(gx, gz, heightMap) {
        if (this.baseGround && this.baseGround.visible) {
            this.baseGround.visible = false;
        }
        const key = `${gx}_${gz}`;
        this.chunkData[key] = heightMap; // Cache raw data for math calculation
        if (this.chunks[key]) {
            this.scene.remove(this.chunks[key]);
            this.chunks[key].geometry.dispose();
            delete this.chunks[key];
        }
        const segments = 32;
        const geometry = new THREE.PlaneGeometry(this.gridSize, this.gridSize, segments, segments);
        geometry.rotateX(-Math.PI / 2);
        const positions = geometry.attributes.position.array;
        
        // Apply Heightmap & Staggered Grid Logic (Visual)
        for (let i = 0; i < positions.length / 3; i++) {
            // PlaneGeometry creates vertices row by row
            // We need to match the vertex to the heightMap index
            // PlaneGeometry(32, 32, 32, 32) creates 33x33 vertices.
            
            // Re-calculate logical grid position from vertex index
            // PlaneGeometry orders: row 0 (Z min) -> row 32 (Z max), within row: X min -> X max
            const ix = i % 33;
            const iz = Math.floor(i / 33);
            // Stagger logic: Shift odd rows by 0.5
            const globalZ = gz * 32 + iz;
            if (Math.abs(globalZ) % 2 === 1) {
                positions[i * 3] += 0.5; 
            }
            if (heightMap && i < heightMap.length) {
                if (heightMap[i] !== undefined) {
                    positions[i * 3 + 1] = heightMap[i];
                }
            }
        }
        geometry.computeVertexNormals();
        
        const mesh = new THREE.Mesh(geometry, this.material);
        // PlaneGeometry is centered at local (0,0), so we move it
        mesh.position.set(gx * 32 + 16, 0, gz * 32 + 16);
        
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.name = `Chunk_${key}`;
        
        this.scene.add(mesh);
        this.chunks[key] = mesh;
    }
    unloadChunk(gx, gz) {
        const key = `${gx}_${gz}`;
        const mesh = this.chunks[key];
        if (mesh) {
            this.scene.remove(mesh);
            mesh.geometry.dispose();
            delete this.chunks[key];
        }
        delete this.chunkData[key];
    }
    getMeshes() {
        return Object.values(this.chunks);
    }
    // --- Mission: Operation "Math Walk" (Raycast Free) ---
    getHeightAt(x, z) {
        // 1. Determine Grid Coordinates
        const gx = Math.floor(x / 32);
        const gz = Math.floor(z / 32);
        const key = `${gx}_${gz}`;
        
        const heightMap = this.chunkData[key];
        if (!heightMap) return 0; // Fallback to 0 if chunk not loaded
        // 2. Local coordinates within chunk (0.0 to 32.0)
        let lx = x - (gx * 32);
        let lz = z - (gz * 32);
        // 3. Staggered Grid Adjustment
        // Visual mesh shifts X by +0.5 on odd global Z rows.
        // To map world X to grid index X, we must reverse this shift.
        // However, since we want to interpolate between vertices, we need to identify the triangle.
        
        // Simple Bilinear Interpolation on the grid square (ignoring exact triangle split for speed, or strict?)
        // Let's do strict triangle interpolation for smoothness.
        // Grid indices (0-31)
        const iz = Math.floor(lz);
        const globalZ = gz * 32 + iz;
        const isOddRow = Math.abs(globalZ) % 2 === 1;
        
        // The vertex grid is shifted. Let's adjust lx relative to the grid origin of this row.
        let gridLx = lx;
        if (isOddRow) gridLx -= 0.5;
        // Ensure within bounds for array lookup
        const ix = Math.floor(gridLx);
        
        // Fractional part for interpolation
        const fx = gridLx - ix;
        const fz = lz - iz;
        // Safety clamp using THREE.MathUtils.clamp (Fix: Math.clamp is not a function)
        if (ix < 0 || ix >= 32 || iz < 0 || iz >= 32) {
            // Edge cases: just return nearest vertex height to avoid crash
            const safeIx = THREE.MathUtils.clamp(Math.round(gridLx), 0, 32);
            const safeIdx = THREE.MathUtils.clamp(iz * 33 + safeIx, 0, heightMap.length - 1);
            return heightMap[safeIdx] || 0;
        }
        // 4. Get heights of the 4 surrounding vertices
        // Top-Left (x, z), Top-Right (x+1, z), Bottom-Left (x, z+1), Bottom-Right (x+1, z+1)
        // Note: Mesh is 33x33 vertices.
        // Row Z (iz)
        const idxTL = iz * 33 + ix;
        const idxTR = iz * 33 + (ix + 1);
        // Row Z+1 (iz+1)
        const idxBL = (iz + 1) * 33 + ix;
        const idxBR = (iz + 1) * 33 + (ix + 1);
        // Handle odd/even row staggering for the "Bottom" vertices
        // If current row is Odd, next row is Even. The visual mesh shifts rows independently.
        // Actually, our heightmap is a regular 33x33 grid. The "Shift" is purely visual X-offset applied in loadChunk.
        // But physically, the vertices at (ix, iz) and (ix, iz+1) are not vertically aligned in world space!
        // (ix, iz) is at X + 0.5, (ix, iz+1) is at X + 0.0.
        
        // Simply interpolating the heightmap values is correct for the logical grid, 
        // but since the world X is shifted, we must act as if we are sampling a skewed grid.
        
        // Let's simplify:
        // We have height values H(c, r).
        // World Pos of node (c, r) = (c * 1.0 + (r%2)*0.5, r * 1.0)
        // We have P(x, z). We want H.
        
        // Get the 3 closest vertices.
        // Because of the stagger, the grid forms equilateral-ish triangles.
        // Ideally we check which triangle P falls into.
        
        // For robustness and speed (and since the shift is just 0.5), 
        // a simple Bilinear Interpolation on the raw heightmap array (using unshifted coords) 
        // usually feels smooth enough, provided we subtract the 0.5 offset from X on odd rows before calculating ratios.
        // Let's stick to that for the "light calculation".
        const hTL = heightMap[idxTL] || 0;
        const hTR = heightMap[idxTR] || 0;
        const hBL = heightMap[idxBL] || 0;
        const hBR = heightMap[idxBR] || 0;
        // Bilinear Interpolation
        // H(x, z) = (1-x)(1-z)H00 + x(1-z)H10 + (1-x)zH01 + xzH11
        // Note: We need to be careful about the bottom row shift.
        // If row iz is odd (shifted +0.5), row iz+1 is even (shifted +0.0).
        // Our 'gridLx' was adjusted for row 'iz'.
        // For row 'iz+1', the relative X is different by 0.5.
        
        // Let's refine for "Staggered Grid":
        // It effectively behaves like a Hex grid.
        // But for a simple RPG walk, simple Bilinear on the *index space* is usually sufficient 
        // if we calculate 'fx' (fractional X) based on the "average" shift or ignore it?
        // No, ignoring it causes bumps.
        
        // Correct approach without complex triangle math:
        // Interpolate Top Edge X (using current row shift)
        const hTop = hTL * (1 - fx) + hTR * fx;
        
        // Interpolate Bottom Edge X (using next row shift)
        // Next row shift logic:
        const isNextRowOdd = Math.abs(globalZ + 1) % 2 === 1;
        let gridLxNext = lx;
        if (isNextRowOdd) gridLxNext -= 0.5;
        const ixNext = Math.floor(gridLxNext); // Might be different from ix!
        const fxNext = gridLxNext - ixNext;
        
        // Re-fetch bottom indices based on next row's proper X index
        const idxBL_Real = (iz + 1) * 33 + ixNext;
        const idxBR_Real = (iz + 1) * 33 + (ixNext + 1);
        const hBL_Real = heightMap[idxBL_Real] || 0;
        const hBR_Real = heightMap[idxBR_Real] || 0;
        
        const hBottom = hBL_Real * (1 - fxNext) + hBR_Real * fxNext;
        // Interpolate Z
        return hTop * (1 - fz) + hBottom * fz;
    }
    dispose() {
        console.log("[Terrain] Disposing TerrainManager...");
        for (const key in this.chunks) {
            const mesh = this.chunks[key];
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
        }
        this.chunks = {};
        this.chunkData = {};
        
        if (this.baseGround) {
            this.scene.remove(this.baseGround);
            if (this.baseGround.geometry) this.baseGround.geometry.dispose();
            if (this.baseGround.material) this.baseGround.material.dispose();
            this.baseGround = null;
        }
        if (this.material) this.material.dispose();
        console.log("[Terrain] Disposed.");
    }
}