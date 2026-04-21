import * as THREE from '@labymc/libraries/three.module.js'
import ParticleDigging from '@labymc/src/js/net/minecraft/client/render/particle/particle/ParticleDigging.js'
import Block from '@labymc/src/js/net/minecraft/client/world/block/Block.js'

/**
 * Block-hardness / progressive-breaking system.
 *
 * Replaces the engine's one-click-destroys-a-block behaviour with a held-to-break flow:
 *   • Each block id has a base break time (seconds) from {@link BLOCK_BASE_BREAK_SECONDS}.
 *   • The currently-held hotbar tool (read off `mc.fusHotbarSlotMeta[selectedSlotIndex]`)
 *     applies a multiplier via {@link TOOL_MULTIPLIERS}. Using the wrong family (sword on
 *     stone) is slow; the right family (pickaxe on stone) is fast.
 *   • While the player holds the left mouse / primary touch and the crosshair rests on the
 *     same block, a progress bar [0..1] accumulates. Completion destroys the block using
 *     the engine's existing destroy path (sound + {@link ParticleRenderer#spawnBlockBreakParticle}).
 *   • During breaking, a "crack overlay" mesh is pinned just outside the block showing the
 *     repo's shader-like noise.png as an alpha mask whose threshold advances with progress,
 *     mirroring vanilla's progressive destroy-stage sprites.
 *   • Small dust puffs ({@link ParticleDigging}) spawn every ~200 ms while breaking, so the
 *     user sees continuous feedback (not just the end burst).
 *
 * Interaction with the engine's click path:
 *   • We wrap {@code mc.onMouseClicked(0)} to suppress vanilla's instant-break on button 0
 *     while preserving {@code fusTryRemoteMelee} (hits on simple-mobs still work).
 *   • Buttons 1 (pick) and 2 (place) go untouched.
 *   • GameWindow's repeat interval keeps firing {@code onMouseClicked(0)} every 250 ms, but
 *     our wrapper turns those into no-ops — the real work is driven by an RAF loop that
 *     tracks pointer state via capture-phase window listeners (robust vs. focus changes).
 *
 * Disposer restores the original {@code onMouseClicked}, removes listeners, and tears down
 * the overlay mesh / material / texture.
 *
 * @param {any} mc
 * @returns {() => void}
 */
