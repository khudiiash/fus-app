import Minecraft from "./Minecraft.js";
import FocusStateType from "../util/FocusStateType.js";
import GuiIngameMenu from "./gui/screens/GuiIngameMenu.js";
import Keyboard from "../util/Keyboard.js";
import GuiLoadingScreen from "./gui/screens/GuiLoadingScreen.js";

/**
 * Shortcuts browsers reserve for DevTools / inspector. When we call preventDefault() on
 * window key events, those must be skipped so DevTools (F12, Ctrl+Shift+I, etc.) still work.
 */
function isBrowserUiShortcut(event) {
    if (event.code === "F12" || event.code === "F11") {
        return true;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.shiftKey) {
        if (["KeyI", "KeyJ", "KeyC", "KeyK", "KeyE"].includes(event.code)) {
            return true;
        }
    }
    if (event.metaKey && event.altKey) {
        if (event.code === "KeyI" || event.code === "KeyJ") {
            return true;
        }
    }
    return false;
}

export default class GameWindow {

    constructor(minecraft, canvasWrapperId) {
        this.minecraft = minecraft;

        this.width = 0;
        this.height = 0;

        this.mouseX = 0;
        this.mouseY = 0;

        this.mouseMotionX = 0;
        this.mouseMotionY = 0;

        this.mouseInsideWindow = false;

        this.mouseDownInterval = null;
        this.focusState = FocusStateType.EXITED;
        this.lastIngameSwitchTime = 0;

        this.mobileDevice = this.detectTouchDevice();

        // Initialize canvas elements
        this.initializeElements(canvasWrapperId);

        // Register listeners
        // FUS Vue embed drives touch (joystick / look / keys). Built-in mobile listeners
        // fire onMouseClicked(2) on every touchend and Keyboard.unPressAll() on left release,
        // which fights the overlay and can break+place in one gesture (same-cell "replace").
        if (
            this.mobileDevice &&
            typeof window !== "undefined" &&
            window.__LABY_MC_FUS_EMBED__
        ) {
            this.registerListener(window, "resize", () => {
                this.updateWindowSize();
            });
            /** In-world: hotbar slot taps. With GUI: forward pointer events like desktop `mousedown`. */
            this.registerFusEmbedTouchInputBridge();
        } else if (this.mobileDevice) {
            this.registerMobileListeners();
        } else {
            this.registerDesktopListeners();
        }

        // Create keyboard
        Keyboard.create();
    }

    initializeElements(canvasWrapperId) {
        // Get canvas wrapper
        this.wrapper = document.getElementById(canvasWrapperId);

        // Remove all children of wrapper
        while (this.wrapper.firstChild) {
            this.wrapper.removeChild(this.wrapper.firstChild);
        }

        // Create render layers
        this.canvasWorld = document.createElement('canvas');
        this.canvasDebug = document.createElement('canvas');
        this.canvasChat = document.createElement('canvas');
        this.canvasPlayerList = document.createElement('canvas');
        this.canvasItems = document.createElement('canvas');

        // Create canvas renderer
        this.canvas = document.createElement('canvas');
        this.wrapper.appendChild(this.canvas);
    }

