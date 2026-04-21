import { ref as dbRef, set as dbSet } from 'firebase/database'
import { FUS_LABY_FLAG_CHANNEL_MS } from '@labymc/src/js/net/minecraft/client/fus/FusLabyFlagChannel.js'

/**
 * Install `mc.fusPlaceSpawnFlag()` and `mc.fusLabyStartFlagTeleportChannel()` on the running
 * engine instance, plus the `mc.fusSpawnFlagPos` / `mc.fusLabyFlagChannelEndAt` state fields
 * the view reads each 220 ms tick to drive the channel-progress bar.
 *
 * The previous installer file was lost in the submodule-deinit incident. This replacement keeps
 * the shape the view already expects (see `LabyJsMinecraftView.vue`'s `onLabyInventoryKeydown`
 * + coord-tick watcher) so no view-side rewiring is needed beyond calling this once at boot.
 *
 * Semantics (mirrors what the view calls "прапор" / "телепорт до прапора"):
 *  - `fusPlaceSpawnFlag()`: snapshot player's current integer block pos to
 *    `worldSpawnFlags/{worldId}/{uid}` in RTDB, and mirror locally on `mc.fusSpawnFlagPos` so
 *    subsequent teleports don't need a round-trip.
 *  - `fusLabyStartFlagTeleportChannel()`: arm a `FUS_LABY_FLAG_CHANNEL_MS` channel, expose its
 *    end time on `mc.fusLabyFlagChannelEndAt` (view polls it for the progress bar), then
 *    teleport the player on completion. Interrupted by taking ≥ 1 damage, moving beyond a small
 *    radius, or opening an ingame screen — matches the "channelled ability" UX the buttons imply.
 *
 * @param {any} mc - js-minecraft Minecraft instance
 * @param {{ worldId: string, uid: string, rtdb: any }} opts
 */
export function installFusLabySpawnFlag(mc, { worldId, uid, rtdb }) {
  if (!mc) return

  mc.fusPlaceSpawnFlag = async function placeFusSpawnFlag() {
    const pl = mc.player
    if (!pl) return
    const x = Math.floor(pl.x)
    const y = Math.floor(pl.y)
    const z = Math.floor(pl.z)
    mc.fusSpawnFlagPos = { x, y, z }
    if (rtdb && worldId && uid) {
      try {
        await dbSet(dbRef(rtdb, `worldSpawnFlags/${worldId}/${uid}`), {
          x,
          y,
          z,
          at: Date.now(),
        })
      } catch (e) {
        console.warn('[fusLabySpawnFlag] RTDB write failed', e)
      }
    }
  }

  /** Channel-cancel sentinels so the countdown tick can bail out safely. */
  let channelStartPos = null
  let channelInitialHealth = 0
  let channelRafId = 0

  const cancelChannel = () => {
    if (channelRafId) {
      cancelAnimationFrame(channelRafId)
      channelRafId = 0
    }
    channelStartPos = null
    mc.fusLabyFlagChannelEndAt = 0
  }

  /** Distance (blocks) the player may drift before the channel auto-cancels. Matches typical MMO channelled-TP feel. */
  const CANCEL_MOVE_RADIUS = 1.5

  mc.fusLabyStartFlagTeleportChannel = function startFusLabyFlagTeleport() {
    const pos = mc.fusSpawnFlagPos
    if (!pos) return
    const pl = mc.player
    if (!pl) return
    /** Already channelling — ignore re-trigger. */
    if (mc.fusLabyFlagChannelEndAt && Date.now() < mc.fusLabyFlagChannelEndAt) return

    channelStartPos = { x: pl.x, y: pl.y, z: pl.z }
    channelInitialHealth = typeof pl.health === 'number' ? pl.health : 0
    const endAt = Date.now() + FUS_LABY_FLAG_CHANNEL_MS
    mc.fusLabyFlagChannelEndAt = endAt

    const tick = () => {
      channelRafId = 0
      const curEndAt = mc.fusLabyFlagChannelEndAt
      if (!curEndAt || curEndAt !== endAt) return
      const now = Date.now()
      const curPl = mc.player
      if (!curPl) {
        cancelChannel()
        return
      }
      if (mc.currentScreen) {
        cancelChannel()
        return
      }
      if (typeof curPl.health === 'number' && curPl.health + 0.001 < channelInitialHealth) {
        cancelChannel()
        return
      }
      if (channelStartPos) {
        const dx = curPl.x - channelStartPos.x
        const dy = curPl.y - channelStartPos.y
        const dz = curPl.z - channelStartPos.z
        if (Math.hypot(dx, dy, dz) > CANCEL_MOVE_RADIUS) {
          cancelChannel()
          return
        }
      }
      if (now >= curEndAt) {
        mc.fusLabyFlagChannelEndAt = 0
        channelStartPos = null
        try {
          curPl.setPosition?.(pos.x + 0.5, pos.y + 0.2, pos.z + 0.5)
          if (typeof curPl.motionX === 'number') curPl.motionX = 0
          if (typeof curPl.motionY === 'number') curPl.motionY = 0
          if (typeof curPl.motionZ === 'number') curPl.motionZ = 0
        } catch (e) {
          console.warn('[fusLabySpawnFlag] teleport failed', e)
        }
        return
      }
      channelRafId = requestAnimationFrame(tick)
    }
    channelRafId = requestAnimationFrame(tick)
  }
}
