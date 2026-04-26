import * as THREE from '@labymc/libraries/three.module.js'
import { inferModelType, loadImage, loadSkinToCanvas } from 'skinview-utils'
import {
  off,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  ref as dbRef,
} from 'firebase/database'
import { PlayerObject } from '@/assets/minecraft-character/model.js'
import {
  applyFusTpToolMaterialPolicy,
  applyFusTpToolTuningToTpHolder,
  cloneToolForFirstPerson,
  disposeFusFpToolSubtree,
  fitToolForThirdPersonHand,
  fusTpToolTuningRevision,
  resolveFusToolsGltfObjectForFp,
} from '@/js-minecraft/src/js/net/minecraft/client/fus/FusToolsGltfFirstPerson.js'
import {
  fusLabyEntityInTerrainDrawWindow,
  fusLabyIsWithinAnimProcessRangeXz,
  fusLabyIsWithinPlayerInterestXz,
} from './fusLabyEntityTerrainWindow.js'
import { FUS_LABY_FLAG_CHANNEL_MS } from '@labymc/src/js/net/minecraft/client/fus/FusLabyFlagChannel.js'
import { FUS_SPAWN_INVULN_MS } from './fusSpawnInvulnInstall.js'
import { fusCreateRemoteHeldBlockMesh, fusDisposeRemoteHeldBlockMesh } from './fusRemoteHeldBlockMesh.js'
import { processFusAvatarSkinCanvasForSkinviewRig } from '@/lib/fusAvatarSkinCanvas.js'

/**
 * Shared procedural skin when presence has no `skinUrl` (or URL load fails).
 * Uses {@link processFusAvatarSkinCanvasForSkinviewRig}: {@link generateFusAvatarSkinCanvas}
 * plus the same {@code loadSkinToCanvas} pass as successful HTTP skins in {@link #loadSkin}.
 * {@code colorSpace} is {@link THREE.NoColorSpace}: {@link WorldRenderer} disables color
 * management and {@link Minecraft#getThreeTexture} uses the same — {@code SRGBColorSpace}
 * here skews solid purple toward blue on the Laby canvas.
 */
/** @type {THREE.CanvasTexture | null} */
let _fusRemoteDefaultSkinTex = null
const FUS_REMOTE_DEFAULT_SKIN_TEX_REV = 4
function fusRemoteDefaultSkinTexture() {
  if (_fusRemoteDefaultSkinTex?.userData?.fusRev === FUS_REMOTE_DEFAULT_SKIN_TEX_REV) {
    return _fusRemoteDefaultSkinTex
  }
  /** Do not dispose the previous singleton — other live avatars may still reference it. */
  _fusRemoteDefaultSkinTex = null
  const canvas = processFusAvatarSkinCanvasForSkinviewRig('default')
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  texture.userData.fusKeepAlive = true
  texture.userData.fusRev = FUS_REMOTE_DEFAULT_SKIN_TEX_REV
  _fusRemoteDefaultSkinTex = texture
  return _fusRemoteDefaultSkinTex
}

/**
 * Remote-player system for the shared Laby world. Subscribes to
 * `worldPresence/{worldId}` and keeps a 3D avatar around for every peer uid:
 *   • Minecraft skin rig (reuses the vendored {@link PlayerObject}).
 *   • Basic (unlit) materials so the avatar renders without scene lighting.
 *   • Async skin texture load via `skinview-utils` (handles legacy 32-row skins).
 *   • Walk/attack animation driven by presence `anim` + `swingAt`.
 *   • Pose interpolation with a short render-delay so jitter from ~20 Hz presence writes
 *     does not read as stutter; `anim` + position together drive walk/idle.
 *   • Billboarded nametag with hearts row drawn from `hearts_sh.png`
 *     (matching the HUD / FP strip used everywhere else in FUS Laby).
 *   • Held item in the right hand: tools are cloned out of `tools.glb`
 *     (same template the FP hand uses) when the peer broadcasts a mesh name;
 *     block ids fall back to a colored cube. GLB tools use
 *     {@link fitToolForThirdPersonHand} + per-frame {@link applyFusTpToolTuningToTpHolder}
 *     (see `FusTpToolTuningGui.js` in dev) so other players' tools use the same TP offsets.
 *
 * This module deliberately doesn't touch the local entity list — the engine's
 * ray-trace and pickaxe hit paths use that for players on their own server; the
 * remote uids here are *cosmetic* avatars synced via RTDB only. PvP hits are
 * routed through `worldCombatHits` elsewhere. A lightweight `onChildAdded` on
 * `worldCombatDeaths` forces death particles + model hide the moment a kill row
 * appears so observers are not left standing on a delayed `worldPresence` hp=0.
 *
 * @param {any} mc
 * @param {{ worldId: string, uid: string, rtdb: any }} opts
 * @returns {() => void}
 */
