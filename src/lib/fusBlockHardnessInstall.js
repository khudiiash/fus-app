import * as THREE from '@labymc/libraries/three.module.js'
import ParticleDigging from '@labymc/src/js/net/minecraft/client/render/particle/particle/ParticleDigging.js'
import Block from '@labymc/src/js/net/minecraft/client/world/block/Block.js'
import { BlockRegistry } from '@labymc/src/js/net/minecraft/client/world/block/BlockRegistry.js'
/**
 * Break strip is sampled from the same sheet as `worldRenderer.textureTerrain` (FUS:
 * {@code terrain/terrain.png}). Default: macrotiles 16–23 (row 1) → pixel (0,16), 128×16, 8 stages.
 * Override with {@code mc.fusDestroyStripPixels}.
 */
const DEFAULT_DESTROY_STRIP = Object.freeze({ x0: 0, y0: 16, tile: 16, stages: 8 })

/** Blit a single stage into a small square texture — avoids `map.repeat/offset` on a cloned
 *  atlas, which reuses mipmaps/linear filters and bleeds *neighbouring* macrotiles (seams, wrong
 *  colours, “magenta on edges” from unrelated atlas pixels). */
const CRACK_BLIT_PX = 96

/**
 * @returns {{ tex: import('three').CanvasTexture, cv: HTMLCanvasElement }}
 */
function createBlittedCrackMapTexture() {
  const cv = document.createElement('canvas')
  cv.width = CRACK_BLIT_PX
  cv.height = CRACK_BLIT_PX
  const tex = new THREE.CanvasTexture(cv)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  /** Do not tag generated canvas as sRGB — wrong transform + fog on alpha = pink fringes. */
  tex.colorSpace =
    typeof THREE !== 'undefined' && THREE.NoColorSpace !== undefined
      ? THREE.NoColorSpace
      : 'no-color-space'
  return { tex, cv }
}

/**
 * @param {HTMLCanvasElement} cv
 * @param {CanvasImageSource} sourceImage
 * @param {{ x0?: number, y0?: number, tile?: number, stages?: number }} strip
 * @param {number} stageIndex
 * @returns {boolean}
 */
