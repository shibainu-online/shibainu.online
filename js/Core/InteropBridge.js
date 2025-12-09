import { Utils } from '../Utils/Utils.js';
export class InteropBridge {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.setupExports();
        this.setupCryptoInterop();
        this.setupClipboardInterop();
    }
    setupExports() {
        window.initNetwork = (ref, networkId, config) => {
            if (window.assetManager) {
                window.assetManager.setNetworkId(networkId);
            }
            if (window.networkManager) {
                window.networkManager.init(ref, networkId, config);
            }
        };
        window.StartGame = (logicRef, id, name, x, y, z, speed, colorHex, isVisible) => {
            if (this.gameEngine) {
                this.gameEngine.startGame(logicRef, id, name, x, y, z, speed, colorHex, isVisible);
            }
        };
        window.DisposeGame = () => {
            if (this.gameEngine) {
                this.gameEngine.dispose();
            }
        };
        window.NetworkInterop = {
            addSignalingUrl: (url) => { if (window.networkManager) window.networkManager.addSignalingUrl(url); },
            setForceLocal: (enabled) => { if (window.networkManager) window.networkManager.setForceLocal(enabled); },
            getPeerCount: () => { return window.networkManager ? window.networkManager.getPeerCount() : 0; },
            restart: () => {
                console.warn("Restart requested via Interop.");
                if(window.restart) window.restart("Requested by System");
            }
        };
        window.broadcastMessage = (m) => {
            if (window.networkManager) window.networkManager.broadcast(m);
        };
        window.TerrainInterop = {
            loadChunk: (gx, gz, heightMap) => {
                if (this.gameEngine && this.gameEngine.terrainManager) {
                    this.gameEngine.terrainManager.loadChunk(gx, gz, heightMap);
                }
            },
            unloadChunk: (gx, gz) => {
                if (this.gameEngine && this.gameEngine.terrainManager) {
                    this.gameEngine.terrainManager.unloadChunk(gx, gz);
                }
            }
        };
        window.VisualEntityInterop = {
            updateEntity: (id, x, y, z, colorHex, name, type, rot, isVisible, moveSpeed, modelType, modelDataId, primitiveType, scale, rx, ry, rz, attrs) => {
                if (this.gameEngine && this.gameEngine.visualEntityManager) {
                    this.gameEngine.visualEntityManager.updateEntity(
                        id, x, y, z, colorHex, name, type, rot, isVisible, moveSpeed,
                        modelType, modelDataId, primitiveType, scale, rx, ry, rz, attrs
                    );
                }
            },
            removeEntity: (id) => {
                if (this.gameEngine && this.gameEngine.visualEntityManager) {
                    this.gameEngine.visualEntityManager.removeEntity(id);
                }
            }
        };
        window.renderBox = (hex) => {
            if(this.gameEngine && this.gameEngine.renderBox) this.gameEngine.renderBox(hex);
        };
        window.SetPlayerSpeed = (speed) => {
            if (this.gameEngine) this.gameEngine.setPlayerSpeed(speed);
        };
        window.WarpLocalPlayer = (x, y, z) => {
            if (this.gameEngine) this.gameEngine.warpLocalPlayer(x, y, z);
        };
        window.StartPlacementMode = (id) => {
            if (this.gameEngine) this.gameEngine.startPlacementMode(id);
        };
        window.EndPlacementMode = () => {
            if (this.gameEngine) return this.gameEngine.endPlacementMode();
            return null;
        };
        window.ToggleMinimap = () => {
            if (this.gameEngine && this.gameEngine.minimapManager) return this.gameEngine.minimapManager.toggle();
            return false;
        };
        window.ToggleNamePlates = () => {
            if (this.gameEngine && this.gameEngine.visualEntityManager) return this.gameEngine.visualEntityManager.toggleNamePlates();
        };
        // --- Inventory Interop ---
        window.SyncInventoryRoot = (itemsJson) => {
            if (this.gameEngine && this.gameEngine.inventoryManager) {
                this.gameEngine.inventoryManager.syncRoot(itemsJson);
            }
        };
        window.OpenSubContainer = (itemsJson) => {
            if (this.gameEngine && this.gameEngine.inventoryManager) {
                this.gameEngine.inventoryManager.openSubContainer(itemsJson);
            }
        };
        // --- Language Interop ---
        window.SetLanguageData = (data) => {
            window.langData = data;
            if (this.gameEngine && this.gameEngine.inventoryManager) {
                if(this.gameEngine.inventoryManager.updateLabels) this.gameEngine.inventoryManager.updateLabels();
            }
        };
        
        window.GetLabel = (key, defaultText) => {
            if (window.langData && window.langData[key]) return window.langData[key];
            return defaultText;
        };
    }
    setupCryptoInterop() {
        window.CryptoInterop = {
            generateKeys: async () => {
                const keyPair = await window.crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array(), hash: "SHA-256" }, true, ["sign", "verify"]);
                const priv = await window.crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
                const pub = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
                return { privateKey: this.toPem(priv, "PRIVATE KEY"), publicKey: this.toPem(pub, "PUBLIC KEY") };
            },
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
            signData: async (data, privPem) => {
                try {
                    const privBuf = this.pemToBuffer(privPem);
                    const key = await window.crypto.subtle.importKey("pkcs8", privBuf, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
                    const enc = new TextEncoder();
                    const signature = await window.crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(data));
                    return Utils.arrayBufferToBase64(signature);
                } catch (e) { return ""; }
            },
            verifyData: async (data, signatureBase64, pubPem) => {
                try {
                    const pubBuf = this.pemToBuffer(pubPem);
                    const key = await window.crypto.subtle.importKey("spki", pubBuf, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
                    const enc = new TextEncoder();
                    const sigBuf = Utils.base64ToArrayBuffer(signatureBase64);
                    return await window.crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBuf, enc.encode(data));
                } catch (e) { return false; }
            },
            aesEncrypt: async (plainText, password) => {
                try {
                    const enc = new TextEncoder();
                    const salt = window.crypto.getRandomValues(new Uint8Array(16));
                    const key = await this.deriveKey(password, salt);
                    const iv = window.crypto.getRandomValues(new Uint8Array(12));
                    const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(plainText));
                    const combined = new Uint8Array(salt.byteLength + iv.byteLength + encrypted.byteLength);
                    combined.set(salt, 0); combined.set(iv, salt.byteLength); combined.set(new Uint8Array(encrypted), salt.byteLength + iv.byteLength);
                    return Utils.arrayBufferToBase64(combined.buffer);
                } catch (e) { return ""; }
            },
            aesDecrypt: async (encryptedBase64, password) => {
                try {
                    const combined = Utils.base64ToArrayBuffer(encryptedBase64);
                    const combinedArr = new Uint8Array(combined);
                    const salt = combinedArr.slice(0, 16);
                    const iv = combinedArr.slice(16, 28);
                    const data = combinedArr.slice(28);
                    const key = await this.deriveKey(password, salt);
                    const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, data);
                    return new TextDecoder().decode(decrypted);
                } catch (e) { return ""; }
            }
        };
    }
    setupClipboardInterop() {
        window.ClipboardInterop = {
            copyText: (text) => { navigator.clipboard.writeText(text).catch(err => {}); }
        };
    }
    async deriveKey(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
        return window.crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    }
    toPem(buffer, label) { const b64 = Utils.arrayBufferToBase64(buffer); return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`; }
    pemToBuffer(pem) { const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s/g, ''); return Utils.base64ToArrayBuffer(b64); }
}