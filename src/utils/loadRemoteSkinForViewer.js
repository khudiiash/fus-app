/**
 * Remote skins (Firebase Storage) + Workbox: cross-origin `img.src` loads used by
 * skinview3d often fail once (net::ERR_FAILED) while a later attempt succeeds.
 * Fetch as blob → blob: URL so decode is same-origin and WebGL upload is stable.
 *
 * @param {*} viewer skinview3d SkinViewer
 * @param {string|null|undefined} skinUrl
 * @param {HTMLCanvasElement} fallbackCanvas
 */
export function isHttpSkinUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

export async function loadRemoteSkinForViewer(viewer, skinUrl, fallbackCanvas) {
  if (!viewer) return
  if (!skinUrl) {
    viewer.loadSkin(fallbackCanvas)
    return
  }
  if (!isHttpSkinUrl(skinUrl)) {
    try {
      await viewer.loadSkin(skinUrl)
    } catch {
      viewer.loadSkin(fallbackCanvas)
    }
    return
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.ready) {
    try {
      await navigator.serviceWorker.ready
    } catch {
      /* ignore */
    }
  }
  const fetchBlob = async () => {
    const res = await fetch(skinUrl, { mode: 'cors', credentials: 'omit', cache: 'default' })
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
  const objectUrl = URL.createObjectURL(blob)
  try {
    await viewer.loadSkin(objectUrl)
  } catch {
    viewer.loadSkin(fallbackCanvas)
  } finally {
    const u = objectUrl
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          URL.revokeObjectURL(u)
        } catch {
          /* ignore */
        }
      })
    })
  }
}