export function installFusRemoteAvatars(mc, { worldId, uid, rtdb }) {
  if (!mc || !mc.worldRenderer?.scene || !rtdb || !worldId || !uid) {
    console.warn('[fusRemoteAvatars] missing prereqs; skip install')
    return () => {}
  }

  const scene = mc.worldRenderer.scene
  const camera = mc.worldRenderer.camera || null

  /** @type {Map<string, Avatar>} */
  const avatars = new Map()
  mc.fusRemoteAvatars = avatars

  /** In-memory skin texture cache keyed by url to avoid reloading when peers respawn. */
  /** @type {Map<string, { texture: THREE.Texture, slim: boolean }>} */
  const skinCache = new Map()

  /** Peer pose samples are played back this many ms behind live for jitter-free motion. */
  /** Slightly ahead of the writer (50–80 ms) so pose is “live” while still smoothing. */
  const INTERP_DELAY_MS = 60
  /** If a presence row is older than this and wasn't flagged `left`, treat the peer as gone. */
  const STALE_MS = 30_000

  /**
   * Per-peer bookkeeping. Pose buffer stores the last N samples (ts, x, y, z, ry, rp, anim)
   * so the renderer can look up "where was this peer 140 ms ago" regardless of when the
   * last RTDB write arrived.
   */
  class Avatar {
    constructor(peerUid) {
      this.uid = peerUid
      /** @type {PlayerObject} */
      this.player = new PlayerObject()
      /** The scene has no real lighting — Standard materials render black. Swap to Basic so
       *  skin textures are visible. Keeps the same 4-material sharing pattern as SkinObject. */
      convertSkinToBasic(this.player.skin)
      /** Container so we can place + rotate one group instead of the whole rig. */
      this.root = new THREE.Group()
      this.root.add(this.player)
      /** Move the model's feet to y=0 (see `PlayerObject` layout notes) then scale to ~1.8 blocks. */
      this.player.position.y = 16
      const scale = 0.0575
      this.modelScale = scale
      this.root.scale.setScalar(scale)
      this.root.visible = false
      scene.add(this.root)

      /** Nametag + hearts plane. A single canvas redrawn on data change keeps cost tiny.
       *  Resolution bumped 2× (512×160) and sampling switched to trilinear + anisotropic
       *  because users reported "when nametags are far, it is incredibly hard to read
       *  their level and name". A 256×80 canvas projected onto a 1.6×0.5 plane collapses
       *  to 5–10 screen pixels at ~20 blocks, below the point where any single glyph
       *  renders legibly. Doubling the canvas gives text ~2× the fine detail to survive
       *  downsampling, and `LinearMipmapLinearFilter` + anisotropy keep the downsample
       *  smooth instead of aliasing into noise. */
      this.nameCanvas = document.createElement('canvas')
      this.nameCanvas.width = 768
      this.nameCanvas.height = 240
      this.nameTexture = new THREE.CanvasTexture(this.nameCanvas)
      this.nameTexture.magFilter = THREE.LinearFilter
      if (mc.fusIosSafari) {
        /** iOS: mipgen + 16× anisotropic fetch on a 768×240 canvas is a steady GPU+memory
         *  cost; linear min is enough for a billboard. */
        this.nameTexture.minFilter = THREE.LinearFilter
        this.nameTexture.generateMipmaps = false
        this.nameTexture.anisotropy = 1
      } else {
        this.nameTexture.minFilter = THREE.LinearMipmapLinearFilter
        this.nameTexture.generateMipmaps = true
        try {
          const cap = mc.worldRenderer?.webRenderer?.capabilities?.getMaxAnisotropy?.()
          if (Number.isFinite(cap) && cap > 0) this.nameTexture.anisotropy = cap
        } catch {
          /* ignore */
        }
      }
      this.nameTexture.colorSpace = THREE.SRGBColorSpace
      this.nameMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2.35, 0.75),
        new THREE.MeshBasicMaterial({
          map: this.nameTexture,
          transparent: true,
          /** Depth-test on so terrain occludes nametags (requested change — the previous
           *  always-on-top behaviour let you spot hidden players through walls, which was
           *  unintended). Depth-write stays off so the transparent plane doesn't cut holes
           *  in whatever renders behind it. */
          depthTest: true,
          depthWrite: false,
          alphaTest: 0.01,
        }),
      )
      this.nameMesh.renderOrder = 5
      /** Slightly above head. Model height ≈ 32 units pre-scale → 1.85 blocks post-scale. */
      this.nameMesh.position.set(0, 2.1 / scale, 0) /** Unscale because this plane is inside `root` (scaled). */
      this.nameMesh.scale.setScalar(1 / scale) /** Counter-scale so the 1.6×0.5 plane stays world-sized. */
      this.root.add(this.nameMesh)

      /** Container inside the right-arm pivot that holds either the GLB tool clone or a
       *  fallback block cube. Rebuilt when `heldTool` or `heldId` changes. */
      this.heldRoot = new THREE.Group()
      /** @type {THREE.Object3D | null} */ this._tpHeldGroup = null
      /** Hand position inside the right-arm local frame. Arm pivot is at the shoulder, the
       *  hand tip is at y≈-12, and the rig faces -Z (MC skin convention), so negative z
       *  puts the item in front of the palm rather than behind the body. */
      this.heldRoot.position.set(-1, -10, -2)
      this.player.skin.rightArm.add(this.heldRoot)

      /** @type {Array<{ ts: number, x: number, y: number, z: number, ry: number, rp: number, anim: string }>} */
      this.poseBuffer = []
      /** Reused by {@link #samplePose} — do not share across avatars. */
      this._poseOut = { x: 0, y: 0, z: 0, ry: 0, rp: 0, anim: 'idle', moving: false }
      this._nameBillboardWp = new THREE.Vector3()
      this.name = ''
      this.skinUrl = null
      /** First {@link #ingestRow} must run {@link #loadSkin} even when URL stays null (procedural default). */
      this._fusSkinSyncedOnce = false
      this.slim = false
      this.pvpMode = 'white'
      this.hp = 20
      this.maxHp = 20
      this.anim = 'idle'
      this.heldId = 0
      this.heldTool = ''
      this.heldKey = ''
      this.swingAt = 0
      this.lastSwingAt = 0
      this._remoteSwingSerial = 0
      this.walkPhase = 0
      this.idlePhase = 0
      this.attackPhase = 0 /** 0..1 progress through a swing clip. */
      this.lastApplyMs = 0
      this.drawnName = ''
      this.drawnMode = ''
      this.drawnHp = -1
      this.drawnMaxHp = -1
      this.drawnHeartsReady = false
      /** Wall-clock ms at which the red-tint flash should clear. Poll-driven in the RAF
       *  loop so flash duration is frame-rate independent and cleanup can't leak past
       *  avatar disposal. */
      this.flashUntilMs = 0
      /** Tracks whether we've already fired the death burst for this avatar. Reset when
       *  the peer respawns (hp crosses back above zero). Without this an observer stuck
       *  between two hp=0 writes would fire puffs every frame. */
      this.deathFired = false
      /** Deduplicate remote `swingAt` (ms) so a delayed packet does not re-fire the clip. */
      this._lastRemoteSwingAt = 0
      /** `worldPresence` `invUntil` (wall ms) — blink skin while active. */
      this.invUntil = 0
      /** `clientMs` of first death (presence or {@link worldCombatDeaths} row) — drop stale
       *  higher-hp presence rows that RTDB reorders behind the real kill, or the model
       *  “comes back standing”. */
      this._deathPresenceRefMs = null
      /** EMA of {@code (row.at - local Date.now())} at ingest so invuln end + blink use time closer to server / writer. */
      this._fusPresenceTimeOff = 0
      /** Wall time (ms) when a teleport channel should end, from {@code labyChEndAt} in RTDB. */
      this.labyChEndAt = 0
      /** Optional channel start; with {@code labyChEndAt} gives real progress when the window != fixed length. */
      this.labyChStartAt = 0
      /** @type {THREE.Group | null} */
      this._labyTpVfxGroup = null
      /** @type {THREE.Mesh[] | null} */
      this._labyTpVfxOrbitMeshes = null
      /** @type {THREE.Mesh[] | null} */
      this._labyTpVfxRingMeshes = null
      /** @type {THREE.Mesh | null} */
      this._labyTpVfxPillar = null
      /** Default atlas immediately — RTDB can lag; async URL loads can fail (then we fall back). */
      this._fusLoadSkinSerial = 0
      this.applySkin(fusRemoteDefaultSkinTexture(), false)
    }

    _clearLabyTpVfx() {
      const g = this._labyTpVfxGroup
      this._labyTpVfxGroup = null
      this._labyTpVfxOrbitMeshes = null
      this._labyTpVfxRingMeshes = null
      this._labyTpVfxPillar = null
      if (!g) return
      if (g.parent) g.parent.remove(g)
      const seenGeom = new Set()
      const seenMat = new Set()
      g.traverse((o) => {
        if (o.isMesh) {
          const geo = o.geometry
          if (geo && !seenGeom.has(geo)) {
            seenGeom.add(geo)
            try {
              geo.dispose()
            } catch {
              /* ignore */
            }
          }
          const mats = o.material
          if (mats) {
            const ar = Array.isArray(mats) ? mats : [mats]
            for (const m of ar) {
              if (m && !seenMat.has(m)) {
                seenMat.add(m)
                try {
                  m.dispose()
                } catch {
                  /* ignore */
                }
              }
            }
          }
        }
      })
    }

    _buildLabyTpVfx() {
      if (this._labyTpVfxGroup) return
      const g = new THREE.Group()
      g.position.set(0, 0, 0)
      /** One scale on the root so the full effect (rings, column, motes) reads at world size. */
      g.scale.setScalar(15)
      g.renderOrder = 2000
      const baseMatOpts = (color, opacity) => ({
        color,
        transparent: true,
        opacity,
        // depthTest: false,
        // depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
      const matA = new THREE.MeshBasicMaterial(baseMatOpts(0x44aaff, 0.5))
      const matB = new THREE.MeshBasicMaterial(baseMatOpts(0x6ae0ff, 0.45))
      const matM = new THREE.MeshBasicMaterial(baseMatOpts(0xb8f0ff, 0.32))
      const matRingO = new THREE.MeshBasicMaterial(baseMatOpts(0x5ecfff, 0.38))
      const matRingI = new THREE.MeshBasicMaterial(baseMatOpts(0x88aaff, 0.3))
      const matPil = new THREE.MeshBasicMaterial({
        ...baseMatOpts(0x6ec8ff, 0.14),
        side: THREE.DoubleSide,
      })
      const geomS = new THREE.IcosahedronGeometry(0.1, 0)
      const geomM = new THREE.IcosahedronGeometry(0.06, 0)
      const orbit = []
      const nA = 20
      for (let i = 0; i < nA; i++) {
        const m = new THREE.Mesh(geomS, matA)
        m.userData.layer = 'a'
        m.userData.ix = i
        m.userData.n = nA
        m.renderOrder = 2000
        m.frustumCulled = false
        g.add(m)
        orbit.push(m)
      }
      const nB = 18
      for (let i = 0; i < nB; i++) {
        const m = new THREE.Mesh(geomS, matB)
        m.userData.layer = 'b'
        m.userData.ix = i
        m.userData.n = nB
        m.renderOrder = 2000
        m.frustumCulled = false
        g.add(m)
        orbit.push(m)
      }
      const nM = 22
      for (let i = 0; i < nM; i++) {
        const m = new THREE.Mesh(geomM, matM)
        m.userData.layer = 'mote'
        m.userData.ix = i
        m.userData.n = nM
        m.userData.s0 = ((i * 37) % 1000) * 0.00073
        m.userData.s1 = ((i * 91) % 1000) * 0.00051
        m.renderOrder = 2000
        m.frustumCulled = false
        g.add(m)
        orbit.push(m)
      }
      const ringGeomO = new THREE.TorusGeometry(0.55, 0.026, 4, 28)
      const ringGeomI = new THREE.TorusGeometry(0.36, 0.02, 4, 20)
      const ringO = new THREE.Mesh(ringGeomO, matRingO)
      const ringI = new THREE.Mesh(ringGeomI, matRingI)
      for (const r of [ringO, ringI]) {
        r.rotation.x = Math.PI / 2
        r.renderOrder = 2000
        r.frustumCulled = false
        r.position.y = 0.03
        g.add(r)
      }
      const pillarGeom = new THREE.CylinderGeometry(0.28, 0.32, 2.35, 9, 1, true)
      const pillar = new THREE.Mesh(pillarGeom, matPil)
      pillar.renderOrder = 2000
      pillar.frustumCulled = false
      pillar.position.y = 1.12
      g.add(pillar)
      this._labyTpVfxOrbitMeshes = orbit
      this._labyTpVfxRingMeshes = [ringI, ringO]
      this._labyTpVfxPillar = pillar
      this._labyTpVfxGroup = g
      this.root.add(g)
    }

    /**
     * Orbit a light helix on this remote avatar when their `labyChEndAt` is in the future
     * (local player’s teleport channel, mirrored via RTDB). Progress uses
     * `labyChStartAt`…`labyChEndAt` when both are set.
     */
    updateLabyTpVfx(wallTimeMs) {
      const end = this.labyChEndAt
      const start = this.labyChStartAt
      const wallSync = wallTimeMs + (this._fusPresenceTimeOff || 0)
      if (this.deathFired) {
        this._clearLabyTpVfx()
        return
      }
      if (!Number.isFinite(end) || end <= 0) {
        this._clearLabyTpVfx()
        return
      }
      if (wallSync >= end) {
        this._clearLabyTpVfx()
        return
      }
      if (!this._labyTpVfxGroup) {
        this._buildLabyTpVfx()
      }
      if (!this._labyTpVfxGroup || !this._labyTpVfxOrbitMeshes) return
      this._labyTpVfxGroup.visible = this.root?.visible === true
      let t
      if (Number.isFinite(start) && start > 0 && end > start) {
        t = (wallSync - start) / (end - start)
      } else {
        t = 1 - (end - wallSync) / FUS_LABY_FLAG_CHANNEL_MS
      }
      const channelT = Math.max(0, Math.min(1, t))
      const w0 = wallSync * 0.00088
      const w1 = wallSync * -0.00115
      const gPulse = 0.85 + 0.15 * channelT
      for (const mesh of this._labyTpVfxOrbitMeshes) {
        const layer = mesh.userData.layer
        if (layer === 'a' || layer === 'b') {
          const n = mesh.userData.n
          const i = mesh.userData.ix
          const tAng = (i / n) * Math.PI * 2
          if (layer === 'a') {
            const a = tAng + w0 * 2.35
            const r = (0.36 + 0.22 * channelT) * gPulse
            const h = 0.12 + (i / Math.max(1, n - 1)) * 1.4
            mesh.position.set(Math.cos(a) * r, h, Math.sin(a) * r)
            mesh.scale.setScalar(0.9 + 0.12 * Math.sin(w0 * 2 + tAng))
            mesh.material?.color?.setRGB(0.25 + 0.45 * channelT, 0.5 + 0.28 * channelT, 0.98)
          } else {
            const a = tAng + 0.35 + w1 * 2.65
            const r = (0.28 + 0.16 * channelT) * gPulse
            const h = 0.1 + (i / Math.max(1, n - 1)) * 1.25
            mesh.position.set(Math.cos(a) * r, h, Math.sin(a) * r)
            mesh.scale.setScalar(0.88 + 0.1 * Math.sin(w1 * 2.3 - tAng))
            mesh.material?.color?.setRGB(0.28 + 0.4 * channelT, 0.75 + 0.2 * channelT, 0.95)
          }
        } else if (layer === 'mote') {
          const n = mesh.userData.n
          const i = mesh.userData.ix
          const s0 = mesh.userData.s0
          const s1 = mesh.userData.s1
          const u = (i * 0.618) % 1
          const r0 = 0.22 + 0.5 * u
          const h = 0.22 + 1.05 * u
          const ang = u * Math.PI * 2.8 + s0 * wallSync
          const bob = 0.08 * Math.sin(s1 * wallSync * 0.0018 + i)
          mesh.position.set(
            Math.cos(ang) * (r0 + 0.08 * channelT) + 0.05 * Math.sin(s0 * wallSync * 0.0014),
            h + bob,
            Math.sin(ang) * (r0 + 0.08 * channelT) + 0.05 * Math.cos(s1 * wallSync * 0.0013),
          )
          mesh.scale.setScalar(0.7 + 0.35 * (0.5 + 0.5 * Math.sin(0.0021 * wallSync + i)))
        }
      }
      const rings = this._labyTpVfxRingMeshes
      if (rings) {
        rings[0].rotation.y = w0 * 1.1
        rings[1].rotation.y = w1 * 0.9
        const sRing = 1.02 + 0.1 * channelT
        rings[0].scale.set(sRing, sRing, sRing)
        rings[1].scale.set(1.08 * sRing, 1.08 * sRing, 1.08 * sRing)
        rings[0].material && (rings[0].material.opacity = 0.32 + 0.14 * channelT)
        rings[1].material && (rings[1].material.opacity = 0.25 + 0.12 * channelT)
      }
      const col = this._labyTpVfxPillar
      if (col) {
        const py = 1.02 + 0.12 * channelT
        const ph = 2.15 + 0.4 * channelT
        const rP = 0.88 + 0.2 * channelT
        col.position.y = py
        col.scale.set(rP, ph / 2.35, rP)
        const m = col.material
        if (m) {
          m.opacity = 0.1 + 0.1 * channelT + 0.04 * (0.5 + 0.5 * Math.sin(0.0025 * wallSync))
        }
      }
    }

    ingestRow(row) {
      const now = Date.now()
      const x = Number(row.x)
      const y = Number(row.y)
      const z = Number(row.z)
      const ry = Number(row.ry)
      const rp = Number(row.rp)
      if (![x, y, z, ry, rp].every(Number.isFinite)) return

      /** Scalar state (updated immediately, no interp). Resolve HP before pose so we never
       *  sample walk/run into the buffer for a dead peer (body is hidden; nametag stays). */
      const prevHp = this.hp
      const cm = Number(row.clientMs) || 0
      let nextHp = Math.max(0, Number(row.hp) || 0)
      if (this.deathFired && nextHp > 0 && this._deathPresenceRefMs != null && cm <= this._deathPresenceRefMs) {
        nextHp = 0
      }

      this.poseBuffer.push({
        ts: now,
        x,
        y,
        z,
        ry,
        rp,
        anim: nextHp <= 0 ? 'idle' : normPresenceAnim(row.anim),
      })
      /** Keep the buffer ~1 s — enough for interpolation + a little slack. */
      if (this.poseBuffer.length > 20) this.poseBuffer.shift()

      this.hp = nextHp
      this.maxHp = Math.max(1, Number(row.maxHp) || 20)
      /** HP transitions:
       *   • Decrease while still alive → hit flash + puff. Observer-agnostic: every client
       *     watching this peer sees the FX without needing to be the attacker.
       *   • Crosses above 0 → respawn. Clear the dead state so the next kill draws a fresh
       *     burst (and the model becomes visible again).
       *   • Crosses to ≤0 → death burst, hide model.
       */
      if (Number.isFinite(prevHp)) {
        if (this.hp < prevHp - 0.001 && this.hp > 0) {
          this.triggerFlash()
        }
        if (prevHp <= 0 && this.hp > 0) {
          this.deathFired = false
          this._deathPresenceRefMs = null
          if (this.root) {
            this.root.visible = true
            /** Re-show every child we hid during `triggerDeath`. Skipping nameMesh here is
             *  safe: it was kept visible during death so toggling back to true is a no-op. */
            for (const c of this.root.children) c.visible = true
          }
        }
        if (prevHp > 0 && this.hp <= 0 && !this.deathFired) {
          this.deathFired = true
          this._deathPresenceRefMs = Math.max(this._deathPresenceRefMs || 0, cm)
          this.triggerDeath()
        }
      }
      const prevAnim = this.anim
      const nextAnim = normPresenceAnim(row.anim)
      this.anim = nextAnim
      this.heldId = Number.isFinite(Number(row.heldId)) ? Number(row.heldId) | 0 : 0
      this.heldTool = typeof row.heldTool === 'string' ? row.heldTool : ''
      const rSwing = Number.isFinite(Number(row.swingAt)) ? Number(row.swingAt) : 0
      const rowSwingSer = Math.max(0, Math.floor(Number(row.swingSerial) || 0))
      let reArmSwing = false
      if (rowSwingSer > this._remoteSwingSerial) {
        this._remoteSwingSerial = rowSwingSer
        reArmSwing = true
      } else if (rSwing > this._lastRemoteSwingAt) {
        this._lastRemoteSwingAt = rSwing
        reArmSwing = true
      }
      if (reArmSwing) {
        /** Local time — remote `swingAt` (wall time at attacker) can be far in the past when
         *  this row is processed late; `(Date.now() - this.swingAt) / 400` would skip the arm. */
        this.swingAt = Date.now()
        this.attackPhase = 0
        this.lastSwingAt = rSwing
      } else if (nextAnim === 'attack' && prevAnim !== 'attack') {
        /** Throttled presence sometimes omits a fresh `swingAt` / serial when `anim` flips. */
        const t = Date.now()
        this.swingAt = t
        this.attackPhase = 0
        this.lastSwingAt = t
      }
      const mode = row.pvpMode === 'red' || row.pvpMode === 'purple' ? row.pvpMode : 'white'
      if (mode !== this.pvpMode) this.pvpMode = mode
      if (typeof row.name === 'string' && row.name !== this.name) this.name = row.name
      const nextSlim = row.slim === true
      const nextSkinUrl = typeof row.skinUrl === 'string' && row.skinUrl.length > 0 ? row.skinUrl : null
      if (nextSkinUrl !== this.skinUrl || nextSlim !== this.slim || !this._fusSkinSyncedOnce) {
        this._fusSkinSyncedOnce = true
        this.skinUrl = nextSkinUrl
        this.slim = nextSlim
        void this.loadSkin()
      }
      if (row.at != null) {
        const atN = Number(row.at)
        if (Number.isFinite(atN) && atN > 0) {
          this._fusPresenceTimeOff = (this._fusPresenceTimeOff || 0) * 0.9 + (atN - now) * 0.1
        }
      }
      if (row.invUntil !== undefined && row.invUntil !== null) {
        const iu = Number(row.invUntil)
        let set = Number.isFinite(iu) && iu > 0 ? iu : 0
        if (set > 0) {
          const cap = now + FUS_SPAWN_INVULN_MS + 2000
          if (set > cap) {
            set = 0
          }
        }
        this.invUntil = set
      }
      if (row.labyChEndAt != null) {
        const ch = Number(row.labyChEndAt)
        this.labyChEndAt = Number.isFinite(ch) && ch > 0 ? ch : 0
      } else {
        this.labyChEndAt = 0
      }
      if (row.labyChStartAt != null) {
        const st = Number(row.labyChStartAt)
        this.labyChStartAt = Number.isFinite(st) && st > 0 ? st : 0
      } else {
        this.labyChStartAt = 0
      }
    }

    async loadSkin() {
      const serial = ++this._fusLoadSkinSerial
      const url = this.skinUrl
      const applyDefaultIfCurrent = () => {
        if (serial !== this._fusLoadSkinSerial) return
        this.applySkin(fusRemoteDefaultSkinTexture(), false)
      }
      if (!url) {
        applyDefaultIfCurrent()
        return
      }
      const cached = skinCache.get(url)
      if (cached) {
        if (serial !== this._fusLoadSkinSerial) return
        this.applySkin(cached.texture, cached.slim)
        return
      }
      try {
        const img = await loadImage(url)
        if (serial !== this._fusLoadSkinSerial) return
        const canvas = document.createElement('canvas')
        loadSkinToCanvas(canvas, img)
        const modelType = inferModelType(canvas)
        const texture = new THREE.CanvasTexture(canvas)
        texture.magFilter = THREE.NearestFilter
        texture.minFilter = THREE.NearestFilter
        texture.generateMipmaps = false
        texture.colorSpace = THREE.NoColorSpace
        texture.needsUpdate = true
        const entry = { texture, slim: modelType === 'slim' }
        skinCache.set(url, entry)
        if (serial !== this._fusLoadSkinSerial) return
        this.applySkin(texture, entry.slim)
      } catch (e) {
        console.warn('[fusRemoteAvatars] skin load failed', url, e)
        applyDefaultIfCurrent()
      }
    }

    applySkin(texture, slim) {
      if (!texture) return
      if (this.flashUntilMs) {
        this.flashUntilMs = 0
        this.clearFlash()
      }
      this.player.skin.map = texture
      const s = this.player.skin
      for (const m of [s.layer1Material, s.layer1MaterialBiased, s.layer2Material, s.layer2MaterialBiased]) {
        if (m) {
          if (m.color) m.color.setRGB(1, 1, 1)
          m.needsUpdate = true
        }
      }
      const explicit = this.slim
      this.player.skin.modelType = explicit || slim ? 'slim' : 'default'
    }

    /**
     * Sample interpolated pose at `renderTimeMs`. Returns {x,y,z,ry,rp,anim,moving}. Once the
     * pose buffer runs dry we just hold the last known sample — avoids the avatar "falling
     * out of the world" during a tab pause.
     * Leg cycle follows presence `anim` only. Do not infer walk from x/z (jitter and late
     * micro-moves retriggered run/walk a second+ after a stop when `anim` was already idle).
     * `attack` does not run the leg cycle.
     */
    samplePose(renderTimeMs) {
      const buf = this.poseBuffer
      if (buf.length === 0) return null
      const o = this._poseOut
      if (buf.length === 1) {
        const s = buf[0]
        o.x = s.x
        o.y = s.y
        o.z = s.z
        o.ry = s.ry
        o.rp = s.rp
        o.anim = s.anim
        o.moving = s.anim === 'walk' || s.anim === 'run'
        return o
      }
      for (let i = buf.length - 1; i >= 1; i--) {
        const b = buf[i]
        const a = buf[i - 1]
        if (renderTimeMs >= a.ts && renderTimeMs <= b.ts) {
          const span = Math.max(1, b.ts - a.ts)
          const t = (renderTimeMs - a.ts) / span
          o.moving = b.anim === 'attack' ? false : b.anim === 'walk' || b.anim === 'run'
          o.x = a.x + (b.x - a.x) * t
          o.y = a.y + (b.y - a.y) * t
          o.z = a.z + (b.z - a.z) * t
          o.ry = lerpAngleDeg(a.ry, b.ry, t)
          o.rp = a.rp + (b.rp - a.rp) * t
          o.anim = b.anim
          return o
        }
      }
      if (renderTimeMs < buf[0].ts) {
        const h = buf[0]
        o.moving = h.anim === 'attack' ? false : h.anim === 'walk' || h.anim === 'run'
        o.x = h.x
        o.y = h.y
        o.z = h.z
        o.ry = h.ry
        o.rp = h.rp
        o.anim = h.anim
        return o
      }
      /** Render time is past the newest sample — hold the tail and let interp catch up. */
      const tail = buf[buf.length - 1]
      o.moving = tail.anim === 'attack' ? false : tail.anim === 'walk' || tail.anim === 'run'
      o.x = tail.x
      o.y = tail.y
      o.z = tail.z
      o.ry = tail.ry
      o.rp = tail.rp
      o.anim = tail.anim
      return o
    }

    /**
     * Redraws the name canvas: text + stroke (no pill background), and a 10-heart row from
     * `mc.fusHeartsSheet`. Falls back to a green HP bar until the strip is loaded.
     */
    redrawNametag() {
      const heartsImg = mc.fusHeartsSheet
      const heartsReady = !!(heartsImg && heartsImg.complete && heartsImg.naturalWidth > 0)
      const nameChanged = this.drawnName !== this.name
      const modeChanged = this.drawnMode !== this.pvpMode
      const hpChanged = this.hp !== this.drawnHp || this.maxHp !== this.drawnMaxHp
      const heartsBecameReady = heartsReady && !this.drawnHeartsReady
      if (!nameChanged && !modeChanged && !hpChanged && !heartsBecameReady) return
      this.drawnName = this.name
      this.drawnMode = this.pvpMode
      this.drawnHp = this.hp
      this.drawnMaxHp = this.maxHp
      this.drawnHeartsReady = heartsReady

      const ctx = this.nameCanvas.getContext('2d')
      if (!ctx) return
      const W = this.nameCanvas.width
      const H = this.nameCanvas.height
      ctx.clearRect(0, 0, W, H)

      ctx.fillStyle =
        this.pvpMode === 'red' ? '#fecaca' : this.pvpMode === 'purple' ? '#e9d5ff' : '#ffffff'
      ctx.font = '700 64px system-ui, Segoe UI, Roboto, Arial'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      /** Subtle stroke so the name stays readable after mip filtering (no plate behind it). */
      ctx.lineWidth = 5
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)'
      ctx.strokeText(this.name || '—', W / 2, 64, W - 96)
      ctx.fillText(this.name || '—', W / 2, 64, W - 96)

      if (heartsReady) {
        this.drawHeartsStrip(ctx, heartsImg, W, 138)
      } else {
        /** Fallback: simple HP bar until `hearts_sh.png` finishes loading. */
        const barX = 48
        const barY = 150
        const barW = W - 96
        const barH = 48
        const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 0
        ctx.fillStyle = '#3f1d1d'
        roundRect(ctx, barX, barY, barW, barH, 8)
        ctx.fill()
        if (ratio > 0) {
          ctx.fillStyle = `hsl(${120 * ratio}, 78%, 48%)`
          roundRect(ctx, barX, barY, Math.max(4, barW * ratio), barH, 8)
          ctx.fill()
        }
      }

      this.nameTexture.needsUpdate = true
    }

    /**
     * Draw a centered row of hearts using the shared 3-frame sprite strip.
     * Each heart = 2 HP. We cap the row at 10 slots (standard HUD) and use the numeric
     * text for overflow past 20 maxHp so absorption-style buffs are still visible.
     * @param {CanvasRenderingContext2D} ctx
     * @param {HTMLImageElement} img
     * @param {number} W
     * @param {number} rowY
     */
    drawHeartsStrip(ctx, img, W, rowY) {
      const iw = img.naturalWidth
      const ih = img.naturalHeight
      const frameW = iw / 3
      const hp = Math.min(20, Math.max(0, Math.ceil(this.hp)))
      const cappedMax = Math.min(20, Math.max(2, Math.round(this.maxHp)))
      const slots = Math.ceil(cappedMax / 2)
      /** Match HUD proportions — slotW:slotH keeps frame aspect. */
      /** Slot sizes doubled along with the canvas — hearts stay the same apparent size
       *  on the in-world billboard but carry twice the texel density into mip levels. */
      const slotW = 60
      const slotH = Math.round((slotW * ih) / frameW)
      const gap = 3
      const rowW = slots * (slotW + gap) - gap
      const xStart = (W - rowW) / 2
      ctx.imageSmoothingEnabled = false
      for (let i = 0; i < slots; i++) {
        const hx = xStart + i * (slotW + gap)
        const left = hp > i * 2
        const right = hp > i * 2 + 1
        let sx = frameW * 2
        if (left && right) sx = 0
        else if (left) sx = frameW
        ctx.drawImage(img, sx, 0, frameW, ih, hx, rowY, slotW, slotH)
      }
      ctx.imageSmoothingEnabled = true
      /** If the peer has absorption-style maxHp > 20, show the raw number next to the row. */
      if (this.maxHp > 20) {
        ctx.fillStyle = '#fde68a'
        ctx.font = '700 40px system-ui, Segoe UI, Roboto, Arial'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(`+${Math.max(0, Math.round(this.hp) - 20)}`, xStart + rowW + 12, rowY + slotH / 2)
      }
    }

    animate(dt, pose) {
      const skin = this.player.skin
      /** Reset joints so state transitions don't leave stale rotations. */
      skin.rightArm.rotation.set(0, 0, 0)
      skin.leftArm.rotation.set(0, 0, 0)
      skin.rightLeg.rotation.set(0, 0, 0)
      skin.leftLeg.rotation.set(0, 0, 0)

      const playLimbAnim =
        !pose ||
        !Number.isFinite(pose.x) ||
        !Number.isFinite(pose.z) ||
        fusLabyIsWithinAnimProcessRangeXz(mc, pose.x, pose.z)

      const isRun = pose?.anim === 'run'
      const moving = playLimbAnim && !!pose?.moving
      if (moving) {
        this.walkPhase += dt * (isRun ? 11.2 : 8)
        const amp = isRun ? 1.02 : 0.9
        const s = Math.sin(this.walkPhase)
        skin.rightLeg.rotation.x = s * amp
        skin.leftLeg.rotation.x = -s * amp
        skin.rightArm.rotation.x = -s * amp
        skin.leftArm.rotation.x = s * amp
      } else if (playLimbAnim) {
        this.walkPhase = 0
        this.idlePhase += dt * 1.4
        const s = Math.sin(this.idlePhase)
        const a = 0.07
        skin.rightArm.rotation.x = s * a
        skin.leftArm.rotation.x = -s * a * 0.85
        skin.leftLeg.rotation.x = s * 0.02
        skin.rightLeg.rotation.x = -s * 0.02
      } else {
        this.walkPhase = 0
      }

      /** Attack swing: forward-then-back on the right arm (slightly longer than local MC swing
       *  so 10–12 Hz network samples still read as a full arc). */
      if (playLimbAnim && this.swingAt > 0) {
        const age = (Date.now() - this.swingAt) / 400
        if (age >= 0 && age <= 1) {
          const t = age < 0.5 ? age * 2 : (1 - age) * 2 /** triangle up to 1 then back. */
          /** Forward arc: rotate forward and inward so the hand arcs across the chest. */
          skin.rightArm.rotation.x = -Math.PI * 0.55 * t
          skin.rightArm.rotation.z = -0.35 * t
        }
      }

      /** Head pitch. Model head faces +Z; MC pitch +ve = looking down → tilt chin down. */
      if (pose && Number.isFinite(pose.rp)) {
        skin.head.rotation.x = THREE.MathUtils.degToRad(pose.rp)
      }
    }

    /**
     * Rebuild the held item in the right hand when the peer's selection changes.
     * Preference order:
     *   1. `heldTool` mesh name → clone from `tools.glb` (same template as local FP hand).
     *   2. `heldId` > 0        → colored cube (block fallback, color from id).
     *   3. nothing             → empty.
     */
    updateHeld() {
      const toolsTpl = mc.fusToolsGltfTemplate || null
      /** Key encodes source so we only rebuild when identity changes. `toolsReady` is part of
       *  the key so a peer whose tool wasn't resolvable earlier rebuilds once the GLB arrives. */
      const key = this.heldTool
        ? `tool:${this.heldTool}:${toolsTpl ? 1 : 0}`
        : this.heldId > 0
          ? `block:${this.heldId}`
          : 'none'
      if (key === this.heldKey) return
      this.heldKey = key
      this.clearHeld()
      if (this.heldTool && toolsTpl) {
        const src = resolveFusToolsGltfObjectForFp(toolsTpl, this.heldTool)
        if (src) {
          const clone = cloneToolForFirstPerson(src)
          const holder = fitToolForThirdPersonHand(clone)
          this._tpHeldGroup = holder
          applyFusTpToolMaterialPolicy(holder)
          this.heldRoot.add(holder)
          return
        }
      }
      this._tpHeldGroup = null
      if (this.heldId > 0) {
        const tex = mc.worldRenderer?.textureTerrain
        const blockMesh = fusCreateRemoteHeldBlockMesh(this.heldId, tex)
        if (blockMesh) {
          this.heldRoot.add(blockMesh)
        } else {
          const cube = new THREE.Mesh(
            new THREE.BoxGeometry(5, 5, 5),
            new THREE.MeshBasicMaterial({ color: heldIdToColor(this.heldId) }),
          )
          this.heldRoot.add(cube)
        }
      }
    }

    clearHeld() {
      this._tpHeldGroup = null
      while (this.heldRoot.children.length > 0) {
        const c = this.heldRoot.children[0]
        this.heldRoot.remove(c)
        if (c.userData?.fusRemoteHeldBlock) {
          fusDisposeRemoteHeldBlockMesh(c)
        } else {
          disposeFusFpToolSubtree(c)
        }
      }
    }

    /**
     * Red-tint flash on the 4 shared skin basic materials. We mutate `.color` directly,
     * which MeshBasicMaterial multiplies against the texture — a deep red ((1, 0.15, 0.15))
     * is enough to read clearly against any skin without obscuring it. The flash is
     * cleared in the RAF loop once {@link this.flashUntilMs} passes so disposal ordering
     * (peer leaves mid-flash) can't leak dangling colours.
     */
    triggerFlash() {
      const s = this.player?.skin
      if (!s) return
      const mats = [s.layer1Material, s.layer1MaterialBiased, s.layer2Material, s.layer2MaterialBiased]
      for (const m of mats) {
        if (!m || !m.color) continue
        if (!m._fusOrigColor) m._fusOrigColor = m.color.clone()
        m.color.setRGB(1, 0.15, 0.15)
      }
      this.flashUntilMs = Date.now() + 220
      /** Hit puff around the chest. Camera-facing is not needed since the particles are
       *  omni-directional boxes. */
      const p = this.root?.position
      if (p && typeof mc.fusFxHit === 'function') {
        try {
          mc.fusFxHit(p.x, p.y + 1.1, p.z, { count: 7, spread: 0.35 })
        } catch {
          /* ignore */
        }
      }
    }

    /** Internal: restore the cached original colour on every skin material. */
    clearFlash() {
      const s = this.player?.skin
      if (!s) return
      const mats = [s.layer1Material, s.layer1MaterialBiased, s.layer2Material, s.layer2MaterialBiased]
      for (const m of mats) {
        if (!m || !m.color || !m._fusOrigColor) continue
        try {
          m.color.copy(m._fusOrigColor)
        } catch {
          /* ignore */
        }
        m._fusOrigColor = null
      }
    }

    /**
     * Death VFX for a remote peer: hide the skin model, fire a larger red-tinted particle
     * burst, leave the nametag intact so teammates can still tell who died. The {@link
     * Avatar#ingestRow} method flips `this.deathFired` back off once the peer respawns,
     * at which point we make {@link this.root} visible again.
     */
    triggerDeath() {
      const p = this.root?.position
      if (p && typeof mc.fusFxDeath === 'function') {
        try {
          mc.fusFxDeath(p.x, p.y + 1.0, p.z, { count: 22, color: 0xdc2626, spread: 1.0 })
        } catch {
          /* ignore */
        }
      }
      /** Hide the body after firing particles. We keep `nameMesh` visible — players like
       *  to see "X was killed by Y" floating where the body fell. */
      if (this.root) {
        const skinVisible = this.root.children.filter((c) => c !== this.nameMesh)
        for (const c of skinVisible) c.visible = false
      }
    }

    billboardNametag(cameraWorldPos) {
      if (!cameraWorldPos) return
      /** Yaw-only billboard so the plane stays upright. */
      const mesh = this.nameMesh
      const wp = this._nameBillboardWp
      mesh.getWorldPosition(wp)
      const dx = cameraWorldPos.x - wp.x
      const dz = cameraWorldPos.z - wp.z
      const worldYaw = Math.atan2(dx, dz)
      /** Subtract the root's Y rotation so local rotation cancels out to look at the camera. */
      mesh.rotation.set(0, worldYaw - this.root.rotation.y, 0)
    }

    dispose() {
      this._clearLabyTpVfx()
      scene.remove(this.root)
      this.clearHeld()
      this.nameMesh.material.dispose?.()
      this.nameTexture.dispose?.()
      /** Leave the skin texture in the shared cache — other peers may re-use it. */
      this.nameMesh.geometry.dispose?.()
      /** Dispose the 4 shared basic materials we attached in convertSkinToBasic. */
      const s = this.player.skin
      s.layer1Material?.dispose?.()
      s.layer1MaterialBiased?.dispose?.()
      s.layer2Material?.dispose?.()
      s.layer2MaterialBiased?.dispose?.()
    }
  }

  const presRef = dbRef(rtdb, `worldPresence/${worldId}`)
  const onAdd = onChildAdded(presRef, (snap) => ingestPeer(snap.key, snap.val()))
  const onChg = onChildChanged(presRef, (snap) => ingestPeer(snap.key, snap.val()))
  const onRem = onChildRemoved(presRef, (snap) => {
    const peerUid = snap.key
    if (!peerUid) return
    const av = avatars.get(peerUid)
    if (av) {
      av.dispose()
      avatars.delete(peerUid)
    }
  })

  const deathsJoinTs = Date.now()
  const applyPeerDeathFromCombatRow = (row) => {
    if (!row || typeof row !== 'object') return
    const clientTs = Number(row.clientTs) || 0
    if (clientTs < deathsJoinTs) return
    const victimUid = typeof row.victimUid === 'string' ? row.victimUid : ''
    if (!victimUid || victimUid === uid) return
    const av = avatars.get(victimUid)
    if (!av) return
    /** Merge `clientTs` even if death already came from presence — fixes RTDB where combat
     *  arrives after `hp:0` so stale high-hp rows with `clientMs` between the two do not
     *  resurrect. */
    if (av.deathFired) {
      av._deathPresenceRefMs = Math.max(av._deathPresenceRefMs || 0, clientTs)
      return
    }
    av.deathFired = true
    av.hp = 0
    av._deathPresenceRefMs = Math.max(av._deathPresenceRefMs || 0, clientTs)
    av.triggerDeath()
    av.redrawNametag()
  }
  const deathsRef = dbRef(rtdb, `worldCombatDeaths/${worldId}`)
  const onDeathAdd = onChildAdded(deathsRef, (snap) => {
    const row = snap.val()
    applyPeerDeathFromCombatRow(row)
  })

  function ingestPeer(peerUid, row) {
    if (!peerUid || !row || typeof row !== 'object') return
    /** Skip our own row — we render ourselves first-person. */
    if (peerUid === uid) return
    if (row.left === true) {
      const av = avatars.get(peerUid)
      if (av) {
        av.dispose()
        avatars.delete(peerUid)
      }
      return
    }
    const clientMs = Number(row.clientMs)
    if (Number.isFinite(clientMs) && Date.now() - clientMs > STALE_MS) {
      /** Treat old rows as departed — prevents "ghost" avatars from users that crashed. */
      const av = avatars.get(peerUid)
      if (av) {
        av.dispose()
        avatars.delete(peerUid)
      }
      return
    }
    const px = Number(row.x)
    const pz = Number(row.z)
    if (!avatars.has(peerUid) && Number.isFinite(px) && Number.isFinite(pz) && !fusLabyIsWithinPlayerInterestXz(mc, px, pz)) {
      return
    }
    let av = avatars.get(peerUid)
    if (!av) {
      av = new Avatar(peerUid)
      avatars.set(peerUid, av)
    }
    av.ingestRow(row)
  }

  let rafId = 0
  let disposed = false
  let prev = performance.now()
  const cameraWorldPos = new THREE.Vector3()
  /** When {@link bumpFusTpToolTuningRebuild} runs, remotes need a re-fit to pick up new tool scale. */
  let lastTpTuningRev = -1

  const frame = () => {
    if (disposed) return
    rafId = requestAnimationFrame(frame)
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0.001, (now - prev) / 1000))
    prev = now

    const cam = camera || mc.worldRenderer?.camera
    if (cam && typeof cam.getWorldPosition === 'function') {
      cam.getWorldPosition(cameraWorldPos)
    }

    const renderWallClock = Date.now() - INTERP_DELAY_MS
    const wall = Date.now()
    const tpTuningBumped = fusTpToolTuningRevision > lastTpTuningRev
    if (tpTuningBumped) {
      lastTpTuningRev = fusTpToolTuningRevision
    }
    const toRemoveAv = []
    for (const av of avatars.values()) {
      if (tpTuningBumped) {
        av.heldKey = ''
      }
      if (av.hp <= 0 && !av.deathFired) {
        av.deathFired = true
        av.triggerDeath()
        av.redrawNametag()
      }
      if (av.deathFired && av.root) {
        for (const c of av.root.children) {
          if (c !== av.nameMesh) c.visible = false
        }
      }
      const pose = av.samplePose(renderWallClock)
      if (pose) {
        if (!fusLabyIsWithinPlayerInterestXz(mc, pose.x, pose.z)) {
          toRemoveAv.push(av)
          continue
        }
      }
      if (pose) {
        av.root.position.set(pose.x, pose.y, pose.z)
        /** MC yaw 0 = -Z (facing north). Our `PlayerObject` rig's skin face texture is
         *  mapped to the -Z face of the head box (same MC skin convention), so rotation 0
         *  already faces -Z. Negate the MC yaw so rotating right in MC rotates the rig
         *  right; the previous `Math.PI - ...` left the avatar facing backwards. */
        av.root.rotation.y = -THREE.MathUtils.degToRad(pose.ry)
        /** Only show the root when alive — `deathFired` stays true from the hp≤0 frame
         *  until the avatar broadcasts a fresh hp>0 (respawn), at which point ingestRow
         *  clears both the flag and explicitly makes children visible again.
         *  Also hide past the same terrain draw window as mobs (mobile mesh lag vs RTDB pose). */
        if (!av.deathFired) {
          av.root.visible = fusLabyEntityInTerrainDrawWindow(mc, pose.x, pose.z)
        }
      }
      if (!av.deathFired) {
        const wallSync = wall + (av._fusPresenceTimeOff || 0)
        if (av.invUntil > 0 && wallSync < av.invUntil) {
          av.player.visible = (Math.floor(wallSync / 150) & 1) === 0
        } else {
          if (av.invUntil > 0) av.invUntil = 0
          av.player.visible = true
        }
      }
      const nearAnim =
        pose && fusLabyIsWithinAnimProcessRangeXz(mc, pose.x, pose.z)
      av.animate(dt, pose)
      av.updateLabyTpVfx(wall)
      if (nearAnim) {
        av.updateHeld()
        if (av._tpHeldGroup) {
          try {
            applyFusTpToolTuningToTpHolder(av._tpHeldGroup)
          } catch {
            /* ignore */
          }
        }
        av.redrawNametag()
        av.billboardNametag(cameraWorldPos)
      }
      /** Flash expiry — centralised here so no setTimeout can outlive the avatar. */
      if (av.flashUntilMs && wall >= av.flashUntilMs) {
        av.flashUntilMs = 0
        av.clearFlash()
      }
    }
    for (const av of toRemoveAv) {
      try {
        av.dispose()
      } catch {
        /* ignore */
      }
      avatars.delete(av.uid)
    }
  }
  rafId = requestAnimationFrame(frame)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) cancelAnimationFrame(rafId)
    /** `onChildAdded` etc. return an Unsubscribe fn; call each explicitly. `off(presRef)` is a
     *  belt-and-suspenders fallback in case the engine held a legacy listener on the same ref. */
    for (const uns of [onAdd, onChg, onRem, onDeathAdd]) {
      try {
        uns()
      } catch {
        /* ignore */
      }
    }
    try {
      off(presRef)
    } catch {
      /* ignore */
    }
    for (const av of avatars.values()) av.dispose()
    avatars.clear()
    for (const entry of skinCache.values()) {
      try {
        entry.texture.dispose?.()
      } catch {
        /* ignore */
      }
    }
    skinCache.clear()
    mc.fusRemoteAvatars = undefined
  }
  mc.fusDisposeRemoteAvatars = dispose
  return dispose
}

