/**
 * Mob types: GLB files under {@code labyminecraft/src/resources/models/} (name ends with {@code _mob.glb}).
 * Add matching files to {@code public/labyminecraft/src/resources/models/} for deploy.
 *
 * Optional fields:
 * - {@code dmgHalf}: mob→player damage (half-hearts); omit → world AI default in {@link FusMobSync}.
 * - {@code moveSpeed}: multiplier on leader patrol/chase step (default 1).
 * - {@code nametagY}: label height above feet in world units (default 1.6).
 *   Anchored at chest / shoulder height so the bar stays in frame when the player walks up to
 *   melee range (the previous "above the head" anchor floated off-screen at close distance).
 * - {@code hpScale}: multiplies {@link fusMobMaxHpForLevel} result (default 1).
 * - {@code animClipIndex}: when clip names are empty/wrong, 0-based GLB clip order per role
 *   (e.g. export order attack, idle, walk → {@code { attack: 0, idle: 1, walk: 2 }}).
 * - {@code aggroRadius}: acquire range — mob picks a target within this distance; chase persists until they exceed
 *   {@code 2 * aggroRadius}, then it goes idle/wander (world units); omit → {@link DEFAULT_MOB_AGGRO_R}.
 */
/** Default detection / chase range when a type omits {@code aggroRadius}. */
export const DEFAULT_MOB_AGGRO_R = 10;

/**
 * Each mob has a distinct gameplay identity — varied {@code moveSpeed}, {@code dmgHalf},
 * {@code hpPerLevel}, and {@code aggroRadius} so the world feels populated with creatures that
 * actually *play* differently (not just reskinned HP bags).
 *
 * Rough tiers: swarm (fast, weak) → balanced → tank (slow, high HP/damage).
 */
export const FUS_MOB_TYPES = [
    /**
     * SPIDER — fast skirmisher. Low HP, low damage, quick to close; big aggro radius.
     * The "first mob you'll always encounter" — safe to fight but persistent.
     * {@code modelScale} multiplies auto height fit (≈1.9m); GLB-only scale is overwritten.
     */
    /**
     * Tuning note (2026-04): user feedback "mobs follow too far, too fast, never let me run".
     * Move speeds trimmed ~25 % across the board and aggro radii roughly halved so you can
     * actually break line of sight by walking away. {@link FusMobSync} combines {@code aggroRadius}
     * with a {@code 1.4 × aggroR} drop threshold (was 2×) — once they fall behind, they disengage.
     */
    {
        id: "spider_mob",
        file: "spider_mob.glb",
        displayName: "Павук",
        hpPerLevel: 8,
        modelScale: 0.6,
        nametagY: 1.4,
        dmgHalf: 1,
        moveSpeed: 0.95,
        aggroRadius: 10,
    },
    /** GOLEM — balanced melee. Steady pace, moderate damage. Good rank-and-file mid-world mob. */
    {
        id: "golem_mob",
        file: "golem_mob.glb",
        displayName: "Голем",
        hpPerLevel: 16,
        modelScale: 1,
        dmgHalf: 2,
        aggroRadius: 8,
        nametagY: 2.0,
        moveSpeed: 0.65,
    },
    /** BOAR — short dash + recover. Lower aggro radius, high burst damage. */
    {
        id: "wild_bore_mob",
        file: "wild_bore_mob.glb",
        displayName: "Вепр",
        hpPerLevel: 11,
        modelScale: 0.5,
        moveSpeed: 0.8,
        dmgHalf: 2,
        aggroRadius: 7,
        nametagY: 1.5,
        animClipIndex: { attack: 0, idle: 1, walk: 2 },
    },
    /** MUTANT IRON GOLEM — slow tank, heavy hit. Avoid unless you're geared. */
    {
        id: "mutant_iron_golem_mob",
        file: "mutant_iron_golem_mob.glb",
        displayName: "Залізний голем",
        hpPerLevel: 22,
        modelScale: 1,
        moveSpeed: 0.5,
        dmgHalf: 4,
        aggroRadius: 8,
        animClipIndex: { attack: 5, idle: 2, walk: 6 },
    },
    /** FENMAW — mobile ambusher. Medium HP, fast, mid-range damage. */
    {
        id: "fenmaw_mob",
        file: "fenmaw_mob.glb",
        displayName: "Фенмав",
        hpPerLevel: 14,
        modelScale: 0.7,
        nametagY: 1.8,
        moveSpeed: 0.85,
        dmgHalf: 2,
        aggroRadius: 9,
    },
    /**
     * WARDEN — boss-tier. Rare spawn, huge HP, crippling damage. 3-coin drop chance lives here.
     * Slow step but large aggro radius so you feel hunted on sight.
     */
    {
        id: "gigant_warden_mob",
        file: "gigant_warden_mob.glb",
        displayName: "Варден",
        hpPerLevel: 26,
        modelScale: 1,
        moveSpeed: 0.55,
        dmgHalf: 6,
        aggroRadius: 13,
    },
    /** SCARAD — skittering pest. Very fast, very fragile, swarms in packs. */
    {
        id: "scarad_mob",
        file: "scarab_mob.glb",
        displayName: "Скарад",
        hpPerLevel: 7,
        modelScale: 0.5,
        nametagY: 0.9,
        moveSpeed: 1.0,
        dmgHalf: 1,
        aggroRadius: 8,
    },
    /** STONE GOLEM — tank variant. High HP but less damage than iron golem; grinder-friendly. */
    {
        id: "stone_golem_mob",
        file: "stone_golem.glb",
        displayName: "Кам'яний голем",
        hpPerLevel: 20,
        modelScale: 1,
        moveSpeed: 0.55,
        nametagY: 2.4,
        dmgHalf: 3,
        aggroRadius: 8,
    },
];

