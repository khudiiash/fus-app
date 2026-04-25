import GuiScreen from "../GuiScreen.js";
import GuiButton from "../widgets/GuiButton.js";
import GuiSwitchButton from "../widgets/GuiSwitchButton.js";
import GuiSliderButton from "../widgets/GuiSliderButton.js";

function fusTogglePageFullscreen() {
    if (typeof document === "undefined") {
        return;
    }
    const doc = document;
    const active =
        doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement;
    if (active) {
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen;
        if (exit) {
            try {
                exit.call(doc);
            } catch (e) {
                console.warn("[GuiOptions] exitFullscreen failed", e);
            }
        }
        return;
    }
    const el = doc.documentElement;
    const req =
        el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) {
        try {
            const p = req.call(el);
            if (p && typeof p.then === "function") {
                p.catch((e) => console.warn("[GuiOptions] requestFullscreen failed", e));
            }
        } catch (e) {
            console.warn("[GuiOptions] requestFullscreen failed", e);
        }
    }
}

function fusIsPageFullscreen() {
    if (typeof document === "undefined") {
        return false;
    }
    const d = document;
    return Boolean(d.fullscreenElement || d.webkitFullscreenElement || d.mozFullScreenElement || d.msFullscreenElement);
}

export default class GuiOptions extends GuiScreen {

    constructor(previousScreen) {
        super();

        this.previousScreen = previousScreen;
    }

    init() {
        super.init();

        let settings = this.minecraft.settings;

        // A bit above center so the menu sits higher on the canvas (FUS Laby / mobile).
        let y = this.height / 2 - 70;
        this.buttonList.push(new GuiSwitchButton("Ambient Occlusion", settings.ambientOcclusion, this.width / 2 - 100, y, 200, 20, value => {
            settings.ambientOcclusion = value;
            this.minecraft.worldRenderer.rebuildAll();
        }));
        this.buttonList.push(new GuiSwitchButton("View Bobbing", settings.viewBobbing, this.width / 2 - 100, y + 24, 200, 20, value => {
            settings.viewBobbing = value;
        }));
        this.buttonList.push(new GuiSliderButton("FOV", settings.fov, 50, 100, this.width / 2 - 100, y + 24 * 2, 200, 20, value => {
            settings.fov = value;
        }));
        this.buttonList.push(new GuiSliderButton("Render Distance", settings.viewDistance, 2, 10, this.width / 2 - 100, y + 24 * 3, 200, 20, value => {
            settings.viewDistance = value;
        }));
        this.fusFullscreenButton = new GuiButton("Fullscreen", this.width / 2 - 100, y + 24 * 4, 200, 20, () => {
            fusTogglePageFullscreen();
            this.fusSyncFullscreenButtonLabel();
        });
        this.buttonList.push(this.fusFullscreenButton);
        this.fusSyncFullscreenButtonLabel();
        if (typeof document !== "undefined" && document.addEventListener) {
            this._fusFsChange = () => this.fusSyncFullscreenButtonLabel();
            document.addEventListener("fullscreenchange", this._fusFsChange);
            document.addEventListener("webkitfullscreenchange", this._fusFsChange);
        }

        if (typeof this.minecraft.fusTeleportToDefaultSpawn === "function") {
            this.buttonList.push(new GuiButton("Stuck? Teleport to world spawn", this.width / 2 - 100, y + 24 * 5, 200, 20, () => {
                try {
                    this.minecraft.fusTeleportToDefaultSpawn();
                } catch (e) {
                    console.warn("[GuiOptions] unstuck teleport failed", e);
                }
            }));
        }

        this.buttonList.push(new GuiButton("Done", this.width / 2 - 100, y + 24 * 6 + 10, 200, 20, () => {
            this.minecraft.displayScreen(this.previousScreen);
        }));
    }

    fusSyncFullscreenButtonLabel() {
        if (this.fusFullscreenButton) {
            this.fusFullscreenButton.string = fusIsPageFullscreen() ? "Exit fullscreen" : "Fullscreen";
        }
    }

    drawScreen(stack, mouseX, mouseY, partialTicks) {
        this.fusSyncFullscreenButtonLabel();
        // Background
        this.drawDefaultBackground(stack);

        // Title
        this.drawCenteredString(stack, "Settings", this.width / 2, 34);

        super.drawScreen(stack, mouseX, mouseY, partialTicks);
    }

    onClose() {
        if (this._fusFsChange && typeof document !== "undefined" && document.removeEventListener) {
            document.removeEventListener("fullscreenchange", this._fusFsChange);
            document.removeEventListener("webkitfullscreenchange", this._fusFsChange);
            this._fusFsChange = null;
        }
        // Save settings
        this.minecraft.settings.save();
    }

}