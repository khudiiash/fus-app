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

/**
 * HP curve (1 heart = 2 HP in the engine, whole hearts only):
 *   • Level  1 ⇒ 3 hearts (6 HP)
 *   • Level 50+ ⇒ 9 hearts (18 HP)
 *   • In between: heart count = floor of linear lerp(3, 9) across levels 1…50, then HP = 2×hearts.
 *   Produces only even max HP: 6, 8, 10, …, 18 — no “half a heart on the max row” at spawn.
 */
const HEARTS_L1 = 3;
const HEARTS_L50 = 9;

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
    const lv = clampLevel(level);
    const t = (lv - FUS_LABY_MIN_LEVEL) / (FUS_LABY_MAX_LEVEL - FUS_LABY_MIN_LEVEL);
    const heartsF = HEARTS_L1 + t * (HEARTS_L50 - HEARTS_L1);
    const wholeHearts = Math.floor(heartsF + 1e-9);
    return Math.max(2, 2 * wholeHearts);
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
        // EntityLiving constructor sets `health = 20.0` but never defines `maxHealth`, so the
        // previous `typeof player.maxHealth === "number"` guard was permanently false on a
        // freshly-spawned player and the level-scaled cap never took effect. Result: the HUD
        // fell back to its default "10 hearts / 20 HP" and users saw empty hearts at every
        // level. Force-assign `maxHealth` here regardless of prior type, then clamp live
        // `health` into the new bound. `prevMax` defaults to the engine's hardcoded 20 so
        // the ratio-preserving clamp behaves sensibly on first bind too.
        const prevMax = typeof player.maxHealth === "number" && player.maxHealth > 0
            ? player.maxHealth
            : 20;
        player.maxHealth = mc.fusMaxHealth;
        if (typeof player.health === "number") {
            const ratio = Math.max(0, Math.min(1, player.health / prevMax));
            /** Whole hearts only: round HP to the nearest 2, clamped to the new cap. */
            const scaled = 2 * Math.round((player.maxHealth * ratio) / 2);
            player.health = Math.min(player.maxHealth, Math.max(0, scaled));
        } else {
            player.health = player.maxHealth;
        }
    }
    /** Stops the damage red-flash (non-damage) when the engine was at 20/20 and we re-clamp
     *  to the level-capped max — see {@code fusResyncHealthFlashBaseline}. */
    if (typeof mc.fusResyncHealthFlashBaseline === "function") {
        try {
            mc.fusResyncHealthFlashBaseline();
        } catch {
            /* ignore */
        }
    }
    void showLevelUp;
}