/**
 * Replace the 4 shared `MeshStandardMaterial` instances on a {@link SkinObject} with
 * `MeshBasicMaterial`s that preserve layer flags (FrontSide vs DoubleSide, polygon offset
 * for the outer layer, alphaTest). Necessary because the world scene here has no lights,
 * so Standard / Physical materials render pitch-black.
 *
 * SkinObject shares the same four material instances across every mesh, so we:
 *   1. Build four replacements carrying the same flags.
 *   2. Swap the mesh material refs during a `traverse`.
 *   3. Reassign `skin.layerXMaterial[Biased]` so the `skin.map` setter keeps working
 *      and updates our new basics on every skin change.
 *
 * @param {import('@/assets/minecraft-character/model.js').SkinObject} skin
 */
function convertSkinToBasic(skin) {
  const oldL1 = skin.layer1Material
  const oldL1B = skin.layer1MaterialBiased
  const oldL2 = skin.layer2Material
  const oldL2B = skin.layer2MaterialBiased

  const newL1 = new THREE.MeshBasicMaterial({
    map: oldL1.map || null,
    side: THREE.FrontSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  })
  const newL1B = new THREE.MeshBasicMaterial({
    map: oldL1B.map || null,
    side: THREE.FrontSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
  /**
   * Outer "slim" layer: treat as **cutout** (not blended transparency) + depth write so
   * terrain in the transparent pass does not draw over the avatar from behind.
   */
  const newL2 = new THREE.MeshBasicMaterial({
    map: oldL2.map || null,
    side: THREE.DoubleSide,
    transparent: false,
    alphaTest: 0.12,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  })
  const newL2B = new THREE.MeshBasicMaterial({
    map: oldL2B.map || null,
    side: THREE.DoubleSide,
    transparent: false,
    alphaTest: 0.12,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })

  skin.traverse((o) => {
    if (!o.isMesh) return
    if (o.material === oldL1) o.material = newL1
    else if (o.material === oldL1B) o.material = newL1B
    else if (o.material === oldL2) o.material = newL2
    else if (o.material === oldL2B) o.material = newL2B
  })

  skin.layer1Material = newL1
  skin.layer1MaterialBiased = newL1B
  skin.layer2Material = newL2
  skin.layer2MaterialBiased = newL2B

  try {
    oldL1.dispose?.()
    oldL1B.dispose?.()
    oldL2.dispose?.()
    oldL2B.dispose?.()
  } catch {
    /* ignore */
  }
}

/**
 * Legacy rows may still send `run`; Laby uses one travel speed — treat as `walk`.
 * @param {unknown} anim
 * @returns {'idle' | 'walk' | 'attack'}
 */
function normPresenceAnim(anim) {
  if (anim === 'attack') return 'attack'
  if (anim === 'walk' || anim === 'run') return anim
  return 'idle'
}

/**
 * Shortest-arc angle interpolation in degrees.
 * @param {number} a
 * @param {number} b
 * @param {number} t
 */
function lerpAngleDeg(a, b, t) {
  let d = ((b - a) + 540) % 360 - 180
  return a + d * t
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

/**
 * Map a block id to a stable color for the fallback held cube. Tools are resolved via
 * `tools.glb`, so this only fires for actual blocks.
 */
function heldIdToColor(id) {
  const KNOWN = {
    1: 0x808080, /** stone */
    2: 0x4caf50, /** grass */
    3: 0x8d6e63, /** dirt */
    4: 0x6e6e6e, /** cobble */
    5: 0xb97a57, /** planks */
    6: 0x8bc34a, /** sapling */
    7: 0x424242, /** bedrock */
    8: 0x2196f3, /** water */
    9: 0x1565c0, /** water */
    10: 0xff5722, /** lava */
    12: 0xf4e1a0, /** sand */
    13: 0x9e9e9e, /** gravel */
    14: 0xffd54f, /** gold ore */
    15: 0xbdbdbd, /** iron ore */
    16: 0x424242, /** coal ore */
    17: 0x6d4c41, /** log */
    18: 0x2e7d32, /** leaves */
    20: 0xe3f2fd, /** glass */
    35: 0xffd54f, /** wool (generic warm) */
    41: 0xffd700, /** gold block */
    42: 0xcfd8dc, /** iron block */
    49: 0x1b1b2d, /** obsidian */
    56: 0x80deea, /** diamond ore */
    57: 0x4dd0e1, /** diamond block */
  }
  return KNOWN[id] ?? 0xb0bec5
}
