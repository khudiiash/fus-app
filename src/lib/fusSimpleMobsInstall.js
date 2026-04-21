import * as THREE from '@labymc/libraries/three.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  FUS_MOB_TYPES,
  fusMobAggroRadius,
  fusMobAnimClip,
  fusMobDmgHalfForLevel,
  fusMobMaxHpForLevel,
  fusMobTypeById,
} from '@labymc/src/js/net/minecraft/client/fus/FusMobRegistry.js'

/**
 * Single-file, local-only mob system. Replacement for the deleted FusMobSync (and the 5 sibling
 * files it depended on) requested by the user as a "throw it away, rewrite smaller" rebuild.
 *
 * Scope on purpose:
 *   - Local only — no RTDB sync, no presence, no server authority. Each client runs its own mob pool.
 *   - Uses {@link FUS_MOB_TYPES} registry (intact) for model paths, HP/damage scaling and aggro radii.
 *   - GLB urls resolve through `__LABY_MC_ASSET_BASE__` (see `labymcEngineMobModelsPlugin` in vite.config).
 *   - AI: acquire target within `aggroRadius`, chase on xz, snap to terrain height each frame, stop at
 *     melee range, drop to idle when target drifts past `1.5 × aggroRadius`.
 *   - Attack hook: installs `mc.fusTryRemoteMelee` so the engine's left-click {@link Minecraft#onMouseClicked}
 *     routes damage to the nearest mob inside a forward cone (no raycast against voxels — keeps this file
 *     self-contained). Returning `true` tells the engine we handled the click so no block gets broken.
 *   - On death: optional `window.__FUS_GRANT_LOOT__({ kind: 'coins', coins: 1 })` call so the existing
 *     view-level Firestore wiring still earns the player coins.
 *
 * Call once after world load:
 *   {@code installFusSimpleMobs(mc, { count: 8, spawnRadius: 28, level: 1 })}
 *   — returns a `dispose()` that removes meshes + cancels the animation loop.
 *
 * @param {any} mc - Running Minecraft instance.
 * @param {{ count?: number, spawnRadius?: number, level?: number, respawn?: boolean }} [opts]
 */
