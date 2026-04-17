import {
  TOOL_SPRITE_COLS,
  TOOL_SPRITE_ROWS,
  TOOLS_SPRITE_SHEET_URL,
  toolSpriteCellFromMeshName,
} from '@/game/blockWorldToolsRegistry'

type McFusTools = {
  fusToolsSpriteSheet: HTMLImageElement | null
  fusGetToolSpriteSrcRect: (meshName: string) => {
    sx: number
    sy: number
    sw: number
    sh: number
  } | null
}

/**
 * Loads `src/game/assets/tools.png` (via {@link TOOLS_SPRITE_SHEET_URL}) and attaches helpers on the
 * js-minecraft instance so {@link IngameOverlay} can draw the same tool icons as Block World / the modal.
 */
export function installFusLabyToolsSpriteHelpers(mc: McFusTools): void {
  mc.fusToolsSpriteSheet = null
  mc.fusGetToolSpriteSrcRect = (meshName: string) => {
    const img = mc.fusToolsSpriteSheet
    if (!img?.naturalWidth) return null
    const raw = typeof meshName === 'string' && meshName.trim() ? meshName.trim() : 'Iron_Pickaxe'
    const cell = toolSpriteCellFromMeshName(raw) ?? toolSpriteCellFromMeshName('Iron_Pickaxe')
    if (!cell) return null
    const cw = img.naturalWidth / TOOL_SPRITE_COLS
    const ch = img.naturalHeight / TOOL_SPRITE_ROWS
    return {
      sx: cell.col * cw,
      sy: cell.row * ch,
      sw: cw,
      sh: ch,
    }
  }
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.onload = () => {
    mc.fusToolsSpriteSheet = image
  }
  image.onerror = () => {
    console.warn('[labyminecraft] tools.png failed to load for Laby hotbar icons')
  }
  image.src = TOOLS_SPRITE_SHEET_URL
}
