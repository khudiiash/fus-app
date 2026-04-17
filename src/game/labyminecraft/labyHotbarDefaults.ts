/**
 * Default Laby (js-minecraft) hotbar = nine vanilla block type ids.
 *
 * **Shop / FUS inventory (future):** BlockWorld uses `buildBlockWorldHotbarSlots` in
 * `blockWorldItems.ts` (Firestore `items`, `auth.profile.inventory`, `toolMeshName` → `tools.glb`).
 * Pack URLs: `TOOLS_PACK_GLB_URL` in `blockWorldToolsRegistry.ts` (`src/game/assets/tools.glb` + `.png`).
 * Laby inventory is separate (`PlayerInventory` / `setItem` numeric type ids); wiring would map
 * owned `block_world` items + counts into Laby slots and optionally sync selected slot with the
 * mobile hotbar bridge in `GameWindow.js`.
 */
import { BlockType } from '@/game/minebase/terrain'
import { fusBlockTypeToLabyTypeId } from '@/game/labyminecraft/labyBlockMapping'

/** Nine placeable FUS terrain types shown in the shared Laby hotbar (matches classic creative bar). */
export const LABY_HOTBAR_BLOCK_TYPES: BlockType[] = [
  BlockType.grass,
  BlockType.stone,
  BlockType.dirt,
  BlockType.sand,
  BlockType.wood,
  BlockType.tree,
  BlockType.leaf,
  BlockType.glass,
  BlockType.coal,
]

export function fillLabyPlayerHotbar(inv: {
  setItem: (index: number, typeId: number) => void
}): void {
  for (let i = 0; i < LABY_HOTBAR_BLOCK_TYPES.length; i++) {
    const fus = LABY_HOTBAR_BLOCK_TYPES[i]
    inv.setItem(i, fusBlockTypeToLabyTypeId(fus))
  }
}