    registerDesktopListeners() {
        this.registerListener(window, 'resize', event => {
            this.updateWindowSize();
        });
        this.registerListener(document, 'mousedown', event => {
            // In-Game mouse click
            this.minecraft.onMouseClicked(event.button);

            // Start interval to repeat the mouse event
            if (this.mouseDownInterval !== null) {
                clearInterval(this.mouseDownInterval);
            }
            this.mouseDownInterval = setInterval(_ => this.minecraft.onMouseClicked(event.button), 250);

            // Handle mouse click on screen
            let currentScreen = this.minecraft.currentScreen;
            if (currentScreen !== null) {
                currentScreen.mouseClicked(
                    event.x / this.scaleFactor,
                    event.y / this.scaleFactor,
                    event.code
                );
            }

            // Fix cursor lock state
            this.requestCursorUpdate();

            // Request lock on click
            if (this.minecraft.currentScreen === null && this.focusState === FocusStateType.EXITED) {
                this.updateFocusState(FocusStateType.REQUEST_LOCK);
            }

            this.initialSoundEngine();
        });
        this.registerListener(document, 'mousemove', event => {
            this.mouseX = event.clientX / this.scaleFactor;
            this.mouseY = event.clientY / this.scaleFactor;

            this.mouseMotionX = event.movementX;
            this.mouseMotionY = -event.movementY;

            // Handle mouse move on screen
            let currentScreen = this.minecraft.currentScreen;
            if (currentScreen !== null) {
                currentScreen.mouseDragged(event.x / this.scaleFactor, event.y / this.scaleFactor, event.code);
            }

            this.requestCursorUpdate();
        });
        this.registerListener(document, 'mouseup', event => {
            // Handle mouse release on screen
            let currentScreen = this.minecraft.currentScreen;
            if (currentScreen !== null) {
                currentScreen.mouseReleased(
                    event.x / this.scaleFactor,
                    event.y / this.scaleFactor,
                    event.code
                );
            }

            if (this.mouseDownInterval !== null) {
                clearInterval(this.mouseDownInterval);
            }
        });
        this.registerListener(document, 'pointerlockchange', event => {
            let intentState = this.focusState.getIntent(); // Get target state we want to switch into
            let isCursorLocked = this.isCursorLockedToCanvas(); // Get current state of the canvas lock
            let isLockIntent = intentState === FocusStateType.LOCKED; // Check if we want to lock the cursor

            let lastSwitchDuration = Date.now() - this.lastIngameSwitchTime;
            if (this.focusState === FocusStateType.LOCKED && !isCursorLocked && lastSwitchDuration < 200) {
                // If the user exists the inventory by using the escape key, the cursor unlocks from the canvas,
                // so we have to prevent that by switching immediately to the request state
                this.focusState = FocusStateType.REQUEST_LOCK;
            } else {
                if (intentState === null) {
                    // The state changed unintentionally, so we have to choose a new state from the current canvas lock
                    this.updateFocusState(isCursorLocked ? FocusStateType.LOCKED : FocusStateType.EXITED);
                } else if (isCursorLocked === isLockIntent) {
                    // Check if the canvas completed the lock operation like intended and change the state to its final state
                    this.updateFocusState(intentState);
                }
            }
        });
        this.registerListener(this.wrapper, 'mouseover', event => {
            // Enable keyboard util handling
            Keyboard.setEnabled(true);
            this.mouseInsideWindow = true;

            // Update cursor lock
            this.requestCursorUpdate();
        });
        this.registerListener(this.wrapper, 'mouseleave', event => {
            // Disable keyboard util handling
            Keyboard.setEnabled(false);
            this.mouseInsideWindow = false;

            // Update cursor lock
            this.requestCursorUpdate();
        });
        this.registerListener(document, 'mouseout', event => {
            this.requestCursorUpdate();
        });
        this.registerListener(document, 'mouseenter', event => {
            this.requestCursorUpdate();
        });
        this.registerListener(window, 'keydown', event => {
            if (!isBrowserUiShortcut(event)) {
                event.preventDefault();
            }

            // Ignore key input if mouse is not inside window
            if (!this.mouseInsideWindow) {
                return;
            }

            // Handle escape press if focus is still in requesting state
            if (event.key === 'Escape' && this.minecraft.currentScreen === null) {
                this.updateFocusState(FocusStateType.REQUEST_EXIT);
                return;
            }

            let currentScreen = this.minecraft.currentScreen;
            if (currentScreen === null) {
                // Handle in-game key press
                this.minecraft.onKeyPressed(event.code);
            } else {
                // Handle key type on screen
                currentScreen.keyTyped(event.code, event.key);
            }

            this.requestCursorUpdate();
        }, false);
        this.registerListener(window, 'keyup', event => {
            // Handle key release on screen
            let currentScreen = this.minecraft.currentScreen;
            if (currentScreen !== null) {
                currentScreen.keyReleased(event.code);
            }
        }, false);
        this.registerListener(document, 'contextmenu');
        this.registerListener(this.wrapper, 'wheel', event => {
            event.stopPropagation();

            // Handle mouse scroll
            let delta = Math.sign(event.deltaY);
            this.minecraft.onMouseScroll(delta);
        });
    }

