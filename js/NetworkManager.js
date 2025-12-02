export class NetworkManager {
    constructor() {
        this.dotNetRef = null;
        this.myId = crypto.randomUUID();
        this.networkId = "Shibainu"; 

        this.peers = {};
        this.dataChannels = {};
        this.broadcastChannel = null;

        this.signalingUrls = [
            "https://close-creation.ganjy.net/matching/signaling.php"
        ];

        this.currentSignalingUrl = null;
        this.lastMsgTime = 0;

        // ★修正: ローカルブリッジ (ShibainuBridge.exe) への接続設定を追加
        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                // ブリッジアプリ用設定 (TURN over TCP)
                // 認証情報はダミーですが、ブラウザの仕様上必須です
                { urls: 'turn:127.0.0.1:443?transport=tcp', username: 'shibainu', credential: 'bridge' }
            ]
        };

        this.forceLocal = false;
        this.pollTimer = null;
        this.isActive = false;
        this.messageQueue = [];
        this.candidateQueue = {};

        this.retryCount = 0;
        this.maxRetries = 20;
        
        // --- Swarm State ---
        this.activeRequests = {}; // { hash: { timestamp, chunks: [] } }
    }

    init(dotNetRef, networkId, config) {
        this.dotNetRef = dotNetRef;
        
        let networkChanged = false;
        if (networkId && this.networkId !== networkId) {
            this.networkId = networkId;
            networkChanged = true;
        }
        
        if (config && config.signalingUrls) {
            this.signalingUrls = config.signalingUrls;
        }
        
        console.log(`[Network] Initialized. ID: ${this.myId}, Network: ${this.networkId}`);

        if (this.isActive || networkChanged) {
            console.log("[Network] Resetting connection for new configuration...");
            this.cleanup();
            this.isActive = false;
        }

        this.connect();
    }

    async connect() {
        this.cleanup();
        this.isActive = true;

        if (this.forceLocal) {
            console.warn("[Network] Force Local Mode enabled.");
            this.setupBroadcastChannel();
            return;
        }

        console.log(`[Network] Connecting to ${this.networkId} network...`);
        const signalingUrl = await this.findSignalingServerWithRetry();

        if (signalingUrl) {
            this.currentSignalingUrl = signalingUrl;
            console.log("[Network] Signaling Server Connected:", signalingUrl);
            this.startSignalingLoop();
        } else {
            console.warn("[Network] Connection Failed. Fallback to Local Mode.");
            this.setupBroadcastChannel();
        }
    }

    async findSignalingServerWithRetry() {
        this.retryCount = 0;
        while (this.retryCount < this.maxRetries && this.isActive) {
            if (this.forceLocal) return null;

            const url = this.signalingUrls[this.retryCount % this.signalingUrls.length];
            try {
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort(), 3000);
                const res = await fetch(`${url}?room=ping`, { method: 'GET', signal: controller.signal });
                clearTimeout(id);
                if (res.ok) return url;
            } catch (e) { }

            this.retryCount++;
            await new Promise(r => setTimeout(r, 500));
        }
        return null;
    }

    cleanup() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.broadcastChannel) { this.broadcastChannel.close(); this.broadcastChannel = null; }
        for (const id in this.peers) { this.peers[id].close(); }
        this.peers = {};
        this.dataChannels = {};
    }

    addSignalingUrl(url) {
        if (url && !this.signalingUrls.includes(url)) {
            this.signalingUrls.unshift(url);
            if (this.isActive) this.connect();
        }
    }

    setForceLocal(enabled) { this.forceLocal = enabled; }

    onDataReceived(data) {
        // ★重要: アセット転送パケットのインターセプト
        // C#には渡さず、ここで処理して負荷を下げる
        if (data.startsWith("CMD_ASSET_")) {
            this.handleAssetMessage(data);
            return;
        }

        if (this.dotNetRef) {
            this.dotNetRef.invokeMethodAsync('OnMessageReceived', data);
        }
    }

    broadcast(message) {
        const peerIds = Object.keys(this.dataChannels);
        let sentCount = 0;

        if (peerIds.length > 0) {
            peerIds.forEach(id => {
                const dc = this.dataChannels[id];
                if (dc.readyState === 'open') {
                    dc.send(message);
                    sentCount++;
                }
            });
        }
        else if (this.broadcastChannel) {
            this.broadcastChannel.postMessage(message);
            sentCount++;
        }
        else if (this.currentSignalingUrl) {
            this.sendSignal({ type: 'broadcast', sender: this.myId, content: message, networkId: this.networkId });
            sentCount++;
        }

        if (sentCount === 0 && !this.currentSignalingUrl) {
            this.messageQueue.push(message);
        }
    }

    setupBroadcastChannel() {
        this.broadcastChannel = new BroadcastChannel(`game_mesh_${this.networkId}`);
        this.broadcastChannel.onmessage = (e) => this.onDataReceived(e.data);
    }

    async startSignalingLoop() {
        if (!this.currentSignalingUrl) return;
        this.pollTimer = setInterval(() => this.pollSignalingServer(), 2000);
        this.sendSignal({ type: 'join', sender: this.myId, networkId: this.networkId });
    }

    getRoomName() {
        return `chromamesia_${this.networkId}`;
    }

    async pollSignalingServer() {
        if (!this.currentSignalingUrl) return;
        try {
            const room = this.getRoomName();
            const res = await fetch(`${this.currentSignalingUrl}?room=${room}&_=${Date.now()}`);
            if (!res.ok) return;
            const messages = await res.json();

            if (!Array.isArray(messages)) return;

            messages.forEach(msg => {
                if (msg.time > this.lastMsgTime && msg.sender !== this.myId) {
                    if (!msg.networkId || msg.networkId === this.networkId) {
                        this.handleSignal(msg);
                    }
                }
            });
            if (messages.length > 0) {
                this.lastMsgTime = Math.max(...messages.map(m => m.time));
            }
        } catch (e) { }
    }

    async sendSignal(data) {
        if (!this.currentSignalingUrl) return;
        try {
            data.time = Date.now() / 1000.0;
            data.networkId = this.networkId; 
            const room = this.getRoomName();
            
            await fetch(`${this.currentSignalingUrl}?room=${room}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (e) { }
    }

    async handleSignal(msg) {
        if (msg.sender === this.myId) return;
        const targetId = msg.sender;

        switch (msg.type) {
            case 'broadcast':
                if (msg.content) this.onDataReceived(msg.content);
                break;
            case 'join':
                if (!this.peers[targetId]) {
                    if (this.myId < targetId) this.connectToPeer(targetId, true);
                    else this.sendSignal({ type: 'join', sender: this.myId, networkId: this.networkId });
                }
                break;
            case 'offer':
                if (msg.target === this.myId) this.connectToPeer(targetId, false, msg.sdp);
                break;
            case 'answer':
                if (msg.target === this.myId && this.peers[targetId]) {
                    try {
                        await this.peers[targetId].setRemoteDescription(new RTCSessionDescription(msg.sdp));
                        this.processCandidateQueue(targetId);
                    } catch (e) { }
                }
                break;
            case 'candidate':
                if (msg.target === this.myId && this.peers[targetId]) {
                    const pc = this.peers[targetId];
                    try {
                        if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        else {
                            if (!this.candidateQueue[targetId]) this.candidateQueue[targetId] = [];
                            this.candidateQueue[targetId].push(msg.candidate);
                        }
                    } catch (e) { }
                }
                break;
        }
    }

    async processCandidateQueue(peerId) {
        const pc = this.peers[peerId];
        const queue = this.candidateQueue[peerId];
        if (pc && queue) {
            for (const candidate of queue) {
                try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { }
            }
            delete this.candidateQueue[peerId];
        }
    }

    async connectToPeer(peerId, isInitiator, offerSdp = null) {
        if (this.peers[peerId]) return;
        const pc = new RTCPeerConnection(this.rtcConfig);
        this.peers[peerId] = pc;

        if (isInitiator) {
            const dc = pc.createDataChannel("game_data");
            this.setupDataChannel(dc, peerId);
        } else {
            pc.ondatachannel = (e) => this.setupDataChannel(e.channel, peerId);
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) this.sendSignal({ type: 'candidate', target: peerId, sender: this.myId, candidate: e.candidate, networkId: this.networkId });
        };

        if (isInitiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.sendSignal({ type: 'offer', target: peerId, sender: this.myId, sdp: offer, networkId: this.networkId });
        } else {
            await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
            this.processCandidateQueue(peerId);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal({ type: 'answer', target: peerId, sender: this.myId, sdp: answer, networkId: this.networkId });
        }
    }

    setupDataChannel(dc, peerId) {
        this.dataChannels[peerId] = dc;
        dc.onopen = () => {
            console.log(`[Network] Direct P2P to ${peerId} OK (${this.networkId}).`);
            this.messageQueue.forEach(msg => dc.send(msg));
            this.messageQueue = [];
        };
        dc.onmessage = (e) => this.onDataReceived(e.data);
        dc.onclose = () => {
            delete this.peers[peerId];
            delete this.dataChannels[peerId];
        };
    }

    // --- P2P Asset Swarm Implementation ---

    requestAsset(hash) {
        if (!window.assetManager) return;
        
        // 重複リクエスト防止（タイムアウト5秒）
        if (this.activeRequests[hash] && (Date.now() - this.activeRequests[hash].timestamp < 5000)) return;
        
        this.activeRequests[hash] = { timestamp: Date.now() };
        console.log(`[Swarm] Broadcasting Manifest Request for: ${hash.substr(0,8)}...`);
        this.broadcast(`CMD_ASSET_REQ_MANIFEST:${hash}`);
    }

    async handleAssetMessage(msg) {
        const parts = msg.split(':');
        const cmd = parts[0];
        const hash = parts[1];

        if (cmd === "CMD_ASSET_REQ_MANIFEST") {
            // 他の人がマニフェスト（ファイル情報）を求めている
            // 自分が持っていれば教えてあげる
            if (window.assetManager) {
                const meta = await window.assetManager.getAssetMetadata(hash);
                if (meta) {
                    // console.log(`[Swarm] Serving Manifest for ${hash.substr(0,8)}...`);
                    this.broadcast(`CMD_ASSET_MANIFEST_RESP:${hash}:${meta.chunkCount}`);
                }
            }
        }
        else if (cmd === "CMD_ASSET_MANIFEST_RESP") {
            // マニフェスト情報が届いた
            // まだ持っていないなら、ダウンロードを開始する
            const count = parseInt(parts[2]);
            if (!window.assetManager) return;

            const hasIt = await window.assetManager.hasAsset(hash);
            if (!hasIt) {
                // ダウンロード開始（ランダムなピアにチャンクを要求）
                // 本来は持っているピアを管理すべきだが、簡易実装としてブロードキャストで要求する
                // console.log(`[Swarm] Starting download for ${hash} (${count} chunks)`);
                this.startDownloadingChunks(hash, count);
            }
        }
        else if (cmd === "CMD_ASSET_REQ_CHUNK") {
            // チャンクデータを要求された
            const index = parseInt(parts[2]);
            if (window.assetManager) {
                const chunkData = await window.assetManager.getChunk(hash, index);
                if (chunkData) {
                    // console.log(`[Swarm] Serving Chunk ${index} of ${hash.substr(0,8)}...`);
                    this.broadcast(`CMD_ASSET_CHUNK_DATA:${hash}:${index}:${parts[3]}:${chunkData}`); // parts[3] is total count
                }
            }
        }
        else if (cmd === "CMD_ASSET_CHUNK_DATA") {
            // チャンクデータが届いた
            const index = parseInt(parts[2]);
            const total = parseInt(parts[3]);
            const data = parts[4]; // Base64 data
            
            if (window.assetManager) {
                window.assetManager.receiveChunk(hash, index, total, data);
            }
        }
    }

    startDownloadingChunks(hash, count) {
        // 並列ダウンロード
        // 負荷分散のため、ランダムな順序で要求を投げる（簡易実装）
        // タイミングをずらしてブロードキャストする
        
        const indices = Array.from({length: count}, (_, i) => i);
        // シャッフル
        indices.sort(() => Math.random() - 0.5);

        indices.forEach((index, i) => {
            setTimeout(() => {
                // console.log(`[Swarm] Requesting chunk ${index}/${count}`);
                this.broadcast(`CMD_ASSET_REQ_CHUNK:${hash}:${index}:${count}`);
            }, i * 50); // 50ms間隔でリクエスト発射
        });
    }
}