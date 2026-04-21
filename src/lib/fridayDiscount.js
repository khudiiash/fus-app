/**
 * Friday all-day discounts for the shop — 20 % to 80 % off every item, deterministic per
 * (ISO date, item id) so the same visitor sees the same prices all Friday regardless of
 * page reload, and two clients comparing prices agree.
 *
 * Non-Friday days → {@link NO_DISCOUNT} / 0 % off.
 *
 * Intentionally **not** persisted to Firestore: the calculation is cheap and a pure function
 * of time+id, so there's nothing to sync. Server-side sanity in {@link purchaseItem} relies
 * on a small rounding tolerance in case of mid-second price changes near midnight.
 */

export const NO_DISCOUNT = { pct: 0, priceNow: (price) => price }

/** 32-bit hash from a string — xmur3, same seed everywhere so clients agree on the roll. */
function xmur3(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    // eslint-disable-next-line no-bitwise
    return (h ^= h >>> 16) >>> 0
  }
}

/** `yyyy-mm-dd` in the **local** timezone so every Friday in the user's locale kicks in. */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** True if {@code date} is a Friday (UI & gating). */
export function isFriday(date = new Date()) {
  return date.getDay() === 5
}

/**
 * Deterministic discount pct ∈ \[20 .. 80\] for a (day, itemId) pair.
 * @returns {number} integer percent off, 0 on non-Fridays.
 */
export function fridayDiscountPct(itemId, date = new Date()) {
  if (!isFriday(date) || !itemId) return 0
  const rng = xmur3(`fri-${localDateKey(date)}-${itemId}`)
  const r = rng() / 0xffffffff
  return 20 + Math.floor(r * 61)
}

/**
 * Discounted price (integer coins). Always ≥ 1 — a free item would break the existing
 * "not enough coins" branches in {@link purchaseItem} for edge-cases.
 */
export function applyFridayDiscount(price, itemId, date = new Date()) {
  const base = Math.max(0, Math.floor(Number(price) || 0))
  const pct = fridayDiscountPct(itemId, date)
  if (pct <= 0) return base
  const cut = Math.round((base * pct) / 100)
  return Math.max(1, base - cut)
}

/**
 * Rich descriptor for UI: `{ pct, basePrice, discountedPrice, savings, isActive }`.
 */
export function getFridayDiscount(item, date = new Date()) {
  const base = Math.max(0, Math.floor(Number(item?.price) || 0))
  const pct = fridayDiscountPct(item?.id, date)
  if (pct <= 0 || base <= 0) {
    return { pct: 0, basePrice: base, discountedPrice: base, savings: 0, isActive: false }
  }
  const discountedPrice = applyFridayDiscount(base, item.id, date)
  return {
    pct,
    basePrice: base,
    discountedPrice,
    savings: Math.max(0, base - discountedPrice),
    isActive: true,
  }
}