export function installFusSimpleMobs(mc, opts = {}) {
  if (!mc || !mc.worldRenderer?.scene) {
    console.warn('[fusSimpleMobs] missing scene; skip install')
    return () => {}
  }

  const {
    count = 8,
    spawnRadius = 28,
    level = 1,
    respawn = true,
  } = opts

  const scene = mc.worldRenderer.scene

  /** @type {Map<string, Promise<{ scene: THREE.Group, clips: THREE.AnimationClip[] }>>} */
  const templateCache = new Map()

  const mobs = []
  mc.fusSimpleMobs = mobs

  let disposed = false
  let rafId = 0
  let respawnIv = 0

  /**
   * GLB url for a mob type, derived from the runtime asset base (`window.__LABY_MC_ASSET_BASE__`).
   * Falls back to `/labyminecraft/` so the loader doesn't fail silently on a stray reload.
   */
  const glbUrlFor = (typeId) => {
    const t = fusMobTypeById(typeId)
    const base =
      typeof window !== 'undefined' && typeof window.__LABY_MC_ASSET_BASE__ === 'string'
        ? window.__LABY_MC_ASSET_BASE__
        : '/labyminecraft/'
    return `${base}src/resources/models/${t.file}`
  }

  const loadTemplate = (typeId) => {
    const cached = templateCache.get(typeId)
    if (cached) return cached
    const loader = new GLTFLoader()
    const url = glbUrlFor(typeId)
    const p = new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => resolve({ scene: gltf.scene, clips: gltf.animations || [] }),
        undefined,
        (err) => reject(err),
      )
    })
    templateCache.set(typeId, p)
    return p
  }

  const randomTypeId = () => {
    const i = Math.floor(Math.random() * FUS_MOB_TYPES.length)
    return FUS_MOB_TYPES[i].id
  }

  const groundYAt = (wx, wz) => {
    const w = mc.world
    if (!w || typeof w.getHeightAt !== 'function') return null
    const h = w.getHeightAt(Math.floor(wx), Math.floor(wz))
    return typeof h === 'number' && h > 0 ? h : null
  }

  const findSpawnNearPlayer = () => {
    const pl = mc.player
    if (!pl) return null
    for (let tries = 0; tries < 12; tries++) {
      const ang = Math.random() * Math.PI * 2
      /** Keep mobs at least 12 blocks out so the first frame isn't a face full of spider. */
      const r = Math.max(12, spawnRadius * (0.45 + Math.random() * 0.55))
      const sx = pl.x + Math.cos(ang) * r
      const sz = pl.z + Math.sin(ang) * r
      const h = groundYAt(sx, sz)
      if (h == null) continue
      return { x: sx, y: h + 1, z: sz }
    }
    return null
  }

  const spawnOne = async () => {
    if (disposed) return
    const typeId = randomTypeId()
    const type = fusMobTypeById(typeId)
    /** @type {{ scene: THREE.Group, clips: THREE.AnimationClip[] } | null} */
    let tpl = null
    try {
      tpl = await loadTemplate(typeId)
    } catch (e) {
      console.warn('[fusSimpleMobs] GLB load failed', typeId, e)
      return
    }
    if (disposed) return
    const pos = findSpawnNearPlayer()
    if (!pos) return

    const mesh = tpl.scene.clone(true)
    const scale = typeof type.modelScale === 'number' && type.modelScale > 0 ? type.modelScale : 1
    mesh.scale.setScalar(scale)
    mesh.position.set(pos.x, pos.y, pos.z)
    /** GLTF scenes commonly ship with matrixAutoUpdate=true per child; make sure it stays that way. */
    mesh.matrixAutoUpdate = true
    mesh.traverse((o) => {
      o.matrixAutoUpdate = true
      if (o.isMesh) {
        o.castShadow = false
        o.receiveShadow = false
      }
    })
    scene.add(mesh)

    let mixer = null
    let idleAction = null
    let walkAction = null
    let attackAction = null
    if (tpl.clips.length > 0) {
      mixer = new THREE.AnimationMixer(mesh)
      const idleClip = fusMobAnimClip(tpl.clips, 'idle', type)
      const walkClip = fusMobAnimClip(tpl.clips, 'walk', type)
      const attackClip = fusMobAnimClip(tpl.clips, 'attack', type)
      if (idleClip) {
        idleAction = mixer.clipAction(idleClip)
        idleAction.play()
      }
      if (walkClip) {
        walkAction = mixer.clipAction(walkClip)
        walkAction.setEffectiveWeight(0)
        walkAction.play()
      }
      if (attackClip) {
        attackAction = mixer.clipAction(attackClip)
        attackAction.setLoop(THREE.LoopOnce, 1)
      }
    }

    const maxHp = fusMobMaxHpForLevel(level, type)
    const mob = {
      id: `m_${Math.random().toString(36).slice(2, 9)}`,
      typeId,
      type,
      mesh,
      mixer,
      idleAction,
      walkAction,
      attackAction,
      hp: maxHp,
      maxHp,
      level,
      /** Move step (blocks / frame at 60 fps). Baseline 0.035 tuned so default mob crosses ~2 bl/sec. */
      speed: 0.035 * (type.moveSpeed || 1),
      aggroR: fusMobAggroRadius(typeId),
      dmgHalf: fusMobDmgHalfForLevel(typeId, level, 2),
      state: 'idle',
      targetY: pos.y,
    }
    mobs.push(mob)
  }

  const initialSpawn = async () => {
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      await spawnOne()
    }
  }
  void initialSpawn()

  /**
   * Periodic respawn to maintain `count`. Cheap: a single `length` check and a fire-and-forget
   * spawn per tick. Stopped in {@code dispose}.
   */
  if (respawn) {
    respawnIv = window.setInterval(() => {
      if (disposed) return
      if (mobs.length < count) {
        void spawnOne()
      }
    }, 4000)
  }

  /** Attack hook — engine routes left-click here first (see Minecraft.onMouseClicked). */
  const DAMAGE_PER_HIT = 8
  const ATTACK_RANGE = 5
  /** Cosine of the half-angle accepted by the forward cone (~30°). */
  const ATTACK_CONE_COS = 0.86
  const prevRemoteMelee = mc.fusTryRemoteMelee

  const tryMelee = () => {
    const pl = mc.player
    if (!pl) return false
    if (mobs.length === 0) return false
    /** Mirrors {@code PlayerEntity.getVectorForRotation} so the attack cone lines up with the crosshair. */
    const yawRad = (pl.rotationYaw * Math.PI) / 180
    const pitchRad = (pl.rotationPitch * Math.PI) / 180
    const cosP = Math.cos(pitchRad)
    const dirX = Math.sin(yawRad) * cosP
    const dirY = -Math.sin(pitchRad)
    const dirZ = -Math.cos(yawRad) * cosP
    const eyeY = pl.y + 1.5

    let best = null
    let bestDot = ATTACK_CONE_COS
    for (const m of mobs) {
      const dx = m.mesh.position.x - pl.x
      const dy = m.mesh.position.y + 1 - eyeY
      const dz = m.mesh.position.z - pl.z
      const dist = Math.hypot(dx, dy, dz)
      if (dist > ATTACK_RANGE) continue
      const dot = (dx * dirX + dy * dirY + dz * dirZ) / (dist || 1)
      if (dot > bestDot) {
        bestDot = dot
        best = m
      }
    }
    if (!best) return false

    best.hp -= DAMAGE_PER_HIT
    try {
      pl.swingArm?.()
    } catch {
      /* ignore — not all forks expose swingArm */
    }

    if (best.hp <= 0) {
      killMob(best)
    } else {
      flashHit(best)
    }
    return true
  }
  mc.fusTryRemoteMelee = tryMelee

  const flashHit = (mob) => {
    /** Tint red briefly on hit so the user gets feedback. */
    mob.mesh.traverse((o) => {
      if (o.isMesh && o.material && !o._fusOrigColor) {
        const mat = o.material
        o._fusOrigColor = mat.color ? mat.color.clone() : null
        if (mat.color) mat.color.setRGB(1, 0.25, 0.25)
      }
    })
    window.setTimeout(() => {
      if (!mob || !mob.mesh) return
      mob.mesh.traverse((o) => {
        if (o.isMesh && o.material && o._fusOrigColor) {
          try {
            o.material.color.copy(o._fusOrigColor)
          } catch {
            /* ignore */
          }
          o._fusOrigColor = null
        }
      })
    }, 120)
  }

  const killMob = (mob) => {
    const ix = mobs.indexOf(mob)
    if (ix >= 0) mobs.splice(ix, 1)
    scene.remove(mob.mesh)
    try {
      mob.mixer?.stopAllAction?.()
    } catch {
      /* ignore */
    }
    mob.mesh.traverse((o) => {
      if (o.isMesh) {
        try {
          o.geometry?.dispose?.()
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) m?.dispose?.()
        } catch {
          /* ignore */
        }
      }
    })

    try {
      if (typeof window !== 'undefined' && typeof window.__FUS_GRANT_LOOT__ === 'function') {
        window.__FUS_GRANT_LOOT__({ kind: 'coins', coins: 1 })
      }
    } catch (e) {
      console.warn('[fusSimpleMobs] loot grant failed', e)
    }
    try {
      if (typeof window !== 'undefined' && typeof window.__FUS_GRANT_LABY_XP__ === 'function') {
        const myUid = mc.session?.profile?.getId?.() || null
        window.__FUS_GRANT_LABY_XP__(5 * Math.max(1, mob.level), {
          mobType: mob.type?.displayName || mob.typeId,
          killerUid: myUid,
        })
      }
    } catch {
      /* ignore */
    }
  }

  /** Main animation + AI loop — decoupled from the engine's own RAF so a frozen engine doesn't freeze us. */
  let prevTimeMs = performance.now()
  const frame = () => {
    if (disposed) return
    rafId = requestAnimationFrame(frame)
    const now = performance.now()
    const dt = Math.min(0.1, (now - prevTimeMs) / 1000)
    prevTimeMs = now

    const pl = mc.player
    if (!pl || mc.fusFrozen) {
      for (const m of mobs) m.mixer?.update?.(dt)
      return
    }

    for (const m of mobs) {
      m.mixer?.update?.(dt)
      const dx = pl.x - m.mesh.position.x
      const dz = pl.z - m.mesh.position.z
      const dist = Math.hypot(dx, dz)
      const engaged = dist < m.aggroR * 1.5
      const inMelee = dist < 1.4

      if (engaged && !inMelee) {
        const nx = dx / (dist || 1)
        const nz = dz / (dist || 1)
        const step = m.speed * 60 * dt
        m.mesh.position.x += nx * step
        m.mesh.position.z += nz * step
        m.mesh.rotation.y = Math.atan2(nx, nz)
        blendTo(m, 'walk')
      } else if (inMelee) {
        blendTo(m, 'attack')
      } else {
        blendTo(m, 'idle')
      }

      const gy = groundYAt(m.mesh.position.x, m.mesh.position.z)
      if (gy != null) {
        m.targetY = gy + 1
      }
      /** Vertical easing so walking up terrain isn't a teleport. */
      m.mesh.position.y += (m.targetY - m.mesh.position.y) * Math.min(1, dt * 12)
    }
  }

  const blendTo = (mob, role) => {
    if (mob.state === role) return
    const durS = 0.15
    const set = (action, weight) => {
      if (!action) return
      action.enabled = true
      action.setEffectiveWeight(weight)
    }
    if (role === 'walk') {
      set(mob.idleAction, 0)
      set(mob.walkAction, 1)
    } else if (role === 'idle') {
      set(mob.idleAction, 1)
      set(mob.walkAction, 0)
    } else if (role === 'attack') {
      /** Only trigger attack if a clip exists; otherwise fall back to idle so we don't lock the mob. */
      if (mob.attackAction) {
        mob.attackAction.reset()
        mob.attackAction.setEffectiveWeight(1)
        mob.attackAction.play()
      } else {
        set(mob.idleAction, 1)
        set(mob.walkAction, 0)
      }
    }
    mob.state = role
    void durS /* reserved for future crossfade */
  }

  rafId = requestAnimationFrame(frame)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    if (respawnIv) {
      window.clearInterval(respawnIv)
      respawnIv = 0
    }
    for (const m of mobs) {
      scene.remove(m.mesh)
      try {
        m.mixer?.stopAllAction?.()
      } catch {
        /* ignore */
      }
    }
    mobs.length = 0
    /** Restore whatever was on `fusTryRemoteMelee` before we installed. */
    mc.fusTryRemoteMelee = typeof prevRemoteMelee === 'function' ? prevRemoteMelee : null
    delete mc.fusSimpleMobs
  }
  mc.fusDisposeSimpleMobs = dispose

  return dispose
}
