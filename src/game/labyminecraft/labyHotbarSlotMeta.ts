import type { BlockWorldHotbarSlot } from '@/game/blockWorldItems'
import type { PresenceDoc } from '@/game/sharedWorldFirestore'
import { fusBlockTypeToLabyTypeId } from '@/game/labyminecraft/labyBlockMapping'

export type FusLabyHotbarSlotMeta =
  | { kind: 'empty' }
  | { kind: 'fist' }
  | { kind: 'block' }
  | { kind: 'tool'; pvpDamageHalf: number; toolMeshName: string }

/**
 * Numeric hotbar entry for js-minecraft inventory (placement uses this type id).
 * Fist / tools / unused → 0 (tools use 2D `tools.png` in {@link IngameOverlay}; must not place a proxy block).
 */
export function labyTypeIdForBwHotbarSlot(slot: BlockWorldHotbarSlot | undefined): number {
  if (!slot || slot.kind === 'fist') return 0
  if (slot.kind === 'item' && slot.meta.kind === 'block') {
    return fusBlockTypeToLabyTypeId(slot.meta.blockType)
  }
  if (slot.kind === 'item' && slot.meta.kind === 'tool') {
    return 0
  }
  return 0
}

export function fusLabyHotbarMetaForSlot(slot: BlockWorldHotbarSlot | undefined): FusLabyHotbarSlotMeta {
  if (!slot || slot.kind === 'fist') {
    return slot?.kind === 'fist' ? { kind: 'fist' } : { kind: 'empty' }
  }
  if (slot.kind === 'item' && slot.meta.kind === 'block') return { kind: 'block' }
  if (slot.kind === 'item' && slot.meta.kind === 'tool') {
    return {
      kind: 'tool',
      pvpDamageHalf: slot.meta.pvpDamageHalf,
      toolMeshName: slot.meta.toolMeshName?.trim() || 'Iron_Pickaxe',
    }
  }
  return { kind: 'empty' }
}

/** Nine entries aligned with `InventoryPlayer` indices (same order as {@link buildBlockWorldHotbarSlots}). */
export function buildFusHotbarSlotMetaRow(
  slots: Array<BlockWorldHotbarSlot | undefined>,
): FusLabyHotbarSlotMeta[] {
  const row: FusLabyHotbarSlotMeta[] = []
  for (let i = 0; i < 9; i++) {
    row.push(fusLabyHotbarMetaForSlot(slots[i]))
  }
  return row
}

export function pvpDamageHalfForSelectedSlot(
  metaRow: FusLabyHotbarSlotMeta[] | null | undefined,
  selectedIndex: number,
): number {
  if (!metaRow || selectedIndex < 0 || selectedIndex > 8) return 0
  const m = metaRow[selectedIndex]
  if (m?.kind === 'tool') return Math.max(0, Math.floor(Number(m.pvpDamageHalf) || 0))
  return 0
}

/** RTDB presence hand fields (same semantics as Block World {@link Control.getPresenceHandFields}). */
export function fusLabyPresenceHandFromBwSlots(
  slots: Array<BlockWorldHotbarSlot | undefined>,
  selectedIndex: number,
): Pick<PresenceDoc, 'mode' | 'slot' | 'bwBlockType' | 'bwHandMine' | 'bwToolMesh'> {
  const slot = Math.max(0, Math.min(8, Math.floor(selectedIndex) || 0))
  const s = slots[slot]
  let bwBlockType = 0
  let bwHandMine: 'fist' | 'tool' = 'fist'
  let bwToolMesh: string | null = null
  let mode: 'mine' | 'build' = 'mine'

  if (s?.kind === 'item' && s.meta.kind === 'block' && s.count > 0) {
    mode = 'build'
    bwBlockType = s.meta.blockType
  } else if (s?.kind === 'item' && s.meta.kind === 'tool') {
    bwHandMine = 'tool'
    bwToolMesh = s.meta.toolMeshName ?? 'Iron_Pickaxe'
  }

  return { mode, slot, bwBlockType, bwHandMine, bwToolMesh }
}
