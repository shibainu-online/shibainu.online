export class InteropBridge {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.setupExports();
        this.setupCryptoInterop();
        this.setupClipboardInterop();
    }

    setupExports() {
        // Network Initialization
        window.initNetwork = (ref) => {
            if (this.gameEngine.networkManager) this.gameEngine.networkManager.init(ref);
        };

        // Game Start
        window.StartGame = (logicRef, id, name, x, y, z, speed, colorHex, isVisible) => {
            this.gameEngine.startGame(logicRef, id, name, x, y, z, speed, colorHex, isVisible);
        };

        // Network Config
        window.NetworkInterop = {
            addSignalingUrl: (url) => { if (this.gameEngine.networkManager) this.gameEngine.networkManager.addSignalingUrl(url); },
            setForceLocal: (enabled) => { if (this.gameEngine.networkManager) this.gameEngine.networkManager.setForceLocal(enabled); },
            restart: () => { if (this.gameEngine.networkManager) this.gameEngine.networkManager.connect(); }
        };

        // P2P Messaging
        window.broadcastMessage = (m) => {
            if (this.gameEngine.networkManager) this.gameEngine.networkManager.broadcast(m);
        };

        // Terrain
        window.TerrainInterop = {
            loadChunk: (gx, gz, heightMap) => {
                if (this.gameEngine.terrainManager) this.gameEngine.terrainManager.loadChunk(gx, gz, heightMap);
            }
        };

        // Visual Entities
        window.VisualEntityInterop = {
            updateEntity: (id, x, y, z, colorHex, name, type, rot, isVisible, moveSpeed) => {
                if (id === this.gameEngine.localPlayerId) return;
                if (this.gameEngine.visualEntityManager) {
                    this.gameEngine.visualEntityManager.updateEntity(id, x, y, z, colorHex, name, type, rot, isVisible, moveSpeed);
                }
            },
            removeEntity: (id) => {
                if (this.gameEngine.visualEntityManager) this.gameEngine.visualEntityManager.removeEntity(id);
            }
        };

        // Player & Camera Control
        window.SyncLocalPosition = (x, y, z) => this.gameEngine.syncLocalPosition(x, y, z);
        window.renderBox = (hex) => this.gameEngine.renderBox(hex);
        window.SetPlayerSpeed = (speed) => this.gameEngine.setPlayerSpeed(speed);
        window.WarpLocalPlayer = (x, y, z) => this.gameEngine.warpLocalPlayer(x, y, z);
        
        // Placement Mode
        window.StartPlacementMode = (id) => this.gameEngine.startPlacementMode(id);
        window.EndPlacementMode = () => this.gameEngine.endPlacementMode();

        // UI / Tools
        window.ToggleMinimap = () => {
            if (this.gameEngine.minimapManager) return this.gameEngine.minimapManager.toggle();
            return false;
        };
        window.ToggleNamePlates = () => {
            if (!this.gameEngine.visualEntityManager) return;
            return this.gameEngine.visualEntityManager.toggleNamePlates();
        };

        // Legacy / Fallback
        window.UpdateRemotePlayer = (id, x, y, z, colorHex) => {
            if (this.gameEngine.visualEntityManager) 
                this.gameEngine.visualEntityManager.updateEntity(id, x, y, z, colorHex, id, "Player");
        };
    }

    setupCryptoInterop() {
        window.CryptoInterop = {
            // RSA Key Generation
            generateKeys: async () => {
                const keyPair = await window.crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
                const priv = await window.crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
                const pub = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
                return { privateKey: this.toPem(priv, "PRIVATE KEY"), publicKey: this.toPem(pub, "PUBLIC KEY") };
            },
            // RSA Public Key Import
            getPublicKeyFromPrivate: async (privPem) => {
                try {
                    const privBuf = this.pemToBuffer(privPem);
                    const key = await window.crypto.subtle.importKey("pkcs8", privBuf, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
                    const jwk = await window.crypto.subtle.exportKey("jwk", key);
                    delete jwk.d; delete jwk.p; delete jwk.q; delete jwk.dp; delete jwk.dq; delete jwk.qi; jwk.key_ops = ["verify"];
                    const pubKey = await window.crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
                    const pubBuf = await window.crypto.subtle.exportKey("spki", pubKey);
                    return this.toPem(pubBuf, "PUBLIC KEY");
                } catch (e) { return ""; }
            },
            // RSA Sign
            signData: async (data, privPem) => {
                try {
                    const privBuf = this.pemToBuffer(privPem);
                    const key = await window.crypto.subtle.importKey("pkcs8", privBuf, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
                    const enc = new TextEncoder();
                    const signature = await window.crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(data));
                    return this.arrayBufferToBase64(signature);
                } catch (e) { return ""; }
            },
            // RSA Verify
            verifyData: async (data, signatureBase64, pubPem) => {
                try {
                    const pubBuf = this.pemToBuffer(pubPem);
                    const key = await window.crypto.subtle.importKey("spki", pubBuf, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
                    const enc = new TextEncoder();
                    const sigBuf = this.base64ToArrayBuffer(signatureBase64);
                    return await window.crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBuf, enc.encode(data));
                } catch (e) { return false; }
            },
            // AES Encrypt (GCM)
            aesEncrypt: async (plainText, password) => {
                try {
                    const enc = new TextEncoder();
                    const salt = window.crypto.getRandomValues(new Uint8Array(16));
                    const key = await this.deriveKey(password, salt);
                    const iv = window.crypto.getRandomValues(new Uint8Array(12));
                    const encrypted = await window.crypto.subtle.encrypt(
                        { name: "AES-GCM", iv: iv },
                        key,
                        enc.encode(plainText)
                    );
                    
                    const combined = new Uint8Array(salt.byteLength + iv.byteLength + encrypted.byteLength);
                    combined.set(salt, 0);
                    combined.set(iv, salt.byteLength);
                    combined.set(new Uint8Array(encrypted), salt.byteLength + iv.byteLength);
                    return this.arrayBufferToBase64(combined.buffer);
                } catch (e) { console.error(e); return ""; }
            },
            // AES Decrypt (GCM)
            aesDecrypt: async (encryptedBase64, password) => {
                try {
                    const combined = this.base64ToArrayBuffer(encryptedBase64);
                    const salt = combined.slice(0, 16);
                    const iv = combined.slice(16, 28);
                    const data = combined.slice(28);

                    const key = await this.deriveKey(password, salt);
                    const decrypted = await window.crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: iv },
                        key,
                        data
                    );
                    return new TextDecoder().decode(decrypted);
                } catch (e) { return ""; }
            }
        };
    }

    setupClipboardInterop() {
        window.ClipboardInterop = {
            copyText: (text) => {
                navigator.clipboard.writeText(text).then(function() {}, function(err) {});
            }
        };
    }

    // Crypto Helpers
    async deriveKey(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
        );
        return window.crypto.subtle.deriveKey(
            { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    toPem(buffer, label) { const b64 = this.arrayBufferToBase64(buffer); return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`; }
    pemToBuffer(pem) { const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s/g, ''); return this.base64ToArrayBuffer(b64); }
    arrayBufferToBase64(buffer) { let binary = ''; const bytes = new Uint8Array(buffer); for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]); return window.btoa(binary); }
    base64ToArrayBuffer(base64) { const binary_string = window.atob(base64); const len = binary_string.length; const bytes = new Uint8Array(len); for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i); return bytes.buffer; }
}