    /**
     * FUS SPA + coarse pointer: vanilla mobile listeners are disabled (they fight the Vue touch HUD).
     * — Window capture: bottom hotbar taps → hotbar slot (see {@link IngameOverlay#renderHotbar}).
     * — Wrapper capture: when a 2D GUI is open, route pointer events to {@link GuiScreen}.
     */
    registerFusEmbedTouchInputBridge() {
        /** @type {number | null} */
        this._fusGuiCaptureId = null;

        const clientToGame = (ev) => {
            const r = this.wrapper.getBoundingClientRect();
            const x = ((ev.clientX - r.left) / Math.max(1, r.width)) * this.width;
            const y = ((ev.clientY - r.top) / Math.max(1, r.height)) * this.height;
            return { x, y };
        };

        // FUS: geometry must match IngameOverlay.renderHotbar (padLeft, extraGap, extraW).
        const FUS_HOTBAR_PAD_LEFT = 10;
        const FUS_HOTBAR_EXTRA_GAP = 2;
        const FUS_HOTBAR_EXTRA_W = 20;

        const fusHotbarSlotAt = (gx, gy) => {
            const w = this.width;
            const h = this.height;
            const hbX = w / 2 - 91 - FUS_HOTBAR_PAD_LEFT;
            const hbY = h - 22;
            if (gy < hbY - 6 || gy > hbY + 26) return null;
            const ex0 = hbX + 200 + FUS_HOTBAR_EXTRA_GAP;
            const ex1 = ex0 + FUS_HOTBAR_EXTRA_W;
            if (gx >= ex0 - 2 && gx <= ex1 + 2) return 9;
            if (gx < hbX - 2 || gx > hbX + 182) return null;
            const slot = Math.floor((gx - hbX) / 20);
            if (slot < 0 || slot > 8) return null;
            return slot;
        };

        const onWindowHotbarPointerDown = (ev) => {
            const fusEmbed = typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__;
            if (!this.mobileDevice && !fusEmbed) return;
            if (!ev.isPrimary) return;
            if (this.minecraft.currentScreen !== null) return;
            if (!this.minecraft.isInGame()) return;
            const inv = this.minecraft.player?.inventory;
            if (!inv) return;
            const { x, y } = clientToGame(ev);
            const slot = fusHotbarSlotAt(x, y);
            if (slot === null) return;
            if (slot === 9) {
                try {
                    if (typeof window.__fusLabyOpenHotbarExtras === "function") {
                        window.__fusLabyOpenHotbarExtras();
                    }
                } catch (_) {
                    /* ignore */
                }
                ev.preventDefault();
                ev.stopImmediatePropagation();
                return;
            }
            inv.selectedSlotIndex = slot;
            this.mouseX = x;
            this.mouseY = y;
            this.initialSoundEngine();
            ev.preventDefault();
            ev.stopImmediatePropagation();
        };
        window.addEventListener("pointerdown", onWindowHotbarPointerDown, true);

        const onPointerDown = (ev) => {
            if (this.minecraft.currentScreen === null) return;
            if (!ev.isPrimary) return;
            const { x, y } = clientToGame(ev);
            this.mouseX = x;
            this.mouseY = y;
            const btnCode = ev.button === 2 ? "Mouse2" : "Mouse0";
            this.minecraft.currentScreen.mouseClicked(x, y, btnCode);
            try {
                this.wrapper.setPointerCapture(ev.pointerId);
            } catch (_) {
                /* ignore */
            }
            this._fusGuiCaptureId = ev.pointerId;
            this.initialSoundEngine();
            ev.preventDefault();
            ev.stopPropagation();
        };

        const onPointerMove = (ev) => {
            if (this._fusGuiCaptureId !== ev.pointerId) return;
            if (this.minecraft.currentScreen === null) return;
            const { x, y } = clientToGame(ev);
            this.mouseX = x;
            this.mouseY = y;
            const btnCode = ev.button === 2 ? "Mouse2" : "Mouse0";
            this.minecraft.currentScreen.mouseDragged(x, y, btnCode);
            ev.preventDefault();
            ev.stopPropagation();
        };

        const endGuiPointer = (ev) => {
            if (this._fusGuiCaptureId !== ev.pointerId) return;
            if (this.minecraft.currentScreen !== null) {
                const { x, y } = clientToGame(ev);
                const btnCode = ev.button === 2 ? "Mouse2" : "Mouse0";
                this.minecraft.currentScreen.mouseReleased(x, y, btnCode);
            }
            try {
                this.wrapper.releasePointerCapture(ev.pointerId);
            } catch (_) {
                /* ignore */
            }
            this._fusGuiCaptureId = null;
            ev.preventDefault();
            ev.stopPropagation();
        };

        this.wrapper.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("pointermove", onPointerMove, true);
        window.addEventListener("pointerup", endGuiPointer, true);
        window.addEventListener("pointercancel", endGuiPointer, true);
    }

