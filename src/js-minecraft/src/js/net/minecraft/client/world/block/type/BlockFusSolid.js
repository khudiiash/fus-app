import Block from "../Block.js";

/**
 * Simple solid cube with a sound preset — used for additional {@code terrain.png}-backed shop
 * blocks without a dedicated subclass each.
 */
export default class BlockFusSolid extends Block {
  /**
   * @param {number} id
   * @param {number} textureSlotId macrotile index (16×16 grid on {@code terrain.png})
   * @param {"stone" | "wood" | "gravel" | "grass" | "cloth" | "glass" | "sand"} soundKey
   */
  constructor(id, textureSlotId, soundKey = "stone") {
    super(id, textureSlotId);
    const s = Block.sounds[soundKey];
    this.sound = s || Block.sounds.stone;
  }
}
