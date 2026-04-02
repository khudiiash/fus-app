/**
 * Loot rolls for «Магічна коробка» — pure functions (used right before / inside Firestore tx).
 * Tuned so EV feels fair: mix of coins (0…1.5× ціни коробки) + шанс на 1–2 предмети.
 */

export const RARITY_IX = { common: 0, rare: 1, epic: 2, legendary: 3 }

/** Максимальна рідкість предмета, що може випасти з коробки цієї рідкості */
export const MAX_DROP_RARITY_IX = {
  common: 1,
  rare: 2,
  epic: 3,
  legendary: 3,
}

/** Верхня межа ціни предмета відносно ціни коробки */
export const PRICE_CAP_MULT = {
  common: 2.1,
  rare: 2.6,
  epic: 3.2,
  legendary: 4.8,
}

/**
 * Чи може цей предмет бути виданий з коробки (синхронно з пулом RNG).
 * @param {{ id:string, category:string, rarity?:string, price?:number, active?:boolean, stock?:number|null }} item
 * @param {Set<string>} inv
 */
export function canGrantShopItemFromBox(item, inv, boxRarity, boxPrice) {
  if (!item || item.active === false) return false
  if (item.category === 'mystery_box') return false
  if (!['skin', 'accessory', 'room', 'pet'].includes(item.category)) return false
  if (inv.has(item.id)) return false
  const br = boxRarity || 'common'
  const maxIx = MAX_DROP_RARITY_IX[br] ?? 1
  const ix = RARITY_IX[item.rarity] ?? 0
  if (ix > maxIx) return false
  const cap = Math.max(50, Number(boxPrice) || 0) * (PRICE_CAP_MULT[br] ?? 2.2)
  const p = Number(item.price) || 0
  if (p > cap) return false
  const hasStock = item.stock !== null && item.stock !== undefined
  if (hasStock && item.stock <= 0) return false
  return true
}

/**
 * @param {Array<{id:string,category:string,rarity?:string,price?:number,active?:boolean,stock?:number|null}>} allItems
 * @param {Set<string>|string[]} inventoryIds
 * @param {string} boxRarity
 * @param {number} boxPrice
 */
export function buildEligibleLootPool(allItems, inventoryIds, boxRarity, boxPrice) {
  const inv = inventoryIds instanceof Set ? inventoryIds : new Set(inventoryIds || [])
  return allItems.filter((it) => canGrantShopItemFromBox(it, inv, boxRarity, boxPrice))
}

function triangularInt(min, max) {
  if (max <= min) return min
  const u1 = Math.random()
  const u2 = Math.random()
  const t = (u1 + u2) / 2
  return min + Math.floor(t * (max - min + 1))
}

function weightedPick(items) {
  if (!items.length) return null
  const weights = items.map((it) => 1 / Math.sqrt(Number(it.price || 80) + 1))
  const sum = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * sum
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]
    if (r <= 0) return items[i]
  }
  return items[items.length - 1]
}

/**
 * @param {{ price?: number, rarity?: string }} boxItem
 * @param {Array<{id:string,rarity?:string,price?:number}>} pool
 * @returns {{ coins: number, itemIds: string[] }}
 */
export function rollMysteryBox(boxItem, pool) {
  const P = Math.max(1, Number(boxItem.price) || 100)
  const br = boxItem.rarity || 'common'
  const maxIx = MAX_DROP_RARITY_IX[br] ?? 1

  const coinMax = Math.floor(P * 1.5)
  let coins = triangularInt(0, coinMax)

  if (Math.random() < 0.055) coins += Math.floor(P * (0.3 + Math.random() * 0.55))

  const pDouble = { common: 0.045, rare: 0.08, epic: 0.11, legendary: 0.15 }[br] ?? 0.05
  const pSingle = { common: 0.28, rare: 0.36, epic: 0.44, legendary: 0.52 }[br] ?? 0.28
  const pFallbackSecond = { common: 0.08, rare: 0.12, epic: 0.16, legendary: 0.2 }[br] ?? 0.08

  const picked = []

  const tryPick = (maxRarityIx) => {
    const sub = pool.filter((it) => {
      const ix = RARITY_IX[it.rarity] ?? 0
      return ix <= maxRarityIx && !picked.includes(it.id)
    })
    if (!sub.length) return
    const c = weightedPick(sub)
    if (c && !picked.includes(c.id)) picked.push(c.id)
  }

  if (Math.random() < pDouble) {
    tryPick(maxIx)
    tryPick(Math.max(0, maxIx - 1))
    if (picked.length < 2 && Math.random() < 0.4) tryPick(maxIx)
  } else if (Math.random() < pSingle) {
    tryPick(maxIx)
    if (picked.length === 0) tryPick(Math.max(0, maxIx - 1))
  } else if (Math.random() < pFallbackSecond) {
    tryPick(Math.max(0, maxIx - 1))
  }

  if (!picked.length) {
    coins = Math.min(coinMax, coins + Math.floor(P * (0.12 + Math.random() * 0.22)))
  }

  return { coins: Math.max(0, Math.round(coins)), itemIds: [...new Set(picked)] }
}
