import { BlockType } from '@/game/minebase/terrain'
import {
  BLOCK_WORLD_PICKAXE_PVP_DAMAGE_HALF,
  FIST_MINE_DAMAGE_PER_SWING,
  MINING_DAMAGE_HOLDING_BLOCK,
} from '@/game/playerConstants'

export const BW_HOTBAR_MAX_SLOTS = 9

export type BlockWorldItemKind = 'tool' | 'block'

/** Parsed from Firestore `items/{id}.blockWorld`. */
export type BlockWorldItemMeta = {
  kind: BlockWorldItemKind
  /** Terrain block enum when {@link kind} is `block`. */
  blockType: BlockType
  /** Damage per swing to terrain blocks (tools); ignored for pure block items when mining. */
  mineDamage: number
  /** Half-heart PvP damage; `0` = cannot hurt players with this item. */
  pvpDamageHalf: number
  /** Node name in `tools.glb` (e.g. `Iron_Pickaxe`). */
  toolMeshName?: string
}

export type BlockWorldHotbarSlot =
  | { kind: 'fist' }
  | { kind: 'item'; itemId: string; meta: BlockWorldItemMeta; count: number }

export type BlockWorldHotbarVisual =
  | { type: 'emoji'; text: string }
  | { type: 'img'; src: string }

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

/**
 * Read `item.blockWorld` from a Firestore item document.
 * Invalid or missing config returns null (item is not a block-world good).
 */
export function parseBlockWorldItem(
  item: Record<string, unknown> | null | undefined,
): BlockWorldItemMeta | null {
  if (!item) return null
  const bw = asRecord(item.blockWorld)
  if (!bw) return null
  const kind = bw.kind === 'tool' || bw.kind === 'block' ? bw.kind : null
  if (!kind) return null

  const blockTypeRaw = Number(bw.blockType)
  const blockType = Number.isFinite(blockTypeRaw)
    ? (Math.floor(blockTypeRaw) as BlockType)
    : BlockType.grass

  if (kind === 'block') {
    if (
      blockType < BlockType.grass ||
      blockType > BlockType.bedrock ||
      blockType === BlockType.bedrock
    ) {
      return null
    }
    return {
      kind: 'block',
      blockType,
      mineDamage: MINING_DAMAGE_HOLDING_BLOCK,
      pvpDamageHalf: 0,
    }
  }

  // tool
  const mineRaw = Number(bw.mineDamage)
  const mineDamage =
    Number.isFinite(mineRaw) && mineRaw > 0 ? mineRaw : 3.2
  const pvpRaw = bw.pvpDamageHalf
  let pvpDamageHalf = BLOCK_WORLD_PICKAXE_PVP_DAMAGE_HALF
  if (pvpRaw === null || pvpRaw === false) pvpDamageHalf = 0
  else if (typeof pvpRaw === 'number' && Number.isFinite(pvpRaw) && pvpRaw >= 0) {
    pvpDamageHalf = Math.floor(pvpRaw)
  }
  const toolMeshName =
    typeof bw.toolMeshName === 'string' && bw.toolMeshName.trim().length > 0
      ? bw.toolMeshName.trim()
      : 'Iron_Pickaxe'
  return {
    kind: 'tool',
    blockType: BlockType.stone,
    mineDamage,
    pvpDamageHalf,
    toolMeshName,
  }
}

/**
 * Hotbar: slot 0 = fist, then up to BW_HOTBAR_MAX_SLOTS - 1 owned `block_world` items.
 * Optional `preferredItemOrder` (Firestore `blockWorldHotbarOrder`): item ids top-to-bottom for slots 1+;
 * remaining owned block_world items fill in catalog order.
 */
export function buildBlockWorldHotbarSlots(
  inventoryIds: string[],
  inventoryCounts: Record<string, number> | null | undefined,
  catalogItems: Array<Record<string, unknown> & { id: string }>,
  preferredItemOrder?: string[] | null,
): BlockWorldHotbarSlot[] {
  const invSet = new Set(inventoryIds || [])
  const counts = inventoryCounts || {}
  const slots: BlockWorldHotbarSlot[] = [{ kind: 'fist' }]
  const used = new Set<string>()

  const pushItemIfOwned = (itemId: string) => {
    if (slots.length >= BW_HOTBAR_MAX_SLOTS) return false
    const id = typeof itemId === 'string' ? itemId.trim() : ''
    if (!id || !invSet.has(id) || used.has(id)) return false
    const item = catalogItems.find((x) => x.id === id)
    if (!item || item.category !== 'block_world' || item.active === false) return false
    const meta = parseBlockWorldItem(item)
    if (!meta) return false
    const c = Math.max(0, Math.floor(Number(counts[id]) || 1))
    if (c < 1) return false
    slots.push({
      kind: 'item',
      itemId: id,
      meta,
      count: c,
    })
    used.add(id)
    return true
  }

  if (Array.isArray(preferredItemOrder)) {
    for (const raw of preferredItemOrder) {
      if (slots.length >= BW_HOTBAR_MAX_SLOTS) break
      pushItemIfOwned(typeof raw === 'string' ? raw : '')
    }
  }

  const sorted = [...catalogItems].sort((a, b) => {
    const ka = String(a.bwSeedKey || a.name || a.id)
    const kb = String(b.bwSeedKey || b.name || b.id)
    return ka.localeCompare(kb, 'uk')
  })

  for (const item of sorted) {
    if (slots.length >= BW_HOTBAR_MAX_SLOTS) break
    if (used.has(item.id)) continue
    if (item.category !== 'block_world' || item.active === false) continue
    if (!invSet.has(item.id)) continue
    const meta = parseBlockWorldItem(item)
    if (!meta) continue
    const c = Math.max(0, Math.floor(Number(counts[item.id]) || 1))
    if (c < 1) continue
    slots.push({
      kind: 'item',
      itemId: item.id,
      meta,
      count: c,
    })
    used.add(item.id)
  }
  return slots
}
