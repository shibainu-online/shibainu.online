export class NetworkInterop {
    // C# から呼ばれるメソッド: 強制ローカルモード切替
    static setForceLocal(isLocal) {
        console.log(`[NetworkInterop] setForceLocal: ${isLocal}`);
        
        if (window.networkManager) {
            if (typeof window.networkManager.setForceLocal === 'function') {
                window.networkManager.setForceLocal(isLocal);
            } else {
                window.networkManager.forceLocal = isLocal;
            }
        } else {
            console.warn("[NetworkInterop] NetworkManager not found on window.");
        }
    }

    // C# から呼ばれるメソッド: アプリ再起動（エラー表示付き）
    static restart(reason) {
        console.error(`[NetworkInterop] Restart requested. Reason: ${reason}`);

        // 即時リロードせずに、モーダルウィンドウを表示してユーザーに通知する
        NetworkInterop.showErrorModal(reason || "An unexpected error occurred requiring a restart.");
    }

    static showErrorModal(message) {
        // 既存のモーダルがあれば削除
        const oldModal = document.getElementById('error-modal');
        if (oldModal) oldModal.remove();

        // オーバーレイ
        const overlay = document.createElement('div');
        overlay.id = 'error-modal';
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
        overlay.style.zIndex = '9999';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';
        overlay.style.flexDirection = 'column';

        // メッセージボックス
        const box = document.createElement('div');
        box.style.backgroundColor = '#222';
        box.style.border = '2px solid #ff4444';
        box.style.padding = '20px';
        box.style.borderRadius = '8px';
        box.style.maxWidth = '80%';
        box.style.textAlign = 'center';
        box.style.color = '#fff';
        box.style.boxShadow = '0 0 20px rgba(255, 0, 0, 0.5)';

        // タイトル
        const title = document.createElement('h2');
        title.innerText = "⚠️ Critical Error / Reset";
        title.style.margin = '0 0 10px 0';
        title.style.color = '#ff4444';

        // エラー内容
        const msg = document.createElement('p');
        msg.innerText = message;
        msg.style.fontSize = '16px';
        msg.style.marginBottom = '20px';
        msg.style.lineHeight = '1.5';

        // 再起動ボタン
        const btn = document.createElement('button');
        btn.innerText = "Restart Application";
        btn.style.padding = '10px 20px';
        btn.style.fontSize = '16px';
        btn.style.cursor = 'pointer';
        btn.style.backgroundColor = '#ff4444';
        btn.style.color = 'white';
        btn.style.border = 'none';
        btn.style.borderRadius = '4px';
        
        // ボタンクリックでリロード
        btn.onclick = () => {
            window.location.reload();
        };

        box.appendChild(title);
        box.appendChild(msg);
        box.appendChild(btn);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }
}

// windowオブジェクトに登録
window.NetworkInterop = NetworkInterop;
console.log("[NetworkInterop] Registered on window object.");