export function installFusBlockHardness(mc) {
  if (!mc || !mc.worldRenderer?.scene) {
    console.warn('[fusBlockHardness] missing scene; skip install')
    return () => {}
  }

  const scene = mc.worldRenderer.scene

  let pointerDown = false

  /**
   * Pointer state is tracked via capture-phase listeners so the engine's own handlers can't
   * swallow the event before we see it. We deliberately key on `pointerdown` rather than
   * `mousedown` so touch input (primary contact) is treated the same as desktop LMB.
   */
  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointerDown = true
  }
  const onPointerUp = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointerDown = false
    resetBreak()
  }
  const onBlur = () => {
    pointerDown = false
    resetBreak()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('pointerup', onPointerUp, { capture: true })
    window.addEventListener('pointercancel', onPointerUp, { capture: true })
    window.addEventListener('blur', onBlur)
  }

  const origOnMouseClicked = mc.onMouseClicked?.bind(mc)
  /**
   * Replacement click handler. For button 0 we:
   *   1. Let {@code fusTryRemoteMelee} run first (so players can still damage simple-mobs).
   *   2. Otherwise do nothing here — the held-to-break RAF loop advances progress on its own
   *      and calls the destroy path itself when complete.
   */
  mc.onMouseClicked = function fusPatchedOnMouseClicked(button) {
    if (button !== 0) {
      if (origOnMouseClicked) origOnMouseClicked(button)
      return
    }
    if (!this.window?.isLocked?.()) {
      if (origOnMouseClicked) origOnMouseClicked(button)
      return
    }
    if (
      typeof window !== 'undefined' &&
      window.__LABY_MC_FUS_EMBED__ &&
      typeof this.fusTryRemoteMelee === 'function'
    ) {
      if (this.fusTryRemoteMelee()) {
        this.worldRenderer.flushRebuild = true
        return
      }
    }
    /** Arm the break RAF; actual progress advances in the frame loop. */
    this.player?.swingArm?.()
  }

  const noiseTex = loadNoiseTexture()
  /**
   * The overlay is a 1.006³ cube so its faces sit ~3 mm outside the block's faces. That's
   * close enough to not show Z-fighting with the actual block, but far enough to avoid
   * depth-buffer flicker when the camera moves across the crack.
   */
  const overlayMat = new THREE.MeshBasicMaterial({
    map: noiseTex,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    alphaTest: 1.0,
    side: THREE.FrontSide,
    color: 0x000000,
    blending: THREE.NormalBlending,
  })
  const overlayMesh = new THREE.Mesh(new THREE.BoxGeometry(1.006, 1.006, 1.006), overlayMat)
  overlayMesh.visible = false
  overlayMesh.renderOrder = 100
  scene.add(overlayMesh)

  /**
   * @typedef {{ key: string, x: number, y: number, z: number, typeId: number, progress: number, lastParticleAt: number }} BreakState
   * @type {BreakState | null}
   */
  let cur = null

  const resetBreak = () => {
    cur = null
    overlayMesh.visible = false
  }

  const keyOf = (x, y, z) => `${x},${y},${z}`

  let rafId = 0
  let prev = performance.now()
  let disposed = false

  const frame = () => {
    if (disposed) return
    rafId = requestAnimationFrame(frame)
    const now = performance.now()
    const dt = Math.min(0.1, (now - prev) / 1000)
    prev = now

    if (!pointerDown || mc.fusFrozen) {
      if (cur) resetBreak()
      return
    }
    if (mc.currentScreen) {
      if (cur) resetBreak()
      return
    }
    /** Mid-teleport channel: no mining. Mirrors the movement lock in fusLabySpawnFlagInstall. */
    if (mc.fusLabyChannelLockMove) {
      if (cur) resetBreak()
      return
    }
    const pl = mc.player
    const world = mc.world
    const wr = mc.worldRenderer
    if (!pl || !world || !wr) {
      if (cur) resetBreak()
      return
    }
    if (!mc.window?.isLocked?.()) {
      if (cur) resetBreak()
      return
    }

    const partial = mc.timer?.partialTicks ?? 0
    const hit = safeRayTrace(pl, partial)
    if (!hit) {
      if (cur) resetBreak()
      return
    }

    const typeId = world.getBlockAt(hit.x, hit.y, hit.z)
    if (typeId === 0) {
      if (cur) resetBreak()
      return
    }

    const k = keyOf(hit.x, hit.y, hit.z)
    if (!cur || cur.key !== k || cur.typeId !== typeId) {
      cur = {
        key: k,
        x: hit.x,
        y: hit.y,
        z: hit.z,
        typeId,
        progress: 0,
        lastParticleAt: 0,
      }
    }

    const baseSeconds = BLOCK_BASE_BREAK_SECONDS[typeId] ?? DEFAULT_BREAK_SECONDS
    if (baseSeconds === Infinity) {
      /** Unbreakable (bedrock). Keep the overlay off so the user doesn't think they're making progress. */
      overlayMesh.visible = false
      return
    }
    const mult = toolMultiplierFor(mc, typeId)
    /** Safety: any multiplier path that returns 0 or negative would produce NaN progress.
     *  Clamp to a slow-but-positive speed so we can't soft-lock the break. */
    const effSeconds = Math.max(0.15, baseSeconds / Math.max(0.05, mult))
    cur.progress = Math.min(1, cur.progress + dt / effSeconds)

    /** Overlay: position on block centre, alphaTest ramps so more of the noise texture becomes
     *  opaque as progress grows. Start at alphaTest=0.95 (almost invisible) → 0.1 (very visible). */
    overlayMesh.visible = true
    overlayMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5)
    overlayMat.alphaTest = Math.max(0.02, 0.95 - cur.progress * 0.85)
    overlayMat.opacity = 0.35 + cur.progress * 0.4
    overlayMat.needsUpdate = true

    /** Hit-dust particles: cap to ~5 per second while breaking; skip on low-tier mobile to
     *  keep the particle pool below the soft-budget {@link ParticleRenderer} runs. */
    if (!mc.fusLowTierMobile && now - cur.lastParticleAt > 200) {
      cur.lastParticleAt = now
      spawnHitDust(mc, hit.x, hit.y, hit.z, typeId)
    }

    if (cur.progress >= 1) {
      finishBreak(mc, cur)
      resetBreak()
    }
  }
  rafId = requestAnimationFrame(frame)

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointerup', onPointerUp, { capture: true })
      window.removeEventListener('pointercancel', onPointerUp, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
    scene.remove(overlayMesh)
    try {
      overlayMesh.geometry.dispose()
      overlayMat.dispose()
      noiseTex.dispose()
    } catch {
      /* ignore */
    }
    if (origOnMouseClicked) {
      mc.onMouseClicked = origOnMouseClicked
    }
  }
  mc.fusDisposeBlockHardness = dispose
  return dispose
}

/** Resolve `noise.png` via the same asset-base window global everything else in FUS uses. */
function loadNoiseTexture() {
  const base =
    typeof window !== 'undefined' && typeof window.__LABY_MC_ASSET_BASE__ === 'string'
      ? String(window.__LABY_MC_ASSET_BASE__).replace(/\/?$/, '/')
      : '/labyminecraft/'
  const url = `${base}src/resources/misc/noise.png`
  const loader = new THREE.TextureLoader()
  const tex = loader.load(url)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace
  return tex
}

function safeRayTrace(pl, partial) {
  try {
    return pl.rayTrace(5, partial) || null
  } catch {
    return null
  }
}

/**
 * Finish a break: reproduces the side-effects the engine's vanilla destroy-on-click does
 * (sound + spawnBlockBreakParticle + setBlockAt(0)), plus a best-effort
 * {@code worldRenderer.flushRebuild} so the chunk re-meshes this frame.
 */
