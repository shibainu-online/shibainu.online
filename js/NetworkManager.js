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

        this.rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        };

        this.forceLocal = false;
        this.pollTimer = null;
        this.isActive = false;
        this.messageQueue = [];
        this.candidateQueue = {};

        this.retryCount = 0;
        this.maxRetries = 20;
    }

    init(dotNetRef, networkId) {
        this.dotNetRef = dotNetRef;
        
        let networkChanged = false;
        if (networkId && this.networkId !== networkId) {
            this.networkId = networkId;
            networkChanged = true;
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
}