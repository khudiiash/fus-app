/**
 * Single source for the procedural 64×64 Minecraft-layout skins used in the profile
 * preview, shop thumbnails, Character room, and Laby when no remote skin URL is set.
 */
import { loadSkinToCanvas } from 'skinview-utils'

export const FUS_AVATAR_SKIN_PALETTES = {
  /** One flat purple — backs use solid texels (uncleared canvas → black in 3D). */
  default: { body: '#7c3aed', legs: '#7c3aed', arms: '#7c3aed', head: '#7c3aed' },
  sigma: { body: '#374151', legs: '#111827', arms: '#374151', head: '#1f2937' },
  brainrot: { body: '#d946ef', legs: '#86198f', arms: '#d946ef', head: '#c026d3' },
  ohio: { body: '#15803d', legs: '#14532d', arms: '#15803d', head: '#166534' },
  rizz: { body: '#9333ea', legs: '#581c87', arms: '#a855f7', head: '#7e22ce' },
  npc: { body: '#9ca3af', legs: '#6b7280', arms: '#9ca3af', head: '#4b5563' },
  brat: { body: '#84cc16', legs: '#3f6212', arms: '#84cc16', head: '#65a30d' },
  chillguy: { body: '#d97706', legs: '#92400e', arms: '#d97706', head: '#b45309' },
  skibidi: { body: '#38bdf8', legs: '#0369a1', arms: '#38bdf8', head: '#0ea5e9' },
  galaxy: { body: '#4338ca', legs: '#1e1b4b', arms: '#6366f1', head: '#3730a3' },
  fire: { body: '#ef4444', legs: '#7f1d1d', arms: '#f97316', head: '#dc2626' },
}

/**
 * Fills the six {@link ModelRenderer#addBox} quads for one part (legacy Minecraft 64×32 UVs).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} ox
 * @param {number} oy
 * @param {number} w
 * @param {number} h
 * @param {number} d
 * @param {string} fillStyle
 */
function fillLegacyMcSkinBox(ctx, ox, oy, w, h, d, fillStyle) {
  ctx.fillStyle = fillStyle
  ctx.fillRect(ox + d + w, oy + d, d, h)
  ctx.fillRect(ox, oy + d, d, h)
  ctx.fillRect(ox + d, oy, w, d)
  ctx.fillRect(ox + d + w, oy, w, d)
  ctx.fillRect(ox + d, oy + d, w, h)
  ctx.fillRect(ox + d + w + d, oy + d, w, h)
}

/**
 * 64×32 skin for {@link ModelPlayer}: UV math divides V by **32** while sampling the texture,
 * so a 64×64 PNG maps the head onto the wrong rows (blue shirt, missing face). This canvas
 * matches `char.png` layout and shows the same colors + face as {@link generateFusAvatarSkinCanvas}.
 *
 * @param {string} [skinId]
 * @returns {HTMLCanvasElement}
 */
export function generateFusAvatarSkinCanvasJsMinecraft(skinId = 'default') {
  const p = FUS_AVATAR_SKIN_PALETTES[skinId] || FUS_AVATAR_SKIN_PALETTES.default
  const arms = p.arms ?? p.body
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 32
  const ctx = c.getContext('2d')
  if (!ctx) return c
  ctx.fillStyle = p.body
  ctx.fillRect(0, 0, 64, 32)
  fillLegacyMcSkinBox(ctx, 0, 0, 8, 8, 8, p.head)
  fillLegacyMcSkinBox(ctx, 16, 16, 8, 12, 4, p.body)
  fillLegacyMcSkinBox(ctx, 40, 16, 4, 12, 4, arms)
  fillLegacyMcSkinBox(ctx, 0, 16, 4, 12, 4, p.legs)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(9, 10, 2, 2)
  ctx.fillRect(13, 10, 2, 2)
  ctx.fillStyle = '#000000'
  ctx.fillRect(10, 10, 1, 1)
  ctx.fillRect(14, 10, 1, 1)
  ctx.fillRect(10, 13, 1, 1)
  ctx.fillRect(11, 14, 2, 1)
  ctx.fillRect(13, 13, 1, 1)
  return c
}

/**
 * 64×64 layout for MinecraftSkinHost / shop thumbnails / Character room (modern skin UVs).
 *
 * @param {string} [skinId]
 * @returns {HTMLCanvasElement}
 */
export function generateFusAvatarSkinCanvas(skinId = 'default') {
  const p = FUS_AVATAR_SKIN_PALETTES[skinId] || FUS_AVATAR_SKIN_PALETTES.default
  const arms = p.arms ?? p.body
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')
  if (!ctx) return c
  ctx.fillStyle = p.body
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = p.head
  ctx.fillRect(8, 8, 8, 8)
  ctx.fillStyle = p.body
  ctx.fillRect(20, 20, 8, 12)
  ctx.fillStyle = arms
  ctx.fillRect(44, 20, 4, 12)
  ctx.fillStyle = arms
  ctx.fillRect(36, 52, 4, 12)
  ctx.fillStyle = p.legs
  ctx.fillRect(4, 20, 4, 12)
  ctx.fillStyle = p.legs
  ctx.fillRect(20, 52, 4, 12)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(9, 10, 2, 2)
  ctx.fillRect(13, 10, 2, 2)
  ctx.fillStyle = '#000000'
  ctx.fillRect(10, 10, 1, 1)
  ctx.fillRect(14, 10, 1, 1)
  ctx.fillRect(10, 13, 1, 1)
  ctx.fillRect(11, 14, 2, 1)
  ctx.fillRect(13, 13, 1, 1)
  return c
}

/**
 * Same pixels as {@link generateFusAvatarSkinCanvas}, then the **same** `skinview-utils`
 * {@link loadSkinToCanvas} pass used for HTTP skins in Laby remote avatars (opaque-skin
 * overlay clears, 1.8 layout normalization). Feed the result into `THREE.CanvasTexture` with
 * {@code THREE.CanvasTexture} in Laby remotes uses {@code NoColorSpace} (same convention as
 * js-minecraft {@code getThreeTexture}) — not the raw generator canvas alone.
 *
 * @param {string} [skinId]
 * @returns {HTMLCanvasElement}
 */
export function processFusAvatarSkinCanvasForSkinviewRig(skinId = 'default') {
  const src = generateFusAvatarSkinCanvas(skinId)
  const dest = document.createElement('canvas')
  loadSkinToCanvas(dest, src)
  return dest
}