function finishBreak(mc, state) {
  try {
    const block = Block.getById(state.typeId)
    if (block) {
      const sound = block.getSound()
      if (sound && mc.soundManager) {
        mc.soundManager.playSound(
          sound.getBreakSound(),
          state.x + 0.5,
          state.y + 0.5,
          state.z + 0.5,
          1.0,
          1.0,
        )
      }
    }
    mc.particleRenderer?.spawnBlockBreakParticle?.(mc.world, state.x, state.y, state.z)
    mc.world.setBlockAt(state.x, state.y, state.z, 0)
    mc.worldRenderer.flushRebuild = true
  } catch (e) {
    console.warn('[fusBlockHardness] finishBreak threw', e)
  }
}

/** Spawn a handful of ParticleDigging flakes on the top face of the block (cheaper than the
 *  64-particle burst used on final break). */
function spawnHitDust(mc, x, y, z, typeId) {
  const block = Block.getById(typeId)
  if (!block) return
  for (let i = 0; i < 4; i++) {
    const px = x + Math.random()
    const py = y + 1 + Math.random() * 0.1
    const pz = z + Math.random()
    const mx = (Math.random() - 0.5) * 0.3
    const my = 0.1 + Math.random() * 0.15
    const mz = (Math.random() - 0.5) * 0.3
    try {
      mc.particleRenderer?.spawnParticle?.(
        new ParticleDigging(mc, mc.world, px, py, pz, mx, my, mz, block),
      )
    } catch {
      /* ignore a single bad particle */
    }
  }
}

/**
 * Base break times (seconds of continuous mining with a **fist** / neutral tool).
 * Values roughly mirror classic Minecraft block strengths but scaled for a game whose
 * combat pace is noticeably faster than vanilla — dirt should feel *satisfying*, not
 * tedious, so we keep the weak blocks sub-second.
 *
 * Any id missing from the map uses {@link DEFAULT_BREAK_SECONDS}. Bedrock (`7`) is
 * flagged `Infinity` so players cannot ever progress the bar on it.
 */
const BLOCK_BASE_BREAK_SECONDS = {
  1: 2.2, // STONE
  2: 0.8, // GRASS
  3: 0.7, // DIRT
  4: 2.5, // COBBLE_STONE
  5: 2.0, // WOOD (planks)
  7: Infinity, // BEDROCK
  12: 0.75, // SAND
  13: 0.8, // GRAVEL
  17: 1.8, // LOG
  18: 0.35, // LEAVE
  20: 0.4, // GLASS
  50: 0.1, // TORCH
}
const DEFAULT_BREAK_SECONDS = 1.5

/**
 * Tool family → per-block-family multiplier (>1 means "faster than fist"). Categorisation
 * is kept deliberately coarse so adding a new skin in the shop doesn't require editing a
 * thousand-entry lookup table: we match tool family by substring on the mesh name that the
 * hotbar already persists (see `fusLabyHotbarFromProfile.js`).
 */
const TOOL_MULTIPLIERS = {
  pickaxe: { stone: 5, metal: 6, dirt: 1, wood: 1.2, leave: 1, glass: 1.5 },
  axe: { stone: 1, metal: 1, dirt: 1, wood: 5, leave: 1.5, glass: 1 },
  shovel: { stone: 1, metal: 1, dirt: 5, wood: 1, leave: 1, glass: 1 },
  sword: { stone: 0.6, metal: 0.5, dirt: 0.8, wood: 0.8, leave: 3, glass: 0.8 },
  fist: { stone: 1, metal: 0.5, dirt: 1, wood: 1, leave: 1, glass: 1 },
}

function blockFamily(typeId) {
  switch (typeId) {
    case 1:
    case 4:
    case 7:
      return 'stone'
    case 2:
    case 3:
    case 12:
    case 13:
      return 'dirt'
    case 5:
    case 17:
      return 'wood'
    case 18:
      return 'leave'
    case 20:
      return 'glass'
    default:
      return 'stone'
  }
}

function toolMultiplierFor(mc, typeId) {
  const pl = mc.player
  const slotMeta = mc.fusHotbarSlotMeta
  const idx = pl?.inventory?.selectedSlotIndex ?? 0
  const meta = Array.isArray(slotMeta) ? slotMeta[idx] : null
  const toolName = meta && meta.kind === 'tool' && typeof meta.toolMeshName === 'string' ? meta.toolMeshName.toLowerCase() : ''
  let family = 'fist'
  if (toolName.includes('pickaxe')) family = 'pickaxe'
  else if (toolName.includes('axe')) family = 'axe'
  else if (toolName.includes('shovel') || toolName.includes('spade')) family = 'shovel'
  else if (toolName.includes('sword')) family = 'sword'
  const fam = blockFamily(typeId)
  const row = TOOL_MULTIPLIERS[family] || TOOL_MULTIPLIERS.fist
  /** Diamond tools get a modest extra multiplier on top of the family bonus. */
  const diamondBonus = toolName.includes('diamond') ? 1.35 : toolName.includes('iron') ? 1.15 : toolName.includes('gold') ? 1.0 : toolName.includes('stone') ? 0.85 : toolName.includes('wood') ? 0.7 : 1
  return (row[fam] || 1) * diamondBonus
}
