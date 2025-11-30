import * as THREE from 'three';

export class TerrainManager {
    constructor(scene, gridSize) {
        this.scene = scene;
        this.gridSize = gridSize || 32;
        this.chunks = {}; 
        this.chunkData = {}; // 高さデータのキャッシュ
        
        // ★修正: ゼブラ影（Shadow Acne）対策のためフラットシェーディングを有効化
        this.material = new THREE.MeshStandardMaterial({ 
            color: 0x55aa55, 
            flatShading: true, 
            roughness: 0.8,
            metalness: 0.1,
            side: THREE.DoubleSide // 裏面も念のため描画
        });

        this.createBaseGround();
    }

    createBaseGround() {
        const planeGeometry = new THREE.PlaneGeometry(2000, 2000);
        const planeMaterial = new THREE.MeshStandardMaterial({ 
            color: 0x55aa55,
            roughness: 0.9,
            metalness: 0.1 
        });
        this.baseGround = new THREE.Mesh(planeGeometry, planeMaterial);
        this.baseGround.rotation.x = -Math.PI / 2;
        this.baseGround.position.y = -0.1;
        this.baseGround.receiveShadow = true;
        this.scene.add(this.baseGround);

        // グリッドヘルパー（開発用）
        // const gridHelper = new THREE.GridHelper(2000, 200);
        // gridHelper.position.y = -0.05;
        // this.scene.add(gridHelper);
    }

    loadChunk(gx, gz, heightMap) {
        // チャンクがロードされたら初期平面を隠す
        if (this.baseGround && this.baseGround.visible) {
            this.baseGround.visible = false;
        }

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
        
        // ★修正: スタッガード・グリッド（ダイヤ型配置）の形成
        // 頂点を走査し、Z行が奇数の場合にX座標を0.5ずらす
        for (let i = 0; i < positions.length / 3; i++) {
            // i番目の頂点
            // positions[i*3]   = x
            // positions[i*3+1] = y (高さ)
            // positions[i*3+2] = z

            // オリジナルのローカル座標を取得
            // PlaneGeometryは中心(0,0)から生成されるため、左上が(-16, -16)のような値になる
            const z = positions[i * 3 + 2];
            
            // グローバルな行インデックスに換算（0.5ズレの判定用）
            // ローカルZ座標を整数インデックス化
            const localRow = Math.round(z + this.gridSize / 2);
            // チャンク位置も考慮した絶対的な行番号
            const globalRow = gz * segments + localRow;

            // 行番号が奇数ならXを0.5ずらす
            if (Math.abs(globalRow) % 2 === 1) {
                positions[i * 3] += 0.5;
            }

            // 高さの適用
            if (heightMap && i < heightMap.length) {
                if (heightMap[i] !== undefined) {
                    positions[i * 3 + 1] = heightMap[i];
                }
            }
        }
        
        // 頂点を動かしたので法線を再計算（ライティング用）
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(geometry, this.material);
        // 座標補正: 中心位置へ移動
        mesh.position.set(gx * this.gridSize + 16, 0, gz * this.gridSize + 16);
        
        mesh.castShadow = false; // 地形自体は影を落とさない方がパフォーマンスが良い（必要ならtrueへ）
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
    }

    getMeshes() {
        const chunks = Object.values(this.chunks);
        if (chunks.length > 0) return chunks;
        return [this.baseGround];
    }

    getHeightAt(x, z) {
        // Raycastによる高さ取得
        // GameEngine等のロジックから呼ばれる
        const raycaster = new THREE.Raycaster();
        raycaster.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
        
        const meshes = this.getMeshes();
        const intersects = raycaster.intersectObjects(meshes);
        
        if (intersects.length > 0) {
            return intersects[0].point.y;
        }
        return 0; 
    }
}