import * as THREE from '@labymc/libraries/three.module.js'
import { ref as dbRef, set as dbSet } from 'firebase/database'
import { FUS_LABY_FLAG_CHANNEL_MS } from '@labymc/src/js/net/minecraft/client/fus/FusLabyFlagChannel.js'
import Keyboard from '@labymc/src/js/net/minecraft/util/Keyboard.js'
import { fusLabyEntityInTerrainDrawWindow } from './fusLabyEntityTerrainWindow.js'
import { fusLabyFeetYAtColumn, fusLabyResolvePeerTeleportPosition } from '@/lib/fusLabySpawnFeet'

/** Extra world-units on Y after resolving peer teleport (feet still clipped low for some builds). */
const FUS_LABY_PEER_TP_Y_LIFT_BLOCKS = 3

/**
 * Spawn-flag + channelled teleport — with a *visible* in-world marker and a dramatic
 * teleport VFX.
 *
 * Public surface installed on the engine instance:
 *   • {@code mc.fusPlaceSpawnFlag()} — snapshot the player's integer block position to
 *     RTDB under `worldSpawnFlags/{worldId}/{uid}`, mirror on `mc.fusSpawnFlagPos`, and
 *     rebuild the 3D marker so the owner can see where they dropped it.
 *   • {@code mc.fusRefreshSpawnFlagMarker()} — rebuild (or remove) the marker based on
 *     the current {@code mc.fusSpawnFlagPos}. Called by the view after it restores the
 *     position from RTDB on mount so the flag is visible on rejoin.
 *   • {@code mc.fusLabyStartFlagTeleportChannel()} — begin a
 *     {@link FUS_LABY_FLAG_CHANNEL_MS} channelled teleport. While channelling the
 *     player is input-locked, and a layered particle VFX swirls around them until
 *     completion (or cancels on GUI / damage / death).
 *
 * Visual design:
 *   1. Marker — an 8-block pole (stone-grey box) with a red billowing cloth (quad whose
 *      vertices are displaced each frame by a cheap sine field) and a soft additive
 *      halo at the base so the flag reads at a distance even in a forest.
 *   2. Teleport channel — three layers stacked: a fast inner helix (16 cubes), a slow
 *      outer orbital ring (24 cubes), and rising sparkle trails spawning from the feet
 *      each 50 ms. Colour shifts blue → cyan → white as progress approaches 1, and at
 *      t ≥ 0.92 we flash a bright burst sphere that scales up and fades out.
 *
 *   The animation budget is low: the shared-material + shared-geometry pattern keeps
 *   the draw-call count near-constant (one per layer), and we recycle sparkle meshes
 *   via a free-list so no per-frame allocations happen after the first second.
 *
 * @param {any} mc
 * @param {{ worldId: string, uid: string, rtdb: any }} opts
 */
