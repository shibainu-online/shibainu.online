import { Utils } from '../Utils/Utils.js';

export class InventoryManager {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.windows = {}; // Map: InstanceId -> ContainerWindow
        this.rootWindowId = "Root";
        this.rootItems = []; 
        this.toggleBtn = null;
        this.infoPopup = null;
        this.dropOverlay = null; // 操作ロック用オーバーレイ
        this.assetManager = window.assetManager;
        this.initUI();
        this.setupEvents();
        this.injectStyles(); // CSS注入
    }

    injectStyles() {
        const style = document.createElement('style');
        style.innerHTML = `
            .inv-item {
                transition: left 0.2s ease-out, top 0.2s ease-out;
            }
            .inv-item.dragging {
                transition: none !important;
                z-index: 9999;
                pointer-events: none; /* ドラッグ中は下の要素(ドロップ先)を検知させる */
            }
            .drop-blocker {
                position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(0,0,0,0.1); /* わずかに暗くしてロック中であることを示す */
                z-index: 2150;
                display: flex; justify-content: center; align-items: center;
                pointer-events: all; /* 全クリックを吸収 */
                touch-action: none; /* タッチ操作も吸収 */
            }
        `;
        document.head.appendChild(style);
    }

    initUI() {
        this.toggleBtn = document.createElement('div');
        this.toggleBtn.id = 'inventory-toggle';
        this.toggleBtn.style.position = 'fixed';
        this.toggleBtn.style.bottom = '20px';
        this.toggleBtn.style.right = '230px';
        this.toggleBtn.style.width = '64px';
        this.toggleBtn.style.height = '64px';
        this.toggleBtn.style.zIndex = '1500';
        this.toggleBtn.style.cursor = 'pointer';
        this.toggleBtn.style.backgroundImage = 'url("assets/storage_close_icon.png")';
        this.toggleBtn.style.backgroundSize = 'contain';
        this.toggleBtn.style.backgroundRepeat = 'no-repeat';
        this.toggleBtn.style.backgroundPosition = 'center';
        this.toggleBtn.style.backgroundColor = 'rgba(0,0,0,0.2)';
        this.toggleBtn.style.borderRadius = '12px';
        this.toggleBtn.style.display = 'none';
        document.body.appendChild(this.toggleBtn);

        this.contextMenu = document.createElement('div');
        this.contextMenu.id = 'inv-context-menu';
        this.contextMenu.style.position = 'fixed';
        this.contextMenu.style.zIndex = '2000';
        this.contextMenu.style.backgroundColor = 'rgba(255, 255, 255, 0.95)';
        this.contextMenu.style.border = '1px solid #ccc';
        this.contextMenu.style.borderRadius = '8px';
        this.contextMenu.style.padding = '5px';
        this.contextMenu.style.display = 'none';
        this.contextMenu.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
        this.contextMenu.innerHTML = '';
        this.contextMenu.style.userSelect = 'none';
        this.contextMenu.style.webkitUserSelect = 'none';
        document.body.appendChild(this.contextMenu);

        this.infoPopup = document.createElement('div');
        this.infoPopup.style.position = 'fixed';
        this.infoPopup.style.zIndex = '2100';
        this.infoPopup.style.backgroundColor = 'rgba(30, 30, 30, 0.95)';
        this.infoPopup.style.color = 'white';
        this.infoPopup.style.padding = '15px';
        this.infoPopup.style.borderRadius = '10px';
        this.infoPopup.style.border = '2px solid #FFB74D';
        this.infoPopup.style.maxWidth = '300px';
        this.infoPopup.style.boxShadow = '0 4px 15px rgba(0,0,0,0.5)';
        this.infoPopup.style.display = 'none';
        this.infoPopup.style.pointerEvents = 'none';
        document.body.appendChild(this.infoPopup);
    }

    show() { if (this.toggleBtn) this.toggleBtn.style.display = 'block'; }

    setupEvents() {
        this.toggleBtn.onclick = (e) => { e.stopPropagation(); this.toggleRoot(); };
        window.addEventListener('mousedown', (e) => this.onGlobalStart(e));
        window.addEventListener('mousemove', (e) => this.onGlobalMove(e));
        window.addEventListener('mouseup', (e) => this.onGlobalEnd(e));
        window.addEventListener('click', (e) => {
            if (this.contextMenu && !this.contextMenu.contains(e.target)) this.contextMenu.style.display = 'none';
            if (this.infoPopup) this.infoPopup.style.display = 'none';
        });
    }

    updateLabels() {
        Object.values(this.windows).forEach(w => w.updateStatusLabel());
    }

    toggleRoot() {
        if (this.windows[this.rootWindowId]) {
            this.closeAll();
            this.toggleBtn.style.backgroundImage = 'url("assets/storage_close_icon.png")';
        } else {
            this.openRootWindow(); 
            this.gameEngine.gameLogicRef.invokeMethodAsync('RefreshInventoryUI');
            this.toggleBtn.style.backgroundImage = 'url("assets/storage_open_icon.png")';
        }
    }

    openRootWindow() {
        if (this.windows[this.rootWindowId]) return;
        const items = this.rootItems || [];
        this.windows[this.rootWindowId] = new ContainerWindow(this.rootWindowId, null, items, 100, 100, this);
        let rootW = 0;
        items.forEach(i => rootW += (i.TotalWeight || 0));
        this.windows[this.rootWindowId].updateStatus(rootW, items.length, 20);
        this.recursiveUpdateWindows(items);
    }

    syncRoot(json) {
        const rootItems = JSON.parse(json);
        this.rootItems = rootItems;
        if (this.windows[this.rootWindowId]) {
            this.windows[this.rootWindowId].updateItems(rootItems);
            let rootW = 0;
            rootItems.forEach(i => rootW += (i.TotalWeight || 0));
            this.windows[this.rootWindowId].updateStatus(rootW, rootItems.length, 20);
            this.recursiveUpdateWindows(rootItems);
        }
    }

    recursiveUpdateWindows(items) {
        items.forEach(item => {
            if ((item.Type === 'Container' || item.Capacity > 0) && this.windows[item.InstanceId]) {
                const win = this.windows[item.InstanceId];
                const children = item.Children || [];
                win.updateItems(children);
                let w = 0;
                children.forEach(c => w += (c.TotalWeight || 0));
                win.updateStatus(w, children.length, item.Capacity || 20);
                this.recursiveUpdateWindows(children);
            }
        });
    }

    openSubContainer(jsonStr) {
        const container = JSON.parse(jsonStr);
        if (this.windows[container.InstanceId]) {
            this.windows[container.InstanceId].bringToFront();
            return;
        }
        const parentId = this.contextMenuSourceWindowId || this.rootWindowId;
        const count = Object.keys(this.windows).length;
        const x = 150 + (count * 30);
        const y = 150 + (count * 30);
        const win = new ContainerWindow(container.InstanceId, parentId, container.Children || [], x, y, this);
        this.windows[container.InstanceId] = win;
        let contentW = 0;
        if(container.Children) container.Children.forEach(c => contentW += (c.TotalWeight || 0));
        win.updateStatus(contentW, (container.Children || []).length, container.Capacity || 20);
    }

    closeWindowAndChildren(windowId) {
        Object.values(this.windows).forEach(w => {
            if (w.parentId === windowId) this.closeWindowAndChildren(w.id);
        });
        if (this.windows[windowId]) {
            this.windows[windowId].dispose();
            delete this.windows[windowId];
        }
    }

    closeAll() {
        if (this.windows[this.rootWindowId]) this.closeWindowAndChildren(this.rootWindowId);
        this.windows = {};
        this.contextMenu.style.display = 'none';
        this.infoPopup.style.display = 'none';
    }

    onGlobalStart(e) {
        // ★FIX: Overlayがある場合はイベントを吸収し、裏側の処理（カバン操作など）を完全に遮断する
        if (this.dropOverlay) {
            e.stopPropagation();
            return;
        }

        const wins = Object.values(this.windows).reverse();
        for (const w of wins) {
            if (w.handleStart(e.clientX, e.clientY, e.target)) return;
        }
    }

    onGlobalMove(e) {
        if (this.dropOverlay) return; // ★FIX
        Object.values(this.windows).forEach(w => w.handleMove(e.clientX, e.clientY));
    }

    onGlobalEnd(e) {
        if (this.dropOverlay) return; // ★FIX
        Object.values(this.windows).forEach(w => w.handleEnd(e.clientX, e.clientY));
    }

    checkDropTarget(screenX, screenY, draggedWindowId, item, sourceWindow) {
        // 1. カバンへのドロップ判定
        const targetWindow = Object.values(this.windows).find(w => {
            if (w.id === draggedWindowId) return false;
            const rect = w.el.getBoundingClientRect();
            return (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom);
        });
        
        if (targetWindow) {
            // 自己格納防止
            if (targetWindow.id === item.InstanceId || this.isChildWindow(item.InstanceId, targetWindow.id)) {
                return false; 
            }

            // カバン内相対座標を計算
            const rect = targetWindow.el.getBoundingClientRect();
            const relativeX = screenX - rect.left - 24; 
            const relativeY = screenY - rect.top - 24;
            
            this.gameEngine.gameLogicRef.invokeMethodAsync('MoveItemToContainer', item.InstanceId, targetWindow.id, relativeX, relativeY);
            return true;
        }

        // 2. 地面へのドロップ判定
        const gridPos = this.gameEngine.getMapGridPosition(screenX, screenY);
        
        if (gridPos) {
            const pPos = this.gameEngine.logicalPos;
            const dx = Math.abs(Math.round(gridPos.x) - Math.round(pPos.x));
            const dz = Math.abs(Math.round(gridPos.z) - Math.round(pPos.z));
            
            if (dx <= 2 && dz <= 2) {
                const dropX = Math.round(gridPos.x);
                const dropZ = Math.round(gridPos.z);
                this.showDropConfirm(screenX, screenY, item, { x: dropX, y: gridPos.y, z: dropZ }, sourceWindow);
                return { isPending: true };
            }
        }
        return false;
    }
    
    isChildWindow(parentId, childId) {
        const childWin = this.windows[childId];
        if (!childWin) return false;
        if (childWin.parentId === parentId) return true;
        return this.isChildWindow(parentId, childWin.parentId);
    }

    showDropConfirm(x, y, item, worldPos, sourceWindow) {
        // 安全策: 既存のオーバーレイがあれば先に消す
        this.removeDropOverlay();

        // 全画面バリアを作成（他の操作をブロック）
        this.dropOverlay = document.createElement('div');
        this.dropOverlay.className = 'drop-blocker';
        
        // ★FIX: バリア自体へのイベント伝播を止める (万が一のすり抜け防止)
        const blockEvent = (e) => {
            e.stopPropagation();
            // confirmBox内のクリックは通す必要があるので preventDefault はしない
        };
        this.dropOverlay.addEventListener('mousedown', blockEvent);
        this.dropOverlay.addEventListener('mouseup', blockEvent);
        this.dropOverlay.addEventListener('click', blockEvent);
        this.dropOverlay.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
        this.dropOverlay.addEventListener('touchstart', blockEvent, {passive: false});
        
        const confirmBox = document.createElement('div');
        confirmBox.style.backgroundColor = 'white';
        confirmBox.style.padding = '15px';
        confirmBox.style.border = '2px solid #FFB74D';
        confirmBox.style.borderRadius = '12px';
        confirmBox.style.textAlign = 'center';
        confirmBox.style.boxShadow = '0 4px 20px rgba(0,0,0,0.4)';
        confirmBox.style.minWidth = '200px';
        confirmBox.style.userSelect = 'none'; 
        
        // ダイアログボックス内でのイベントバブリング防止
        const preventClick = (e) => e.stopPropagation();
        confirmBox.addEventListener('mousedown', preventClick);
        confirmBox.addEventListener('click', preventClick);
        
        const msg = window.GetLabel('Inv_DropConfirm', 'Throw {0} here?').replace('{0}', item.Name);
        const yes = window.GetLabel('Btn_Yes', 'Yes');
        const no = window.GetLabel('Btn_No', 'No');
        
        confirmBox.innerHTML = `
            <div style="margin-bottom:15px; font-weight:bold; color:#333; font-size:1rem;">${msg}</div>
            <div style="font-size:0.8rem; color:#666; margin-bottom:15px;">X:${worldPos.x}, Z:${worldPos.z}</div>
            <div style="display:flex; justify-content:space-around; gap:10px;">
                <button id="btn-yes" style="cursor:pointer; padding:8px 20px; background:#4CAF50; color:white; border:none; border-radius:20px; font-weight:bold; box-shadow:0 2px 0 #2E7D32;">${yes}</button>
                <button id="btn-no" style="cursor:pointer; padding:8px 20px; background:#f44336; color:white; border:none; border-radius:20px; font-weight:bold; box-shadow:0 2px 0 #C62828;">${no}</button>
            </div>
        `;
        
        this.dropOverlay.appendChild(confirmBox);
        document.body.appendChild(this.dropOverlay);
        
        const yesBtn = confirmBox.querySelector('#btn-yes');
        const noBtn = confirmBox.querySelector('#btn-no');

        yesBtn.onclick = (e) => {
            e.stopPropagation();
            try {
                let finalY = worldPos.y;
                if (this.gameEngine.terrainManager) {
                    const h = this.gameEngine.terrainManager.getHeightAt(worldPos.x, worldPos.z);
                    if (h !== null) finalY = h + 0.5;
                }

                this.gameEngine.gameLogicRef.invokeMethodAsync('DropItemAt', item.InstanceId, worldPos.x, finalY, worldPos.z);
                this.closeWindowAndChildren(item.InstanceId);
                
                // 成功時はドラッグ状態を「完了」としてクリア (元に戻さない)
                if (sourceWindow) sourceWindow.finishDragState();
            } finally {
                // 何があっても必ずオーバーレイを消す
                this.removeDropOverlay();
            }
        };
        
        noBtn.onclick = (e) => {
            e.stopPropagation();
            try {
                // キャンセル時はドラッグ状態を「キャンセル」として元に戻す
                if (sourceWindow) sourceWindow.cancelDragState();
                this.gameEngine.gameLogicRef.invokeMethodAsync('RefreshInventoryUI');
            } finally {
                this.removeDropOverlay();
            }
        };
    }

    removeDropOverlay() {
        // クラス名で検索して、残存している全てのブロッカーを削除する (Ghost Overlay対策)
        const blockers = document.querySelectorAll('.drop-blocker');
        blockers.forEach(el => el.remove());
        
        this.dropOverlay = null;
    }

    showContextMenu(x, y, item, sourceWindowId) {
        this.contextMenuTarget = item;
        this.contextMenuSourceWindowId = sourceWindowId;
        this.contextMenu.innerHTML = '';
        const lblInfo = window.GetLabel('Inv_Info', 'Info');
        const btnInfo = this.createMenuBtn(`${lblInfo}`, () => this.showInfoPopup(x, y, item));
        this.contextMenu.appendChild(btnInfo);
        let useLabel = window.GetLabel('Btn_Use', 'Use');
        let isContainer = (item.Type === 'Container' || item.Capacity > 0);
        if (isContainer) {
            const isOpen = !!this.windows[item.InstanceId];
            useLabel = isOpen ? window.GetLabel('Inv_Close', 'Close') : window.GetLabel('Inv_Open', 'Open');
            if (isOpen) {
                const btnClose = this.createMenuBtn(useLabel, () => {
                    this.closeWindowAndChildren(item.InstanceId);
                    this.contextMenu.style.display = 'none';
                });
                this.contextMenu.appendChild(btnClose);
            } else {
                const btnOpen = this.createMenuBtn(useLabel, () => this.handleContextAction('use'));
                this.contextMenu.appendChild(btnOpen);
            }
        } else {
            const btnUse = this.createMenuBtn(useLabel, () => this.handleContextAction('use'));
            this.contextMenu.appendChild(btnUse);
        }
        const lblDrop = window.GetLabel('Btn_Drop', 'Drop');
        const btnDrop = this.createMenuBtn(lblDrop, () => this.handleContextAction('drop'), true);
        this.contextMenu.appendChild(btnDrop);
        this.contextMenu.style.left = `${x}px`;
        this.contextMenu.style.top = `${y}px`;
        this.contextMenu.style.display = 'block';
    }

    showInfoPopup(x, y, item) {
        this.contextMenu.style.display = 'none';
        
        const lWeight = window.GetLabel('Inv_Weight', 'Weight');
        const lItems = window.GetLabel('Inv_Items', 'Count');
        const lCap = window.GetLabel('Inv_Capacity', 'Capacity');
        let html = `
            <div style="font-weight:bold; border-bottom:1px solid #555; padding-bottom:5px; margin-bottom:5px;">*${item.Name}*</div>
            <div style="font-size:12px; margin-bottom:10px;">${item.Description || "No description."}</div>
            <div style="font-size:11px; color:#aaa;">
                Type: ${item.Type}<br/>
                ${lWeight}: ${item.TotalWeight.toFixed(1)}kg<br/>
                ${item.Count > 1 ? `${lItems}: ${item.Count}<br/>` : ''}
                ${(item.Type === 'Food' && item.Name === 'Apple') ? 'Nutrition: 40<br/>' : ''}
                ${item.Capacity > 0 ? `${lCap}: ${item.Capacity}<br/>` : ''}
            </div>
        `;
        this.infoPopup.innerHTML = html;
        this.infoPopup.style.left = `${x + 10}px`;
        this.infoPopup.style.top = `${y}px`;
        this.infoPopup.style.display = 'block';
    }

    createMenuBtn(text, onClick, isDanger = false) {
        const div = document.createElement('div');
        div.innerText = text;
        div.style.padding = '8px 16px';
        div.style.cursor = 'pointer';
        div.style.borderBottom = '1px solid #eee';
        if (isDanger) div.style.color = 'red';
        div.onclick = (e) => { e.stopPropagation(); onClick(); };
        return div;
    }

    handleContextAction(action) {
        if (!this.contextMenuTarget) return;
        this.gameEngine.gameLogicRef.invokeMethodAsync('PerformInventoryAction', this.contextMenuTarget.InstanceId, action);
        if (action === 'drop') {
            this.closeWindowAndChildren(this.contextMenuTarget.InstanceId);
        }
        this.contextMenu.style.display = 'none';
        this.contextMenuTarget = null;
    }

    dispose() {
        this.closeAll();
        if(this.toggleBtn) this.toggleBtn.remove();
        if(this.contextMenu) this.contextMenu.remove();
        if(this.infoPopup) this.infoPopup.remove();
        this.removeDropOverlay();
    }
}

