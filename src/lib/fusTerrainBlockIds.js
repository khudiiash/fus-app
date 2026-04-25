/**
 * FUS shop / Firestore `blockWorld.blockType` = catalog index. Maps to engine block ids
 * (js-minecraft {@link BlockRegistry}).
 *
 * RTDB: prefer protocol v2 so `t` is always an engine id; when {@code v !== 2}, values in
 * {@code 0..CATALOG_LEN-1} are treated as **catalog** indices (not engine ids, even <20).
 */

/** @type {readonly number[]} catalog index → engine block id */
export const FUS_CATALOG_TO_ENGINE_BLOCK_ID = [
  2, // 0 grass
  12, // 1 sand
  17, // 2 log / колода
  18, // 3 leaves
  3, // 4 dirt
  1, // 5 stone
  1, // 6 coal ore (no ore block — stone)
  5, // 7 wood planks
  1, // 8 diamond block (approximation)
  4, // 9 quartz (approximation)
  20, // 10 glass
  7, // 11 — unused in seeds; bedrock fallback
  9, // 12 water
  21, // 13 indestructible obsidian (shop — engine id 21, see {@link BlockRegistry#INDESTRUCTIBLE_OBSIDIAN})
]

/**
 * Persisted on RTDB `cells.*.v`. When equal, {@link encodeWorldBlockEditPayload `t`} is an engine block id,
 * not a shop catalog index (see {@link FUS_CATALOG_TO_ENGINE_BLOCK_ID}).
 */
export const WORLD_BLOCK_EDIT_PROTOCOL_V2 = 2

/**
 * @param {unknown} val RTDB cell `{ t, p?, v? }`
 * @returns {number} engine block type id (0 = air)
 */
export function decodeWorldBlockTypeFromRtdb(val) {
  if (!val || typeof val !== 'object') return 0
  const t = Number(val.t)
  if (!Number.isFinite(t)) return 0
  const id = t | 0
  const v = Number(val.v)
  if (v === WORLD_BLOCK_EDIT_PROTOCOL_V2) {
    return id
  }
  const n = FUS_CATALOG_TO_ENGINE_BLOCK_ID.length
  if (id >= 0 && id < n) {
    return FUS_CATALOG_TO_ENGINE_BLOCK_ID[id] ?? 0
  }
  return id
}

/**
 * Payload for `worldBlockEdits/{worldId}/cells/{x,y,z}` (local edits → RTDB).
 * @param {number} engineTypeId
 */
export function encodeWorldBlockEditPayload(engineTypeId) {
  const t = engineTypeId | 0
  if (t === 0) {
    return null
  }
  return { t, p: 1, v: WORLD_BLOCK_EDIT_PROTOCOL_V2 }
}

/**
 * Reverse of {@link FUS_CATALOG_TO_ENGINE_BLOCK_ID} — engine block id to shop {@code bwSeedKey}.
 * Used for mining drops: when a block breaks, we check whether the shop actually carries an item
 * for that block type before rolling a drop. Keys come from seed rows in
 * {@link ../firebase/seedData.js}.
 *
 * Some engine ids alias multiple shop rows (stone / coal / diamond all use engine id 1 because
 * js-minecraft's block registry has no ore variants). We map those aliases to the most generic
 * shop row — {@code fus_bw_block_stone} — since that's what the game world actually rendered.
 * @type {Readonly<Record<number, string>>}
 */
export const ENGINE_BLOCK_ID_TO_BW_SEED_KEY = Object.freeze({
  1: 'fus_bw_block_stone',
  2: 'fus_bw_block_grass',
  3: 'fus_bw_block_dirt',
  4: 'fus_bw_block_quartz',
  5: 'fus_bw_block_wood',
  12: 'fus_bw_block_sand',
  17: 'fus_bw_block_tree',
  18: 'fus_bw_block_leaf',
  20: 'fus_bw_block_glass',
  21: 'fus_bw_block_indestructible',
})

/**
 * @param {number} engineBlockId
 * @returns {string | null} canonical shop {@code bwSeedKey} or {@code null} when the block has
 *   no matching shop row (e.g. bedrock, water, unknown).
 */
export function bwSeedKeyForEngineBlockId(engineBlockId) {
  const id = engineBlockId | 0
  const key = ENGINE_BLOCK_ID_TO_BW_SEED_KEY[id]
  return typeof key === 'string' ? key : null
}
