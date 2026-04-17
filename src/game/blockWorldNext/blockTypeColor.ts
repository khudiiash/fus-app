import { BlockType } from '@/game/minebase/terrain'

/** Approximate albedo for debug / overlay meshes (not texture atlas). */
export function blockTypeHex(type: number): number {
  switch (type) {
    case BlockType.grass:
      return 0x5aad5a
    case BlockType.sand:
      return 0xd6c08a
    case BlockType.tree:
      return 0x4a3520
    case BlockType.leaf:
      return 0x2d6b2d
    case BlockType.dirt:
      return 0x6b4f3a
    case BlockType.stone:
      return 0x8a8a8a
    case BlockType.coal:
      return 0x3a3a3a
    case BlockType.wood:
      return 0x8b6914
    case BlockType.diamond:
      return 0x4ee1dc
    case BlockType.quartz:
      return 0xf0f0f0
    case BlockType.glass:
      return 0xa8d8ff
    case BlockType.bedrock:
      return 0x2a2a2a
    case BlockType.water:
      return 0x2a6eaa
    default:
      return 0x888888
  }
}