class ContainerWindow {
    constructor(id, parentId, items, x, y, manager) {
        this.id = id;
        this.parentId = parentId;
        this.items = items;
        this.manager = manager;
        this.currentWeight = 0;
        this.currentCount = 0;
        this.currentCapacity = 0;
        
        this.el = document.createElement('div');
        this.el.className = 'inv-window';
        this.el.style.position = 'fixed';
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
        this.el.style.width = '400px';
        this.el.style.height = '400px';
        this.el.style.zIndex = '1400';
        this.el.style.backgroundImage = 'url("assets/storage_000.png")';
        this.el.style.backgroundSize = '100% 100%';
        this.el.style.backgroundRepeat = 'no-repeat';
        this.el.style.userSelect = 'none';
        this.el.style.webkitUserSelect = 'none';
        
        document.body.appendChild(this.el);
        
        this.statusBar = document.createElement('div');
        this.statusBar.style.position = 'absolute';
        this.statusBar.style.bottom = '15px';
        this.statusBar.style.left = '0';
        this.statusBar.style.width = '100%';
        this.statusBar.style.textAlign = 'center';
        this.statusBar.style.color = 'white';
        this.statusBar.style.fontSize = '12px';
        this.statusBar.style.textShadow = '1px 1px 2px black';
        this.statusBar.style.pointerEvents = 'none';
        this.el.appendChild(this.statusBar);
        
        this.itemContainer = document.createElement('div'); // アイテム配置用コンテナ
        this.itemContainer.style.position = 'absolute';
        this.itemContainer.style.top = '0';
        this.itemContainer.style.left = '0';
        this.itemContainer.style.width = '100%';
        this.itemContainer.style.height = '100%';
        this.el.appendChild(this.itemContainer);

        this.renderItems();
        
        this.isDragging = false;
        this.isDraggingItem = false;
        this.potentialDragItem = false; 
        this.dragOffset = {x:0, y:0};
        this.dragItemEl = null;
        this.originalPos = {x:0, y:0};
        this.dragStartPos = {x:0, y:0};
        this.draggingItemId = null;
    }

