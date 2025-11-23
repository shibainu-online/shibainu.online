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
        
        // 送信待ちメッセージキュー
        this.messageQueue = [];
        // ICE Candidate待ち行列
        this.candidateQueue = {};
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
            console.warn("[Network] Force Local Mode enabled.");
            this.setupBroadcastChannel();
            return;
        }
        
        const signalingAvailable = await this.checkSignalingServer();

        if (signalingAvailable) {
            console.log("[Network] Global Mode: Signaling server found. Starting WebRTC.");
            this.startSignalingLoop();
        } else {
            console.warn("[Network] Local Mode: Signaling server not found. Fallback to BroadcastChannel.");
            this.setupBroadcastChannel();
        }
    }
    
    cleanup() {
        this.isActive = false;

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
            // console.log("[Network] No active peers. Queuing message:", message);
            this.messageQueue.push(message);
            
            // 10秒後に自動消滅
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

    async checkSignalingServer() {
        if (this.signalingUrls.length === 0) return false;
        const url = this.signalingUrls[0];
        try {
            const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
            if (res.ok) {
                this.currentSignalingUrl = url;
                return true;
            }
        } catch (e) {
            console.log(`[Network] Signaling check failed for ${url}:`, e);
        }
        return false;
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
        const targetId = msg.sender;
        switch (msg.type) {
            case 'join':
                if (!this.peers[targetId]) {
                    console.log("[Network] Found peer (via CGI):", targetId);
                    this.connectToPeer(targetId, true); 
                }
                break;
            case 'offer':
                if (msg.target === this.myId) {
                    console.log("[Network] Received offer from:", targetId);
                    this.connectToPeer(targetId, false, msg.sdp);
                }
                break;
            case 'answer':
                if (msg.target === this.myId && this.peers[targetId]) {
                    console.log("[Network] Received answer from:", targetId);
                    await this.peers[targetId].setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    this.processCandidateQueue(targetId);
                }
                break;
            case 'candidate':
                if (msg.target === this.myId && this.peers[targetId]) {
                    const pc = this.peers[targetId];
                    // ★修正: addIceCandidateのエラーをキャッチしてキューに入れる (タイミング問題回避)
                    try {
                        if (pc.remoteDescription && pc.remoteDescription.type) {
                            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } else {
                            throw new Error("Remote description not ready");
                        }
                    } catch (e) {
                        // エラーならキューへ
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
            console.log(`[Network] Processed ${queue.length} queued candidates for ${peerId}`);
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
            this.processCandidateQueue(peerId); // Offerセット直後にもキュー処理を試みる

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal({ type: 'answer', target: peerId, sender: this.myId, sdp: answer });
        }
    }

    setupDataChannel(dc, peerId) {
        this.dataChannels[peerId] = dc;
        
        dc.onopen = () => {
            console.log(`[Network] P2P Connected to ${peerId}!`);
            
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