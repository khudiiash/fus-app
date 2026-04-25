/**
 * Human-readable (Ukrainian) names for Laby mob-drop `bwSeedKey` values. Used for world
 * drop billboards, direct inventory grants, and in-app toasts.
 */
const LABEL_UK = Object.freeze({
  fus_bw_block_grass: 'Трава (блок)',
  fus_bw_block_dirt: 'Земля (блок)',
  fus_bw_block_sand: 'Пісок (блок)',
  fus_bw_block_stone: 'Камінь (блок)',
  fus_bw_block_wood: 'Деревина (блок)',
  fus_bw_block_leaf: 'Листя (блок)',
  fus_bw_block_coal: 'Вугілля (блок)',
  fus_bw_block_tree: 'Колода (блок)',
  fus_bw_block_glass: 'Скло (блок)',
  fus_bw_block_quartz: 'Кварц (блок)',
  fus_bw_block_diamond: 'Алмаз (блок)',
  fus_bw_pick: 'Кайло (базове)',
  fus_bw_tool_Stone_Pickaxe: 'Кам’яне кайло',
  fus_bw_tool_Iron_Pickaxe: 'Залізне кайло',
  fus_bw_tool_Wooden_Sword: 'Дерев’яний меч',
  fus_bw_tool_Stone_Sword: 'Кам’яний меч',
})

/**
 * @param {string} [bwKey]
 * @returns {string}
 */
export function labyDisplayNameForMobDropBwKey(bwKey) {
  const k = String(bwKey || '').trim()
  if (k && LABEL_UK[k]) {
    return LABEL_UK[k]
  }
  if (!k) return 'Предмет'
  const tail = k.replace(/^fus_bw_/, '').replace(/_/g, ' ')
  return tail || k
}
