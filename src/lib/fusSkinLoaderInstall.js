import * as THREE from '@labymc/libraries/three.module.js'
import { generateFusAvatarSkinCanvasJsMinecraft } from '@/lib/fusAvatarSkinCanvas.js'

/**
 * Install `mc.ensureFusSkinTexture(url, cb)` on the engine. Loads a Minecraft-style skin
 * from a URL, wraps it in a `THREE.CanvasTexture`, swaps it into the local player's
 * `PlayerRenderer.textureCharacter`, and invokes `cb` so the caller can trigger a rebuild.
 *
 * Previous install file was lost in the submodule-deinit incident. This replacement keeps
 * the API the view already calls (see `LabyJsMinecraftView.vue` `ensureFusSkinTexture(...)`).
 *
 * Semantics:
 *  - Null / empty url → silent no-op (no cb).
 *  - Repeat calls with same url hit an in-memory cache instead of re-fetching.
 *  - CORS: uses `crossOrigin='anonymous'`. Firebase Storage + the rest of the app's avatar
 *    URLs already serve with CORS headers, so this works for our actual skin sources.
 *  - Callback is only invoked after a *successful* load + apply. We deliberately don't
 *    `prepareModel(player)` here — the view's cb does that so it can batch the rebuild
 *    with other skin-related state changes.
 *
 * @param {any} mc
 */
export function installFusSkinLoader(mc) {
  if (!mc) return

  /** @type {Map<string, THREE.CanvasTexture>} */
  const cache = new Map()

  /** Procedural profile skins — shared per `skinId`; never dispose (see `applyTextureToLocalPlayer`). */
  /** @type {Map<string, THREE.CanvasTexture>} */
  const defaultSkinCache = new Map()

  const applyTextureToLocalPlayer = (texture) => {
    const renderer = mc.player?.renderer
    if (!renderer) return
    /** Dispose the previous skin texture to keep GPU memory bounded across skin swaps. */
    const prev = renderer.textureCharacter
    if (prev && prev !== texture && typeof prev.dispose === 'function') {
      if (prev.userData?.fusKeepAlive) {
        /* shared cached texture */
      } else {
        try {
          prev.dispose()
        } catch {
          /* ignore */
        }
      }
    }
    renderer.textureCharacter = texture
    /**
     * Swapping {@code textureCharacter} alone does nothing visible: {@link PlayerRenderer#rebuild}
     * binds the map onto the tessellator's shared materials, and FP clones the arm with
     * {@link Mesh#material.clone} — those keep the old map until a rebuild. {@link EntityRenderer#prepareModel}
     * skips rebuild when only the texture changed (buildMeta ignores skin), so we refresh
     * the live materials and force the next {@code prepareModel} to rebuild (hand clone).
     */
    try {
      if (typeof renderer.tessellator?.bindTexture === 'function') {
        renderer.tessellator.bindTexture(texture)
      }
    } catch {
      /* ignore */
    }
    try {
      if (renderer.group && typeof renderer.group === 'object') {
        delete renderer.group.buildMeta
      }
    } catch {
      /* ignore */
    }
  }

  mc.ensureFusSkinTexture = async function ensureFusSkinTexture(url, cb) {
    if (!url || typeof url !== 'string') return
    const cached = cache.get(url)
    if (cached) {
      applyTextureToLocalPlayer(cached)
      if (typeof cb === 'function') {
        try {
          cb()
        } catch (e) {
          console.warn('[fusSkinLoader] cb threw', e)
        }
      }
      return
    }
    try {
      const texture = await loadSkinAsCanvasTexture(url)
      cache.set(url, texture)
      applyTextureToLocalPlayer(texture)
      if (typeof cb === 'function') {
        try {
          cb()
        } catch (e) {
          console.warn('[fusSkinLoader] cb threw', e)
        }
      }
    } catch (e) {
      console.warn('[fusSkinLoader] load failed', url, e)
    }
  }

  /**
   * Same procedural 64×64 skin as the profile / shop preview when there is no `skinUrl`.
   * Textures are cached per `skinId` and marked `userData.fusKeepAlive` so swaps to/from
   * URL skins do not dispose shared instances.
   *
   * @param {string} [skinId]
   * @param {() => void} [cb]
   */
  mc.ensureFusDefaultProfileSkinTexture = function ensureFusDefaultProfileSkinTexture(skinId, cb) {
    const id = typeof skinId === 'string' && skinId.length ? skinId : 'default'
    let texture = defaultSkinCache.get(id)
    if (!texture) {
      const canvas = generateFusAvatarSkinCanvasJsMinecraft(id)
      texture = new THREE.CanvasTexture(canvas)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.generateMipmaps = false
      texture.colorSpace = THREE.NoColorSpace
      texture.needsUpdate = true
      texture.userData.fusKeepAlive = true
      defaultSkinCache.set(id, texture)
    }
    applyTextureToLocalPlayer(texture)
    if (typeof cb === 'function') {
      try {
        cb()
      } catch (e) {
        console.warn('[fusSkinLoader] default skin cb threw', e)
      }
    }
  }
}

/**
 * Standard Minecraft skin canvas texture: pixel-art filtering, no mipmaps, linear color space.
 * Mirrors `Minecraft.getThreeTexture`'s settings so vanilla and custom skins render identically.
 */
async function loadSkinAsCanvasTexture(url) {
  const img = await loadImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  return texture
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(e instanceof Error ? e : new Error('skin image load failed'))
    img.src = url
  })
}
