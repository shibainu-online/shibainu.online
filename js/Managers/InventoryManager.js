export class InventoryManager {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.windows = {}; // Map: InstanceId -> ContainerWindow
        this.rootWindowId = "Root";
        this.toggleBtn = null;
        this.infoPopup = null;
        this.assetManager = window.assetManager;
        this.initUI();
        this.setupEvents();
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
        window.SyncInventoryRoot = (json) => this.syncRoot(json);
        window.OpenSubContainer = (json) => this.openSubContainer(json);
    }
    toggleRoot() {
        if (this.windows[this.rootWindowId]) {
            this.closeAll();
            this.toggleBtn.style.backgroundImage = 'url("assets/storage_close_icon.png")';
        } else {
            this.gameEngine.gameLogicRef.invokeMethodAsync('RefreshInventoryUI');
            this.toggleBtn.style.backgroundImage = 'url("assets/storage_open_icon.png")';
        }
    }
    syncRoot(json) {
        const rootItems = JSON.parse(json);
        let rootW = 0;
        rootItems.forEach(i => rootW += (i.TotalWeight || 0));
        if (!this.windows[this.rootWindowId]) {
            this.windows[this.rootWindowId] = new ContainerWindow(this.rootWindowId, null, rootItems, 100, 100, this);
        } else {
            this.windows[this.rootWindowId].updateItems(rootItems);
        }
        this.windows[this.rootWindowId].updateStatus(rootW, rootItems.length, 20);
        this.recursiveUpdateWindows(rootItems);
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
        const wins = Object.values(this.windows).reverse();
        for (const w of wins) {
            if (w.handleStart(e.clientX, e.clientY, e.target)) return;
        }
    }
    onGlobalMove(e) { 
        Object.values(this.windows).forEach(w => w.handleMove(e.clientX, e.clientY));
    }
    onGlobalEnd(e) { 
        Object.values(this.windows).forEach(w => w.handleEnd(e.clientX, e.clientY));
    }
    checkDropTarget(screenX, screenY, draggedWindowId, item) {
        const targetWindow = Object.values(this.windows).find(w => {
            if (w.id === draggedWindowId) return false;
            const rect = w.el.getBoundingClientRect();
            return (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom);
        });
        if (targetWindow) {
            this.gameEngine.gameLogicRef.invokeMethodAsync('MoveItemToContainer', item.InstanceId, targetWindow.id);
            return true;
        }
        const worldPos = this.gameEngine.getTerrainIntersection(screenX, screenY);
        if (worldPos) {
            const playerPos = this.gameEngine.logicalPos;
            const dist = worldPos.distanceTo(playerPos);
            if (dist <= 2.5) {
                this.showDropConfirm(screenX, screenY, item, worldPos);
                return { isPending: true };
            }
        }
        return false;
    }
    showDropConfirm(x, y, item, worldPos) {
        const confirmBox = document.createElement('div');
        confirmBox.style.position = 'fixed';
        confirmBox.style.left = `${x}px`;
        confirmBox.style.top = `${y}px`;
        confirmBox.style.zIndex = '2200';
        confirmBox.style.backgroundColor = 'white';
        confirmBox.style.padding = '10px';
        confirmBox.style.border = '2px solid #FFB74D';
        confirmBox.style.borderRadius = '8px';
        confirmBox.style.textAlign = 'center';
        confirmBox.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
        confirmBox.innerHTML = `
            <div style="margin-bottom:5px; font-weight:bold;">Throw ${item.Name} here?</div>
            <button id="btn-yes" style="margin-right:10px;">Yes</button>
            <button id="btn-no">No</button>
        `;
        document.body.appendChild(confirmBox);
        return new Promise((resolve) => {
            confirmBox.querySelector('#btn-yes').onclick = () => {
                this.gameEngine.gameLogicRef.invokeMethodAsync('DropItemAt', item.InstanceId, worldPos.x, worldPos.y, worldPos.z);
                this.closeWindowAndChildren(item.InstanceId);
                confirmBox.remove();
                resolve(true);
            };
            confirmBox.querySelector('#btn-no').onclick = () => {
                confirmBox.remove();
                resolve(false);
            };
        });
    }
    showContextMenu(x, y, item, sourceWindowId) {
        this.contextMenuTarget = item;
        this.contextMenuSourceWindowId = sourceWindowId;
        this.contextMenu.innerHTML = '';
        const btnInfo = this.createMenuBtn("Info (情報)", () => this.showInfoPopup(x, y, item));
        this.contextMenu.appendChild(btnInfo);
        let useLabel = "Use (使う)";
        let isContainer = (item.Type === 'Container' || item.Capacity > 0);
        
        if (isContainer) {
            const isOpen = !!this.windows[item.InstanceId];
            useLabel = isOpen ? "Close (閉じる)" : "Open (開く)";
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
        const btnDrop = this.createMenuBtn("Drop (捨てる)", () => this.handleContextAction('drop'), true);
        this.contextMenu.appendChild(btnDrop);
        this.contextMenu.style.left = `${x}px`;
        this.contextMenu.style.top = `${y}px`;
        this.contextMenu.style.display = 'block';
    }
    showInfoPopup(x, y, item) {
        this.contextMenu.style.display = 'none';
        let html = `<strong>${item.Name}</strong><hr style="margin:5px 0; border-color:#555;">`;
        html += `<div style="font-size:0.9em; margin-bottom:5px;">${item.Description || "No description."}</div>`;
        html += `<div style="font-size:0.85em; color:#ccc;">`;
        html += `Type: ${item.Type}<br>`;
        html += `Weight: ${item.TotalWeight.toFixed(1)}kg<br>`;
        if(item.Count > 1) html += `Count: ${item.Count}<br>`;
        if (item.Type === 'Food' && item.Name === 'Apple') html += `Nutrition: 40<br>`;
        if (item.Capacity > 0) html += `Capacity: ${item.Capacity}<br>`;
        html += `</div>`;
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
    }
}
class ContainerWindow {
    constructor(id, parentId, items, x, y, manager) {
        this.id = id;
        this.parentId = parentId;
        this.items = items;
        this.manager = manager;
        
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
        this.renderItems();
        
        // State for drag
        this.isDragging = false;
        this.isDraggingItem = false;
        this.potentialDragItem = false; // Bug Fix #1: Threshold check
        this.dragOffset = {x:0, y:0};
        this.dragItemEl = null;
        this.originalPos = {x:0, y:0};
        this.dragStartPos = {x:0, y:0};
    }
    updateItems(newItems) {
        this.items = newItems;
        this.renderItems();
    }
    updateStatus(weight, count, capacity) {
        this.statusBar.innerText = `Weight: ${weight.toFixed(1)}kg | Items: ${count}/${capacity}`;
    }
    renderItems() {
        const children = Array.from(this.el.children);
        children.forEach(c => {
            if (c !== this.statusBar && c.innerText !== "✖") c.remove();
        });
        
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
            close.onclick = (e) => { e.stopPropagation(); this.manager.closeWindowAndChildren(this.id); };
            this.el.appendChild(close);
        }
        this.items.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'inv-item';
            el.style.position = 'absolute';
            el.style.width = '48px';
            el.style.height = '48px';
            el.style.borderRadius = '50%';
            el.style.cursor = 'grab';
            
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
            if (item.Count > 1) {
                const badge = document.createElement('div');
                badge.innerText = item.Count;
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
            let ix = 20 + (index % 6) * 60;
            let iy = 20 + Math.floor(index / 6) * 60;
            if (item.Data && item.Data.ui_x) ix = parseFloat(item.Data.ui_x);
            if (item.Data && item.Data.ui_y) iy = parseFloat(item.Data.ui_y);
            el.style.left = `${ix}px`;
            el.style.top = `${iy}px`;
            el.dataset.id = item.InstanceId;
            el.onclick = (e) => {
                e.stopPropagation();
                // Bug Fix #1: Only open menu if NOT dragging
                if (!this.isDraggingItem) this.manager.showContextMenu(e.clientX, e.clientY, item, this.id);
            };
            this.el.appendChild(el);
        });
    }
    handleStart(clientX, clientY, target) {
        if (!this.el.contains(target)) return false;
        
        // Item Drag Setup (Delayed)
        if (target.classList.contains('inv-item') || target.parentElement.classList.contains('inv-item')) {
            const itemEl = target.classList.contains('inv-item') ? target : target.parentElement;
            
            this.potentialDragItem = true; // Wait for move threshold
            this.dragItemEl = itemEl;
            this.dragStartPos.x = clientX;
            this.dragStartPos.y = clientY;
            
            const rect = itemEl.getBoundingClientRect();
            this.dragOffset.x = clientX - rect.left;
            this.dragOffset.y = clientY - rect.top;
            
            this.originalPos.x = parseFloat(itemEl.style.left);
            this.originalPos.y = parseFloat(itemEl.style.top);
            return true;
        }
        
        // Window Drag (Immediate)
        if (target === this.el) {
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
            // Bug Fix #1: Threshold Check (5px)
            const dist = Math.sqrt(Math.pow(clientX - this.dragStartPos.x, 2) + Math.pow(clientY - this.dragStartPos.y, 2));
            if (dist > 5) {
                // Start Actual Drag
                this.potentialDragItem = false;
                this.isDraggingItem = true;
                this.manager.contextMenu.style.display = 'none';
                
                // Stratosphere Layer Logic
                const rect = this.dragItemEl.getBoundingClientRect();
                this.dragItemEl.style.position = 'fixed';
                this.dragItemEl.style.left = `${rect.left}px`;
                this.dragItemEl.style.top = `${rect.top}px`;
                this.dragItemEl.style.zIndex = '9999';
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
        // Reset potential drag
        this.potentialDragItem = false;
        if (this.isDraggingItem && this.dragItemEl) {
            const id = this.dragItemEl.dataset.id;
            const item = this.items.find(i => i.InstanceId === id);
            
            let handled = false;
            
            const containerRect = this.el.getBoundingClientRect();
            const itemRect = this.dragItemEl.getBoundingClientRect();
            const centerX = itemRect.left + itemRect.width / 2;
            const centerY = itemRect.top + itemRect.height / 2;
            const isInside = (centerX >= containerRect.left && centerX <= containerRect.right && 
                              centerY >= containerRect.top && centerY <= containerRect.bottom);
            if (!isInside) {
                if (item) {
                    const result = await this.manager.checkDropTarget(clientX, clientY, this.id, item);
                    if (result && result.isPending) {
                        this.dragItemEl.remove();
                        handled = true; 
                    } else {
                        handled = !!result;
                        if (handled) this.dragItemEl.remove();
                    }
                }
            } else {
                this.returnToContainer(this.dragItemEl, containerRect);
                
                const maxX = containerRect.width - 48;
                const maxY = containerRect.height - 48;
                const globalLeft = parseFloat(this.dragItemEl.style.left); // Actually it's local now
                const globalTop = parseFloat(this.dragItemEl.style.top);
                
                const clampedX = Math.max(0, Math.min(globalLeft, maxX));
                const clampedY = Math.max(0, Math.min(globalTop, maxY));
                
                this.dragItemEl.style.left = `${clampedX}px`;
                this.dragItemEl.style.top = `${clampedY}px`;
                this.manager.gameEngine.gameLogicRef.invokeMethodAsync('UpdateInventoryItemPosition', id, clampedX, clampedY);
                handled = true;
            }
            if (!handled && this.dragItemEl && document.body.contains(this.dragItemEl)) {
                this.returnToContainer(this.dragItemEl, containerRect);
                this.revertPosition(this.dragItemEl, this.originalPos.x, this.originalPos.y);
            }
            this.isDraggingItem = false;
            if(this.dragItemEl) {
                this.dragItemEl.style.zIndex = '';
                this.dragItemEl.style.cursor = 'grab';
                this.dragItemEl = null;
            }
        }
        
        if (this.isDragging) {
            this.isDragging = false;
            this.el.style.cursor = 'default';
        }
    }
    returnToContainer(itemEl, containerRect) {
        if (!itemEl || !this.el.contains(itemEl)) {
            this.el.appendChild(itemEl);
        }
        const globalLeft = parseFloat(itemEl.style.left);
        const globalTop = parseFloat(itemEl.style.top);
        
        itemEl.style.position = 'absolute';
        itemEl.style.left = `${globalLeft - containerRect.left}px`;
        itemEl.style.top = `${globalTop - containerRect.top}px`;
        itemEl.style.zIndex = '';
    }
    revertPosition(el, targetX, targetY) {
        el.style.transition = "left 0.2s ease-out, top 0.2s ease-out";
        el.style.left = `${targetX}px`;
        el.style.top = `${targetY}px`;
        setTimeout(() => { el.style.transition = ""; }, 200);
    }
    bringToFront() { this.el.style.zIndex = '1401'; }
    dispose() {
        if (this.el) this.el.remove();
    }
}