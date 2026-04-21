/**
 * Block-world shop tool rows (seedData) — mesh names match `tools.glb` / sprite atlas in js-minecraft.
 */

const TIERS = ['Wooden', 'Stone', 'Iron', 'Golden', 'Diamond', 'Netherite']
const TOOL_TYPES = ['Pickaxe', 'Axe', 'Shovel', 'Sword', 'Hoe']

/** @type {string[]} */
export const ALL_TOOL_MESH_NAMES = TIERS.flatMap((t) => TOOL_TYPES.map((k) => `${t}_${k}`))

const TIER_DAMAGE = {
  Wooden: 8,
  Stone: 11,
  Iron: 15,
  Golden: 12,
  Diamond: 19,
  Netherite: 22,
}

/**
 * Per-tool-kind PvP damage multiplier. Sword is the dedicated weapon; axe is the all-rounder
 * heavy hitter; pickaxe/shovel are improvised; hoe is famously useless. Multiplied by the
 * tier weight below to produce a final half-heart number.
 *
 * Tuned so that the canonical "first sword" (Wooden Sword) deals 2 hearts (4 half) and
 * top-tier (Netherite Sword) deals 5 hearts (10 half) — matches vanilla Minecraft scale.
 */
const TIER_PVP_WEIGHT = {
  Wooden: 1.0,
  Stone: 1.4,
  Iron: 1.8,
  Golden: 1.4,
  Diamond: 2.2,
  Netherite: 2.5,
}

const KIND_PVP_BASE = {
  Sword: 4,
  Axe: 3,
  Pickaxe: 2,
  Shovel: 2,
  Hoe: 1,
}

/**
 * @param {string} meshName e.g. `Iron_Pickaxe`
 * @returns {{ tier: string, kind: string } | null}
 */
export function parseToolMeshBaseName(meshName) {
  const m = String(meshName).match(/^(Wooden|Stone|Iron|Golden|Diamond|Netherite)_(.+)$/)
  if (!m) return null
  return { tier: m[1], kind: m[2] }
}

/**
 * Canonical PvP damage (half-hearts) for a tool mesh. Used by both the seed-data writer
 * (so freshly minted shop rows get the right value) and the runtime combat path (so legacy
 * docs that all carry the obsolete flat `pvpDamageHalf: 2` still get tier/kind scaling
 * without re-seeding Firestore).
 *
 * Examples:
 *   - Wooden_Sword → 4   (vanilla baseline)
 *   - Iron_Sword   → 7
 *   - Diamond_Axe  → 7
 *   - Wooden_Hoe   → 1
 *   - Netherite_Sword → 10
 *
 * @param {string} meshName
 * @returns {number}
 */
export function pvpDamageHalfForMeshName(meshName) {
  const p = parseToolMeshBaseName(meshName)
  if (!p) return 2
  const base = KIND_PVP_BASE[p.kind] ?? 2
  const w = TIER_PVP_WEIGHT[p.tier] ?? 1.0
  const v = Math.round(base * w)
  return Math.max(1, Math.min(20, v))
}

/**
 * @param {string} meshName
 */
export function defaultBlockWorldToolDoc(meshName) {
  const p = parseToolMeshBaseName(meshName)
  const mineDamage = p ? TIER_DAMAGE[p.tier] ?? 14 : 14
  return {
    kind: 'tool',
    toolMeshName: meshName,
    mineDamage,
    pvpDamageHalf: pvpDamageHalfForMeshName(meshName),
  }
}
