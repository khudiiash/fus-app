/**
 * {@code terrain.png} uses 16×16 px macrotiles on a sheet that is usually 256×256 (16×16 cells).
 * Wider sheets (e.g. 512 px) treat indices as **row-major** with {@link #beta16ToLinear32} so
 * legacy 0…255 “terrain slots” still map to the **left 16 columns** of each row.
 *
 * Indices ≥ 256 can be used as direct macrotile addresses on very large atlases.
 */
export const TERRAIN_TILE_PX = 16

/**
 * @param {number} legacy0to255
 * @returns {number}
 */
export function beta16ToLinear32(legacy0to255) {
  const i = legacy0to255 | 0
  if (i < 0) return 0
  if (i > 255) return i
  return (Math.floor(i / 16) * 32 + (i & 15)) | 0
}

/**
 * @param {number} slot
 * @param {number} tilesX
 * @returns {number}
 */
export function toLinearMacrotileIndex(slot, tilesX) {
  const t = (slot | 0) >>> 0
  const tx = tilesX | 0
  if (t >= 256) return t
  if (tx <= 16) return t
  return beta16ToLinear32(t)
}

/**
 * @param {import('three').Texture | null | undefined} tex
 * @returns {{ w: number, h: number, tilesX: number, tilesY: number }}
 */
export function readTerrainAtlasMetrics(tex) {
  const im = tex?.image
  const w = im?.width > 0 ? im.width : 256
  const h = im?.height > 0 ? im.height : 256
  const tilesX = Math.max(1, w / TERRAIN_TILE_PX) | 0
  const tilesY = Math.max(1, h / TERRAIN_TILE_PX) | 0
  return { w, h, tilesX, tilesY }
}

/**
 * Full macrotile UVs (matches legacy {@link import("./BlockRenderer.js")} face flip).
 *
 * @param {number} linearIndex
 * @param {number} w
 * @param {number} h
 * @param {number} tilesX
 * @param {number} tilesY
 * @returns {{ minU: number, maxU: number, minV: number, maxV: number }}
 */
export function tileUvsForLinearIndex(linearIndex, w, h, tilesX, tilesY) {
  const idx = (linearIndex | 0) >>> 0
  const col = idx % tilesX
  const row = (idx / tilesX) | 0
  const minU = (col * TERRAIN_TILE_PX) / w
  const maxU = ((col + 1) * TERRAIN_TILE_PX) / w
  const vTop = (row * TERRAIN_TILE_PX) / h
  const vBot = ((row + 1) * TERRAIN_TILE_PX) / h
  return { minU, maxU, minV: 1 - vBot, maxV: 1 - vTop }
}

/**
 * Pixel rect inside one macrotile (torch model in {@link import("./BlockRenderer.js")#renderTorch}).
 *
 * @param {number} linearIndex
 * @param {number} w
 * @param {number} h
 * @param {number} tilesX
 * @param {number} pxi0
 * @param {number} pyi0
 * @param {number} pxi1
 * @param {number} pyi1
 * @returns {{ minU: number, maxU: number, minV: number, maxV: number }}
 */
export function subTilePixelUvs(linearIndex, w, h, tilesX, pxi0, pyi0, pxi1, pyi1) {
  const idx = (linearIndex | 0) >>> 0
  const col = idx % tilesX
  const row = (idx / tilesX) | 0
  const ox = col * TERRAIN_TILE_PX
  const oy = row * TERRAIN_TILE_PX
  const minU = (ox + pxi0) / w
  const maxU = (ox + pxi1) / w
  const vTop = (oy + pyi0) / h
  const vBot = (oy + pyi1) / h
  return { minU, maxU, minV: 1 - vBot, maxV: 1 - vTop }
}
