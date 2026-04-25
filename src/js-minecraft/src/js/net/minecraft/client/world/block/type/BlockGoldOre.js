import Block from '../Block.js'

/**
 * Gold ore block — reuses the stone texture slot; vertex tint reads as a warm gold-veined
 * stone in the world mesh shader (no separate atlas cell required for the first pass).
 */
export default class BlockGoldOre extends Block {
  constructor(id, textureSlotId) {
    super(id, textureSlotId)
  }

  getColor(world, x, y, z, face) {
    void world
    void x
    void y
    void z
    void face
    return 0xf0c96a
  }
}
