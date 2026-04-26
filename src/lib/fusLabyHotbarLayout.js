/**
 * Persisted hotbar layout for FUS Laby (slots 1–8; slot 0 is always fist / empty).
 * Stored in localStorage per user id.
 */
import { parseBlockWorldItem } from '@/lib/blockWorldShopVisuals'
import { FUS_CATALOG_TO_ENGINE_BLOCK_ID } from '@/lib/fusTerrainBlockIds'
import { applyLabyDefaultTorchSlot, buildFusLabyHotbarFromProfile } from '@/lib/fusLabyHotbarFromProfile'

/** @typedef {{ kind: 'tool', toolMeshName: string, itemId?: string } | { kind: 'block', catalogType: number } | null} FusHotbarSlotMeta */

/**
 * @param {string} uid
 * @returns {string}
 */
function storageKey(uid) {
  return `fusLabyHotbarV1:${uid}`
}

/**
 * @returns {string[] | null} Eight Firestore item ids for engine slots 1–8 (may contain empty strings).
 */
export function loadLabyHotbarItemIds(uid) {
  if (typeof localStorage === 'undefined' || !uid) return null
  try {
    const raw = localStorage.getItem(storageKey(uid))
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || !Array.isArray(o.slots)) return null
    const slots = o.slots.map((x) => (typeof x === 'string' ? x : '')).slice(0, 8)
    while (slots.length < 8) slots.push('')
    return slots
  } catch {
    return null
  }
}

/**
 * @param {string} uid
 * @param {string[]} slotItemIds length 8 → maps to engine slots 1..8
 */
export function saveLabyHotbarItemIds(uid, slotItemIds) {
  if (typeof localStorage === 'undefined' || !uid) return
  const slots = slotItemIds.slice(0, 8).map((s) => (typeof s === 'string' ? s : ''))
  while (slots.length < 8) slots.push('')
  try {
    localStorage.setItem(storageKey(uid), JSON.stringify({ slots, savedAt: Date.now() }))
  } catch {
    /* quota */
  }
}

/**
 * @param {string} itemId
 * @param {unknown[]} shopItems
 * @returns {Record<string, unknown> | null}
 */
function rowById(itemId, shopItems) {
  if (!itemId) return null
  for (const it of shopItems) {
    if (it && typeof it === 'object' && /** @type {any} */ (it).id === itemId) {
      return /** @type {Record<string, unknown>} */ (it)
    }
  }
  return null
}

/**
 * @param {string[]} slotItemIds length 8 for slots 1–8
 * @param {Record<string, unknown> | null | undefined} profile
 * @param {unknown[]} shopItems
 */
export function buildEngineHotbarFromSavedSlots(slotItemIds, profile, shopItems) {
  const inv = new Set(profile?.inventory || [])
  /** @type {number[]} */
  const engineSlots = []
  /** @type {(FusHotbarSlotMeta | null)[]} */
  const slotMeta = []
  for (let i = 0; i < 9; i++) {
    engineSlots.push(0)
    slotMeta.push(null)
  }

  for (let si = 0; si < 8; si++) {
    const slotIndex = si + 1
    const id = slotItemIds[si] || ''
    if (!id) continue
    const row = rowById(id, shopItems)
    if (!row || !inv.has(row.id) || row.category !== 'block_world' || row.active === false) {
      continue
    }
    const bw = parseBlockWorldItem(row)
    if (!bw) continue
    if (bw.kind === 'block') {
      const cat = bw.blockType | 0
      if (cat >= 0 && cat < FUS_CATALOG_TO_ENGINE_BLOCK_ID.length) {
        const eng = FUS_CATALOG_TO_ENGINE_BLOCK_ID[cat]
        if (typeof eng === 'number') {
          engineSlots[slotIndex] = eng
          slotMeta[slotIndex] = {
            kind: 'block',
            catalogType: cat,
            itemId: typeof row.id === 'string' ? row.id : undefined,
          }
        }
      }
    } else if (bw.kind === 'tool') {
      engineSlots[slotIndex] = 0
      slotMeta[slotIndex] = {
        kind: 'tool',
        toolMeshName:
          typeof bw.toolMeshName === 'string' && bw.toolMeshName.length ? bw.toolMeshName : 'Iron_Pickaxe',
        itemId: typeof row.id === 'string' ? row.id : undefined,
        mineDamage: Number(bw.mineDamage) || 0,
        pvpDamageHalf: Number(bw.pvpDamageHalf) || 0,
      }
    }
  }

  applyLabyDefaultTorchSlot(engineSlots, slotMeta)

  return { engineSlots, slotMeta }
}

/**
 * Saved layout (if valid) else automatic fill from profile.
 * @param {Record<string, unknown> | null | undefined} profile
 * @param {unknown[]} shopItems
 * @param {string} [uid]
 */
export function resolveFusLabyHotbar(profile, shopItems, uid) {
  if (uid) {
    const saved = loadLabyHotbarItemIds(uid)
    if (saved) {
      return buildEngineHotbarFromSavedSlots(saved, profile, shopItems)
    }
  }
  return buildFusLabyHotbarFromProfile(profile, shopItems)
}