/** @param {string} id */
export function fusMobTypeById(id) {
    return FUS_MOB_TYPES.find((t) => t.id === id) || FUS_MOB_TYPES[0];
}

/**
 * @param {import("three").AnimationClip[]|null|undefined} clips
 * @param {"idle"|"walk"|"attack"} role
 * @param {object} type from {@link FUS_MOB_TYPES}
 */
export function fusMobAnimClip(clips, role, type) {
    if (!clips || clips.length === 0) {
        return null;
    }
    const ix = type && type.animClipIndex;
    const idx =
        ix && typeof ix[role] === "number" && Number.isFinite(ix[role]) ? ix[role] | 0 : null;
    if (idx != null && idx >= 0 && idx < clips.length) {
        return clips[idx];
    }
    const patterns =
        role === "idle"
            ? ["idle", "stand", "breath", "wait"]
            : role === "walk"
              ? ["walk", "run", "move", "jog"]
              : ["attack", "punch", "slash", "hit", "swing", "strike"];
    for (let p = 0; p < patterns.length; p++) {
        const sub = patterns[p].toLowerCase();
        for (let i = 0; i < clips.length; i++) {
            if (clips[i].name && String(clips[i].name).toLowerCase().includes(sub)) {
                return clips[i];
            }
        }
    }
    if (clips.length >= 3) {
        if (role === "attack") {
            return clips[0];
        }
        if (role === "idle") {
            return clips[1];
        }
        if (role === "walk") {
            return clips[2];
        }
    }
    if (clips.length === 2) {
        return role === "attack" ? clips[0] : clips[1];
    }
    return clips[0];
}

/**
 * @param {string} typeId
 */
export function fusMobMoveStepMul(typeId) {
    const t = fusMobTypeById(typeId);
    const m = t.moveSpeed;
    return typeof m === "number" && Number.isFinite(m) && m > 0 ? m : 1;
}

/**
 * Nametag Y offset above entity feet (world units).
 * @param {string} typeId
 */
