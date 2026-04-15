import * as THREE from 'three'
import type { PresenceDoc } from '@/game/sharedWorldFirestore'
import { PLAYER_EYE_HEIGHT } from '@/game/playerConstants'

function colorFromUid(uid: string): number {
  let h = 0
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0
  return (h & 0xffffff) | 0x505050
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose()
      const mat = child.material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    }
  })
}

/**
 * Simple proxies for other players (same RTDB presence as classic block world).
 */
export class BlockWorldNextPresenceAvatars {
  private readonly scene: THREE.Scene
  private readonly selfUid: string
  private readonly roots = new Map<string, THREE.Group>()

  constructor(scene: THREE.Scene, selfUid: string) {
    this.scene = scene
    this.selfUid = selfUid
  }

  sync(map: Map<string, PresenceDoc>) {
    const seen = new Set<string>()
    for (const [uid, p] of map) {
      if (uid === this.selfUid) continue
      seen.add(uid)
      let g = this.roots.get(uid)
      if (!g) {
        g = new THREE.Group()
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(0.48, 1.65, 0.48),
          new THREE.MeshStandardMaterial({
            color: colorFromUid(uid),
            roughness: 0.78,
            metalness: 0.08,
          }),
        )
        body.position.y = 0.825
        body.castShadow = true
        body.receiveShadow = true
        g.add(body)
        this.scene.add(g)
        this.roots.set(uid, g)
      }
      const feetY = p.y - PLAYER_EYE_HEIGHT - 0.02
      g.position.set(p.x, feetY, p.z)
      g.rotation.y = p.ry
    }
    for (const [uid, g] of [...this.roots]) {
      if (!seen.has(uid)) {
        this.scene.remove(g)
        disposeObject3D(g)
        this.roots.delete(uid)
      }
    }
  }

  dispose() {
    for (const g of this.roots.values()) {
      this.scene.remove(g)
      disposeObject3D(g)
    }
    this.roots.clear()
  }
}
