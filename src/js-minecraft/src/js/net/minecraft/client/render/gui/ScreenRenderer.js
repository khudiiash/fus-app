export default class ScreenRenderer {

    constructor(minecraft, window) {
        this.minecraft = minecraft;
        this.window = window;
    }

    initialize() {
        let scale = this.getLimitedScaleFactor();

        // Update camera size
        this.window.canvas.width = this.window.width * scale;
        this.window.canvas.height = this.window.height * scale;

        // Get context stack of 2d canvas
        this.stack2d = this.window.canvas.getContext('2d');
        this.stack2d.webkitImageSmoothingEnabled = false;
        this.stack2d.mozImageSmoothingEnabled = false;
        this.stack2d.imageSmoothingEnabled = false;
    }

    render(partialTicks) {
        let scale = this.getLimitedScaleFactor();

        let mouseX = this.minecraft.window.mouseX;
        let mouseY = this.minecraft.window.mouseY;

        this.stack2d.save();

        // Draw world to canvas
        if (this.minecraft.isInGame()) {
            this.stack2d.drawImage(this.window.canvasWorld, 0, 0, this.window.width * scale, this.window.height * scale);
        } else {
            this.reset();
        }

        // Scale GUI (canvas 2D: two arguments; third is ignored in browsers)
        this.stack2d.scale(scale, scale);

        try {
            // Render in-game overlay (hotbar, crosshair, FUS health) only when no menu — keeps
            // settings / controls full-screen and avoids HUD bleeding through the dim layer.
            if (this.minecraft.isInGame() && this.minecraft.loadingScreen === null) {
                if (this.minecraft.currentScreen === null) {
                    this.minecraft.ingameOverlay.render(this.stack2d, mouseX, mouseY, partialTicks);
                }
            }

            // Render current screen
            if (this.minecraft.currentScreen !== null) {
                this.minecraft.currentScreen.drawScreen(this.stack2d, mouseX, mouseY, partialTicks)
            }
        } catch (e) {
            console.error(e);
            console.log(e.stack);
        }

        // Undo the GUI {@code scale} from above — must use the same factor as
        // {@link #getLimitedScaleFactor} (not raw {@code scaleFactor}) or the
        // matrix drifts when {@code min(scaleFactor,4) !== scaleFactor}.
        this.stack2d.scale(1 / scale, 1 / scale);

        /**
         * 3D hotbar items render to `canvasItems` with {@link ItemRenderer#webRenderer#setPixelRatio},
         * so the buffer can be w×DPR by h×DPR. The 2D overlay / hotbar strip uses *logical* w×h. Blitting
         * with the 2-argument `drawImage` only placed the intrinsic texture at (0,0) — the items layer
         * was shorter / offset vs the 2D GUI and looked “floating” above the slots (see FUS Laby / Android
         * DPR). Stretch to the same destination rect as {@code canvasWorld} above.
         */
        const cvi = this.window.canvasItems;
        this.stack2d.drawImage(
            cvi,
            0,
            0,
            cvi.width,
            cvi.height,
            0,
            0,
            this.window.width * scale,
            this.window.height * scale,
        );

        this.stack2d.restore();
    }

    reset() {
        this.stack2d.clearRect(0, 0, this.window.canvas.width, this.window.canvas.height);
    }

    getLimitedScaleFactor() {
        return Math.min(this.window.scaleFactor, 4);
    }

}