    updateItems(newItems) {
        this.items = newItems;
        this.renderItems();
    }

    updateStatus(weight, count, capacity) {
        this.currentWeight = weight;
        this.currentCount = count;
        this.currentCapacity = capacity;
        this.updateStatusLabel();
    }

    updateStatusLabel() {
        const lWeight = window.GetLabel('Inv_Weight', 'Weight');
        const lItems = window.GetLabel('Inv_Items', 'Items');
        this.statusBar.innerText = `${lWeight}: ${this.currentWeight.toFixed(1)}kg | ${lItems}: ${this.currentCount}/${this.currentCapacity}`;
    }

    renderItems() {
        // --- Diff Rendering (Ghost Fix) ---
        // 既存のDOMと最新のデータを照合する
        
        // 1. 閉じるボタンの管理
        if (this.id !== "Root" && !this.el.querySelector('.close-btn')) {
            const close = document.createElement('div');
            close.className = 'close-btn';
            close.innerText = "✖";
            close.style.position = 'absolute';
            close.style.top = '10px';
            close.style.right = '10px';
            close.style.cursor = 'pointer';
            close.style.color = '#fff';
            close.style.fontWeight = 'bold';
            close.style.zIndex = '10'; // アイテムより手前に
            close.style.userSelect = 'none';
            close.onclick = (e) => { 
                e.stopPropagation(); 
                this.manager.closeWindowAndChildren(this.id); 
            };
            close.onmousedown = (e) => e.stopPropagation(); 
            this.el.appendChild(close);
        }

        const existingEls = Array.from(this.itemContainer.children);
        const existingMap = new Map();
        existingEls.forEach(el => {
            if(el.dataset.id) existingMap.set(el.dataset.id, el);
        });

        // 2. アイテムの更新・作成
        this.items.forEach((item, index) => {
            // ドラッグ中のアイテムは更新しない（位置が飛ぶのを防ぐ）
            if (this.draggingItemId === item.InstanceId) return;

            let ix = 20 + (index % 6) * 60;
            let iy = 20 + Math.floor(index / 6) * 60;
            if (item.Data && item.Data.ui_x) ix = parseFloat(item.Data.ui_x);
            if (item.Data && item.Data.ui_y) iy = parseFloat(item.Data.ui_y);

            let el = existingMap.get(item.InstanceId);

            if (el) {
                // Update
                existingMap.delete(item.InstanceId); // マップから削除して、残ったものを後で消す
                
                // 位置のスムーズな更新 (CSS transitionが効く)
                el.style.left = `${ix}px`;
                el.style.top = `${iy}px`;
                
                // アイコンやバッジの更新が必要ならここでやる
                const badge = el.querySelector('.badge');
                if (item.Count > 1) {
                    if (badge) badge.innerText = item.Count;
                    else this.addBadge(el, item.Count);
                } else if (badge) {
                    badge.remove();
                }
            } else {
                // Create New
                el = document.createElement('div');
                el.className = 'inv-item';
                el.style.position = 'absolute';
                el.style.width = '48px';
                el.style.height = '48px';
                el.style.borderRadius = '50%';
                el.style.cursor = 'grab';
                el.style.userSelect = 'none';
                el.dataset.id = item.InstanceId;
                
                // 初期位置
                el.style.left = `${ix}px`;
                el.style.top = `${iy}px`;

                this.applyItemVisuals(el, item);

                el.onclick = (e) => {
                    e.stopPropagation();
                    if (!this.isDraggingItem) this.manager.showContextMenu(e.clientX, e.clientY, item, this.id);
                };

                this.itemContainer.appendChild(el);
            }
        });

        // 3. 削除されたアイテムのDOMを消去
        existingMap.forEach((el) => {
            // ドラッグ中のアイテムは消さない
            if (this.draggingItemId !== el.dataset.id) {
                el.remove();
            }
        });
    }

