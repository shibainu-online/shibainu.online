export class NetworkManager {
    constructor() {
        this.dotNetRef = null;
        this.myId = crypto.randomUUID();
        
        this.peers = {}; 
        this.dataChannels = {};
        this.broadcastChannel = null;

        // シグナリングサーバーリスト
        this.signalingUrls = [
            "https://close-creation.ganjy.net/matching/signaling.php"
        ];
        
        this.currentSignalingUrl = null;
        this.lastMsgTime = 0;
        
        this.rtcConfig = {
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        };

        this.forceLocal = false;
        this.pollTimer = null;
        
        this.isActive = false;
        
        this.messageQueue = [];
        this.candidateQueue = {};
        
        // リトライ用
        this.retryCount = 0;
        this.maxRetries = 20; // 20回試行 (約40秒)
    }

    init(dotNetRef) {
        this.dotNetRef = dotNetRef;
        console.log("[Network] Initialized (Ref updated). My PeerID:", this.myId);
        
        // 既に稼働中なら再接続しない
        if (!this.isActive) {
            this.connect();
        } else {
            console.log("[Network] Already active, skipping reconnection.");
        }
    }
    
    async connect() {
        this.cleanup();
        this.isActive = true; 

        if (this.forceLocal) {
            console.warn("[Network] Force Local Mode enabled via UI.");
            this.setupBroadcastChannel();
            return;
        }
        
        console.log("[Network] Attempting to connect to signaling server...");
        const signalingUrl = await this.findSignalingServerWithRetry();

        if (signalingUrl) {
            this.currentSignalingUrl = signalingUrl;
            console.log("[Network] Global Mode: Connected to", signalingUrl);
            this.startSignalingLoop();
        } else {
            console.warn("[Network] Connection Failed after retries. Fallback to BroadcastChannel (Local Mode).");
            this.setupBroadcastChannel();
        }
    }
    
    // リトライ付きでサーバーを探す
    async findSignalingServerWithRetry() {
        this.retryCount = 0;
        
        while (this.retryCount < this.maxRetries && this.isActive) {
            // UIで強制ローカルに切り替えられたら中断
            if (this.forceLocal) return null;

            const url = this.signalingUrls[this.retryCount % this.signalingUrls.length];
            console.log(`[Network] Connecting to ${url} (Attempt ${this.retryCount + 1}/${this.maxRetries})...`);
            
            try {
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort(), 2000); // 2秒タイムアウト
                
                const res = await fetch(url, { method: 'GET', signal: controller.signal });
                clearTimeout(id);
                
                if (res.ok) {
                    return url; // 成功したらそのURLを返す
                }
            } catch (e) {
                // タイムアウトやエラーは無視して次へ
            }
            
            this.retryCount++;
            // 少し待ってから次へ
            await new Promise(r => setTimeout(r, 200));
        }
        return null;
    }
    
    cleanup() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.broadcastChannel) {
            this.broadcastChannel.close();
            this.broadcastChannel = null;
        }
        
        for (const id in this.peers) {
            this.peers[id].close();
        }
        this.peers = {};
        this.dataChannels = {};
        this.messageQueue = [];
        this.candidateQueue = {};
    }

    addSignalingUrl(url) {
        if (url && !this.signalingUrls.includes(url)) {
            this.signalingUrls.unshift(url);
            console.log("[Network] Added signaling URL:", url);
        }
    }
    
    setForceLocal(enabled) {
        this.forceLocal = enabled;
    }

    onDataReceived(data) {
        if (this.dotNetRef) {
            this.dotNetRef.invokeMethodAsync('OnMessageReceived', data);
        }
    }

    broadcast(message) {
        const peerIds = Object.keys(this.dataChannels);
        let sentCount = 0;

        // WebRTC
        if (peerIds.length > 0) {
            peerIds.forEach(id => {
                const dc = this.dataChannels[id];
                if (dc.readyState === 'open') {
                    dc.send(message);
                    sentCount++;
                }
            });
        }
        // Local
        else if (this.broadcastChannel) {
            this.broadcastChannel.postMessage(message);
            sentCount++;
        }

        // 誰も送る相手がいない場合はキューに保存
        if (sentCount === 0) {
            this.messageQueue.push(message);
            setTimeout(() => {
                const idx = this.messageQueue.indexOf(message);
                if (idx > -1) this.messageQueue.splice(idx, 1);
            }, 10000);
        }
    }

    setupBroadcastChannel() {
        this.broadcastChannel = new BroadcastChannel('game_mesh_network');
        this.broadcastChannel.onmessage = (e) => {
            this.onDataReceived(e.data);
        };
        console.log("[Network] BroadcastChannel is ready.");
    }

    async startSignalingLoop() {
        if (!this.currentSignalingUrl) return;
        this.pollTimer = setInterval(() => this.pollSignalingServer(), 2000);
        this.sendSignal({ type: 'join', sender: this.myId });
    }

    async pollSignalingServer() {
        if (!this.currentSignalingUrl) return;
        try {
            const res = await fetch(`${this.currentSignalingUrl}?room=chromamesia_global`);
            if (!res.ok) return;
            const messages = await res.json();
            messages.forEach(msg => {
                if (msg.time > this.lastMsgTime && msg.sender !== this.myId) {
                    this.handleSignal(msg);
                }
            });
            if (messages.length > 0) {
                this.lastMsgTime = Math.max(...messages.map(m => m.time));
            }
        } catch (e) {}
    }

    async sendSignal(data) {
        if (!this.currentSignalingUrl) return;
        try {
            await fetch(`${this.currentSignalingUrl}?room=chromamesia_global`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (e) {}
    }

    async handleSignal(msg) {
        if (msg.sender === this.myId) return;
        const targetId = msg.sender;
        
        switch (msg.type) {
            case 'join':
                if (!this.peers[targetId]) {
                    // ★修正: 通信の衝突(Glare)を防ぐため、IDが小さい方だけが発信するルールにする
                    if (this.myId < targetId) {
                        console.log(`[Network] Found peer ${targetId}. Initiating connection (MyID < TargetID).`);
                        this.connectToPeer(targetId, true); 
                    } else {
                        // ★追加: IDが大きい場合、相手(小さい方)は自分の古いJoinを見ていない可能性がある
                        // そのため、もう一度Joinを送って存在をアピールする
                        console.log(`[Network] Found peer ${targetId}. Waiting for Offer (MyID > TargetID). Re-sending Join.`);
                        this.sendSignal({ type: 'join', sender: this.myId });
                    }
                }
                break;
            case 'offer':
                if (msg.target === this.myId) {
                    console.log("[Network] Received offer from:", targetId);
                    // Offerが来たら（自分がInitiatorかどうかに関わらず）受ける
                    this.connectToPeer(targetId, false, msg.sdp);
                }
                break;
            case 'answer':
                if (msg.target === this.myId && this.peers[targetId]) {
                    console.log("[Network] Received answer from:", targetId);
                    try {
                        await this.peers[targetId].setRemoteDescription(new RTCSessionDescription(msg.sdp));
                        this.processCandidateQueue(targetId);
                    } catch (e) { console.error("SetRemoteDesc Error:", e); }
                }
                break;
            case 'candidate':
                if (msg.target === this.myId && this.peers[targetId]) {
                    const pc = this.peers[targetId];
                    try {
                        if (pc.remoteDescription && pc.remoteDescription.type) {
                            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } else {
                            throw new Error("Remote description not ready");
                        }
                    } catch (e) {
                        if (!this.candidateQueue[targetId]) this.candidateQueue[targetId] = [];
                        this.candidateQueue[targetId].push(msg.candidate);
                    }
                }
                break;
        }
    }

    async processCandidateQueue(peerId) {
        const pc = this.peers[peerId];
        const queue = this.candidateQueue[peerId];
        if (pc && queue) {
            for (const candidate of queue) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                } catch(e) {}
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
            pc.ondatachannel = (e) => {
                this.setupDataChannel(e.channel, peerId);
            };
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.sendSignal({ type: 'candidate', target: peerId, sender: this.myId, candidate: e.candidate });
            }
        };

        if (isInitiator) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.sendSignal({ type: 'offer', target: peerId, sender: this.myId, sdp: offer });
        } else {
            await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
            this.processCandidateQueue(peerId);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal({ type: 'answer', target: peerId, sender: this.myId, sdp: answer });
        }
    }

    setupDataChannel(dc, peerId) {
        this.dataChannels[peerId] = dc;
        
        dc.onopen = () => {
            console.log(`[Network] P2P Connected to ${peerId}! (DataChannel Open)`);
            if (this.messageQueue.length > 0) {
                console.log(`[Network] Sending ${this.messageQueue.length} queued messages to ${peerId}`);
                this.messageQueue.forEach(msg => dc.send(msg));
            }
        };

        dc.onmessage = (e) => this.onDataReceived(e.data);
        dc.onclose = () => {
            console.log(`[Network] Disconnected from ${peerId}`);
            delete this.peers[peerId];
            delete this.dataChannels[peerId];
        };
    }
    
    async verifyMasterKey(privateKeyBase64, publicKeyBase64) {
        return true; 
    }
}