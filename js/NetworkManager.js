export class NetworkManager {
    constructor() {
        this.dotNetRef = null;
        this.myId = crypto.randomUUID();
        
        // WebRTC用
        this.peers = {}; 
        this.dataChannels = {};
        
        // ローカル用
        this.broadcastChannel = null;

        // シグナリングサーバーリスト (初期値)
        // ★修正: 指定のCGIをデフォルトで登録
        this.signalingUrls = [
            "https://close-creation.ganjy.net/matching/signaling.php"
        ];
        
        this.currentSignalingUrl = null;
        this.lastMsgTime = 0;
        
        this.rtcConfig = {
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        };

        // 強制ローカルモードフラグ
        this.forceLocal = false;
        
        // ポーリング用タイマーID
        this.pollTimer = null;
    }

    init(dotNetRef) {
        this.dotNetRef = dotNetRef;
        console.log("[Network] Initialized. My PeerID:", this.myId);
        this.connect();
    }
    
    // 接続処理 (再接続可能)
    async connect() {
        // 既存の接続をお掃除
        this.cleanup();

        // 強制ローカルモードなら即BroadcastChannel
        if (this.forceLocal) {
            console.warn("[Network] Force Local Mode enabled.");
            this.setupBroadcastChannel();
            return;
        }
        
        // シグナリングサーバー確認
        const signalingAvailable = await this.checkSignalingServer();

        if (signalingAvailable) {
            console.log("[Network] Global Mode: Signaling server found. Starting WebRTC.");
            this.startSignalingLoop();
        } else {
            console.warn("[Network] Local Mode: Signaling server not found. Fallback to BroadcastChannel.");
            this.setupBroadcastChannel();
        }
    }
    
    // お掃除
    cleanup() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.broadcastChannel) {
            this.broadcastChannel.close();
            this.broadcastChannel = null;
        }
        
        // 既存のピア切断
        for (const id in this.peers) {
            this.peers[id].close();
        }
        this.peers = {};
        this.dataChannels = {};
    }

    // URL追加
    addSignalingUrl(url) {
        if (url && !this.signalingUrls.includes(url)) {
            // 優先度高くするため先頭に追加
            this.signalingUrls.unshift(url);
            console.log("[Network] Added signaling URL:", url);
        }
    }
    
    // モード設定
    setForceLocal(enabled) {
        this.forceLocal = enabled;
    }

    // ------------------------------------------------------------

    onDataReceived(data) {
        if (this.dotNetRef) {
            this.dotNetRef.invokeMethodAsync('OnMessageReceived', data);
        }
    }

    broadcast(message) {
        // WebRTCのピアがいればそちらへ
        const peerIds = Object.keys(this.dataChannels);
        if (peerIds.length > 0) {
            peerIds.forEach(id => {
                const dc = this.dataChannels[id];
                if (dc.readyState === 'open') {
                    dc.send(message);
                }
            });
        }
        // フォールバック: BroadcastChannelが有効ならそちらへ
        else if (this.broadcastChannel) {
            this.broadcastChannel.postMessage(message);
        }
    }

    // ============================================================
    //  Local Mode (BroadcastChannel)
    // ============================================================
    setupBroadcastChannel() {
        this.broadcastChannel = new BroadcastChannel('game_mesh_network');
        this.broadcastChannel.onmessage = (e) => {
            this.onDataReceived(e.data);
        };
        console.log("[Network] BroadcastChannel is ready.");
    }

    // ============================================================
    //  Global Mode (WebRTC + CGI Signaling)
    // ============================================================
    async checkSignalingServer() {
        if (this.signalingUrls.length === 0) return false;

        // 先頭のURLを試す
        const url = this.signalingUrls[0];
        try {
            // 疎通確認
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
        
        // 定期ポーリング開始
        this.pollTimer = setInterval(() => this.pollSignalingServer(), 2000);
        
        // 参加表明
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
                }
                break;

            case 'candidate':
                if (msg.target === this.myId && this.peers[targetId]) {
                    await this.peers[targetId].addIceCandidate(new RTCIceCandidate(msg.candidate));
                }
                break;
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
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal({ type: 'answer', target: peerId, sender: this.myId, sdp: answer });
        }
    }

    setupDataChannel(dc, peerId) {
        this.dataChannels[peerId] = dc;
        dc.onopen = () => console.log(`[Network] P2P Connected to ${peerId}!`);
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