export function fusMobNametagY(typeId) {
    const t = fusMobTypeById(typeId);
    const y = t.nametagY;
    return typeof y === "number" && Number.isFinite(y) ? y : 2.4;
}

/**
 * Attention / aggro range (world units) for leader AI — spot and path toward players within this radius.
 *
 * Returns the registry value verbatim (clamped only to sane bounds: 3..96). The previous
 * floor of 24 silently overrode every per-type setting (e.g. spider's intended 10) so mobs
 * spotted players from ~half the visible map. Trust what the registry says.
 *
 * @param {string} typeId
 */
export function fusMobAggroRadius(typeId) {
    const t = fusMobTypeById(typeId);
    const r = t.aggroRadius;
    if (typeof r === "number" && Number.isFinite(r) && r > 0) {
        return Math.min(96, Math.max(3, r));
    }
    return Math.min(96, Math.max(3, DEFAULT_MOB_AGGRO_R));
}

/**
 * Mob → player damage (half-hearts) for a given level.
 *
 * Scales the type's base {@code dmgHalf} by mob level so a level-10 mob hits roughly twice
 * as hard as a level-1 mob of the same type. Formula: {@code dmg * (1 + (lv - 1) * 0.18)}
 * — a 10-level gap is ~2.6×, a 5-level gap is ~1.7×. Rounded to the nearest half-heart and
 * clamped to {@code [1, 120]} so tiny mobs still register and bosses can't one-shot.
 *
 * @param {string} typeId
 * @param {number} level
 * @param {number} defaultHalf used when the type omits {@code dmgHalf}
 */
export function fusMobDmgHalfForLevel(typeId, level, defaultHalf) {
    const t = fusMobTypeById(typeId);
    const baseRaw =
        typeof t.dmgHalf === "number" && Number.isFinite(t.dmgHalf) ? t.dmgHalf : defaultHalf;
    const base = Math.max(0, Number(baseRaw) || 0);
    const lv = Math.max(1, Math.min(60, Math.floor(Number(level)) || 1));
    const scaled = Math.round(base * (1 + (lv - 1) * 0.18));
    return Math.max(1, Math.min(120, scaled));
}

/**
 * Back-compat wrapper — flat per-type damage with no level scaling. Prefer
 * {@link fusMobDmgHalfForLevel} for new call sites.
 *
 * @param {string} typeId
 * @param {number} defaultHalf
 */
export function fusMobDmgHalfOrDefault(typeId, defaultHalf) {
    const t = fusMobTypeById(typeId);
    if (typeof t.dmgHalf === "number" && Number.isFinite(t.dmgHalf)) {
        return Math.max(0, Math.min(120, Math.round(t.dmgHalf)));
    }
    return defaultHalf;
}

/**
 * Max HP for a mob of {@code level}.
 *
 * Earlier formula was a flat {@code hpPerLevel * level} which meant a level-10 spider had
 * 10× the HP of a level-1 spider — every HP-scaling encounter became a 30-second slog.
 * Switched to a gentler {@code hpPerLevel * (1 + (lv - 1) * 0.35)} curve: lv 1 = base,
 * lv 5 ≈ 2.4×, lv 10 ≈ 4.15×. Combined with {@link fusMobDmgHalfForLevel} scaling, higher
 * levels stay meaningfully harder without trading purely on bullet-sponge HP.
 *
 * @param {number} level
 * @param {{ hpPerLevel: number, hpScale?: number }} type
 */
export function fusMobMaxHpForLevel(level, type) {
    const lv = Math.max(1, Math.min(60, Math.floor(level) || 1));
    let hp = Math.max(8, Math.round(type.hpPerLevel * (1 + (lv - 1) * 0.35)));
    if (typeof type.hpScale === "number" && Number.isFinite(type.hpScale) && type.hpScale > 0) {
        hp = Math.max(1, Math.round(hp * type.hpScale));
    }
    return hp;
}
