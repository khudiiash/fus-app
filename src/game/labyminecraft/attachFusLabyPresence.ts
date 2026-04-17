import type { PresenceDoc } from '@/game/sharedWorldFirestore'
import {
  bindPresenceDisconnectRemove,
  deletePresence,
  subscribePresence,
  writePresence,
} from '@/game/sharedWorldFirestore'
import { LabyPresenceAvatars } from '@/game/labyminecraft/labyPresenceAvatars'
import { blockWorldAggressiveMobile } from '@/game/minebase/utils'
import * as THREE from '@labymc/libraries/three.module.js'

function presenceMotionKey(doc: PresenceDoc): string {
  return [
    `${doc.x.toFixed(2)}|${doc.y.toFixed(2)}|${doc.z.toFixed(2)}|${doc.ry.toFixed(3)}|${doc.hr.toFixed(3)}|${doc.moving ? 1 : 0}`,
    doc.playerHpHalfUnits ?? '',
    doc.mode ?? '',
    doc.slot ?? '',
    doc.bwBlockType ?? '',
    doc.bwHandMine ?? '',
    doc.bwToolMesh ?? '',
  ].join('|')
}

export type FusLabyPresenceHandle = {
  dispose: () => void
  getMeleeRaycastRoots: () => object[]
}

type McWithPresence = {
  worldRenderer: { scene: THREE.Scene }
  player: unknown
}

/**
 * RTDB presence for the Laby canvas: writes local pose and renders other UIDs as simple boxes.
 */
export function attachFusLabyPresence(opts: {
  mc: McWithPresence
  worldId: string
  uid: string
  buildPresence: () => PresenceDoc | null
}): FusLabyPresenceHandle {
  const { mc, worldId, uid, buildPresence } = opts
  const scene = mc.worldRenderer.scene
  const avatars = new LabyPresenceAvatars(scene, uid)
  const unsub = subscribePresence(worldId, (map) => {
    avatars.sync(map)
  })
  void bindPresenceDisconnectRemove(worldId, uid).catch((e) => {
    console.warn('[labyminecraft] bindPresenceDisconnectRemove', e)
  })
  const presenceTickMs = blockWorldAggressiveMobile() ? 220 : 150
  let stopped = false
  let lastSentKey = ''
  let lastWriteAt = 0
  const tick = () => {
    if (stopped) return
    const doc = buildPresence()
    if (!doc) return
    const k = presenceMotionKey(doc)
    const now = Date.now()
    if (k === lastSentKey && now - lastWriteAt < 25_000) return
    lastSentKey = k
    lastWriteAt = now
    void writePresence(worldId, uid, doc).catch((e) => {
      console.warn('[labyminecraft] writePresence', e)
    })
  }
  const presenceTimer = window.setInterval(tick, presenceTickMs)
  tick()

  return {
    dispose() {
      stopped = true
      window.clearInterval(presenceTimer)
      try {
        unsub()
      } catch {
        /* ignore */
      }
      avatars.dispose()
      void deletePresence(worldId, uid).catch(() => {})
    },
    getMeleeRaycastRoots: () => avatars.getMeleeRaycastRoots(),
  }
}