    registerMobileListeners() {
        let touchStartTime = 0;
        let prevTouched = false;

        this.registerListener(window, 'resize', event => {
            this.updateWindowSize();
        });
        this.registerListener(document, 'touchstart', event => {
            for (let i = 0; i < event.touches.length; i++) {
                let touch = event.touches[i];
                let x = touch.pageX;
                let y = touch.pageY;

                // Handle mouse click on screen
                let currentScreen = this.minecraft.currentScreen;
                if (currentScreen !== null) {
                    currentScreen.mouseClicked(
                        x / this.scaleFactor,
                        y / this.scaleFactor,
                        0
                    );
                }

                let isRightHand = x > this.wrapper.offsetWidth / 2;

                // Handle player movement
                if (isRightHand) {
                    touchStartTime = Date.now();
                } else {
                    let tileSize = this.wrapper.offsetWidth / 8;

                    let tileX = 0;
                    let tileY = this.wrapper.offsetHeight - tileSize * 3;

                    let relX = x - tileX;
                    let relY = y - tileY;

                    let tileIndex = Math.floor(relX / tileSize) + Math.floor(relY / tileSize) * 3;

                    // Walk buttons
                    switch (tileIndex) {
                        case 0:
                        case 1:
                        case 2:
                            Keyboard.setState("KeyW", true);
                            break;
                        case 3:
                            Keyboard.setState("KeyA", true);
                            break;
                        case 4:
                            Keyboard.setState("Space", true);
                            break;
                        case 5:
                            Keyboard.setState("KeyD", true);
                            break;
                        case 6:
                        case 7:
                        case 8:
                            Keyboard.setState("KeyS", true);
                            break;
                    }
                }
            }
        }, false);
        this.registerListener(document, 'touchmove', event => {
            for (let i = 0; i < event.touches.length; i++) {
                let touch = event.touches[i];
                let x = touch.pageX;
                let y = touch.pageY;

                // Handle mouse move on screen
                let currentScreen = this.minecraft.currentScreen;
                if (currentScreen !== null) {
                    currentScreen.mouseDragged(
                        x / this.scaleFactor,
                        y / this.scaleFactor,
                        0
                    );
                }

                // Right hand
                let isRightHand = x > this.wrapper.offsetWidth / 2;

                // Handle player movement
                if (isRightHand) {
                    if (prevTouched) {
                        this.mouseMotionX = (x - prevTouched.pageX) * 10;
                        this.mouseMotionY = -(y - prevTouched.pageY) * 10;
                    }
                    prevTouched = touch;
                    touchStartTime = Date.now();
                }
            }
        }, false);
        this.registerListener(document, 'touchend', event => {
            // Break block
            if (!prevTouched && touchStartTime !== 0 && (Date.now() - touchStartTime) < 1000) {
                this.minecraft.onMouseClicked(2);
            }

            prevTouched = false;
            touchStartTime = 0;

            // Handle touches
            for (let i = 0; i < event.changedTouches.length; i++) {
                let touch = event.changedTouches[i];
                let x = touch.pageX;
                let y = touch.pageY;

                // Handle mouse release on screen
                let currentScreen = this.minecraft.currentScreen;
                if (currentScreen !== null) {
                    currentScreen.mouseReleased(
                        x / this.scaleFactor,
                        y / this.scaleFactor,
                        0
                    );
                }

                // Left hand
                let isLeftHand = touch.pageX < this.wrapper.offsetWidth / 2;

                // Release all keys
                if (isLeftHand) {
                    Keyboard.unPressAll();
                    break;
                }
            }

            this.initialSoundEngine();
        }, false);
        this.registerListener(document, 'contextmenu');

        // Break block listener
        setInterval(() => {
            if (touchStartTime !== 0 && (Date.now() - touchStartTime) > 250) {
                touchStartTime = Date.now();
                this.minecraft.onMouseClicked(0);
            }
        }, 200);
    }

