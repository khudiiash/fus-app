import type { BlockWorldHotbarSlot } from '@/game/blockWorldItems'
import { blockWorldBlockIconUrl } from '@/game/blockWorldBlockIconUrls'
import {
  TOOL_SPRITE_COLS,
  TOOL_SPRITE_ROWS,
  TOOLS_SPRITE_SHEET_URL,
  toolSpriteCellFromMeshName,
} from '@/game/blockWorldToolsRegistry'

export type HotbarCellVisual =
  | { type: 'emoji'; text: string }
  | { type: 'img'; src: string }
  | {
      type: 'toolSprite'
      sheetSrc: string
      col: number
      row: number
      cols: number
      rows: number
    }

export function hotbarCellVisualForBwSlot(
  slot: BlockWorldHotbarSlot | undefined,
): HotbarCellVisual {
  if (!slot || slot.kind === 'fist') return { type: 'emoji', text: '✊' }
  if (slot.kind === 'item' && slot.meta.kind === 'tool') {
    const meshName = slot.meta.toolMeshName ?? 'Iron_Pickaxe'
    const cell =
      toolSpriteCellFromMeshName(meshName) ??
      toolSpriteCellFromMeshName('Iron_Pickaxe') ?? { row: 3, col: 2 }
    return {
      type: 'toolSprite',
      sheetSrc: TOOLS_SPRITE_SHEET_URL,
      col: cell.col,
      row: cell.row,
      cols: TOOL_SPRITE_COLS,
      rows: TOOL_SPRITE_ROWS,
    }
  }
  if (slot.kind === 'item' && slot.meta.kind === 'block') {
    return { type: 'img', src: blockWorldBlockIconUrl(slot.meta.blockType) }
  }
  return { type: 'emoji', text: '?' }
}
