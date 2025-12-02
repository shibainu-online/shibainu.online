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
        
        // NEW: Registry URL
        this.registryUrl = "https://close-creation.ganjy.net/matching/turn_registry.php";

        this.currentSignalingUrl = null;
        this.lastMsgTime = 0;

        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        this.forceLocal = false;
        this.pollTimer = null;
        this.isActive = false;
        this.messageQueue = [];
        this.candidateQueue = {};

        this.retryCount = 0;
        this.maxRetries = 20;
        
        this.activeRequests = {};
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

        // ★追加: 接続前にレジストリからTURNリストを取得
        this.fetchPublicTurnServers().then(() => {
            this.connect();
        });
    }

    async fetchPublicTurnServers() {
        if (this.forceLocal) return;
        try {
            console.log("[Network] Checking Public TURN Registry...");
            const res = await fetch(this.registryUrl);
            if (res.ok) {
                const servers = await res.json();
                if (Array.isArray(servers) && servers.length > 0) {
                    console.log(`[Network] Found ${servers.length} public TURN servers!`);
                    // 既存のSTUN設定に、取得したTURN設定をマージする
                    this.rtcConfig.iceServers = [
                        ...this.rtcConfig.iceServers.filter(s => !s.urls.toString().startsWith('turn:')), // 重複防止で既存TURN削除
                        ...servers
                    ];
                } else {
                    console.log("[Network] No public TURN servers active.");
                }
            }
        } catch (e) {
            console.warn("[Network] Registry check failed:", e);
        }
    }

    setTurnUrl(url) {
        if (!url) return;
        console.log(`[Network] Overwriting TURN URL to: ${url}`);
        
        const newIceServers = this.rtcConfig.iceServers.filter(server => {
            if (typeof server.urls === 'string') return !server.urls.startsWith('turn:');
            if (Array.isArray(server.urls)) return !server.urls.some(u => u.startsWith('turn:'));
            return true;
        });

        newIceServers.push({
            urls: url,
            username: 'shibainu',
            credential: 'bridge'
        });

        this.rtcConfig.iceServers = newIceServers;

        if (this.isActive) {
            console.log("[Network] Reconnecting with new TURN settings...");
            this.connect();
        }
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
            if (window.assetManager) {
                const meta = await window.assetManager.getAssetMetadata(hash);
                if (meta) {
                    this.broadcast(`CMD_ASSET_MANIFEST_RESP:${hash}:${meta.chunkCount}`);
                }
            }
        }
        else if (cmd === "CMD_ASSET_MANIFEST_RESP") {
            const count = parseInt(parts[2]);
            if (!window.assetManager) return;
            const hasIt = await window.assetManager.hasAsset(hash);
            if (!hasIt) {
                this.startDownloadingChunks(hash, count);
            }
        }
        else if (cmd === "CMD_ASSET_REQ_CHUNK") {
            const index = parseInt(parts[2]);
            if (window.assetManager) {
                const chunkData = await window.assetManager.getChunk(hash, index);
                if (chunkData) {
                    this.broadcast(`CMD_ASSET_CHUNK_DATA:${hash}:${index}:${parts[3]}:${chunkData}`);
                }
            }
        }
        else if (cmd === "CMD_ASSET_CHUNK_DATA") {
            const index = parseInt(parts[2]);
            const total = parseInt(parts[3]);
            const data = parts[4];
            if (window.assetManager) {
                window.assetManager.receiveChunk(hash, index, total, data);
            }
        }
    }

    startDownloadingChunks(hash, count) {
        const indices = Array.from({length: count}, (_, i) => i);
        indices.sort(() => Math.random() - 0.5);
        indices.forEach((index, i) => {
            setTimeout(() => {
                this.broadcast(`CMD_ASSET_REQ_CHUNK:${hash}:${index}:${count}`);
            }, i * 50);
        });
    }
}