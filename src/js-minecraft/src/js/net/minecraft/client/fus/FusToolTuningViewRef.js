/**
 * While a FUS tool tuning dat.gui is open, pointer lock is usually lost (`hasInGameFocus` false)
 * and in singleplayer `Minecraft.isPaused` skips `WorldRenderer.render`. Bumping this ref on
 * open/close keeps the 3D view running so live slider edits are visible.
 * @param {import("../Minecraft.js").default} mc
 */
export function fusToolTuningGuiBegin(mc) {
    mc.fusToolTuningGuiRefCount = (mc.fusToolTuningGuiRefCount | 0) + 1;
}

/**
 * @param {import("../Minecraft.js").default} mc
 */
export function fusToolTuningGuiEnd(mc) {
    mc.fusToolTuningGuiRefCount = Math.max(0, (mc.fusToolTuningGuiRefCount | 0) - 1);
}
