import * as THREE from '@labymc/libraries/three.module.js'

/**
 * Shared combat visual-FX kit — hit particles and death bursts.
 *
 * Two entry points are published on {@code mc}:
 *   • {@code mc.fusFxHit(x, y, z, opts?)} — small "dust" burst used whenever something
 *     *takes* damage (mob getting swung on, player getting shot at, etc.). Mimics vanilla
 *     MC's critical-hit puff: ~8 tiny cubes fountain up + outward, fade and fall under
 *     gravity over ~450 ms. Cheap enough to call per hit even on mobile.
 *   • {@code mc.fusFxDeath(x, y, z, opts?)} — chunkier "disintegration" burst for when an
 *     entity dies. ~14 bigger cubes blasted outward in a full sphere, longer lifetime
 *     (~900 ms), optional base colour tint so player deaths can show a blood-red puff and
 *     mob deaths use a neutral grey dust. Callers are expected to hide the dying mesh
 *     themselves — the FX is purely additive.
 *
 * Design notes:
 *   • Particles are a pool of `Mesh`es with a single shared `MeshBasicMaterial` per
 *     "flavour" (additive hit / lambert-ish death). Recycling avoids GC thrash when
 *     spawning dozens of particles per second in a busy fight.
 *   • Physics is a tiny manual integrator: `{pos, vel, life, ttl, scale}` arrays + gravity.
 *     Using the animation system or a real particle engine would be overkill.
 *   • Pool cap scales with {@code mc.fusLowTierMobile} (Android / iOS touch) so busy fights
 *     do not peg the GPU. Oldest-wins eviction is fine for cosmetic FX.
 *   • The tick runs from {@link WorldRenderer#render} (not a second rAF) to stay aligned
 *     with the frame loop and avoid extra scheduling on weak devices.
 *   • The whole thing lives on the same `worldRenderer.scene` as mobs / avatars; we don't
 *     create a separate scene because camera matrices and tone-mapping need to match.
 *
 * @param {any} mc
 * @returns {() => void} dispose
 */
