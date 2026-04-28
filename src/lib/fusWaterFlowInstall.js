import World from '@labymc/src/js/net/minecraft/client/world/World.js'

/**
 * Lightweight still-water gravity: any water block with air below flows down one layer.
 * Writes are **not** mirrored to RTDB — use {@link mc.fusSuppressWorldEditWrite} (see
 * {@link installFusWorldEditsRtdb}) so shared worlds are not spammed with fluid steps.
 *
 * Disable entirely: {@code mc.fusWaterFlowDisabled = true}
 *
 * @param {import('@labymc/src/js/net/minecraft/client/Minecraft.js').default} mc
 * @returns {() => void}
 */
export function installFusWaterFlow(mc) {
  if (!mc?.world) {
    return () => {}
  }

  const WATER_ID = 9
  let phase = 0
  const prevOnTick = mc.world.onTick.bind(mc.world)

  mc.world.onTick = function fusWaterFlowOnTick() {
    prevOnTick()
    phase = (phase + 1) % 3
    if (phase !== 0) return
    if (mc.fusWaterFlowDisabled) return
    const world = this
    const pl = mc.player
    if (!pl) return
    const pcx = Math.floor(pl.x) >> 4
    const pcz = Math.floor(pl.z) >> 4
    if (!world.chunkExists(pcx, pcz)) return

    for (let n = 0; n < 24; n++) {
      const bx = Math.floor(pl.x) + ((Math.random() * 56) | 0) - 28
      const bz = Math.floor(pl.z) + ((Math.random() * 56) | 0) - 28
      if (!world.chunkExists(bx >> 4, bz >> 4)) continue

      for (let y = 1; y < World.TOTAL_HEIGHT - 1 && y < 130; y++) {
        if (world.getBlockAt(bx, y, bz) !== WATER_ID) continue
        if (world.getBlockAt(bx, y - 1, bz) !== 0) continue
        mc.fusSuppressWorldEditWrite = true
        try {
          world.setBlockAt(bx, y - 1, bz, WATER_ID)
        } finally {
          mc.fusSuppressWorldEditWrite = false
        }
        break
      }
    }
  }

  return () => {
    mc.world.onTick = prevOnTick
  }
}
