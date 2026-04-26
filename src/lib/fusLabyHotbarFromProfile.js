/**
 * Maps Firestore shop `block_world` rows + student inventory into Laby engine hotbar
 * (9 slots: engine block ids + optional per-slot meta for tools / HUD overlays).
 */
import { parseBlockWorldItem } from '@/lib/blockWorldShopVisuals'
import { FUS_CATALOG_TO_ENGINE_BLOCK_ID } from '@/lib/fusTerrainBlockIds'

/**
 * @typedef {{ kind: 'tool', toolMeshName: string, itemId?: string } | { kind: 'block', catalogType: number, itemId?: string }} FusHotbarSlotMeta
 */

/** Engine id for {@code BlockRegistry.TORCH}; always Laby hotbar slot 8. */
export const FUS_LABY_HOTBAR_TORCH_ENGINE_ID = 50
/** {@link FUS_CATALOG_TO_ENGINE_BLOCK_ID} index for the default torch slot. */
export const FUS_LABY_HOTBAR_TORCH_CATALOG = 14

/**
 * @param {number[]} engineSlots
 * @param {(FusHotbarSlotMeta | null)[]} slotMeta
 */
export function applyLabyDefaultTorchSlot(engineSlots, slotMeta) {
  engineSlots[8] = FUS_LABY_HOTBAR_TORCH_ENGINE_ID
  slotMeta[8] = { kind: 'block', catalogType: FUS_LABY_HOTBAR_TORCH_CATALOG, itemId: undefined }
}

/**
 * @param {Record<string, unknown> | null | undefined} profile Auth user doc (inventory, inventoryCounts)
 * @param {unknown[]} shopItems From userStore.items
 * @returns {{ engineSlots: number[], slotMeta: (FusHotbarSlotMeta | null)[] }}
 */
export function buildFusLabyHotbarFromProfile(profile, shopItems) {
  const inv = new Set(profile?.inventory || [])
  /** @type {{ it: Record<string, unknown>, bw: NonNullable<ReturnType<typeof parseBlockWorldItem>> }[]} */
  const rows = []
  for (const it of shopItems) {
    if (!it || typeof it !== 'object') continue
    const row = /** @type {Record<string, unknown>} */ (it)
    if (!inv.has(row.id) || row.category !== 'block_world' || row.active === false) continue
    const bw = parseBlockWorldItem(row)
    if (!bw) continue
    rows.push({ it: row, bw })
  }
  rows.sort((a, b) =>
    String(a.it.name || a.it.id || '').localeCompare(String(b.it.name || b.it.id || ''), 'uk'),
  )

  /** @type {number[]} */
  const engineSlots = []
  /** @type {(FusHotbarSlotMeta | null)[]} */
  const slotMeta = []
  for (let i = 0; i < 9; i++) {
    engineSlots.push(0)
    slotMeta.push(null)
  }

  // Slot 0 stays empty (fist). Fill slots 1–7 from owned items; slot 8 is always the torch
  // (original Laby). At most seven shop cells so the last slot stays free for it.
  const maxFill = Math.min(7, rows.length)
  for (let i = 0; i < maxFill; i++) {
    const slotIndex = i + 1
    const { it, bw } = rows[i]
    if (bw.kind === 'block') {
      const cat = bw.blockType | 0
      if (cat >= 0 && cat < FUS_CATALOG_TO_ENGINE_BLOCK_ID.length) {
        const eng = FUS_CATALOG_TO_ENGINE_BLOCK_ID[cat]
        if (typeof eng === 'number') {
          engineSlots[slotIndex] = eng
          slotMeta[slotIndex] = {
            kind: 'block',
            catalogType: cat,
            itemId: typeof it.id === 'string' ? it.id : undefined,
          }
        }
      }
    } else if (bw.kind === 'tool') {
      engineSlots[slotIndex] = 0
      slotMeta[slotIndex] = {
        kind: 'tool',
        toolMeshName: typeof bw.toolMeshName === 'string' && bw.toolMeshName.length ? bw.toolMeshName : 'Iron_Pickaxe',
        itemId: typeof it.id === 'string' ? it.id : undefined,
        mineDamage: Number(bw.mineDamage) || 0,
        pvpDamageHalf: Number(bw.pvpDamageHalf) || 0,
      }
    }
  }

  applyLabyDefaultTorchSlot(engineSlots, slotMeta)

  return { engineSlots, slotMeta }
}
