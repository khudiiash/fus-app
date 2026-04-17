import { buildBlockWorldHotbarSlots, type BlockWorldHotbarSlot } from '@/game/blockWorldItems'
import {
  buildFusHotbarSlotMetaRow,
  labyTypeIdForBwHotbarSlot,
  type FusLabyHotbarSlotMeta,
} from '@/game/labyminecraft/labyHotbarSlotMeta'

type McInv = {
  player?: {
    inventory?: {
      setItem: (index: number, typeId: number) => void
    }
  }
  itemRenderer?: {
    scheduleDirty: (groupId: string) => void
  }
  /** Written each apply for {@link fusLabyRemoteMelee} / presence hand (not read by js-minecraft core). */
  fusHotbarSlotMeta?: FusLabyHotbarSlotMeta[]
}

/**
 * Fills Laby js-minecraft hotbar (9 slots) from the same shop model as Block World:
 * `buildBlockWorldHotbarSlots` + optional `blockWorldHotbarOrder`.
 * Missing slots are padded with {@link LABY_HOTBAR_BLOCK_TYPES}.
 */
export function applyLabyHotbarFromShop(
  mc: McInv,
  inventoryIds: string[],
  inventoryCounts: Record<string, number> | null | undefined,
  catalog: Array<Record<string, unknown> & { id: string }>,
  preferredOrder: string[] | null | undefined,
): void {
  const inv = mc.player?.inventory
  if (!inv?.setItem) return
  const built = buildBlockWorldHotbarSlots(inventoryIds, inventoryCounts, catalog, preferredOrder)
  const row: Array<BlockWorldHotbarSlot | undefined> = []
  for (let i = 0; i < 9; i++) row[i] = built[i]

  for (let i = 0; i < 9; i++) {
    inv.setItem(i, labyTypeIdForBwHotbarSlot(row[i]))
  }
  mc.fusHotbarSlotMeta = buildFusHotbarSlotMetaRow(row)
  mc.itemRenderer?.scheduleDirty?.('hotbar')
}