    addBadge(el, count) {
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.innerText = count;
        badge.style.position = 'absolute';
        badge.style.bottom = '0';
        badge.style.right = '0';
        badge.style.background = 'black';
        badge.style.color = 'white';
        badge.style.fontSize = '10px';
        badge.style.padding = '1px 3px';
        badge.style.borderRadius = '4px';
        el.appendChild(badge);
    }

    applyItemVisuals(el, item) {
        if (item.IconHash && window.assetManager) {
            el.style.backgroundColor = 'transparent';
            window.assetManager.loadAsset(item.IconHash).then(base64 => {
                if (base64) {
                    el.style.backgroundImage = `url("data:image/png;base64,${base64}")`;
                    el.style.backgroundSize = 'cover';
                } else el.style.backgroundColor = item.ColorHex || '#fff';
            });
        } else {
            el.style.backgroundColor = item.ColorHex || '#fff';
            el.style.border = '2px solid #fff';
            el.style.boxShadow = '0 2px 5px rgba(0,0,0,0.3)';
        }
        if (item.Count > 1) this.addBadge(el, item.Count);
    }

    handleStart(clientX, clientY, target) {
        // アイテムコンテナ内の要素がクリックされたかチェック
        const itemEl = target.closest('.inv-item');
        if (itemEl && this.itemContainer.contains(itemEl)) {
            this.potentialDragItem = true;
            this.dragItemEl = itemEl;
            this.dragStartPos.x = clientX;
            this.dragStartPos.y = clientY;
            
            const rect = itemEl.getBoundingClientRect();
            this.dragOffset.x = clientX - rect.left;
            this.dragOffset.y = clientY - rect.top;
            
            // 元のローカル座標を記録（キャンセル時の戻り先）
            this.originalPos.x = parseFloat(itemEl.style.left);
            this.originalPos.y = parseFloat(itemEl.style.top);
            return true;
        }

        // ウィンドウ自体のドラッグ
        if (this.el.contains(target) && target !== this.statusBar && !target.classList.contains('close-btn')) {
            this.isDragging = true;
            const rect = this.el.getBoundingClientRect();
            this.dragOffset.x = clientX - rect.left;
            this.dragOffset.y = clientY - rect.top;
            this.el.style.cursor = 'grabbing';
            this.bringToFront();
            this.manager.contextMenu.style.display = 'none';
            return true;
        }
        return false;
    }