    updateWindowSize() {
        this.updateScaleFactor();

        let wrapperWidth = this.width * this.scaleFactor;
        let wrapperHeight = this.height * this.scaleFactor;

        let worldRenderer = this.minecraft.worldRenderer;
        let itemRenderer = this.minecraft.itemRenderer;

        // Update world renderer size and camera
        worldRenderer.camera.aspect = this.width / this.height;
        worldRenderer.camera.updateProjectionMatrix();
        worldRenderer.webRenderer.setSize(wrapperWidth, wrapperHeight);

        // Update item renderer size and camera
        itemRenderer.camera.aspect = this.width / this.height;
        itemRenderer.camera.updateProjectionMatrix();
        itemRenderer.webRenderer.setSize(wrapperWidth, wrapperHeight);

        // Update canvas 2d size
        this.canvas.style.width = wrapperWidth + "px";
        this.canvas.style.height = wrapperHeight + "px";

        if (this.canvasDebug.width !== this.canvas.width || this.canvasDebug.height !== this.canvas.height) {
            this.canvasDebug.width = this.canvas.width;
            this.canvasDebug.height = this.canvas.height;
        }

        if (this.canvasChat.width !== this.canvas.width || this.canvasChat.height !== this.canvas.height) {
            this.canvasChat.width = this.canvas.width;
            this.canvasChat.height = this.canvas.height;
        }

        if (this.canvasPlayerList.width !== this.canvas.width || this.canvasPlayerList.height !== this.canvas.height) {
            this.canvasPlayerList.width = this.canvas.width;
            this.canvasPlayerList.height = this.canvas.height;
        }

        // Reinitialize gui
        this.minecraft.screenRenderer.initialize();

        // Reinitialize current screen
        if (this.minecraft.currentScreen !== null) {
            this.minecraft.currentScreen.setup(this.minecraft, this.width, this.height);
        }

        this.minecraft.ingameOverlay.chatOverlay.setDirty();

        // Render first frame
        if (this.minecraft.isInGame()) {
            this.minecraft.worldRenderer.render(0);
            this.minecraft.onRender(0)
        }
    }

    updateScaleFactor() {
        let wrapperWidth = this.wrapper.offsetWidth;
        let wrapperHeight = this.wrapper.offsetHeight;

        let scale;
        for (scale = 1; wrapperWidth / (scale + 1) >= 320 && wrapperHeight / (scale + 1) >= 240; scale++) {
            // Empty
        }

        this.scaleFactor = scale;
        this.width = Math.ceil(wrapperWidth / scale);
        this.height = Math.ceil(wrapperHeight / scale);
    }

    isCursorLockedToCanvas() {
        // The actual state of the browser cursor lock
        return document.pointerLockElement === this.canvas;
    }

