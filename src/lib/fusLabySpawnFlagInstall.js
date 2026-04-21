import * as THREE from '@labymc/libraries/three.module.js'
import { ref as dbRef, set as dbSet } from 'firebase/database'
import { FUS_LABY_FLAG_CHANNEL_MS } from '@labymc/src/js/net/minecraft/client/fus/FusLabyFlagChannel.js'

/**
 * Spawn-flag + channelled teleport.
 *
 * Installs two public methods on the engine instance:
 *   • {@code mc.fusPlaceSpawnFlag()} — snapshot the player's current integer block position
 *     to RTDB under `worldSpawnFlags/{worldId}/{uid}` and mirror on `mc.fusSpawnFlagPos`
 *     (no round-trip required for teleport).
 *   • {@code mc.fusLabyStartFlagTeleportChannel()` — begin a {@link FUS_LABY_FLAG_CHANNEL_MS}
 *     channelled teleport. While channelling:
 *       – The player cannot move or jump: we zero their WASD input and vertical motion
 *         each frame. Falls through gravity if they were airborne (correct; no levitation).
 *       – A helix of {@link HELIX_PARTICLES} small blue cubes spins around the player from
 *         ankle to head. Glow is achieved with additive blending on a base-colour emissive
 *         material; no postprocess bloom required.
 *       – The channel cancels on: opening a GUI, taking ≥ 1 damage (compared to initial
 *         health, so the PvP flash-heal window doesn't false-cancel), or the player dying.
 *
 *  The view polls {@code mc.fusLabyFlagChannelEndAt} every 220 ms to drive the progress bar
 *  (see LabyJsMinecraftView.vue); not changed by this rewrite so no UI wiring to touch.
 *
 * @param {any} mc
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

  /** @type {THREE.Group | null} */
  let helixGroup = null
  /** @type {{ mesh: THREE.Mesh, phase: number, heightFactor: number }[]} */
  let helixNodes = []
  /** Channel-cancel sentinels so the countdown tick can bail out safely. */
  let channelStartHealth = 0
  let channelRafId = 0
  let channelEndAt = 0

  const HELIX_PARTICLES = 18
  /** Two full rotations around the player during the 15 s channel = deliberate, not frantic. */
  const HELIX_REVOLUTIONS = 2

  const buildHelix = () => {
    const scene = mc.worldRenderer?.scene
    if (!scene) return
    helixGroup = new THREE.Group()
    helixNodes = []
    const geom = new THREE.BoxGeometry(0.12, 0.12, 0.12)
    /** Additive blending + saturated blue → lo-fi "mana glow" look that reads well in both
     *  day and night worlds. No `emissive` because MeshBasicMaterial ignores it. */
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3aaaff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    for (let i = 0; i < HELIX_PARTICLES; i++) {
      const mesh = new THREE.Mesh(geom, mat)
      const heightFactor = i / (HELIX_PARTICLES - 1)
      const phase = (i / HELIX_PARTICLES) * Math.PI * 2
      helixNodes.push({ mesh, phase, heightFactor })
      helixGroup.add(mesh)
    }
    scene.add(helixGroup)
  }

  const clearHelix = () => {
    if (!helixGroup) return
    const scene = mc.worldRenderer?.scene
    scene?.remove(helixGroup)
    for (const { mesh } of helixNodes) {
      try {
        mesh.geometry.dispose()
      } catch {
        /* shared geometry; ignore double-dispose */
      }
    }
    /** Dispose the shared material once, using the first node as the anchor. */
    if (helixNodes[0]) {
      try {
        helixNodes[0].mesh.material.dispose()
      } catch {
        /* ignore */
      }
    }
    helixGroup = null
    helixNodes = []
  }

  const updateHelix = (pl, channelT) => {
    if (!helixGroup) return
    /** `channelT` ∈ [0,1] — progress. Radius pulses out with progress so the cast feels like
     *  it's winding up: starts close, expands to ~1.2 blocks at completion. */
    const radius = 0.75 + 0.45 * channelT
    const baseAngle = channelT * Math.PI * 2 * HELIX_REVOLUTIONS
    helixGroup.position.set(pl.x, pl.y, pl.z)
    for (const node of helixNodes) {
      const angle = baseAngle + node.phase
      const y = node.heightFactor * 1.8 /** foot → crown height */
      node.mesh.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius)
    }
  }

  const cancelChannel = () => {
    if (channelRafId) {
      cancelAnimationFrame(channelRafId)
      channelRafId = 0
    }
    channelEndAt = 0
    mc.fusLabyFlagChannelEndAt = 0
    mc.fusLabyChannelLockMove = false
    clearHelix()
  }

  mc.fusLabyStartFlagTeleportChannel = function startFusLabyFlagTeleport() {
    const pos = mc.fusSpawnFlagPos
    if (!pos) return
    const pl = mc.player
    if (!pl) return
    /** Already channelling — ignore re-trigger. */
    if (channelEndAt && Date.now() < channelEndAt) return

    channelStartHealth = typeof pl.health === 'number' ? pl.health : 0
    channelEndAt = Date.now() + FUS_LABY_FLAG_CHANNEL_MS
    mc.fusLabyFlagChannelEndAt = channelEndAt
    mc.fusLabyChannelLockMove = true
    buildHelix()

    const tick = () => {
      channelRafId = 0
      const curEndAt = channelEndAt
      if (!curEndAt) return
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
      if (typeof curPl.health === 'number' && (curPl.health <= 0 || curPl.health + 0.001 < channelStartHealth)) {
        cancelChannel()
        return
      }

      /**
       * Hard-freeze horizontal input each frame. We zero the engine's input fields rather
       * than yanking the keyboard state so desktop users can still mash WASD — it simply
       * does nothing. Saves a re-sync dance when the channel ends.
       */
      curPl.moveForward = 0
      curPl.moveStrafing = 0
      curPl.jumping = false
      if (typeof curPl.motionX === 'number') curPl.motionX *= 0.5
      if (typeof curPl.motionZ === 'number') curPl.motionZ *= 0.5

      const t = 1 - (curEndAt - now) / FUS_LABY_FLAG_CHANNEL_MS
      updateHelix(curPl, Math.max(0, Math.min(1, t)))

      if (now >= curEndAt) {
        channelEndAt = 0
        mc.fusLabyFlagChannelEndAt = 0
        mc.fusLabyChannelLockMove = false
        clearHelix()
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

  /** Disposer — safe to call on view unmount even when no channel is active. */
  mc.fusDisposeLabySpawnFlag = cancelChannel
}
