/**
 * Camera Y is “eye” height; feet sit this far below (matches presence / remote avatar math).
 */
export const PLAYER_EYE_HEIGHT = 1.62

/** 10 hearts × 2 half-hearts (Minecraft-style HUD). */
export const BLOCK_WORLD_MAX_HP_HALF_UNITS = 20

/** Survival-like reach for mine / build / melee (blocks). */
export const BLOCK_WORLD_MAX_REACH = 4.5
/** One full heart removed per pickaxe hit on a player. */
export const BLOCK_WORLD_PICKAXE_PVP_DAMAGE_HALF = 2

/** Mining damage per swing with empty hand (slow breaking). */
export const FIST_MINE_DAMAGE_PER_SWING = 0.32
/** Mining with a block selected (almost useless, Minecraft-like). */
export const MINING_DAMAGE_HOLDING_BLOCK = 0.14
