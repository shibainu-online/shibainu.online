export class TitleManager {
    constructor() {
        this.img = document.getElementById('title-bg-img');
        this.video = document.getElementById('title-bg-video');
        this.logo = document.getElementById('title-logo');
        this.container = document.getElementById('title-screen');
        
        this.init();
    }

    init() {
        if (!this.video) return;

        this.video.addEventListener('canplaythrough', () => {
            this.playVideoAndFade();
        }, { once: true });

        setTimeout(() => {
            if (this.video.paused) this.playVideoAndFade();
        }, 3000);
        
        this.video.load();
    }

    playVideoAndFade() {
        this.video.play().then(() => {
            console.log("[TitleManager] Video playing. Fading in.");
            
            this.video.style.opacity = '1';
            
            if (this.img) this.img.style.opacity = '0';
            
            if (this.logo) this.logo.classList.add('visible');

        }).catch(err => {
            console.warn("[TitleManager] Video play failed (autoplay policy?):", err);
            if (this.logo) this.logo.classList.add('visible');
        });
    }

    hide() {
        console.log("[TitleManager] Hiding title screen.");
        if (this.container) {
            this.container.classList.add('fade-out');
            
            setTimeout(() => {
                if (this.video) {
                    this.video.pause();
                    this.video.currentTime = 0;
                }
                this.container.style.display = 'none';
            }, 1500);
        }
    }
}

window.titleManager = new TitleManager();

window.HideTitleScreen = () => {
    if (window.titleManager) {
        window.titleManager.hide();
    }
};