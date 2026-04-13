/**
 * UI icons for block-world shop / hotbar — same PNGs as terrain materials so previews match in-world blocks.
 */
import { BlockType } from '@/game/minebase/terrain'
import grassTop from '@/game/minebase/static/textures/block/grass_top_green.png'
import grassSide from '@/game/minebase/static/textures/block/grass_block_side.png'
import dirtTex from '@/game/minebase/static/textures/block/dirt.png'
import sandTex from '@/game/minebase/static/textures/block/sand.png'
import oakLeaves from '@/game/minebase/static/textures/block/oak_leaves.png'
import oakLog from '@/game/minebase/static/textures/block/oak_log.png'
import stoneTex from '@/game/minebase/static/textures/block/stone.png'
import coalOre from '@/game/minebase/static/textures/block/coal_ore.png'
import oakPlanks from '@/game/minebase/static/textures/block/oak_planks.png'
import diamondBlock from '@/game/minebase/static/textures/block/diamond_block.png'
import quartzSide from '@/game/minebase/static/textures/block/quartz_block_side.png'
import glassTex from '@/game/minebase/static/textures/block/glass.png'

const BY_TYPE: Partial<Record<BlockType, string>> = {
  [BlockType.grass]: grassTop,
  [BlockType.sand]: sandTex,
  [BlockType.tree]: oakLog,
  [BlockType.leaf]: oakLeaves,
  [BlockType.dirt]: dirtTex,
  [BlockType.stone]: stoneTex,
  [BlockType.coal]: coalOre,
  [BlockType.wood]: oakPlanks,
  [BlockType.diamond]: diamondBlock,
  [BlockType.quartz]: quartzSide,
  [BlockType.glass]: glassTex,
}

/** Fallback if a new {@link BlockType} is missing from the map. */
const FALLBACK = grassSide

export function blockWorldBlockIconUrl(blockType: BlockType): string {
  return BY_TYPE[blockType] ?? FALLBACK
}