export function installFusCombatFx(mc) {
  if (!mc || !mc.worldRenderer?.scene) {
    console.warn('[fusCombatFx] missing scene; skip install')
    return () => {}
  }

  const scene = mc.worldRenderer.scene

  const maxAlive = () => (mc.fusLowTierMobile ? 40 : 160)

  /** Shared geometry — a 1×1×1 cube that each particle scales down from. One geometry
   *  avoids the per-particle buffer upload that per-mesh Box geometries would cause. */
  const cubeGeom = new THREE.BoxGeometry(1, 1, 1)

  /** Hit material: additive blend for that sparky "particle over texture" feel. */
  const hitMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  /** Death material: normal alpha blend, per-particle color via `material.color.setHex()`
   *  applied at spawn since all particles in a burst share the same flavour. We clone the
   *  material per spawn to allow different colours simultaneously (mob + player dying in
   *  the same frame). Throwaway lightweight allocations. */
  const deathMatTemplate = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  })

  /**
   * @typedef {Object} Particle
   * @property {THREE.Mesh} mesh
   * @property {THREE.Vector3} vel
   * @property {number} life  - seconds remaining
   * @property {number} ttl   - total seconds
   * @property {number} baseScale
   * @property {number} gravity
   * @property {boolean} fadeFromOne
   */
  /** @type {Particle[]} */
  const alive = []

  const GRAVITY_HIT = 16 /** blocks/s² — snappy settling. */
  const GRAVITY_DEATH = 12

  /**
   * Allocate or evict-then-reuse a mesh. We do NOT reuse old meshes because each death
   * particle carries its own cloned material; instead we free the mesh + material when
   * eviction happens. The geometry is shared so disposal cost is zero there.
   */
  const spawnMesh = (material, scale) => {
    const cap = maxAlive()
    if (alive.length >= cap) {
      const victim = alive.shift()
      if (victim) destroyParticle(victim)
    }
    const mesh = new THREE.Mesh(cubeGeom, material)
    mesh.scale.setScalar(scale)
    /** Render on top of the world but still respect occluding terrain — depth-test yes,
     *  depth-write no (kept above). Particles briefly poking into blocks is fine. */
    mesh.renderOrder = 50
    scene.add(mesh)
    return mesh
  }

  const destroyParticle = (p) => {
    try {
      scene.remove(p.mesh)
    } catch {
      /* ignore */
    }
    /** Dispose the per-particle material clone; the shared `cubeGeom` is kept. */
    const m = p.mesh.material
    if (m && m !== hitMat) {
      try {
        m.dispose?.()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Hit burst — small, sparkly, fast.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {{ count?: number, spread?: number }} [opts]
   */
  mc.fusFxHit = (x, y, z, opts = {}) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    const low = !!mc.fusLowTierMobile
    const defN = low ? 3 : 8
    let n = Number.isFinite(Number(opts.count)) ? Number(opts.count) : defN
    if (low) n = Math.min(4, Math.max(1, n))
    else n = Math.min(24, Math.max(1, n))
    const count = n
    const spread = Math.max(0.1, opts.spread ?? 0.35)
    for (let i = 0; i < count; i++) {
      const scale = (low ? 0.04 : 0.055) + Math.random() * (low ? 0.035 : 0.05)
      const mesh = spawnMesh(hitMat, scale)
      mesh.position.set(
        x + (Math.random() - 0.5) * spread * 0.5,
        y + 0.25 + (Math.random() - 0.5) * spread * 0.25,
        z + (Math.random() - 0.5) * spread * 0.5,
      )
      /** Upward-forward fountain with random scatter. */
      const vx = (Math.random() - 0.5) * 3.2
      const vy = 1.8 + Math.random() * 2.6
      const vz = (Math.random() - 0.5) * 3.2
      alive.push({
        mesh,
        vel: new THREE.Vector3(vx, vy, vz),
        life: 0.45 + Math.random() * 0.15,
        ttl: 0.6,
        baseScale: scale,
        gravity: GRAVITY_HIT,
        fadeFromOne: true,
      })
    }
  }

  /**
   * Death burst — chunkier, longer-lived, coloured.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {{ count?: number, spread?: number, color?: number }} [opts]
   */
  mc.fusFxDeath = (x, y, z, opts = {}) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    const low = !!mc.fusLowTierMobile
    const defD = low ? 10 : 18
    const count = Math.max(low ? 3 : 4, Math.min(low ? 24 : 48, Number.isFinite(Number(opts.count)) ? Number(opts.count) : defD))
    const spread = Math.max(0.25, opts.spread ?? 0.9)
    const color = typeof opts.color === 'number' ? opts.color : 0xe2e8f0
    for (let i = 0; i < count; i++) {
      /** Clone the material so we can tint this burst independently of other ongoing
       *  bursts (e.g. a player dying red next to a mob dying grey). */
      const mat = deathMatTemplate.clone()
      mat.color.setHex(color)
      const scale = 0.12 + Math.random() * 0.14
      const mesh = spawnMesh(mat, scale)
      mesh.position.set(
        x + (Math.random() - 0.5) * spread * 0.35,
        y + 0.8 + (Math.random() - 0.5) * spread * 0.4,
        z + (Math.random() - 0.5) * spread * 0.35,
      )
      /** Full sphere burst + bias upward so the puff reads as an explosion, not a settle. */
      const phi = Math.random() * Math.PI * 2
      const costh = 1 - Math.random() * 1.3 /** most particles upward, some sideways. */
      const sinth = Math.sqrt(Math.max(0, 1 - costh * costh))
      const speed = 2.2 + Math.random() * 2.4
      alive.push({
        mesh,
        vel: new THREE.Vector3(
          Math.cos(phi) * sinth * speed,
          costh * speed + 1.1,
          Math.sin(phi) * sinth * speed,
        ),
        life: 0.85 + Math.random() * 0.35,
        ttl: 1.1,
        baseScale: scale,
        gravity: GRAVITY_DEATH,
        fadeFromOne: false,
      })
    }
  }

  let disposed = false
  let prev = performance.now()

  const tick = () => {
    if (disposed) return
    const now = performance.now()
    const dt = Math.min(0.1, (now - prev) / 1000)
    prev = now

    for (let i = alive.length - 1; i >= 0; i--) {
      const p = alive[i]
      p.life -= dt
      if (p.life <= 0) {
        destroyParticle(p)
        alive.splice(i, 1)
        continue
      }
      p.vel.y -= p.gravity * dt
      p.mesh.position.x += p.vel.x * dt
      p.mesh.position.y += p.vel.y * dt
      p.mesh.position.z += p.vel.z * dt
      /** Spin a bit for visual interest — very cheap. */
      p.mesh.rotation.x += dt * 6
      p.mesh.rotation.y += dt * 4
      /** Shrink + fade toward end-of-life. Fade curve favours the back half so the burst
       *  feels punchy at the start and wisps out. */
      const t = Math.max(0, p.life / p.ttl)
      p.mesh.scale.setScalar(p.baseScale * (p.fadeFromOne ? t : 0.6 + 0.4 * t))
      if (p.mesh.material) {
        p.mesh.material.opacity = Math.min(1, Math.max(0, t * 1.4))
      }
    }
  }

  mc.fusCombatFxTick = tick

  const dispose = () => {
    if (disposed) return
    disposed = true
    delete mc.fusCombatFxTick
    for (const p of alive) destroyParticle(p)
    alive.length = 0
    try {
      cubeGeom.dispose?.()
    } catch {
      /* ignore */
    }
    try {
      hitMat.dispose?.()
    } catch {
      /* ignore */
    }
    try {
      deathMatTemplate.dispose?.()
    } catch {
      /* ignore */
    }
    mc.fusFxHit = undefined
    mc.fusFxDeath = undefined
  }
  mc.fusDisposeCombatFx = dispose
  return dispose
}