function blitDestroyStripToCrackMap(cv, sourceImage, strip, stageIndex) {
  if (!cv || !sourceImage) return false
  const w =
    /** @type {any} */ (sourceImage).naturalWidth ||
    /** @type {any} */ (sourceImage).width
  const h =
    /** @type {any} */ (sourceImage).naturalHeight ||
    /** @type {any} */ (sourceImage).height
  if (!(w > 0) || !(h > 0)) return false
  const x0s = Number(strip.x0) || DEFAULT_DESTROY_STRIP.x0
  const y0s = Number(strip.y0) || DEFAULT_DESTROY_STRIP.y0
  const tile = Number(strip.tile) || DEFAULT_DESTROY_STRIP.tile
  const stages = Math.max(1, Math.min(32, Math.floor(Number(strip.stages) || DEFAULT_DESTROY_STRIP.stages)))
  const st = Math.max(0, Math.min(stages - 1, stageIndex | 0))
  const sx = x0s + st * tile
  const sy = y0s
  if (sx < 0 || sy < 0 || sx + tile > w || sy + tile > h) {
    return false
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return false
  ctx.clearRect(0, 0, cv.width, cv.height)
  ctx.imageSmoothingEnabled = false
  try {
    ctx.drawImage(sourceImage, sx, sy, tile, tile, 0, 0, cv.width, cv.height)
  } catch {
    return false
  }
  return true
}

/**
 * Horizontal strip: {@code stages} square frames, dark polylines on transparent RGBA. Works
 * when the terrain atlas has no (or empty) β240 destroy macrotiles.
 * @param {number} stages
 * @returns {import('three').CanvasTexture | null}
 */
function buildProceduralDestroyTexture(stages) {
  if (typeof document === 'undefined') return null
  const fSize = 48
  const cv = document.createElement('canvas')
  cv.width = fSize * stages
  cv.height = fSize
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.clearRect(0, 0, cv.width, cv.height)
  let seed = 0x27d4eb2d
  const roll = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0xffffffff
  }
  for (let f = 0; f < stages; f++) {
    const ox = f * fSize
    const density = 2 + f * 2
    const w = 1 + Math.min(2, Math.floor(f / 2))
    ctx.strokeStyle = 'rgba(0,0,0,0.78)'
    ctx.lineWidth = w
    ctx.lineCap = 'round'
    for (let i = 0; i < density; i++) {
      const x0 = ox + roll() * fSize
      const y0 = roll() * fSize
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      let px = x0
      let py = y0
      for (let s = 0; s < 3; s++) {
        const ang = roll() * Math.PI * 2
        const len = 5 + roll() * 12
        px += Math.cos(ang) * len
        py += Math.sin(ang) * len
        ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace =
    typeof THREE !== 'undefined' && THREE.NoColorSpace !== undefined
      ? THREE.NoColorSpace
      : 'no-color-space'
  tex.repeat.set(1 / stages, 1)
  tex.offset.set(0, 0)
  return tex
}

/**
 * @param {import('three').Texture | null} map
 * @param {number} stageIndex
 * @param {number} stages
 */
function setProceduralDestroyFrame(map, stageIndex, stages) {
  if (!map) return
  const st = Math.max(0, Math.min(stages - 1, stageIndex | 0))
  const inv = 1 / stages
  if (Math.abs(map.repeat.x - inv) > 1e-7) map.repeat.set(inv, 1)
  const ox = st * inv
  if (Math.abs(map.offset.x - ox) > 1e-7 || Math.abs(map.offset.y) > 1e-7) {
    map.offset.set(ox, 0)
  }
}

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
 *   • During breaking, a "crack overlay" uses a {@link Texture#clone} of `terrain` with UVs
 *     on the destroy strip (default pixel rect {@link DEFAULT_DESTROY_STRIP}). Override with
 *     {@code mc.fusDestroyStripPixels}. Set {@code mc.fusUseProceduralDestroyOverlay = true}
 *     for a built-in canvas strip only.
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
  const instantBlockActions = mc.fusInstantBlockActions !== false
  const scene = mc.worldRenderer.scene
  let mouseBreakHeld = false

  /**
   * Desktop-only pointer tracking. On mobile we must NOT use a global `pointerdown`
   * listener because the look-drag / joystick / jump-button pointers would flip this flag
   * too (and releasing any of them while the break button was still held would prematurely
   * {@code resetBreak}). Instead mobile drives breaks through an explicit
   * {@code mc.fusMobileBreakHeld} (kept for compatibility; the look zone no longer holds
   *  it during drags — mobile mining is tap-driven from {@link LabyMobileControls}).
   *
   * Mouse-only filter: we reject `pointerType === 'pen' / 'touch'` and ignore non-primary
   * buttons; right/middle click never starts mining.
   */
  const onPointerDown = (e) => {
    if (e.pointerType !== 'mouse') return
    if (e.button !== 0) return
    mouseBreakHeld = true
  }
  const onPointerUp = (e) => {
    if (e.pointerType !== 'mouse') return
    if (e.button !== 0) return
    mouseBreakHeld = false
    /** Do not {@link resetBreak} here — releasing the button only pauses dt progress; the crack
     *  and `cur` stay so tap-tap and short holds keep accumulated mining (and VFX) coherent.
     *  Full reset happens on new block, break completion, or blur. */
  }
  const onMouseDown = (e) => {
    if (e.button !== 0) return
    mouseBreakHeld = true
  }
  const onMouseUp = (e) => {
    if (e.button !== 0) return
    mouseBreakHeld = false
  }
  const onBlur = () => {
    mouseBreakHeld = false
    resetBreak()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('pointerup', onPointerUp, { capture: true })
    window.addEventListener('pointercancel', onPointerUp, { capture: true })
    window.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('mouseup', onMouseUp, { capture: true })
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
    /** Dead players don't click. Blocks anything from breaking, being placed, or mobs
     *  being hit while the death overlay is waiting for the respawn button. */
    if (typeof this.fusIsDead === 'function' && this.fusIsDead()) return
    if (button !== 0) {
      if (origOnMouseClicked) origOnMouseClicked(button)
      return
    }
    /** Mobile taps never acquire pointer lock, so the engine's own `isLocked` guard would
     *  swallow every click. We only need a locked pointer on desktop — on touch devices
     *  the mobile HUD button is authoritative input and the lock check is meaningless.
     *  Detect touch once per click to keep the guard tight on desktop (where an unlocked
     *  pointer really does mean "UI was clicked, not the world"). */
    const isTouch =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
    const embed = typeof window !== 'undefined' && window.__LABY_MC_FUS_EMBED__
    /**
     * Desktop Laby: pointer lock is often not held in fullscreen or after UI focus, but the
     * progressive-break + melee path must still run — the old "fall back to vanilla" branch
     * made clicks do nothing (vanilla one-shot break is bypassed) so blocks *never* broke.
     * Touch already skipped this guard.
     */
    if (!isTouch && !this.window?.isLocked?.() && !embed) {
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
    /** Per-swing progress pulse. The RAF's dt-based accumulation is the main driver, but a
     *  mobile *tap* (≈80 ms press-release) only gives ~5 frames of dt which is far too
     *  little on any block harder than leaves. A flat 12 % bump per swing means 9 taps
     *  clear the softest blocks and ~12 taps the hardest. Hold-to-break still works
     *  because the engine's own repeat-interval fires `onMouseClicked(0)` every 250 ms. */
    bumpProgressOnSwing()
  }

  const baseTerrain = mc.worldRenderer.textureTerrain
  const destroyStrip = {
    ...DEFAULT_DESTROY_STRIP,
    ...(typeof mc.fusDestroyStripPixels === 'object' && mc.fusDestroyStripPixels !== null
      ? mc.fusDestroyStripPixels
      : null),
  }
  const STAGE_COUNT = Math.max(1, Math.min(32, Math.floor(Number(destroyStrip.stages) || 8)))
  const useProcedural = mc.fusUseProceduralDestroyOverlay === true
  let crackMap = null
  /** @type {HTMLCanvasElement | null} */
  let crackMapCanvas = null
  let useBlittedAtlas = false
  if (!useProcedural && typeof document !== 'undefined') {
    const t = createBlittedCrackMapTexture()
    crackMap = t.tex
    crackMapCanvas = t.cv
    useBlittedAtlas = true
    if (blitDestroyStripToCrackMap(t.cv, baseTerrain?.image, destroyStrip, 0)) {
      crackMap.needsUpdate = true
    }
  }
  if (!crackMap) {
    crackMap = buildProceduralDestroyTexture(STAGE_COUNT)
  }
  const overlayMat = new THREE.MeshBasicMaterial({
    map: crackMap,
    transparent: true,
    opacity: 0,
    premultipliedAlpha: false,
    /** `fog: false` — otherwise mostly-transparent crack pixels get fog tints and read as
     *  pink/magenta, especially on face edges and at geometry seams. */
    fog: false,
    depthTest: true,
    /** Chunk {@link Tessellator} uses {@code transparent: true}. Requires {@link WebGLRenderer#sortObjects}
     *  on the world renderer so {@link Object3D#renderOrder} can draw this decal after terrain. */
    depthWrite: false,
    /** Bias the decal slightly in front of the block face (same cell) vs chunk depth. */
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    side: THREE.FrontSide,
    color: 0xffffff,
    blending: THREE.NormalBlending,
    toneMapped: false,
  })
  const overlayScale = 1.04
  const overlayMesh = new THREE.Mesh(
    new THREE.BoxGeometry(overlayScale, overlayScale, overlayScale),
    overlayMat,
  )
  overlayMesh.frustumCulled = false
  overlayMesh.visible = false
  overlayMesh.renderOrder = 10

  let blitStripEmptyChecked = false
  const switchToProceduralCrackMap = () => {
    if (!useBlittedAtlas) return
    useBlittedAtlas = false
    crackMapCanvas = null
    try {
      crackMap.dispose()
    } catch {
      /* ignore */
    }
    crackMap = buildProceduralDestroyTexture(STAGE_COUNT)
    overlayMat.map = crackMap
    overlayMat.needsUpdate = true
  }
  /** Multiply crack decal toward block-appropriate hues (terrain strip is stone-grey). */
  const breakCrackTintHex = (typeId) => {
    switch (typeId | 0) {
      case 2:
        return 0xb0e0a8
      case 3:
        return 0xd8c8a8
      case 18:
        return 0xa8d888
      case 12:
        return 0xf0e6b8
      case 13:
        return 0xd0d0d0
      default:
        return 0xffffff
    }
  }

  const applyDestroyFrame = (stage) => {
    if (useBlittedAtlas && crackMapCanvas) {
      if (blitDestroyStripToCrackMap(crackMapCanvas, baseTerrain?.image, destroyStrip, stage)) {
        crackMap.needsUpdate = true
        if (!blitStripEmptyChecked) {
          blitStripEmptyChecked = true
          try {
            const ctx2 = crackMapCanvas.getContext('2d', { willReadFrequently: true })
            if (ctx2) {
              const mid = (CRACK_BLIT_PX / 2) | 0
              const a = ctx2.getImageData(mid, mid, 1, 1).data[3]
              if (a < 8) {
                switchToProceduralCrackMap()
                setProceduralDestroyFrame(crackMap, stage, STAGE_COUNT)
              }
            }
          } catch {
            /* tainted canvas or read error — keep blitted path */
          }
        }
      }
    } else {
      setProceduralDestroyFrame(crackMap, stage, STAGE_COUNT)
    }
  }
  const syncBreakOverlay = (x, y, z, progress, typeId = -1) => {
    if (!crackMap) return
    const p = Math.max(0, Math.min(1, progress))
    const stage = Math.min(STAGE_COUNT - 1, Math.floor(p * STAGE_COUNT))
    applyDestroyFrame(stage)
    /** Floor opacity so the first ~10% break time is not effectively invisible. */
    overlayMat.opacity = Math.max(0.5, Math.min(0.92, 0.4 + p * 0.58))
    overlayMat.color.setHex(typeId >= 0 ? breakCrackTintHex(typeId) : 0xffffff)
    overlayMesh.visible = true
    overlayMesh.position.set(x + 0.5, y + 0.5, z + 0.5)
  }
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

  /** Release state (pointerup / look-away / GUI / frozen) — keep `cur` *and* keep the overlay
   *  visible so the player can see the crack they've accrued while they line up the next tap.
   *  Zeroing would send the wrong message ("your progress is gone") when in fact it isn't.
   *  The crack freezes at its current alpha until they tap again or aim elsewhere (which
   *  triggers a full {@link resetBreak} via the key-mismatch branch in {@link frame}). */
  const pauseBreak = () => {
    /** Intentionally left as a marker — overlay state is handled inside the frame loop so
     *  the crack position/alpha reflect the last active sample on the currently-aimed cell. */
  }

  const keyOf = (x, y, z) => `${x},${y},${z}`

  /** Instant progress pulse fired from {@link Minecraft.onMouseClicked} on every button-0 click
   *  (desktop mouse click, mobile tap on the break button, or the interval-repeat while held).
   *  The main dt-based accumulation in {@link frame} is still the primary driver; soft ground
   *  and leaves use a larger bump so tap-mining keeps up with the rebalanced multipliers. */
  const bumpProgressOnSwing = () => {
    if (mc.fusFrozen || mc.fusLabyChannelLockMove) return
    const pl = mc.player
    const world = mc.world
    const wr = mc.worldRenderer
    if (!pl || !world || !wr) return
    const partial = mc.timer?.partialTicks ?? 0
    const hit = safeRayTrace(pl, partial)
    if (!hit) return
    const typeId = world.getBlockAt(hit.x, hit.y, hit.z)
    if (typeId === 0) return
    const baseSeconds = BLOCK_BASE_BREAK_SECONDS[typeId] ?? DEFAULT_BREAK_SECONDS
    if (baseSeconds === Infinity) return
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
    const bf = blockFamily(typeId)
    const torchId = BlockRegistry.TORCH.getId()
    const swingBump = instantBlockActions
      ? 1
      : typeId === torchId
        ? 1
        : bf === 'dirt' || bf === 'leave'
          ? 0.22
          : 0.12
    cur.progress = Math.min(1, cur.progress + swingBump)
    syncBreakOverlay(hit.x, hit.y, hit.z, cur.progress, typeId)
    /** Taps and short clicks never keep `wantBreak` true long enough for the RAF path to
     *  emit hit dust; without this, mining looks particle-less until a long hold. */
    const nowD = performance.now()
    spawnHitDust(
      mc,
      hit.x,
      hit.y,
      hit.z,
      typeId,
      mc.fusLowTierMobile ? 3 : 4,
    )
    if (cur) cur.lastParticleAt = nowD
    if (cur.progress >= 1) {
      finishBreak(mc, cur)
      resetBreak()
    }
  }

  let rafId = 0
  let prev = performance.now()
  let disposed = false

  const frame = () => {
    if (disposed) return
    rafId = requestAnimationFrame(frame)
    const now = performance.now()
    const dt = Math.min(0.1, (now - prev) / 1000)
    prev = now

    const wantBreak = mouseBreakHeld || !!mc.fusMobileBreakHeld
    if (mc.fusFrozen) {
      pauseBreak()
      return
    }
    /** Not holding break: still draw a frozen crack if we have partial progress (tap-mining
     *  never keeps `wantBreak` true long enough for the block below to run every frame). */
    if (!wantBreak) {
      if (
        cur &&
        cur.progress > 0 &&
        (typeof mc.fusIsDead !== 'function' || !mc.fusIsDead())
      ) {
        syncBreakOverlay(cur.x, cur.y, cur.z, cur.progress, cur.typeId)
      }
      pauseBreak()
      return
    }
    /** Actively breaking: `cur.progress` advances in the block below. */
    /** Dead state: pause every break-in-progress and zero mobile-held flag. The
     *  mobile joystick's `pointerleave` from the death overlay would have unlatched
     *  most cases, but a rapid die-while-holding can leave `fusMobileBreakHeld` true. */
    if (typeof mc.fusIsDead === 'function' && mc.fusIsDead()) {
      pauseBreak()
      return
    }
    if (mc.currentScreen) {
      pauseBreak()
      return
    }
    /** Mid-teleport channel: no mining. Mirrors the movement lock in fusLabySpawnFlagInstall. */
    if (mc.fusLabyChannelLockMove) {
      pauseBreak()
      return
    }
    const pl = mc.player
    const world = mc.world
    const wr = mc.worldRenderer
    if (!pl || !world || !wr) {
      pauseBreak()
      return
    }
    const embed = typeof window !== 'undefined' && window.__LABY_MC_FUS_EMBED__
    const isTouch =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
    /** Touch / mobile HUD never holds pointer lock; Laby embed often has no lock while in-world.
     *  `mousedown` / `mouseup` mirror `pointer*` so `mouseBreakHeld` tracks even if pointer
     *  events are flaky in an iframe. */
    const canBreakWithoutLock =
      isTouch || !!mc.fusMobileBreakHeld || (embed && mouseBreakHeld)
    if (!mc.window?.isLocked?.() && !canBreakWithoutLock) {
      pauseBreak()
      return
    }

    const partial = mc.timer?.partialTicks ?? 0
    const hit = safeRayTrace(pl, partial)
    if (!hit) {
      overlayMesh.visible = false
      pauseBreak()
      return
    }

    const typeId = world.getBlockAt(hit.x, hit.y, hit.z)
    if (typeId === 0) {
      /** Target gone (peer broke it underneath us) — zero cur so next aim starts fresh. */
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
     *  Soft ground/leaves allow a lower floor so shovel / gold on dirt feels instant; stone
     *  and ores keep a higher floor so tap-spam cannot trivialize hard blocks. */
    const rawEff = baseSeconds / Math.max(0.05, mult)
    const bf = blockFamily(typeId)
    const torchId = BlockRegistry.TORCH.getId()
    const isTorch = typeId === torchId
    const effSeconds = isTorch
      ? 0.001
      : bf === 'dirt' || bf === 'leave'
        ? Math.max(0.08, rawEff)
        : Math.max(0.15, rawEff)
    cur.progress = Math.min(1, cur.progress + dt / effSeconds)

    /** Crack overlay: procedural strip (or atlas if {@code mc.fusUseAtlasDestroyOverlay}). */
    syncBreakOverlay(hit.x, hit.y, hit.z, cur.progress, cur.typeId)

    /** Hit-dust particles: ~5/sec while actively pressing. Low-tier mobile gets a halved
     *  rate (one dust burst every 400 ms, only two flakes per burst) so we preserve the
     *  visual feedback — the user report was "no particles on mobile" — without re-creating
     *  the hitches the previous cap was meant to avoid. See {@link spawnHitDust}. */
    const particleInterval = mc.fusLowTierMobile ? 350 : 160
    if (now - cur.lastParticleAt > particleInterval) {
      cur.lastParticleAt = now
      spawnHitDust(mc, hit.x, hit.y, hit.z, typeId, mc.fusLowTierMobile ? 4 : 6)
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
      window.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('mouseup', onMouseUp, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
    try {
      scene.remove(overlayMesh)
    } catch {
      /* ignore */
    }
    try {
      overlayMesh.geometry.dispose()
      overlayMat.dispose()
      if (crackMap) crackMap.dispose()
    } catch {
      /* ignore */
    }
    if (origOnMouseClicked) {
      mc.onMouseClicked = origOnMouseClicked
    }
    mc.fusResetBlockBreakState = undefined
  }
  /** Clears in-progress break after respawn / scene transitions (see {@link installFusDeathScreen}). */
  mc.fusResetBlockBreakState = () => {
    try {
      resetBreak()
    } catch {
      /* ignore */
    }
  }
  mc.fusDisposeBlockHardness = dispose
  return dispose
}

function safeRayTrace(pl, partial) {
  try {
    return pl.rayTrace(5, partial) || null
  } catch {
    return null
  }
}

/**
 * Finish a break: sound, block-break particles (passes {@code state.typeId} so particles still spawn
 * if sync already cleared the cell), {@code setBlockAt(0)}, and {@code worldRenderer.flushRebuild}.
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
    mc.particleRenderer?.spawnBlockBreakParticle?.(
      mc.world,
      state.x,
      state.y,
      state.z,
      state.typeId,
    )
    mc.world.setBlockAt(state.x, state.y, state.z, 0)
    const goldId = BlockRegistry.GOLD_ORE && BlockRegistry.GOLD_ORE.getId
      ? BlockRegistry.GOLD_ORE.getId()
      : 51
    if (
      state.typeId === goldId &&
      typeof mc.fusDropCoinAt === 'function'
    ) {
      const n = 1 + Math.floor(Math.random() * 3)
      const jx = (Math.random() - 0.5) * 0.35
      const jz = (Math.random() - 0.5) * 0.35
      try {
        mc.fusDropCoinAt(state.x + 0.5 + jx, state.y + 0.35, state.z + 0.5 + jz, {
          coins: n,
          source: 'ore',
        })
      } catch (e) {
        console.warn('[fusBlockHardness] ore coin drop', e)
      }
    }
    mc.worldRenderer.flushRebuild = true
  } catch (e) {
    console.warn('[fusBlockHardness] finishBreak threw', e)
  }
}

/** Spawn a handful of ParticleDigging flakes on the top face of the block (cheaper than the
 *  64-particle burst used on final break). `count` defaults to 4 for desktop; callers should
 *  pass a smaller value on low-tier mobile where the particle-renderer pool is tighter. */
function spawnHitDust(mc, x, y, z, typeId, count = 4) {
  let block = Block.getById(typeId)
  if (!block) block = Block.getById(1)
  if (!block) return
  for (let i = 0; i < count; i++) {
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
 * Soft terrain (dirt, grass, sand) should break quickly with a matching tool; stone,
 * cobble, and ores stay slow unless you use a pickaxe. The default hotbar pickaxe must
 * not mine dirt at fist speed — see {@link TOOL_MULTIPLIERS} {@code pickaxe.dirt}.
 *
 * Any id missing from the map uses {@link DEFAULT_BREAK_SECONDS}. Bedrock (`7`) is
 * flagged `Infinity` so players cannot ever progress the bar on it.
 */
const BLOCK_BASE_BREAK_SECONDS = {
  1: 2.2, // STONE
  2: 0.38, // GRASS
  3: 0.32, // DIRT
  4: 2.5, // COBBLE_STONE
  5: 2.0, // WOOD (planks)
  7: Infinity, // BEDROCK
  21: Infinity, // shop indestructible (obsidian tile)
  12: 0.38, // SAND
  13: 0.5, // GRAVEL
  17: 1.8, // LOG
  18: 0.25, // LEAVE
  20: 0.4, // GLASS
  50: 0.0, // TORCH — one swing / one held frame; see {@link #bumpProgressOnSwing} + `frame` torch branch
  51: 2.8, // GOLD_ORE
}
const DEFAULT_BREAK_SECONDS = 1.4

/**
 * Tool family → per-block-family multiplier (>1 means "faster than fist"). Categorisation
 * is kept deliberately coarse so adding a new skin in the shop doesn't require editing a
 * thousand-entry lookup table: we match tool family by substring on the mesh name that the
 * hotbar already persists (see `fusLabyHotbarFromProfile.js`).
 */
const TOOL_MULTIPLIERS = {
  /** Pick on dirt/sand is wrong-tool but not fist-slow; shovel is best on soft ground. */
  pickaxe: { stone: 5, metal: 6, dirt: 3.2, wood: 1.2, leave: 1.1, glass: 1.5 },
  axe: { stone: 1, metal: 1, dirt: 2, wood: 5, leave: 1.5, glass: 1 },
  shovel: { stone: 1, metal: 0.9, dirt: 12, wood: 1, leave: 1, glass: 1 },
  sword: { stone: 0.6, metal: 0.5, dirt: 0.8, wood: 0.8, leave: 3, glass: 0.8 },
  fist: { stone: 1, metal: 0.5, dirt: 1, wood: 1, leave: 1, glass: 1 },
}

function blockFamily(typeId) {
  switch (typeId) {
    case 1:
    case 4:
    case 7:
    case 21:
      return 'stone'
    case 51:
      return 'metal'
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
    case 50: // torch — not “stone” for break-speed math; one-hit handled in click / frame
      return 'torch'
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
  const diamondBonus = toolName.includes('diamond')
    ? 1.35
    : toolName.includes('iron')
      ? 1.15
      : toolName.includes('gold')
        ? 1.22 /** MC-like: gold is fast on blocks you can insta-mine with the right head */
        : toolName.includes('stone')
          ? 0.85
          : toolName.includes('wood')
            ? 0.7
            : 1
  return (row[fam] || 1) * diamondBonus
}