    handleMove(clientX, clientY) {
        if (this.potentialDragItem) {
            const dist = Math.sqrt(Math.pow(clientX - this.dragStartPos.x, 2) + Math.pow(clientY - this.dragStartPos.y, 2));
            if (dist > 5) {
                // ドラッグ開始確定
                this.potentialDragItem = false;
                this.isDraggingItem = true;
                this.manager.contextMenu.style.display = 'none';
                this.draggingItemId = this.dragItemEl.dataset.id;

                // 成層圏転送 (body直下へ移動し、fixed配置)
                const rect = this.dragItemEl.getBoundingClientRect();
                this.dragItemEl.style.position = 'fixed';
                this.dragItemEl.style.left = `${rect.left}px`;
                this.dragItemEl.style.top = `${rect.top}px`;
                this.dragItemEl.classList.add('dragging');
                
                document.body.appendChild(this.dragItemEl);
                this.dragItemEl.style.cursor = 'grabbing';
            }
        }

        if (this.isDraggingItem && this.dragItemEl) {
            const newX = clientX - this.dragOffset.x;
            const newY = clientY - this.dragOffset.y;
            this.dragItemEl.style.left = `${newX}px`;
            this.dragItemEl.style.top = `${newY}px`;
        }
        else if (this.isDragging) {
            const newX = clientX - this.dragOffset.x;
            const newY = clientY - this.dragOffset.y;
            this.el.style.left = `${newX}px`;
            this.el.style.top = `${newY}px`;
        }
    }

