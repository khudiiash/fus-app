/**
 * Mystery box loot: eligible pool, roll outcome, and grant checks (used by `openMysteryBox` in collections).
 */

const RARITY_RANK = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
}

/** @param {unknown} r */
export function rarityRank(r) {
  const k = String(r || 'common').toLowerCase()
  return RARITY_RANK[k] ?? 0
}

/**
 * Max shop price for loot items vs box list price (keeps cheap boxes from dropping expensive skins).
 * @param {unknown} boxPrice
 */
function lootPriceCap(boxPrice) {
  const p = Number(boxPrice)
  if (!Number.isFinite(p) || p <= 0) {
    return Number.POSITIVE_INFINITY
  }
  return Math.max(p * 3, p + 50)
}

/**
 * @param {Array<Record<string, unknown> & { id?: string }>} allItems
 * @param {Set<string>} inv owned item ids
 * @param {unknown} boxRarity
 * @param {unknown} boxPrice
 * @returns {Array<Record<string, unknown> & { id: string }>}
 */
export function buildEligibleLootPool(allItems, inv, boxRarity, boxPrice) {
  const cap = lootPriceCap(boxPrice)
  const maxR = rarityRank(boxRarity)
  /** Categories that should not drop from boxes */
  const skip = new Set(['mystery_box', 'badge'])

  const out = []
  for (const it of allItems) {
    if (!it || typeof it !== 'object') continue
    const id = it.id
    if (typeof id !== 'string' || !id) continue
    if (inv.has(id)) continue
    const cat = it.category
    if (typeof cat === 'string' && skip.has(cat)) continue
    if (rarityRank(it.rarity) > maxR) continue
    const price = Number(it.price)
    const effPrice = Number.isFinite(price) ? Math.max(0, price) : 0
    if (effPrice > cap) continue
    out.push({ ...it, id })
  }
  return out
}

/**
 * @param {Record<string, unknown>} boxItem
 * @param {Array<{ id: string }>} pool
 * @returns {{ coins: number, itemIds: string[] }}
 */
export function rollMysteryBox(boxItem, pool) {
  const bp = Math.max(0, Number(boxItem?.price) || 0)
  const coinsMin = Math.max(8, Math.floor(bp * 0.08))
  const coinsMax = Math.max(coinsMin + 4, Math.floor(bp * 0.32) + 24)
  const coins = coinsMin + Math.floor(Math.random() * (coinsMax - coinsMin + 1))

  const r = Math.random()
  let numItems = 0
  if (r < 0.38) numItems = 0
  else if (r < 0.82) numItems = 1
  else numItems = 2

  if (!pool.length || numItems === 0) {
    return { coins, itemIds: [] }
  }

  const copy = [...pool]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }

  const itemIds = []
  const want = Math.min(numItems, copy.length)
  for (let i = 0; i < want; i++) {
    const id = copy[i]?.id
    if (typeof id === 'string' && id && !itemIds.includes(id)) {
      itemIds.push(id)
    }
  }
  return { coins, itemIds }
}

/**
 * @param {Record<string, unknown> & { id?: string }} it
 * @param {Set<string>} inv
 * @param {unknown} boxRarity
 * @param {unknown} boxPrice
 */
export function canGrantShopItemFromBox(it, inv, boxRarity, boxPrice) {
  if (!it || typeof it !== 'object') return false
  const id = it.id
  if (typeof id !== 'string' || !id) return false
  if (inv.has(id)) return false
  if (it.category === 'mystery_box') return false
  if (rarityRank(it.rarity) > rarityRank(boxRarity)) return false
  const cap = lootPriceCap(boxPrice)
  const price = Number(it.price)
  const effPrice = Number.isFinite(price) ? Math.max(0, price) : 0
  if (effPrice > cap) return false
  return true
}