export function installFusLabySpawnFlag(mc, { worldId, uid, rtdb }) {
  if (!mc) return
  if (mc.fusLabyPresenceTpChEndAt == null) {
    mc.fusLabyPresenceTpChEndAt = 0
  }
  if (mc.fusLabyPresenceTpChStartAt == null) {
    mc.fusLabyPresenceTpChStartAt = 0
  }
  let lastFlagRejectToastAt = 0
  const notifyFlagReject = (msg) => {
    const now = Date.now()
    if (now - lastFlagRejectToastAt < 1200) return
    lastFlagRejectToastAt = now
    try {
      mc.addMessageToChat?.(msg)
    } catch {
      /* ignore */
    }
  }

  /* ─────────────────────────────── Marker ──────────────────────────────── */

  /** @type {THREE.Group | null} */
  let markerGroup = null
  /** @type {THREE.Mesh | null} */
  let markerCloth = null
  /** @type {Float32Array | null} */
  let markerClothBaseY = null
  /** @type {THREE.Mesh | null} */
  let markerHalo = null

  const clearMarker = () => {
    if (!markerGroup) return
    const scene = mc.worldRenderer?.scene
    scene?.remove(markerGroup)
    markerGroup.traverse((o) => {
      if (o.isMesh) {
        try {
          o.geometry?.dispose?.()
        } catch {
          /* shared or already-disposed */
        }
        const m = o.material
        if (Array.isArray(m)) {
          m.forEach((mi) => mi.dispose?.())
        } else {
          m?.dispose?.()
        }
      }
    })
    markerGroup = null
    markerCloth = null
    markerClothBaseY = null
    markerHalo = null
  }

  const buildMarker = (pos) => {
    const scene = mc.worldRenderer?.scene
    if (!scene) return
    clearMarker()
    const group = new THREE.Group()
    /** Ground at (x+0.5, y, z+0.5) so the pole sits on the centre of the block cell. */
    group.position.set(pos.x + 0.5, pos.y, pos.z + 0.5)

    /** Pole — stone grey, 0.15 × 3.0 × 0.15 box, shifted up so its base sits on the block. */
    const poleGeom = new THREE.BoxGeometry(0.15, 3.0, 0.15)
    const poleMat = new THREE.MeshBasicMaterial({ color: 0x555a65 })
    const pole = new THREE.Mesh(poleGeom, poleMat)
    pole.position.y = 1.5
    group.add(pole)

    /** Finial (knob at top). */
    const finialGeom = new THREE.BoxGeometry(0.25, 0.25, 0.25)
    const finialMat = new THREE.MeshBasicMaterial({ color: 0xffd24a })
    const finial = new THREE.Mesh(finialGeom, finialMat)
    finial.position.y = 3.1
    group.add(finial)

    /**
     * Cloth — a 1.2 × 0.7 plane with 10 × 6 segments. We displace its local +Z per
     * vertex each animation tick to fake a wind billow. Plane is anchored on its left
     * edge so it pivots around the pole; in Three plane geometry is centred on origin
     * so we translate the geometry left by 0.6 before use and then position the mesh
     * flush with the pole.
     */
    const clothGeom = new THREE.PlaneGeometry(1.2, 0.7, 10, 6)
    clothGeom.translate(0.6, 0, 0)
    const clothMat = new THREE.MeshBasicMaterial({
      color: 0xe34747,
      side: THREE.DoubleSide,
    })
    const cloth = new THREE.Mesh(clothGeom, clothMat)
    cloth.position.set(0.075, 2.55, 0) /* just inside the pole on its right face */
    markerCloth = cloth
    const posAttr = clothGeom.attributes.position
    markerClothBaseY = new Float32Array(posAttr.count)
    for (let i = 0; i < posAttr.count; i++) {
      markerClothBaseY[i] = posAttr.getY(i)
    }
    group.add(cloth)

    /**
     * Halo — a thin additive disc at the pole's base that pulses scale/opacity. Helps
     * the marker read at a distance in dense chunks.
     */
    const haloGeom = new THREE.PlaneGeometry(1.8, 1.8)
    haloGeom.rotateX(-Math.PI / 2)
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0xffd24a,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const halo = new THREE.Mesh(haloGeom, haloMat)
    halo.position.y = 0.02
    markerHalo = halo
    group.add(halo)

    scene.add(group)
    markerGroup = group
  }

  const refreshMarker = () => {
    const pos = mc.fusSpawnFlagPos
    if (!pos) {
      clearMarker()
      return
    }
    buildMarker(pos)
  }
  mc.fusRefreshSpawnFlagMarker = refreshMarker

  /** Marker animation RAF — runs for the lifetime of the install. Stopped by
   *  {@code fusDisposeLabySpawnFlag}. Cheap: ~60 vertex writes/frame + two opacity
   *  scalars. No per-frame allocations. */
  let markerRafId = 0
  let markerDisposed = false
  const markerFrame = () => {
    if (markerDisposed) return
    markerRafId = requestAnimationFrame(markerFrame)
    if (!markerGroup) return
    const fp = mc.fusSpawnFlagPos
    if (fp && [fp.x, fp.z].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      markerGroup.visible = fusLabyEntityInTerrainDrawWindow(mc, fp.x + 0.5, fp.z + 0.5)
    } else {
      markerGroup.visible = false
    }
    const t = performance.now() / 1000
    if (markerCloth && markerClothBaseY) {
      const posAttr = markerCloth.geometry.attributes.position
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i)
        /** Wave stronger at the free end (right side, where x is largest). */
        const amp = 0.12 * (x / 1.2)
        const wave = Math.sin(t * 3 + x * 5) * amp + Math.sin(t * 5 + x * 7) * amp * 0.3
        posAttr.setY(i, markerClothBaseY[i] + wave)
        posAttr.setZ?.(i, Math.sin(t * 2 + x * 4) * amp * 0.6)
      }
      posAttr.needsUpdate = true
    }
    if (markerHalo) {
      const pulse = 0.8 + Math.sin(t * 2) * 0.2
      markerHalo.scale.setScalar(pulse)
      markerHalo.material.opacity = 0.2 + Math.sin(t * 2) * 0.08
    }
  }
  markerRafId = requestAnimationFrame(markerFrame)

  /* ──────────────────────────── Place flag ─────────────────────────────── */

  mc.fusPlaceSpawnFlag = async function placeFusSpawnFlag() {
    const pl = mc.player
    if (!pl) return
    const hp = Number(pl.health)
    const deadByHp = Number.isFinite(hp) && hp <= 0
    const deadByState = !!pl.isDead || !!pl.dead || (typeof mc.fusIsDead === 'function' && mc.fusIsDead())
    if (deadByHp || deadByState) {
      notifyFlagReject('[FUS] Не можна ставити прапор, коли ти мертвий.')
      return
    }
    const x = Math.floor(pl.x)
    const y = Math.floor(pl.y)
    const z = Math.floor(pl.z)
    /** `ry` is yaw at the moment of placement — required by the RTDB validation rule for
     *  `worldSpawnFlags` (`database.rules.json` rejects writes missing any of x/y/z/ry).
     *  We also capture it so a future "teleport back facing the same way" UX doesn't have
     *  to guess. Normalised to the [-180,180] degree range for sane downstream math. */
    const rawYaw = typeof pl.rotationYaw === 'number' ? pl.rotationYaw : 0
    const ry = ((((rawYaw + 180) % 360) + 360) % 360) - 180
    mc.fusSpawnFlagPos = { x, y, z, ry }
    refreshMarker()
    if (rtdb && worldId && uid) {
      try {
        await dbSet(dbRef(rtdb, `worldSpawnFlags/${worldId}/${uid}`), {
          x,
          y,
          z,
          ry,
          at: Date.now(),
        })
      } catch (e) {
        console.warn('[fusLabySpawnFlag] RTDB write failed', e)
      }
    }
  }

  /* ───────────────────────── Teleport channel VFX ──────────────────────── */

  /** @type {THREE.Group | null} */
  let vfxGroup = null
  /** @type {{ mesh: THREE.Mesh, phase: number, heightFactor: number }[]} */
  let innerHelix = []
  /** @type {{ mesh: THREE.Mesh, phase: number }[]} */
  let outerRing = []
  /** @type {THREE.Mesh | null} */
  let burst = null
  /** @type {{ mesh: THREE.Mesh, bornAt: number, life: number, x: number, z: number }[]} */
  let sparkles = []
  /** Free-list of sparkle meshes (re-used to avoid per-frame allocation). */
  const sparklePool = []
  let sparkleGeom = null
  let sparkleMat = null
  let lastSparkleAt = 0

  /** Lerp r/g/b between two hex colours. Cheap per-frame tint path so we don't spam
   *  `new Color()` instances. */
  const lerpHex = (a, b, t) => {
    const ar = (a >> 16) & 0xff
    const ag = (a >> 8) & 0xff
    const ab = a & 0xff
    const br = (b >> 16) & 0xff
    const bg = (b >> 8) & 0xff
    const bb = b & 0xff
    const r = Math.round(ar + (br - ar) * t)
    const g = Math.round(ag + (bg - ag) * t)
    const bl = Math.round(ab + (bb - ab) * t)
    return (r << 16) | (g << 8) | bl
  }

  const buildVfx = () => {
    const scene = mc.worldRenderer?.scene
    if (!scene) return
    if (vfxGroup) return
    innerHelix = []
    outerRing = []
    burst = null
    vfxGroup = new THREE.Group()

    /** Shared materials so all 40+ meshes only hit the GPU as two draw calls. The
     *  colour is mutated on the material each frame (lerpHex above). */
    const innerGeom = new THREE.BoxGeometry(0.18, 0.18, 0.18)
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x3aaaff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    })
    for (let i = 0; i < 16; i++) {
      const mesh = new THREE.Mesh(innerGeom, innerMat)
      innerHelix.push({
        mesh,
        phase: (i / 16) * Math.PI * 2,
        heightFactor: i / 15,
      })
      vfxGroup.add(mesh)
    }

    const outerGeom = new THREE.BoxGeometry(0.14, 0.14, 0.14)
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0x6cf0ff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    })
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(outerGeom, outerMat)
      outerRing.push({
        mesh,
        phase: (i / 24) * Math.PI * 2,
      })
      vfxGroup.add(mesh)
    }

    /** Completion-burst: a large additive sphere that scales/fades at t ≥ 0.92. */
    const burstGeom = new THREE.SphereGeometry(1, 16, 12)
    const burstMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    })
    burst = new THREE.Mesh(burstGeom, burstMat)
    burst.scale.setScalar(0.001)
    vfxGroup.add(burst)

    /** Sparkle pool — shared small glowing plane. Rotates to face the camera each
     *  frame in the VFX tick so they look volumetric from all angles. */
    sparkleGeom = new THREE.PlaneGeometry(0.22, 0.22)
    sparkleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    })

    scene.add(vfxGroup)
  }

  const clearVfx = () => {
    const scene = mc.worldRenderer?.scene
    if (!scene || !vfxGroup) {
      innerHelix = []
      outerRing = []
      sparkles.length = 0
      sparklePool.length = 0
      return
    }
    scene.remove(vfxGroup)
    /** Dispose shared geometry/material via a set so we don't double-dispose. */
    const seenGeom = new Set()
    const seenMat = new Set()
    vfxGroup.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry && !seenGeom.has(o.geometry)) {
          seenGeom.add(o.geometry)
          try {
            o.geometry.dispose()
          } catch {
            /* shared */
          }
        }
        const m = o.material
        if (m && !seenMat.has(m)) {
          seenMat.add(m)
          try {
            m.dispose()
          } catch {
            /* shared */
          }
        }
      }
    })
    try {
      sparkleGeom?.dispose()
    } catch {
      /* shared */
    }
    try {
      sparkleMat?.dispose()
    } catch {
      /* shared */
    }
    sparkleGeom = null
    sparkleMat = null
    vfxGroup = null
    innerHelix = []
    outerRing = []
    burst = null
    sparkles.length = 0
    sparklePool.length = 0
  }

  const spawnSparkle = (pl, now) => {
    if (!vfxGroup || !sparkleGeom || !sparkleMat) return
    const pooled = sparklePool.pop()
    let mesh
    if (pooled) {
      mesh = pooled
      mesh.visible = true
      vfxGroup.add(mesh)
    } else {
      mesh = new THREE.Mesh(sparkleGeom, sparkleMat)
      vfxGroup.add(mesh)
    }
    const angle = Math.random() * Math.PI * 2
    const radius = 0.35 + Math.random() * 0.6
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    mesh.position.set(pl.x + x, pl.y + 0.05, pl.z + z)
    sparkles.push({ mesh, bornAt: now, life: 700 + Math.random() * 400, x, z })
  }

  const retireSparkle = (s) => {
    s.mesh.visible = false
    vfxGroup?.remove(s.mesh)
    sparklePool.push(s.mesh)
  }

  const updateVfx = (pl, channelT, now) => {
    if (!vfxGroup) return
    /** Inner helix — tight, fast. Radius expands from 0.55 → 1.0. 3 full revolutions. */
    const innerRadius = 0.55 + 0.45 * channelT
    const innerAngle = channelT * Math.PI * 2 * 3
    const tint = lerpHex(0x3aaaff, 0xffffff, channelT)
    if (innerHelix[0]) innerHelix[0].mesh.material.color.setHex(tint)
    for (const node of innerHelix) {
      const a = innerAngle + node.phase
      const y = node.heightFactor * 1.9
      node.mesh.position.set(
        pl.x + Math.cos(a) * innerRadius,
        pl.y + y,
        pl.z + Math.sin(a) * innerRadius,
      )
      node.mesh.rotation.y = a
    }

    /** Outer ring — slow orbital plane at shoulder height, counter-rotating. Radius
     *  shrinks from 1.8 → 0.6 to "collapse into" the burst. */
    const outerRadius = 1.8 - 1.2 * channelT
    const outerAngle = -channelT * Math.PI * 2 * 1.5
    const outerTint = lerpHex(0x6cf0ff, 0xffffff, channelT)
    if (outerRing[0]) outerRing[0].mesh.material.color.setHex(outerTint)
    for (const node of outerRing) {
      const a = outerAngle + node.phase
      node.mesh.position.set(
        pl.x + Math.cos(a) * outerRadius,
        pl.y + 1.2 + Math.sin(a * 2 + now / 200) * 0.15,
        pl.z + Math.sin(a) * outerRadius,
      )
    }

    /** Sparkle feed — spawn one every 50 ms during the channel, then age/retire. */
    if (now - lastSparkleAt > 50 && channelT < 0.97) {
      lastSparkleAt = now
      spawnSparkle(pl, now)
    }
    const cam = mc.worldRenderer?.camera
    for (let i = sparkles.length - 1; i >= 0; i--) {
      const s = sparkles[i]
      const age = (now - s.bornAt) / s.life
      if (age >= 1) {
        sparkles.splice(i, 1)
        retireSparkle(s)
        continue
      }
      s.mesh.position.y = pl.y + 0.05 + age * 2.2
      s.mesh.material = sparkleMat /* shared */
      s.mesh.scale.setScalar(1 - age * 0.5)
      if (cam) s.mesh.lookAt(cam.position)
    }

    /** Completion burst — inflate fast at t ≥ 0.92, fade at the very end. */
    if (burst) {
      if (channelT < 0.92) {
        burst.scale.setScalar(0.001)
        burst.material.opacity = 0
      } else {
        const bt = (channelT - 0.92) / 0.08
        burst.position.set(pl.x, pl.y + 1.0, pl.z)
        burst.scale.setScalar(0.2 + bt * 3.5)
        burst.material.opacity = Math.max(0, 0.9 - bt * 0.9)
      }
    }
  }

  /* ────────────────────────── Teleport channel ─────────────────────────── */

  /** Channel-cancel sentinels so the countdown tick can bail out safely. */
  let channelStartHealth = 0
  let channelStartX = 0
  let channelStartY = 0
  let channelStartZ = 0
  let channelRafId = 0
  let channelEndAt = 0

  const clearChannelInputKeys = () => {
    try {
      Keyboard.setState('KeyW', false)
      Keyboard.setState('KeyS', false)
      Keyboard.setState('KeyA', false)
      Keyboard.setState('KeyD', false)
      Keyboard.setState('Space', false)
    } catch {
      /* ignore */
    }
  }

  const clearPresenceTpCh = () => {
    try {
      mc.fusLabyPresenceTpChEndAt = 0
      mc.fusLabyPresenceTpChStartAt = 0
      void mc.fusForcePresenceWrite?.()
    } catch {
      /* ignore */
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
    clearChannelInputKeys()
    clearVfx()
    clearPresenceTpCh()
  }

  const postTeleportSafetyFix = (pl) => {
    try {
      const wx = mc?.world
      if (!pl || !wx) return
      const bx = Math.floor(Number(pl.x) || 0)
      const by = Math.floor(Number(pl.y) || 0)
      const bz = Math.floor(Number(pl.z) || 0)
      const fixedFeetY = fusLabyFeetYAtColumn(wx, bx, bz, by)
      if (!Number.isFinite(fixedFeetY)) return
      if (Math.abs((Number(pl.y) || 0) - fixedFeetY) > 0.35) {
        pl.setPosition?.(bx + 0.5, fixedFeetY, bz + 0.5)
      }
      if (typeof pl.fallDistance === 'number') pl.fallDistance = 0
      if (typeof pl.prevY === 'number') pl.prevY = pl.y
    } catch {
      /* ignore safety correction */
    }
  }

  /**
   * Same ~15s channel + VFX as the spawn flag; completion position depends on {@code pos}:
   *   • Default: block column + {@link fusLabyFeetYAtColumn} (spawn flag / block rt coords).
   *   • {@code usePresenceEntityPos: true}: peer teleport — at **completion** time, re-read
   *     {@code peerUid} via {@code mc.fusLabyReadPeerPos} (so the target is not ~15s stale),
   *     then {@link fusLabyResolvePeerTeleportPosition} for a safe stand near that feet Y.
   *
   * @param {{ x: number, y: number, z: number, usePresenceEntityPos?: boolean, peerUid?: string }} pos
   */
  function startTeleportChannelToBlockPos(pos) {
    if (!pos) return
    const px = Number(pos.x)
    const py = Number(pos.y)
    const pz = Number(pos.z)
    if (![px, py, pz].every((n) => Number.isFinite(n))) {
      return
    }
    const peerUid = typeof pos.peerUid === 'string' ? pos.peerUid : ''
    const usePresence = pos.usePresenceEntityPos === true
    const pl = mc.player
    if (!pl) return
    /** Already channelling — ignore re-trigger. */
    if (channelEndAt && Date.now() < channelEndAt) return

    channelStartHealth = typeof pl.health === 'number' ? pl.health : 0
    channelStartX = Number(pl.x) || 0
    channelStartY = Number(pl.y) || 0
    channelStartZ = Number(pl.z) || 0
    const startT = Date.now()
    const nextEnd = startT + FUS_LABY_FLAG_CHANNEL_MS
    try {
      buildVfx()
    } catch (e) {
      console.warn('[fusLabySpawnFlag] buildVfx failed', e)
      return
    }
    if (!vfxGroup) {
      return
    }
    channelEndAt = nextEnd
    mc.fusLabyFlagChannelEndAt = nextEnd
    mc.fusLabyChannelLockMove = true
    try {
      mc.fusLabyPresenceTpChStartAt = startT
      mc.fusLabyPresenceTpChEndAt = nextEnd
      void mc.fusForcePresenceWrite?.()
    } catch {
      /* ignore */
    }
    clearChannelInputKeys()

    const chPeerUid = peerUid

    const tick = () => {
      try {
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
        if (
          typeof curPl.health === 'number' &&
          (curPl.health <= 0 || curPl.health + 0.001 < channelStartHealth)
        ) {
          cancelChannel()
          return
        }
        const movedDx = (Number(curPl.x) || 0) - channelStartX
        const movedDz = (Number(curPl.z) || 0) - channelStartZ
        const movedDy = Math.abs((Number(curPl.y) || 0) - channelStartY)
        if (movedDx * movedDx + movedDz * movedDz > 0.25 || movedDy > 1.2) {
          cancelChannel()
          return
        }

        if (!vfxGroup) {
          buildVfx()
        }

        /**
         * Hard-freeze horizontal input each frame. We zero the engine's input fields
         * rather than yanking the keyboard state so desktop users can still mash WASD —
         * it simply does nothing. Saves a re-sync dance when the channel ends.
         */
        curPl.moveForward = 0
        curPl.moveStrafing = 0
        curPl.jumping = false
        if (typeof curPl.motionX === 'number') curPl.motionX *= 0.5
        if (typeof curPl.motionZ === 'number') curPl.motionZ *= 0.5

        const t = 1 - (curEndAt - now) / FUS_LABY_FLAG_CHANNEL_MS
        updateVfx(curPl, Math.max(0, Math.min(1, t)), performance.now())

        if (now >= curEndAt) {
          channelEndAt = 0
          mc.fusLabyFlagChannelEndAt = 0
          mc.fusLabyChannelLockMove = false
          clearChannelInputKeys()
          clearVfx()
          clearPresenceTpCh()
          try {
            if (usePresence) {
              let tx = px
              let ty = py
              let tz = pz
              if (chPeerUid && typeof mc.fusLabyReadPeerPos === 'function') {
                const cur = mc.fusLabyReadPeerPos(chPeerUid)
                if (cur && [cur.x, cur.y, cur.z].every((n) => Number.isFinite(Number(n)))) {
                  tx = Number(cur.x)
                  ty = Number(cur.y)
                  tz = Number(cur.z)
                }
              }
              const res = fusLabyResolvePeerTeleportPosition(mc?.world, tx, tz, ty)
              const x = res.x
              const y = res.y + FUS_LABY_PEER_TP_Y_LIFT_BLOCKS
              const z = res.z
              if ([x, y, z].every((n) => Number.isFinite(n))) {
                curPl.setPosition?.(x, y, z)
                postTeleportSafetyFix(curPl)
              } else {
                console.warn('[fusLabySpawnFlag] peer teleport resolved non-finite', res)
              }
            } else {
              const bx = Math.floor(px)
              const by = Math.floor(py)
              const bz = Math.floor(pz)
              const feetY = fusLabyFeetYAtColumn(mc?.world, bx, bz, by)
              curPl.setPosition?.(bx + 0.5, feetY, bz + 0.5)
              postTeleportSafetyFix(curPl)
            }
            if (typeof curPl.motionX === 'number') curPl.motionX = 0
            if (typeof curPl.motionY === 'number') curPl.motionY = 0
            if (typeof curPl.motionZ === 'number') curPl.motionZ = 0
            try {
              mc.fusRefreshSpawnInvuln?.()
            } catch {
              /* ignore */
            }
          } catch (e) {
            console.warn('[fusLabySpawnFlag] teleport failed', e)
          }
          return
        }
        channelRafId = requestAnimationFrame(tick)
      } catch (err) {
        console.error('[fusLabySpawnFlag] channel tick', err)
        try {
          cancelChannel()
        } catch {
          /* ignore */
        }
        clearPresenceTpCh()
      }
    }
    channelRafId = requestAnimationFrame(tick)
  }

  mc.fusLabyStartFlagTeleportChannel = function startFusLabyFlagTeleport() {
    const pos = mc.fusSpawnFlagPos
    if (!pos) return
    startTeleportChannelToBlockPos(pos)
  }

  mc.fusLabyStartTeleportToBlockPosChannel = function (pos) {
    startTeleportChannelToBlockPos(pos)
  }

  /** Disposer — safe to call on view unmount even when no channel is active. */
  mc.fusDisposeLabySpawnFlag = () => {
    cancelChannel()
    markerDisposed = true
    if (markerRafId) {
      cancelAnimationFrame(markerRafId)
      markerRafId = 0
    }
    clearMarker()
  }
}