    async handleEnd(clientX, clientY) {
        this.potentialDragItem = false;
        
        if (this.isDraggingItem && this.dragItemEl) {
            const id = this.dragItemEl.dataset.id;
            const item = this.items.find(i => i.InstanceId === id);
            
            // ポインタイベントを戻して判定できるようにする
            this.dragItemEl.classList.remove('dragging');
            this.dragItemEl.style.pointerEvents = 'auto';

            let handled = false;
            const containerRect = this.el.getBoundingClientRect();
            
            // アイテムの中心位置で判定
            const itemRect = this.dragItemEl.getBoundingClientRect();
            const centerX = itemRect.left + itemRect.width / 2;
            const centerY = itemRect.top + itemRect.height / 2;
            
            const isInside = (centerX >= containerRect.left && centerX <= containerRect.right && 
                              centerY >= containerRect.top && centerY <= containerRect.bottom);

            if (!isInside) {
                // 外に出た -> ドロップ or 他のカバンへ移動
                if (item) {
                    const result = await this.manager.checkDropTarget(clientX, clientY, this.id, item, this);
                    if (result) {
                        if (result.isPending) {
                            this.dragItemEl.remove(); 
                            handled = true;
                            // draggingItemId はクリアしない（renderItemsでのゴースト防止）
                            return; 
                        } else {
                            handled = true; // 移動成功
                            this.dragItemEl.remove();
                        }
                    }
                }
            } else {
                // カバン内に戻った -> 座標更新
                // グローバル(fixed)座標からコンテナ内ローカル(absolute)座標への変換
                const globalLeft = parseFloat(this.dragItemEl.style.left);
                const globalTop = parseFloat(this.dragItemEl.style.top);
                
                // コンテナの枠線等を考慮して補正 (ここでは簡易的に計算)
                // コンテナ内は absolute 配置なので、コンテナ左上からの相対距離になる
                let localX = globalLeft - containerRect.left;
                let localY = globalTop - containerRect.top;

                // 範囲制限 (アイテムサイズ 48px を考慮)
                const maxX = containerRect.width - 48;
                const maxY = containerRect.height - 48;
                localX = Math.max(0, Math.min(localX, maxX));
                localY = Math.max(0, Math.min(localY, maxY));

                // DOMをコンテナに戻す
                this.itemContainer.appendChild(this.dragItemEl);
                this.dragItemEl.style.position = 'absolute';
                this.dragItemEl.style.left = `${localX}px`;
                this.dragItemEl.style.top = `${localY}px`;
                this.dragItemEl.style.zIndex = '';
                this.dragItemEl.style.cursor = 'grab';

                // サーバー同期
                this.manager.gameEngine.gameLogicRef.invokeMethodAsync('UpdateInventoryItemPosition', id, localX, localY);
                handled = true;
            }

            if (!handled && this.dragItemEl && document.body.contains(this.dragItemEl)) {
                // どこにも置けなかった -> 元の位置に戻す
                this.cancelDragState();
            } else if (handled) {
                this.isDraggingItem = false;
                this.draggingItemId = null;
                this.dragItemEl = null;
            }
        }

        if (this.isDragging) {
            this.isDragging = false;
            this.el.style.cursor = 'default';
        }
    }

    // ドラッグ成功時（破棄確定時など）、状態だけをクリアする
    finishDragState() {
        this.isDraggingItem = false;
        this.draggingItemId = null;
        this.dragItemEl = null;
    }

    // ドラッグキャンセル時、アイテムを元の位置に戻す
    cancelDragState() {
        if (!this.dragItemEl) return;
        
        // 元のコンテナに戻す
        this.itemContainer.appendChild(this.dragItemEl);
        this.dragItemEl.style.position = 'absolute';
        this.dragItemEl.style.zIndex = '';
        this.dragItemEl.style.cursor = 'grab';
        this.dragItemEl.classList.remove('dragging');
        this.dragItemEl.style.pointerEvents = 'auto';

        // アニメーションで戻る
        requestAnimationFrame(() => {
            this.dragItemEl.style.left = `${this.originalPos.x}px`;
            this.dragItemEl.style.top = `${this.originalPos.y}px`;
        });

        this.isDraggingItem = false;
        this.draggingItemId = null;
        this.dragItemEl = null;
        
        // 念のため再描画
        setTimeout(() => this.renderItems(), 300);
    }

    bringToFront() { this.el.style.zIndex = '1401'; }

    dispose() {
        if (this.el) this.el.remove();
    }
}