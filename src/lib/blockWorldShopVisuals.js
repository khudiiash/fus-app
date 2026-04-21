/**
 * Shop / UI previews for `category: block_world` items (Firestore `blockWorld` meta).
 */

/** Hotbar / HUD: 6 tiers × 5 tool types (see `src/js-minecraft/src/resources/gui/tools.png`). */
import toolsSheetUrl from '@labymc/src/resources/gui/tools.png'
/** Block icons: 16×16 tiles (see {@link BlockRegistry} textureSlotId). */
import terrainSheetUrl from '@labymc/src/resources/terrain/terrain.png'
import { FUS_CATALOG_TO_ENGINE_BLOCK_ID } from '@/lib/fusTerrainBlockIds'

export const TERRAIN_SPRITE_SHEET_URL = terrainSheetUrl
/** js-minecraft engine block id → atlas index (same as {@link Block} textureSlotId). */
const ENGINE_BLOCK_ID_TO_TEXTURE_SLOT = {
  1: 0,
  2: 1,
  3: 2,
  4: 14,
  5: 10,
  7: 11,
  9: 7,
  12: 8,
  13: 13,
  17: 4,
  18: 6,
  20: 12,
  /** Indestructible: same atlas tile as bedrock (red tint is applied in-engine). */
  21: 11,
}

/** Aligns with FUS terrain enum used in shop seeds (grass=0 … water=12). */
const BLOCK_EMOJI = {
  0: '🟩',
  1: '🟨',
  2: '🪵',
  3: '🍃',
  4: '🟫',
  5: '⬜',
  6: '⬛',
  7: '🪵',
  8: '💎',
  9: '▫️',
  10: '🪟',
  11: '⬛',
  12: '🌊',
  /** Indestructible shop block — lock icon reinforces the "cannot be broken" rule. */
  13: '🔒',
}

export const TOOLS_SPRITE_SHEET_URL = toolsSheetUrl
export const TOOL_SPRITE_COLS = 6
export const TOOL_SPRITE_ROWS = 5

/** Columns: wood → netherite. Rows: hoe, shovel, axe, pickaxe, sword. */
const TIER_COL = {
  Wooden: 0,
  Stone: 1,
  Iron: 2,
  Golden: 3,
  Diamond: 4,
  Netherite: 5,
}
const TYPE_ROW = {
  Hoe: 0,
  Shovel: 1,
  Axe: 2,
  Pickaxe: 3,
  Sword: 4,
}

/**
 * @param {string} meshName e.g. `Iron_Pickaxe`
 * @returns {{ row: number, col: number }}
 */
export function toolSpriteCellFromMeshName(meshName) {
  const m = String(meshName || '').match(/^(Wooden|Stone|Iron|Golden|Diamond|Netherite)_(Hoe|Shovel|Axe|Pickaxe|Sword)$/)
  if (!m) {
    return { row: TYPE_ROW.Pickaxe, col: TIER_COL.Iron }
  }
  const col = TIER_COL[/** @type {keyof TIER_COL} */ (m[1])]
  const row = TYPE_ROW[/** @type {keyof TYPE_ROW} */ (m[2])]
  if (col === undefined || row === undefined) {
    return { row: TYPE_ROW.Pickaxe, col: TIER_COL.Iron }
  }
  return { row, col }
}

/**
 * @param {Record<string, unknown> | null | undefined} item Firestore item row
 * @returns {{ kind: 'tool', toolMeshName: string, mineDamage: number, pvpDamageHalf: number } | { kind: 'block', blockType: number } | null}
 */
export function parseBlockWorldItem(item) {
  if (!item || typeof item !== 'object') return null
  const bw = item.blockWorld
  if (!bw || typeof bw !== 'object') return null
  if (bw.kind === 'block') {
    const t = Number(bw.blockType)
    if (!Number.isFinite(t)) return null
    return { kind: 'block', blockType: t }
  }
  if (bw.kind === 'tool') {
    const mesh = bw.toolMeshName
    if (typeof mesh !== 'string' || !mesh.length) return null
    return {
      kind: 'tool',
      toolMeshName: mesh,
      mineDamage: Number(bw.mineDamage) || 0,
      pvpDamageHalf: Number(bw.pvpDamageHalf) || 0,
    }
  }
  return null
}

export const BW_HOTBAR_MAX_SLOTS = 9

/**
 * @param {{ kind: 'fist' } | { kind: 'item', itemId: string, meta: ReturnType<typeof parseBlockWorldItem>, count: number }} slot
 */
export function hotbarCellVisualForBwSlot(slot) {
  if (!slot || slot.kind === 'fist') {
    return { type: 'emoji', text: '✊' }
  }
  const meta = slot.meta
  if (!meta) {
    return { type: 'emoji', text: '?' }
  }
  if (meta.kind === 'block') {
    const cat = meta.blockType | 0
    const eng = FUS_CATALOG_TO_ENGINE_BLOCK_ID[cat]
    const tex =
      typeof eng === 'number' ? ENGINE_BLOCK_ID_TO_TEXTURE_SLOT[eng] : undefined
    if (typeof tex === 'number') {
      return {
        type: 'blockIcon',
        engineBlockId: eng,
        sheetSrc: terrainSheetUrl,
        textureSlot: tex,
        cols: 16,
        rows: 16,
      }
    }
    const e = BLOCK_EMOJI[meta.blockType]
    return { type: 'emoji', text: e || '⬜' }
  }
  const cell = toolSpriteCellFromMeshName(meta.toolMeshName)
  return {
    type: 'toolSprite',
    sheetSrc: TOOLS_SPRITE_SHEET_URL,
    row: cell.row,
    col: cell.col,
    cols: TOOL_SPRITE_COLS,
    rows: TOOL_SPRITE_ROWS,
  }
}
