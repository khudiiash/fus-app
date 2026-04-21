/**
 * Apply a FUS player level (1–50) to the minecraft instance. Reconstructed stub after
 * a local-history loss — intentionally conservative: publishes the level on {@code mc.fusLevel}
 * and nudges max health so {@link PlayerEntity#health} can scale with level, without depending
 * on other FUS combat hooks that are no longer present in the tree.
 */

/** @type {number} */
export const FUS_LABY_MIN_LEVEL = 1;
/** @type {number} */
export const FUS_LABY_MAX_LEVEL = 50;

/** Vanilla minecraft health cap (`maxHealth` is stored as HP, not half-hearts). */
const BASE_MAX_HEALTH = 20;

/** Each level above 1 grants +1 HP (half-heart). Level 50 ⇒ 20 + 49 = 69 HP (≈ 34.5 hearts). */
const HP_PER_LEVEL = 1;

/**
 * @param {number} raw
 * @returns {number}
 */
function clampLevel(raw) {
    const n = Math.floor(Number(raw) || FUS_LABY_MIN_LEVEL);
    if (n < FUS_LABY_MIN_LEVEL) return FUS_LABY_MIN_LEVEL;
    if (n > FUS_LABY_MAX_LEVEL) return FUS_LABY_MAX_LEVEL;
    return n;
}

/**
 * @param {number} level
 * @returns {number}
 */
export function fusMaxHealthForLevel(level) {
    return BASE_MAX_HEALTH + (clampLevel(level) - 1) * HP_PER_LEVEL;
}

/**
 * Push a player's FUS level into the minecraft instance. Safe to call any number of times;
 * early-returns on missing arguments so it can run before {@code mc.player} exists.
 *
 * @param {import("../Minecraft.js").default | null | undefined} mc
 * @param {number} level
 * @param {boolean} [showLevelUp=false] — reserved for future toast UX; currently unused.
 */
export function applyFusPlayerLevelToMinecraft(mc, level, showLevelUp = false) {
    if (!mc || typeof mc !== "object") return;
    const lv = clampLevel(level);
    mc.fusLevel = lv;
    mc.fusMaxHealth = fusMaxHealthForLevel(lv);
    const player = mc.player;
    if (player && typeof player === "object") {
        player.fusLevel = lv;
        if (typeof player.maxHealth === "number") {
            const prevMax = player.maxHealth;
            player.maxHealth = mc.fusMaxHealth;
            if (typeof player.health === "number" && prevMax > 0) {
                // Preserve HP ratio so de-levelling doesn't instantly kill the player.
                const ratio = Math.max(0, Math.min(1, player.health / prevMax));
                player.health = Math.min(player.maxHealth, Math.round(player.maxHealth * ratio));
            }
        }
    }
    void showLevelUp;
}
