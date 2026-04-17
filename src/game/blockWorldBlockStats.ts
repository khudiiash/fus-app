import { BlockType } from '@/game/minebase/terrain'

/** Total “mining damage” required to break one voxel of this type (fist/tool apply damage per swing). */
export function blockTypeBreakHp(t: BlockType): number {
  switch (t) {
    case BlockType.leaf:
      return 4
    case BlockType.grass:
    case BlockType.dirt:
      return 14
    case BlockType.sand:
      return 12
    case BlockType.glass:
      return 10
    case BlockType.wood:
    case BlockType.tree:
      return 22
    case BlockType.coal:
      return 38
    case BlockType.stone:
      return 72
    case BlockType.quartz:
      return 48
    case BlockType.diamond:
      return 90
    case BlockType.bedrock:
    case BlockType.water:
      return Number.POSITIVE_INFINITY
    default:
      return 20
  }
}
