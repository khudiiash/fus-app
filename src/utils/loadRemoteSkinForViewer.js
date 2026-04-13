/**
 * Remote skins (Firebase Storage) + Workbox: fetch as blob, decode with
 * {@link createImageBitmap}, then pass an ImageBitmap into `loadSkin` so we use the
 * same synchronous skinview-utils path as canvas uploads (avoids blob: + `<img>`
 * decode issues that broke remote PlayerObject skins while CharacterScene still worked).
 *
 * @param {{ loadSkin: Function }} viewer MinecraftSkinHost (or compatible loadSkin)
 * @param {string|null|undefined} skinUrl
 * @param {HTMLCanvasElement} fallbackCanvas
 */
export function isHttpSkinUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

function sanitizeSkinUrlString(url) {
  if (typeof url !== 'string') return ''
  return url
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
}

/** @param {{ loadSkin: Function }} viewer @param {unknown} source */
async function awaitLoadSkin(viewer, source) {
  const ret = viewer.loadSkin(source)
  if (ret != null && typeof ret.then === 'function') await ret
}

export async function loadRemoteSkinForViewer(viewer, skinUrl, fallbackCanvas) {
  if (!viewer) return
  skinUrl = sanitizeSkinUrlString(skinUrl)
  if (!skinUrl) {
    viewer.loadSkin(fallbackCanvas)
    return
  }
  if (!isHttpSkinUrl(skinUrl)) {
    try {
      await awaitLoadSkin(viewer, skinUrl)
    } catch {
      viewer.loadSkin(fallbackCanvas)
    }
    return
  }
  const fetchBlob = async () => {
    const res = await fetch(skinUrl, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'default',
    })
    if (!res.ok) throw new Error(String(res.status))
    return res.blob()
  }
  let blob = null
  const delaysMs = [0, 120, 300, 600]
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) await new Promise((r) => setTimeout(r, delaysMs[i]))
    try {
      blob = await fetchBlob()
      break
    } catch {
      /* retry */
    }
  }
  if (!blob) {
    viewer.loadSkin(fallbackCanvas)
    return
  }
  if (typeof createImageBitmap === 'function') {
    let bitmap = null
    try {
      bitmap = await createImageBitmap(blob)
    } catch {
      viewer.loadSkin(fallbackCanvas)
      return
    }
    try {
      await awaitLoadSkin(viewer, bitmap)
    } catch {
      viewer.loadSkin(fallbackCanvas)
    } finally {
      try {
        bitmap.close()
      } catch {
        /* ignore */
      }
    }
    return
  }
  const objectUrl = URL.createObjectURL(blob)
  try {
    await awaitLoadSkin(viewer, objectUrl)
  } catch {
    viewer.loadSkin(fallbackCanvas)
  } finally {
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl)
      } catch {
        /* ignore */
      }
    }, 8000)
  }
}