    isLocked() {
        // FUS + touch: pointer lock is often unavailable; treat in-game as “locked” so movement/look work.
        if (
            typeof window !== "undefined" &&
            window.__LABY_MC_FUS_EMBED__ &&
            this.mobileDevice &&
            this.minecraft.isInGame() &&
            this.minecraft.currentScreen === null
        ) {
            return true;
        }
        // The actual definition for the game if the cursor is locked or not
        return this.focusState.isLock() && this.minecraft.currentScreen === null;
    }

    updateFocusState(state) {
        if (state.getIntent() === this.focusState || state === this.focusState) {
            return;
        }

        let prevLock = this.focusState.isLock();
        let nextLock = state.isLock();

        // Update state
        this.focusState = state;

        // Update cursor visibility
        document.body.style.cursor = nextLock ? 'none' : 'default';

        // Request lock state
        this.requestCursorUpdate();

        // Open menu on exit
        if (prevLock !== nextLock) {
            let currentScreen = this.minecraft.currentScreen;

            // Open in-game menu
            if (currentScreen === null && !nextLock) {
                this.minecraft.displayScreen(new GuiIngameMenu());
            }

            // Close current screen
            if (!(currentScreen instanceof GuiLoadingScreen) && nextLock) {
                this.minecraft.displayScreen(null);
                this.lastIngameSwitchTime = Date.now();
            }
        }
    }

    requestCursorUpdate() {
        // Check if the current state doesn't match the canvas lock
        if (this.mouseInsideWindow && this.focusState.isLock() !== this.isCursorLockedToCanvas()) {
            // Request cursor lock depending on the state
            if (this.focusState.isLock()) {
                this.canvas.requestPointerLock();
            } else {
                document.exitPointerLock();
            }
        }
    }

    detectTouchDevice() {
        let match = window.matchMedia || window.msMatchMedia;
        if (match) {
            let mq = match("(pointer:coarse)");
            return mq.matches;
        }
        return false;
    }

    getMemoryLimit() {
        return this.getMemoryValue("jsHeapSizeLimit", 1);
    }

    getMemoryAllocated() {
        return this.getMemoryValue("totalJSHeapSize", 0);
    }

    getMemoryUsed() {
        return this.getMemoryValue("usedJSHeapSize", 0);
    }

    getMemoryValue(key, fallbackValue = 0) {
        let performance = window.performance || window.msPerformance || window.webkitPerformance || window.mozPerformance;
        if (performance && performance.memory && performance.memory[key]) {
            return performance.memory[key];
        }
        return fallbackValue;
    }

    getGPUName() {
        let gl = this.canvasWorld.getContext("webgl2");
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        return gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    }

    openUrl(url, newTab) {
        // FUS Vue embed: never navigate away (stop()/menus may run without a stable flag order).
        if (typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__) {
            return;
        }
        if (newTab) {
            window.open(url, '_blank').focus();
        } else {
            window.location = url;
        }
    }

    close() {
        // Standalone game used to send users to the upstream repo. In FUS Vue embed,
        // `Minecraft.stop()` runs on route leave / HMR — must not hijack `window.location`.
        if (typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__) {
            return;
        }
        this.openUrl(Minecraft.URL_GITHUB);
    }

    async getClipboardText() {
        return navigator.clipboard.readText();
    }

    isMobileDevice() {
        return this.mobileDevice;
    }

    pullMouseMotionX() {
        let value = this.mouseMotionX;
        this.mouseMotionX = 0;
        return value;
    }

    pullMouseMotionY() {
        let value = this.mouseMotionY;
        this.mouseMotionY = 0;
        return value;
    }

    initialSoundEngine() {
        // Create sound engine (It has to be created after user interaction)
        if (!this.minecraft.soundManager.isCreated()) {
            this.minecraft.soundManager.create(this.minecraft.worldRenderer);
        }
    }

    registerListener(parent, event, listener = null, preventDefaults = true) {
        parent.addEventListener(event, event => {
            if (preventDefaults) {
                event.preventDefault();
            }

            if (listener !== null) {
                listener(event);
            }
        });
    }
}
