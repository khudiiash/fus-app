/**
 * {@link registerDesktopListeners} in GameWindow.js forwards `document` mousedown (bubble) to
 * `minecraft.onMouseClicked`, so any click that reaches `document` also mines/attacks. Stopping
 * propagation in the bubble phase on the dat.gui root keeps those events in the panel subtree.
 *
 * Do not stop `mousemove` / `mouseup` / `pointermove` / `pointerup` / `touchmove` / `touchend`
 * on the root: dat.gui registers those on `window` for number sliders, color drags, etc. If they
 * never reach `window`, sliders feel broken (wrong or frozen values). In GameWindow, the document
 * `mousemove` handler skips when `event.target` is under `.dg` so the camera does not turn while
 * the pointer is on the panel.
 * @param {HTMLElement} el
 */
export function installFusToolGuiInputShield(el) {
    if (!el) {
        return;
    }
    el.style.pointerEvents = "auto";
    const stop = (e) => {
        e.stopPropagation();
    };
    for (const t of [
        "pointerdown",
        "click",
        "mousedown",
        "wheel",
        "touchstart",
    ]) {
        el.addEventListener(t, stop, false);
    }
}
