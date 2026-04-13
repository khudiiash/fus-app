/**
 * Minimal loadSkin-compatible host for a skinview3d-style PlayerObject rig
 * (remote players — no renderer / composer).
 */
import {
  inferModelType,
  isTextureSource,
  loadImage,
  loadSkinToCanvas,
} from 'skinview-utils'
import { CanvasTexture, NearestFilter, SRGBColorSpace } from 'three'

export function createPlayerSkinViewerShim(playerObject) {
  const skinCanvas = document.createElement('canvas')
  let skinTexture = null

  function recreateSkinTexture() {
    if (skinTexture) skinTexture.dispose()
    skinTexture = new CanvasTexture(skinCanvas)
    skinTexture.magFilter = NearestFilter
    skinTexture.minFilter = NearestFilter
    skinTexture.colorSpace = SRGBColorSpace
    skinTexture.needsUpdate = true
    playerObject.skin.map = skinTexture
  }

  function resetSkin() {
    playerObject.skin.visible = false
    playerObject.skin.map = null
    if (skinTexture) {
      skinTexture.dispose()
      skinTexture = null
    }
  }

  function loadSkin(source, options = {}) {
    if (source === null) {
      resetSkin()
    } else if (isTextureSource(source)) {
      loadSkinToCanvas(skinCanvas, source)
      recreateSkinTexture()
      if (options.model === undefined || options.model === 'auto-detect') {
        playerObject.skin.modelType = inferModelType(skinCanvas)
      } else {
        playerObject.skin.modelType = options.model
      }
      if (options.makeVisible !== false) {
        playerObject.skin.visible = true
      }
    } else {
      return loadImage(source).then((image) => loadSkin(image, options))
    }
  }

  function dispose() {
    resetSkin()
  }

  /** Atlas canvas after the last successful {@link loadSkin} (for name tags, etc.). */
  function getSkinCanvas() {
    return skinCanvas
  }

  return { loadSkin, dispose, getSkinCanvas }
}
