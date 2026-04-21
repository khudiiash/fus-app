import {
    get,
    onChildAdded,
    onChildChanged,
    onChildRemoved,
    onValue,
    push,
    ref,
    remove,
    set,
    update,
    serverTimestamp,
} from "firebase/database";
import { auth, rtdb } from "@/firebase/config";
import FusMobEntity from "./FusMobEntity.js";
import {
    FUS_MOB_TYPES,
    fusMobAggroRadius,
    fusMobDmgHalfForLevel,
    fusMobMaxHpForLevel,
    fusMobMoveStepMul,
    fusMobNametagY,
    fusMobTypeById,
} from "./FusMobRegistry.js";
import { fusMobFindStrictPlateauFeet, fusMobTryStepXZ } from "./fusMobWorld.js";
import { rollMobKillLoot } from "./fusMobLootRoll.js";
import { fusMobKillXpReward } from "./fusMobKillXp.js";
import { fusPushMobLootDrop } from "./FusLabyLootDrops.js";

const MOB_ROOT = "worldMobs";
const MOB_PLAYER_HITS = "worldMobPlayerHits";
const MOB_HITS = "worldMobHits";
const PRESENCE_ROOT = "worldPresence";

/**
 * Horizontal melee reach (world units). Was 2.85 — felt like mobs hit from far because the hit test
 * also adds +0.4 margin (see {@link MOB_ATTACK_HIT_PAD}), and the client mob is always ~1 AI-tick behind
 * its authoritative pose. Reach of 1.9 ≈ 2 blocks + a small margin reads as "contact".
 */
const ATTACK_R = 1.9;
/** Slack added to {@link ATTACK_R} during the {@code push()} hit test (player may have dodged slightly). */
const MOB_ATTACK_HIT_PAD = 0.4;
/** Vertical tolerance for melee — mobs shouldn't magically hit you 3 blocks overhead. */
const ATTACK_Y_RANGE = 1.8;
/** World units per AI step — large enough to clear 1-block lips when combined with {@link fusMobTryStepXZ} slides. */
const PATROL_STEP = 0.34;
/**
 * Max chase distance per AI tick (blocks). A mob in chase should keep up with a walking player
 * (~4.3 b/s × 0.22 s = ~0.95 blocks). The full distance is split into {@link CHASE_SUBSTEPS} small
 * {@link fusMobTryStepXZ} hops so collision stays accurate over longer strides.
 */
const CHASE_STEP_DISTANCE = 0.95;
/** Sub-step count for chase motion — 3 × ~0.32 blocks gives slide/nudge a chance at each hop. */
const CHASE_SUBSTEPS = 3;
/** Leader AI tick (ms). Larger = fewer RTDB writes and less {@code onValue} churn for all clients. */
const MOB_AI_MS = 220;
/** Low-tier devices: fewer AI passes + fewer {@code update()} writes to RTDB. */
const MOB_AI_MS_LOW_TIER = 320;
/**
 * Strained-mobile leader (iOS Safari, low-core Android): halve the AI write rate again.
 * Each tick walks every mob and issues RTDB updates — at 320 ms this was ~3 Hz of RTDB
 * writes per mob, and `onChildChanged` on every peer fired at the same rate. User report:
 * iPhone at 5 fps, main thread pinned. 500 ms cuts that in half.
 */
const MOB_AI_MS_STRAINED = 500;
const MOB_ATTACK_COOLDOWN_MS = 900;
/** Keep {@code anim: "attack"} this long (ms) — matches client attack clip length roughly. */
const MOB_ATTACK_HOLD_MS = 380;
/** Apply damage / push mob hit this many ms after swing starts (end of strike, not start). */
const MOB_ATTACK_HIT_DELAY_MS = 300;
/**
 * Entity interpolation window for RTDB pose updates (engine ticks). Matches AI period so the
 * visual mob catches up to its authoritative position before the next write arrives. Was 14
 * (700 ms) — that was the primary cause of "mob attacks from across the room" because the AI
 * had already moved the mob into range while the visual was still 500 ms behind.
 */
const POSE_INCREMENTS_ACTIVE = 5;
/** Longer smoothing when the mob is idle (no one near) — avoids jitter on tiny pose drift. */
const POSE_INCREMENTS_IDLE = 10;
/** Half-hearts dealt to players per hit (MC-style 20 = full bar). Lower = gentler. */
const MOB_DMG_HALF = 2;
/**
 * Shared Laby world origin (XZ). Used as the "difficulty origin" — mobs scale up with distance
 * from the hub even though the dynamic spawner places them around *players*, not around the hub.
 */
const LABY_MOB_RING_CX = 75;
const LABY_MOB_RING_CZ = -72;
/**
 * Increment to force a one-time wipe of the legacy static seed. Value ≥ 12 means the leader
 * drops every preexisting `m_*` row (instead of reseeding) and the dynamic spawner takes over.
 */
const MOB_SEED_VERSION = 12;

/**
 * Dynamic-spawning tuning. The leader runs {@link FusMobSync#_spawnTickForPlayers} once per AI
 * tick to keep an active swarm around every player in the world — spawn in when a fresh zone
 * is entered, despawn when no one is nearby for a while. This replaces the old 60-mob static
 * seed anchored to the hub.
 */
const MOB_TARGET_PER_PLAYER = 4;
/**
 * Strained mobile (iOS Safari, low-core Android) cannot afford the full per-player mob budget —
 * every active mob is a skinned mesh + {@link THREE.AnimationMixer} + nametag canvas + AI state.
 * User report: iPhone at 5 fps (couldn't even open settings). Cutting to 2 cleared the main
 * thread enough for the chrome to respond again.
 */
const MOB_TARGET_PER_PLAYER_STRAINED = 2;
const MOB_SPAWN_RING_MIN = 20;
const MOB_SPAWN_RING_MAX = 46;
const MOB_SPAWN_COUNT_RADIUS = 60;
const MOB_SPAWN_COUNT_R2 = MOB_SPAWN_COUNT_RADIUS * MOB_SPAWN_COUNT_RADIUS;
/**
 * Minimum horizontal spacing between any two spawned mobs (blocks). User: "mobs are grouping in
 * 5–7 and following the player". Enforcing spacing at spawn time means aggro stacks only happen
 * when the player walks into multiple independent radii, not at the spawn point.
 */
const MOB_MIN_SPACING = 11;
const MOB_MIN_SPACING_SQ = MOB_MIN_SPACING * MOB_MIN_SPACING;
/** After this long with no player within {@link MOB_AI_ACTIVE_RADIUS}, leader removes the mob. */
const MOB_DESPAWN_ABANDONED_MS = 45_000;
/** Global hard cap — prevents a "visited 20 areas" session from leaving 200 stale mob rows. */
const MOB_TOTAL_CAP = 40;
/** At most this many spawn writes per spawn pass (keeps RTDB write rate bounded). */
const SPAWN_PER_TICK_CAP = 2;
/**
 * Throttle: run the dynamic spawn/despawn pass at most once every this many ms. The AI tick runs
 * every 220–320 ms, but the strict plateau search is the most expensive thing on the leader
 * (ring scan + per-cell {@link fusGroundY}), so we only do it a few times per second. Also gated
 * by {@link Minecraft#_fusTerrainBootUntil} so we don't fight chunk uploads during boot.
 *
 * Performance ticket: user reported 3–6 fps on both Android and iOS after we moved to dynamic
 * spawning. Leader was spending ~60 ms per AI tick in the plateau search.
 */
const SPAWN_TICK_INTERVAL_MS = 1500;

/** Leader skips heavy mob AI when no player is within this distance (blocks). Must cover seeded patrol spread (~±92). */
const MOB_AI_ACTIVE_RADIUS = 240;

/** Acquire targets by horizontal distance; ignore huge vertical separation for “see player” (still limited). */
const AGGRO_MAX_VERTICAL = 24;

/**
 * Local-only entity LOD: no {@link FusMobEntity} (no GLTF / mixer / world tick) until the player is near.
 * Uses view distance (chunks) + hysteresis so we do not thrash at the boundary.
 */
const MOB_ENTITY_LOD_ACTIVATE_EXTRA = 38;
const MOB_ENTITY_LOD_DEACTIVATE_EXTRA = 78;

/**
 * @param {string} mobKey
 */
function stableMobEntityId(mobKey) {
    let h = 0;
    for (let i = 0; i < mobKey.length; i++) {
        h = (Math.imul(31, h) + mobKey.charCodeAt(i)) | 0;
    }
    return 1000000000 + (Math.abs(h) % 1000000000);
}

/**
 * Degrees yaw so (mx,mz) faces (tx,tz) in XZ (Minecraft-style).
 * @param {number} mx
 * @param {number} mz
 * @param {number} tx
 * @param {number} tz
 */
function fusMobYawDegFace(mx, mz, tx, tz) {
    return (Math.atan2(tx - mx, tz - mz) * 180) / Math.PI;
}

/**
 * True if RTDB row already matches the AI-computed pose (skip redundant {@code update()} — every write
 * re-fires {@code onValue} for the whole instances tree on all clients).
 * @param {object} row
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} ry
 * @param {'idle'|'walk'|'attack'} anim
 * @param {boolean} moving
 * @param {boolean} facePlayer
 */
function mobAiRowMatches(row, x, y, z, ry, anim, moving, facePlayer) {
    if (!row || typeof row !== "object") {
        return false;
    }
    const rx = Number(row.x);
    const ry0 = Number(row.y);
    const rz = Number(row.z);
    const rry = Number(row.ry);
    if (![rx, ry0, rz].every((n) => Number.isFinite(n))) {
        return false;
    }
    const px = 0.055;
    const py = 0.12;
    const pRy = 6;
    const ra = row.anim === "attack" || row.anim === "walk" ? row.anim : "idle";
    const rm = row.moving === true;
    const rf = row.facePlayer === true;
    return (
        Math.abs(rx - x) < px &&
        Math.abs(ry0 - y) < py &&
        Math.abs(rz - z) < px &&
        Number.isFinite(rry) &&
        Math.abs(rry - ry) < pRy &&
        ra === anim &&
        rm === moving &&
        rf === facePlayer
    );
}

/** Half-width / height for leader step collision vs {@link FusMobEntity} bounds. */
const MOB_CAP_HALF = 0.35;
const MOB_CAP_H = 1.85;

export default class FusMobSync {

    /**
     * @param {import("../Minecraft.js").default} minecraft
     * @param {string} worldId
     * @param {string} uid
     * @param {import("./FusRemotePresence.js").default | null} presence
     */
    constructor(minecraft, worldId, uid, presence) {
        this.minecraft = minecraft;
        this.worldId = worldId;
        this.uid = uid;
        this.presence = presence;
        /** @type {Map<string, FusMobEntity>} */
        this._ents = new Map();
        /** Per-mob hysteresis for {@link #_shouldMobEntityBeActive} (spawn vs despawn band). */
        /** @type {Map<string, boolean>} */
        this._mobLodState = new Map();
        /** @type {Record<string, unknown> | null} */
        this._instances = null;
        this._leader = false;
        /** Cached presence snapshot for stale-leader detection. */
        this._presenceVal = null;
        /** @type {import("firebase/database").Unsubscribe | null} */
        this._unsubMobAdd = null;
        /** @type {import("firebase/database").Unsubscribe | null} */
        this._unsubMobChg = null;
        /** @type {import("firebase/database").Unsubscribe | null} */
        this._unsubMobRm = null;
        /** @type {import("firebase/database").Unsubscribe | null} */
        this._unsubPresence = null;
        /** @type {import("firebase/database").Unsubscribe | null} */
        this._unsubHits = null;
        /** @type {ReturnType<typeof setTimeout> | null} */
        this._aiTo = null;
        /** @type {ReturnType<typeof setInterval> | null} legacy unused (kept for destroy() compat on older builds). */
        this._aiIv = null;
        /** Re-check mob spawn/despawn when the player moves (RTDB may not tick if mobs are idle). */
        /** @type {ReturnType<typeof setInterval> | null} */
        this._lodIv = null;
        /** @type {Map<string, number>} */
        this._mobAttackMs = new Map();
        /** @type {Map<string, number>} */
        this._mobAttackHoldUntil = new Map();
        /** @type {Map<string, { tx: number, tz: number, until: number }>} */
        this._wander = new Map();
        /** Leader-only: mob melee hit pushed at {@link MOB_ATTACK_HIT_DELAY_MS}, not at swing start. */
        /** @type {Map<string, { fireAt: number, toUid: string, typeId: string, level: number }>} */
        this._pendingMobHit = new Map();
        /** Leader-only: locked player uid while chasing — dropped when they exceed {@code 2 * aggroRadius}. */
        /** @type {Map<string, string>} */
        this._mobChaseUid = new Map();
        this._seedDone = false;
        /** Log RTDB permission errors once (avoid console spam until rules are deployed). */
        this._seedPermWarned = false;
    }

    /**
     * @param {import("../Minecraft.js").default} minecraft
     * @param {string} worldId
     * @param {string} uid
     * @param {import("./FusRemotePresence.js").default | null} presence
     */
    static attach(minecraft, worldId, uid, presence) {
        if (!rtdb || !worldId || !uid) {
            return null;
        }
        const s = new FusMobSync(minecraft, worldId, uid, presence);
        s.start();
        return s;
    }

    start() {
        const mc = this.minecraft;
        mc.fusMobSyncRef = this;

        /** Preallocate the instances map early so seed/AI paths have a stable reference. */
        this._instances = Object.create(null);
        /** @type {Map<string, number>} last observed row-change wall clock (ms) for stale-leader detection. */
        this._lastRowChangeMs = new Map();
        /** Seed LOD sync on player-move in addition to RTDB-driven sync (prevents starved entities on idle mobs). */
        this._lastPlayerSyncX = NaN;
        this._lastPlayerSyncZ = NaN;
        this._syncPending = false;
        this._lastFullSyncMs = 0;

        const presRef = ref(rtdb, `${PRESENCE_ROOT}/${this.worldId}`);
        this._recomputeLeader(null);
        this._unsubPresence = onValue(presRef, (snap) => {
            const val = snap.exists() ? snap.val() : null;
            this._presenceVal = val;
            this._recomputeLeader(val);
        });

        /**
         * Per-child listeners instead of {@code onValue} on the whole instances tree. With 49+ mobs
         * and 5–10 writes/sec from the leader, {@code onValue} forced every client to re-decode the
         * whole tree on every pose update — a major mobile CPU sink. {@link onChildChanged} fires
         * only for the changed key and we patch-merge into {@link _instances}.
         */
        const instRef = ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances`);
        this._unsubMobAdd = onChildAdded(instRef, (snap) => {
            const k = snap.key;
            const v = snap.val();
            if (!k) {
                return;
            }
            this._instances[k] = v;
            this._lastRowChangeMs.set(k, Date.now());
            this._requestEntitySync();
        });
        this._unsubMobChg = onChildChanged(instRef, (snap) => {
            const k = snap.key;
            const v = snap.val();
            if (!k) {
                return;
            }
            this._instances[k] = v;
            this._lastRowChangeMs.set(k, Date.now());
            this._requestEntitySync();
        });
        this._unsubMobRm = onChildRemoved(instRef, (snap) => {
            const k = snap.key;
            if (!k) {
                return;
            }
            delete this._instances[k];
            this._lastRowChangeMs.delete(k);
            const ent = this._ents.get(k);
            if (ent) {
                try {
                    ent.renderer?.fusDispose?.();
                } catch (_) {
                    /* ignore */
                }
                if (this.minecraft.world) {
                    this.minecraft.world.removeEntityById(ent.id);
                }
                this._ents.delete(k);
            }
            this._mobLodState.delete(k);
            this._requestEntitySync();
        });

        const hitsInRef = ref(rtdb, `${MOB_PLAYER_HITS}/${this.worldId}`);
        this._unsubHits = onChildAdded(hitsInRef, (snap) => {
            void this._onPlayerHitRow(snap);
        });

        void this._maybeSeed();

        /**
         * Self-scheduling {@code setTimeout} so we can adapt tick rate per-frame (e.g. when paused
         * or when no players are nearby). A plain {@code setInterval} keeps queuing up even when the
         * tab is background-throttled which led to burst updates on resume.
         */
        this._aiStopped = false;
        this._scheduleNextAi();

        const lodMs =
            typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__ ? 260 : 150;
        this._lodIv = setInterval(() => {
            if (this.minecraft.isInGame() && this.minecraft.world) {
                this._maybePlayerMovedSync();
            }
        }, lodMs);
    }

    _scheduleNextAi() {
        if (this._aiStopped) {
            return;
        }
        const mc = this.minecraft;
        /** Strained mobile (iOS + low-core Android) uses the slowest tick to free the main thread. */
        const base = mc.fusIosSafari
            ? MOB_AI_MS_STRAINED
            : mc.fusLowTierMobile
                ? MOB_AI_MS_LOW_TIER
                : MOB_AI_MS;
        /** Back off when the local player is not in-game (login screen, paused) — spares CPU + RTDB writes. */
        const active = mc.isInGame && mc.isInGame();
        const ms = active ? base : 800;
        this._aiTo = setTimeout(() => {
            try {
                this._tickAi();
            } catch (e) {
                console.warn("[FUS] mob ai tick", e);
            }
            this._scheduleNextAi();
        }, ms);
    }

    /** Coalesce entity LOD sync to at most once per ~80ms even if many rows change simultaneously. */
    _requestEntitySync() {
        if (this._syncPending) {
            return;
        }
        this._syncPending = true;
        const run = () => {
            this._syncPending = false;
            this._lastFullSyncMs = Date.now();
            if (this.minecraft.isInGame() && this.minecraft.world) {
                this._syncEntitiesFromInstances();
            }
        };
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
            window.requestAnimationFrame(run);
        } else {
            setTimeout(run, 16);
        }
    }

    /** Re-evaluate LOD when the player actually moved >= 3 blocks (RTDB listeners cover mob-side changes). */
    _maybePlayerMovedSync() {
        const pl = this.minecraft.player;
        if (!pl) {
            return;
        }
        const px = pl.x;
        const pz = pl.z;
        if (!Number.isFinite(this._lastPlayerSyncX)) {
            this._lastPlayerSyncX = px;
            this._lastPlayerSyncZ = pz;
            this._requestEntitySync();
            return;
        }
        const dx = px - this._lastPlayerSyncX;
        const dz = pz - this._lastPlayerSyncZ;
        if (dx * dx + dz * dz >= 9) {
            this._lastPlayerSyncX = px;
            this._lastPlayerSyncZ = pz;
            this._requestEntitySync();
        }
    }

    /**
     * @param {Record<string, unknown> | null} presenceVal
     */
    _recomputeLeader(presenceVal) {
        const STALE_MS = 45000;
        const now = Date.now();
        /** @type {string[]} */
        const uids = [this.uid];
        if (presenceVal && typeof presenceVal === "object") {
            for (const k of Object.keys(presenceVal)) {
                if (k === this.uid) {
                    continue;
                }
                const row = presenceVal[k];
                if (!row || typeof row !== "object" || row.left === true || row.dead === true) {
                    continue;
                }
                const lm = Number(row.labyClientMs);
                if (Number.isFinite(lm) && now - lm > STALE_MS) {
                    continue;
                }
                uids.push(k);
            }
        }
        uids.sort();
        this._leader = uids[0] === this.uid;
        /** @type {string[]} Sorted uid array — used by {@link #_isEffectiveLeader} for stale takeover fallback. */
        this._sortedLeaderUids = uids;
        void this._maybeSeed();
    }

    /**
     * Effective (nominal OR takeover) leader check. If the primary leader has not produced any
     * RTDB row changes for {@link STALE_LEADER_TAKEOVER_MS}, this client becomes the acting leader
     * iff it is next in uid order. Guards against background-throttled mobile tabs freezing AI for
     * the whole world — the primary symptom the user reported ("mobs stand still, don't react").
     */
    _isEffectiveLeader() {
        if (this._leader) {
            return true;
        }
        const uids = this._sortedLeaderUids;
        if (!uids || uids.length === 0) {
            return false;
        }
        const now = Date.now();
        let mostRecent = 0;
        for (const ts of this._lastRowChangeMs.values()) {
            if (ts > mostRecent) {
                mostRecent = ts;
            }
        }
        if (mostRecent === 0) {
            /** No history yet — only the nominal leader gets to seed. */
            return false;
        }
        const STALE_LEADER_TAKEOVER_MS = 6000;
        if (now - mostRecent < STALE_LEADER_TAKEOVER_MS) {
            return false;
        }
        /** Second-in-line takes over. Prevents all clients trampling each other. */
        return uids[1] === this.uid;
    }

    /**
     * One-time migration: wipe the legacy static seed so the dynamic spawner starts clean. Once
     * `mobSeedVersion` on RTDB equals {@link MOB_SEED_VERSION}, subsequent calls are no-ops.
     * The spawner itself (see {@link #_spawnTickForPlayers}) creates mobs around players.
     */
    async _maybeSeed() {
        if (!this._leader) {
            return;
        }
        if (this._seedDone) {
            return;
        }
        const w = this.minecraft.world;
        if (!w) {
            return;
        }
        const instRef = ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances`);
        const verRef = ref(rtdb, `${MOB_ROOT}/${this.worldId}/mobSeedVersion`);
        try {
            const verSnap = await get(verRef);
            const ver = verSnap.exists() ? Number(verSnap.val()) : 0;
            if (ver === MOB_SEED_VERSION) {
                this._seedDone = true;
                return;
            }
            /** Fresh start: clear the old "60 mobs around the hub" static seed. */
            await set(instRef, null);
            await set(verRef, MOB_SEED_VERSION);
            this._seedDone = true;
            console.info(`[FUS] mob seed: cleared legacy rows (seedV=${MOB_SEED_VERSION}) — dynamic spawner active`);
        } catch (e) {
            if (!this._seedPermWarned) {
                this._seedPermWarned = true;
                console.warn(
                    "[FUS] mob seed: RTDB permission denied — deploy database.rules.json (worldMobs) or sign in. Further errors suppressed.",
                    e,
                );
            }
        }
    }

    /**
     * Pick a mob typeId + level appropriate for a spawn position relative to the hub. Farther
     * from the hub = harder tiers / higher levels, matching the progression players expect.
     *
     * @param {number} distFromHub blocks
     * @returns {{ typeId: string, level: number } | null}
     */
    _rollMobForDistance(distFromHub) {
        /** @type {string[]} */
        let pool;
        let levelMin;
        let levelMax;
        if (distFromHub < 40) {
            pool = ["spider_mob", "scarad_mob"];
            levelMin = 1;
            levelMax = 4;
        } else if (distFromHub < 90) {
            pool = ["fenmaw_mob", "golem_mob", "wild_bore_mob"];
            levelMin = 3;
            levelMax = 8;
        } else if (distFromHub < 160) {
            pool = ["fenmaw_mob", "golem_mob", "stone_golem_mob", "wild_bore_mob", "mutant_iron_golem_mob"];
            levelMin = 6;
            levelMax = 12;
        } else {
            pool = ["stone_golem_mob", "mutant_iron_golem_mob", "gigant_warden_mob"];
            levelMin = 10;
            levelMax = 16;
        }
        /** Guard: at least one member of the pool must exist in the registry. */
        const valid = pool.filter((id) => FUS_MOB_TYPES.some((t) => t.id === id));
        if (valid.length === 0) {
            return null;
        }
        const typeId = valid[Math.floor(Math.random() * valid.length)];
        const level = levelMin + Math.floor(Math.random() * (levelMax - levelMin + 1));
        return { typeId, level };
    }

    /**
     * Leader-side dynamic spawn/despawn pass. Called from {@link #_tickAi}, but internally
     * throttled to {@link SPAWN_TICK_INTERVAL_MS} and skipped while terrain is still booting.
     * Both gates matter for mobile FPS — a ring-scan plateau check is the single most expensive
     * thing the leader does, and doing it every AI tick tanks low-tier Android / iOS to sub-10 fps.
     */
    _spawnTickForPlayers() {
        if (!this._leader || !this._seedDone) {
            return;
        }
        const w = this.minecraft.world;
        if (!w) {
            return;
        }
        /**
         * Gate: during {@code _fusTerrainBootUntil} chunks are still being meshed and uploaded.
         * Spawning now just burns CPU on unloaded columns (returns {@code null}) and competes
         * with the far more important chunk rebuilds. Users report "blocks jumping around" on
         * boot — that's the chunk queue starving because we were fighting it.
         */
        const now0 = typeof performance !== "undefined" ? performance.now() : Date.now();
        const bootUntil = Number(this.minecraft._fusTerrainBootUntil);
        if (Number.isFinite(bootUntil) && now0 < bootUntil) {
            return;
        }
        /** Throttle: the AI tick runs ~4 Hz; we only spawn ~0.67 Hz. */
        const last = Number(this._lastSpawnTickAt) || 0;
        if (now0 - last < SPAWN_TICK_INTERVAL_MS) {
            return;
        }
        this._lastSpawnTickAt = now0;
        const targets = this._allPlayerTargets();
        if (targets.length === 0) {
            return;
        }
        const keys = Object.keys(this._instances);
        /** Drop dead rows fully — no respawn-in-place; the spawner will fill the void naturally. */
        const aliveKeys = [];
        for (let i = 0; i < keys.length; i++) {
            const r = this._instances[keys[i]];
            if (r && typeof r === "object" && r.dead !== true) {
                aliveKeys.push(keys[i]);
            }
        }

        /** Count alive mobs within the spawn-assessment ring of each player. */
        /** @type {number[]} */
        const nearbyCount = new Array(targets.length).fill(0);
        for (let i = 0; i < aliveKeys.length; i++) {
            const r = this._instances[aliveKeys[i]];
            const mx = Number(r.x);
            const mz = Number(r.z);
            if (![mx, mz].every((n) => Number.isFinite(n))) continue;
            for (let p = 0; p < targets.length; p++) {
                const dx = targets[p].x - mx;
                const dz = targets[p].z - mz;
                if (dx * dx + dz * dz <= MOB_SPAWN_COUNT_R2) {
                    nearbyCount[p]++;
                }
            }
        }

        /**
         * Spawn top-up: iterate players by "most starved first" so everyone gets attention even
         * when the spawn budget is tight. Skip spawning entirely when we're at the global cap.
         *
         * Strained mobile leader: use a lower per-player target so the local client isn't
         * rendering the full pack. The leader status moves with whoever has the lowest-load
         * device, so this effectively becomes the global spawn density.
         */
        const targetPerPlayer = this.minecraft.fusIosSafari
            ? MOB_TARGET_PER_PLAYER_STRAINED
            : MOB_TARGET_PER_PLAYER;
        const order = targets.map((_, i) => i).sort((a, b) => nearbyCount[a] - nearbyCount[b]);
        let spawnsThisTick = 0;
        const totalAlive = aliveKeys.length;
        for (let oi = 0; oi < order.length && spawnsThisTick < SPAWN_PER_TICK_CAP; oi++) {
            const p = targets[order[oi]];
            const need = targetPerPlayer - nearbyCount[order[oi]];
            if (need <= 0) continue;
            if (totalAlive + spawnsThisTick >= MOB_TOTAL_CAP) break;
            /**
             * Two attempts per starved player per call is plenty — spawner runs every
             * {@link SPAWN_TICK_INTERVAL_MS} so a missed frame just delays the spawn to the next
             * pass (≤1.5 s). Previously we did four attempts, multiplied by ring-20 plateau
             * scans, which was the dominant leader cost.
             */
            for (let attempt = 0; attempt < 2 && spawnsThisTick < SPAWN_PER_TICK_CAP; attempt++) {
                const ang = Math.random() * Math.PI * 2;
                const r = MOB_SPAWN_RING_MIN + Math.random() * (MOB_SPAWN_RING_MAX - MOB_SPAWN_RING_MIN);
                const cx = Math.round(p.x + Math.cos(ang) * r);
                const cz = Math.round(p.z + Math.sin(ang) * r);
                const bx = cx | 0;
                const bz = cz | 0;
                if (!w.chunkExists(bx >> 4, bz >> 4)) continue;
                /**
                 * Sanity check: column must have a non-default heightmap value. A freshly-loaded
                 * chunk whose meshes haven't settled yet returns low/default heights and sending
                 * mobs there plants them underground (user: "only name and HP line visible").
                 */
                const colTop = typeof w.getHeightAt === "function" ? (w.getHeightAt(bx, bz) | 0) : 0;
                if (colTop < 6) continue;
                const pos = fusMobFindStrictPlateauFeet(w, cx, cz, MOB_CAP_HALF, MOB_CAP_H);
                if (!pos) continue;
                /**
                 * Spread-out: reject the candidate if another alive mob already sits within
                 * {@link MOB_MIN_SPACING} blocks horizontally. User report: "mobs group in 5–7 and
                 * follow the player". Enforcing spacing at spawn time means swarm-on-player only
                 * happens if the player walks into several independent aggro radii, not because
                 * they all share a tile.
                 */
                let tooClose = false;
                for (let k = 0; k < aliveKeys.length; k++) {
                    const other = this._instances[aliveKeys[k]];
                    if (!other) continue;
                    const odx = Number(other.x) - pos.x;
                    const odz = Number(other.z) - pos.z;
                    if (odx * odx + odz * odz < MOB_MIN_SPACING_SQ) {
                        tooClose = true;
                        break;
                    }
                }
                if (tooClose) continue;
                const dHub = Math.hypot(pos.x - LABY_MOB_RING_CX, pos.z - LABY_MOB_RING_CZ);
                const roll = this._rollMobForDistance(dHub);
                if (!roll) continue;
                const type = fusMobTypeById(roll.typeId);
                const maxHp = fusMobMaxHpForLevel(roll.level, type);
                const mobKey = `m_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
                const row = {
                    typeId: roll.typeId,
                    level: roll.level,
                    x: pos.x,
                    y: pos.y,
                    z: pos.z,
                    ry: Math.random() * 360,
                    hp: maxHp,
                    maxHp,
                    dead: false,
                    anim: "idle",
                    moving: false,
                    patrolAx: pos.x,
                    patrolAz: pos.z,
                    facePlayer: false,
                    spawnedAt: Date.now(),
                    lastSeenAt: Date.now(),
                    updatedAt: serverTimestamp(),
                };
                /** Optimistically add to local cache so subsequent count in same tick includes it. */
                this._instances[mobKey] = row;
                void set(ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances/${mobKey}`), row).catch((e) =>
                    console.warn("[FUS] dynamic mob spawn", e),
                );
                spawnsThisTick++;
                break;
            }
        }

        /**
         * Abandonment sweep: any alive mob that hasn't had a player within {@link MOB_AI_ACTIVE_RADIUS}
         * for {@link MOB_DESPAWN_ABANDONED_MS} gets removed. {@code lastSeenAt} is refreshed whenever
         * a player IS nearby (below). Note: we cap despawns per tick too so we don't churn RTDB.
         */
        const now = Date.now();
        let despawns = 0;
        const DESPAWN_PER_TICK_CAP = 3;
        const aiR2 = MOB_AI_ACTIVE_RADIUS * MOB_AI_ACTIVE_RADIUS;
        for (let i = 0; i < aliveKeys.length && despawns < DESPAWN_PER_TICK_CAP; i++) {
            const key = aliveKeys[i];
            const row = this._instances[key];
            if (!row) continue;
            const mx = Number(row.x);
            const mz = Number(row.z);
            let nearPlayer = false;
            for (let p = 0; p < targets.length; p++) {
                const dx = targets[p].x - mx;
                const dz = targets[p].z - mz;
                if (dx * dx + dz * dz <= aiR2) {
                    nearPlayer = true;
                    break;
                }
            }
            if (nearPlayer) {
                /** Refresh presence stamp — cheap RTDB update, only every 30s to avoid spam. */
                const lastSeen = Number(row.lastSeenAt) || 0;
                if (now - lastSeen > 30_000) {
                    row.lastSeenAt = now;
                    void update(ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances/${key}`), {
                        lastSeenAt: now,
                    }).catch(() => { /* non-critical */ });
                }
                continue;
            }
            const lastSeen = Number(row.lastSeenAt);
            const birth = Number(row.spawnedAt);
            const stamp = Number.isFinite(lastSeen) ? lastSeen : (Number.isFinite(birth) ? birth : 0);
            if (stamp > 0 && now - stamp > MOB_DESPAWN_ABANDONED_MS) {
                despawns++;
                delete this._instances[key];
                void remove(ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances/${key}`)).catch((e) =>
                    console.warn("[FUS] dynamic mob despawn", e),
                );
            }
        }
    }

    /**
     * @param {import("firebase/database").DataSnapshot} snap
     */
    async _onPlayerHitRow(snap) {
        if (!this._isEffectiveLeader()) {
            return;
        }
        const v = snap.val();
        if (!v || typeof v !== "object") {
            try {
                await remove(snap.ref);
            } catch (_) {
                /* ignore */
            }
            return;
        }
        const mobKey = typeof v.mobKey === "string" ? v.mobKey : "";
        const fromUid = typeof v.fromUid === "string" ? v.fromUid : "";
        const dmgHalf = Number(v.dmgHalf);
        const d = Number.isFinite(dmgHalf) && dmgHalf > 0 ? Math.min(120, dmgHalf) : 2;
        try {
            await remove(snap.ref);
        } catch (_) {
            /* ignore */
        }
        if (!mobKey || !fromUid || !this._instances || !this._instances[mobKey]) {
            return;
        }
        const row = this._instances[mobKey];
        if (row == null || typeof row !== "object" || row.dead === true) {
            return;
        }
        const hp0 = Number(row.hp);
        const cur = Number.isFinite(hp0) ? hp0 : Number(row.maxHp) || 20;
        const newHp = Math.max(0, cur - d);
        const now = Date.now();
        /** Always chase whoever damaged us — RTDB pose can lag behind the hit-tested entity, so pure aggro range may miss a valid melee attacker. */
        if (newHp > 0 && fromUid) {
            this._mobChaseUid.set(mobKey, fromUid);
        }
        const typeIdLoot = typeof row.typeId === "string" ? row.typeId : "spider_mob";
        const lvLoot = Number.isFinite(Number(row.level)) ? Math.max(1, Math.floor(Number(row.level))) : 1;
        if (newHp <= 0) {
            const lx = Number(row.x);
            const ly = Number(row.y);
            const lz = Number(row.z);
            if ([lx, ly, lz].every((n) => Number.isFinite(n))) {
                const loot = rollMobKillLoot(typeIdLoot, lvLoot);
                void fusPushMobLootDrop(this.worldId, lx, ly + 0.45, lz, loot);
            }
            if (typeof window !== "undefined") {
                const maxH = Number.isFinite(Number(row.maxHp)) ? Number(row.maxHp) : fusMobMaxHpForLevel(lvLoot, fusMobTypeById(typeIdLoot));
                /**
                 * Pass the killer's level so the reward scales relative to them. Local player's
                 * level is the cheapest + most accurate source; fall back to the global cfg for
                 * remote kills (we don't have other players' levels cached everywhere).
                 */
                const myUid = this.uid;
                let killerLevel = Math.max(1, Math.floor(Number(this.minecraft.fusPlayerLevel) || 1));
                if (fromUid !== myUid) {
                    const cfg = window.__FUS_MC__;
                    if (cfg && Number.isFinite(Number(cfg.level))) {
                        killerLevel = Math.max(1, Math.floor(Number(cfg.level)));
                    }
                }
                const xp = fusMobKillXpReward(typeIdLoot, lvLoot, maxH, killerLevel);
                if (xp > 0) {
                    const grant = window.__FUS_GRANT_LABY_XP__;
                    if (typeof grant === "function") {
                        try {
                            grant(xp, { killerUid: fromUid, mobType: typeIdLoot, level: lvLoot });
                        } catch (e) {
                            console.warn("[FUS] mob xp grant", e);
                        }
                    }
                }
            }
        }
        try {
            await update(ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances/${mobKey}`), {
                hp: newHp,
                dead: newHp <= 0,
                diedAt: newHp <= 0 ? now : null,
                anim: newHp <= 0 ? "idle" : row.anim,
                moving: false,
                updatedAt: serverTimestamp(),
            });
        } catch (e) {
            console.warn("[FUS] mob hp update", e);
        }
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {string} key
     * @returns {boolean}
     */
    _shouldMobEntityBeActive(x, y, z, key) {
        const pl = this.minecraft.player;
        if (!pl) {
            return false;
        }
        const dx = x - pl.x;
        const dy = y - pl.y;
        const dz = z - pl.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const wr = this.minecraft.worldRenderer;
        const vd =
            wr && typeof wr.getEffectiveViewDistanceChunks === "function"
                ? wr.getEffectiveViewDistanceChunks()
                : Math.max(2, Math.min(12, Number(this.minecraft.settings?.viewDistance) || 3));
        const vdBlocks = vd * 16;
        /**
         * Strained mobile tier: cap activation radius to the visible terrain; a mob sitting 40
         * blocks past the fog wall still consumes a mixer + nametag canvas + skinned mesh. That
         * was the main Android burn: 20–30 live mobs rotating in/out behind fog.
         */
        const strained = !!this.minecraft.fusIosSafari;
        const inExtra = strained ? 0 : MOB_ENTITY_LOD_ACTIVATE_EXTRA;
        const outExtra = strained ? 18 : MOB_ENTITY_LOD_DEACTIVATE_EXTRA;
        const rIn = vdBlocks + inExtra;
        const rOut = vdBlocks + outExtra;
        const rIn2 = rIn * rIn;
        const rOut2 = rOut * rOut;
        const prev = this._mobLodState.get(key);
        if (d2 <= rIn2) {
            this._mobLodState.set(key, true);
            return true;
        }
        if (d2 >= rOut2) {
            this._mobLodState.set(key, false);
            return false;
        }
        if (prev === undefined) {
            return false;
        }
        return prev === true;
    }

    _syncEntitiesFromInstances() {
        const w = this.minecraft.world;
        if (!w) {
            return;
        }
        const inst = this._instances;
        const seen = new Set();
        /**
         * Activation budget per sync pass — prevents a single-frame burst when many mobs enter LOD
         * at once (e.g. teleport, initial world load). New entity = GLB clone + mixer + nametag DOM
         * creation; doing 10 at once produced multi-second hitches on mobile.
         */
        const fusEmbed = typeof window !== "undefined" && !!window.__LABY_MC_FUS_EMBED__;
        const booting =
            fusEmbed &&
            typeof performance !== "undefined" &&
            typeof this.minecraft._fusTerrainBootUntil === "number" &&
            performance.now() < this.minecraft._fusTerrainBootUntil;
        let activationBudget = this.minecraft.fusIosSafari
            ? (booting ? 1 : 2)
            : this.minecraft.fusLowTierMobile
                ? (booting ? 2 : 3)
                : (booting ? 4 : 10);
        /**
         * Hard cap on simultaneously-active mob entities on the local client. Each active mob
         * costs: a skinned-mesh clone + {@link THREE.AnimationMixer} + per-frame nametag canvas
         * + entity tick + pose interpolation. On strained mobile (iOS Safari, low-core Android)
         * the CPU can only afford ~5 of these without the UI dying. User report: "iPhone at 5
         * fps, couldn't even open settings" — main thread was pinned by 8–10 live skinned mobs.
         */
        const strained = !!this.minecraft.fusIosSafari;
        const mobActiveCap = strained ? 5 : this.minecraft.fusLowTierMobile ? 8 : 20;
        /**
         * @type {Array<{ key: string, row: any, x: number, y: number, z: number, d2: number }>}
         * Pending activations sorted by distance so the closest mobs pop in first.
         */
        const toActivate = [];
        const pl = this.minecraft.player;
        /**
         * First pass: collect every mob with its distance so we can apply a hard cap on the
         * number of active ones (nearest wins). Without this pass, a cluster of 7 mobs that all
         * sit inside LOD radius would all go active on strained mobile regardless of the cap.
         */
        /** @type {Array<{ key: string, row: any, x: number, y: number, z: number, d2: number }>} */
        const visible = [];
        if (inst) {
            for (const key of Object.keys(inst)) {
                const row = inst[key];
                if (!row || typeof row !== "object") {
                    continue;
                }
                seen.add(key);
                const x = Number(row.x);
                const y = Number(row.y);
                const z = Number(row.z);
                if (![x, y, z].every((n) => Number.isFinite(n))) {
                    continue;
                }
                if (!this._shouldMobEntityBeActive(x, y, z, key)) {
                    if (this._ents.has(key)) {
                        const far = this._ents.get(key);
                        if (far) {
                            try {
                                far.renderer?.fusDispose?.();
                            } catch (_) {
                                /* ignore */
                            }
                            w.removeEntityById(far.id);
                        }
                        this._ents.delete(key);
                    }
                    continue;
                }
                const dx = pl ? x - pl.x : 0;
                const dy = pl ? y - pl.y : 0;
                const dz = pl ? z - pl.z : 0;
                visible.push({ key, row, x, y, z, d2: dx * dx + dy * dy + dz * dz });
            }
        }
        /** Apply the hard cap: nearest N active, everything else behaves as LOD-far. */
        visible.sort((a, b) => a.d2 - b.d2);
        const activeSet = new Set();
        for (let i = 0; i < Math.min(mobActiveCap, visible.length); i++) {
            activeSet.add(visible[i].key);
        }
        for (let i = 0; i < visible.length; i++) {
            const v = visible[i];
            if (!activeSet.has(v.key)) {
                /** Over the cap — deactivate if previously active, otherwise just skip. */
                if (this._ents.has(v.key)) {
                    const far = this._ents.get(v.key);
                    if (far) {
                        try {
                            far.renderer?.fusDispose?.();
                        } catch (_) {
                            /* ignore */
                        }
                        w.removeEntityById(far.id);
                    }
                    this._ents.delete(v.key);
                }
                continue;
            }
            let ent = this._ents.get(v.key);
            if (!ent) {
                toActivate.push(v);
                continue;
            }
            this._applyRowToEntity(ent, v.row, v.x, v.y, v.z);
        }

        /** Activate pending mobs nearest-first, capped to {@code activationBudget}. */
        if (toActivate.length > 0) {
            toActivate.sort((a, b) => a.d2 - b.d2);
            const upTo = Math.min(activationBudget, toActivate.length);
            for (let i = 0; i < upTo; i++) {
                const p = toActivate[i];
                const id = stableMobEntityId(p.key);
                const ent = new FusMobEntity(this.minecraft, w, id);
                ent.fusMobKey = p.key;
                w.addEntity(ent);
                this._ents.set(p.key, ent);
                this._applyRowToEntity(ent, p.row, p.x, p.y, p.z);
            }
            /** Re-sync soon so deferred mobs pop in quickly — but not on the same frame. */
            if (toActivate.length > upTo) {
                this._scheduleDeferredActivationSweep();
            }
        }

        for (const key of this._ents.keys()) {
            if (!seen.has(key)) {
                const ent = this._ents.get(key);
                if (ent) {
                    try {
                        ent.renderer?.fusDispose?.();
                    } catch (_) {
                        /* ignore */
                    }
                    w.removeEntityById(ent.id);
                }
                this._ents.delete(key);
                this._mobLodState.delete(key);
            }
        }
        if (inst) {
            for (const k of [...this._mobLodState.keys()]) {
                if (!(k in inst)) {
                    this._mobLodState.delete(k);
                }
            }
        }
    }

    /**
     * Apply an RTDB row onto an existing entity (extracted so activation path can share it with
     * the main update path).
     */
    _applyRowToEntity(ent, row, x, y, z) {
        const typeId = typeof row.typeId === "string" ? row.typeId : "spider_mob";
        const type = fusMobTypeById(typeId);
        ent.fusTypeId = type.id;
        ent.fusDisplayName = type.displayName;
        ent.fusLevel = Number.isFinite(Number(row.level)) ? Math.max(1, Math.floor(Number(row.level))) : 1;
        const maxHp = Number.isFinite(Number(row.maxHp))
            ? Number(row.maxHp)
            : fusMobMaxHpForLevel(ent.fusLevel, type);
        ent.fusMaxHp = maxHp;
        const nextHp = Number.isFinite(Number(row.hp)) ? Number(row.hp) : maxHp;
        /**
         * Damage popup: any drop in HP since we last saw this mob spawns a floating number.
         * We compare the previously-applied client value on the entity (not the raw row field)
         * so two adjacent onChildChanged events for the same hp don't pop twice. First sync
         * after activation is skipped (no prior anchor) to avoid a spurious popup on LOD-in.
         */
        const prevHp = Number.isFinite(Number(ent._fusPopupPrevHp))
            ? Number(ent._fusPopupPrevHp)
            : nextHp;
        if (
            Number.isFinite(nextHp) &&
            nextHp < prevHp - 0.01 &&
            row.dead !== true &&
            typeof window !== "undefined"
        ) {
            const amt = prevHp - nextHp;
            /** Use the authoritative pose, not the in-flight interp target — popup anchors to
             *  where the hit just landed. Anchor slightly above the mob's nametag. */
            const ax = Number.isFinite(Number(row.x)) ? Number(row.x) : ent.x;
            const ay = Number.isFinite(Number(row.y)) ? Number(row.y) : ent.y;
            const az = Number.isFinite(Number(row.z)) ? Number(row.z) : ent.z;
            const lift = Number.isFinite(ent.fusNametagYOffset) ? ent.fusNametagYOffset : 1.6;
            const popups = this.minecraft.fusDamagePopups;
            if (popups && typeof popups.spawn === "function") {
                /** Crit flag = >40% max-HP chunk in one hit. Roughly tracks "heavy" player hits. */
                const crit = maxHp > 0 && amt >= Math.max(4, maxHp * 0.4);
                popups.spawn(ax, ay + lift + 0.25, az, amt, crit);
            }
        }
        ent._fusPopupPrevHp = nextHp;
        ent.health = nextHp;
        ent.fusMobDead = row.dead === true || ent.health <= 0;
        if (!ent.fusMobDead) {
            ent.fusMobDeathSmokeSpawned = false;
        }
        ent.fusNametagYOffset = fusMobNametagY(typeId);
        ent.fusFacePlayer = row.facePlayer === true;
        ent.fusMobAuthority = this._leader;
        ent.fusAnim = row.anim === "attack" || row.anim === "walk" ? row.anim : "idle";
        ent.fusMoving = row.moving === true;
        const ry = Number(row.ry);
        if ([x, y, z].every((n) => Number.isFinite(n))) {
            /**
             * Active mobs interpolate over ~{@link POSE_INCREMENTS_ACTIVE} ticks (~250 ms) — matches
             * the leader's AI period so the visual never trails too far behind the authoritative
             * pose. Idle mobs use a longer window to smooth out tiny pose drift. This is the
             * single biggest "mob feels laggy / attacks from far" fix.
             */
            const inc = ent.fusMoving || ent.fusAnim === "attack"
                ? POSE_INCREMENTS_ACTIVE
                : POSE_INCREMENTS_IDLE;
            ent.fusApplyPose(x, y, z, Number.isFinite(ry) ? ry : ent.rotationYaw, inc);
        }
        ent.collision = false;
    }

    _scheduleDeferredActivationSweep() {
        if (this._pendingActivationSweep) {
            return;
        }
        this._pendingActivationSweep = true;
        const delay = this.minecraft.fusIosSafari ? 180 : this.minecraft.fusLowTierMobile ? 120 : 60;
        setTimeout(() => {
            this._pendingActivationSweep = false;
            if (this.minecraft.isInGame() && this.minecraft.world) {
                this._requestEntitySync();
            }
        }, delay);
    }

    /**
     * @returns {{ uid: string, x: number, y: number, z: number }[]}
     */
    _allPlayerTargets() {
        /** @type {{ uid: string, x: number, y: number, z: number }[]} */
        const out = [];
        const pl = this.minecraft.player;
        /** Must match {@code worldMobPlayerHits.fromUid} (rules: {@code auth.uid}) so chase lock resolves after melee. */
        const localUid =
            auth && typeof auth.currentUser?.uid === "string" && auth.currentUser.uid.length > 0
                ? auth.currentUser.uid
                : this.uid;
        if (pl && pl.health > 0) {
            out.push({ uid: localUid, x: pl.x, y: pl.y, z: pl.z });
        }
        if (this.presence && typeof this.presence.getRemotePositionsForMobAi === "function") {
            out.push(...this.presence.getRemotePositionsForMobAi());
        }
        return out;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {{ uid: string, x: number, y: number, z: number }[]} targets
     */
    _minSqDistToTargets(x, y, z, targets) {
        let best = Infinity;
        for (let t = 0; t < targets.length; t++) {
            const p = targets[t];
            const dx = p.x - x;
            const dy = p.y - y;
            const dz = p.z - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < best) {
                best = d2;
            }
        }
        return best;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {{ uid: string, x: number, y: number, z: number }[]} targets
     * @param {number} radiusXZ
     * @param {number} maxDy
     */
    _anyPlayerInAiCylinder(x, y, z, targets, radiusXZ, maxDy) {
        const r2 = radiusXZ * radiusXZ;
        for (let t = 0; t < targets.length; t++) {
            const p = targets[t];
            const dx = p.x - x;
            const dz = p.z - z;
            if (dx * dx + dz * dz > r2) {
                continue;
            }
            if (Math.abs(p.y - y) <= maxDy) {
                return true;
            }
        }
        return false;
    }

    _tickAi() {
        if (!this._isEffectiveLeader() || !this.minecraft.isInGame() || !this.minecraft.world) {
            return;
        }
        /**
         * Embed loader gate: when the opaque boot overlay is up we want the CPU going to chunk
         * rebuilds, not mob AI / spawn scans. {@code fusFrozen} is released the instant the
         * overlay is dismissed (see LabyJsMinecraftView#waitForWorldRenderReady).
         */
        if (this.minecraft.fusFrozen === true) {
            return;
        }
        /** Retry seed when world just finished loading (first {@link #_maybeSeed} can run too early). */
        void this._maybeSeed();
        if (!this._instances) {
            return;
        }
        /** Dynamic spawn/despawn pass — keeps a ring of mobs around every player. */
        try {
            this._spawnTickForPlayers();
        } catch (e) {
            console.warn("[FUS] dynamic spawn tick", e);
        }

        const w = this.minecraft.world;
        const keys = Object.keys(this._instances);
        const now = Date.now();
        const targets = this._allPlayerTargets();
        const aiR2 = MOB_AI_ACTIVE_RADIUS * MOB_AI_ACTIVE_RADIUS;

        for (let i = 0; i < keys.length; i++) {
            const mobKey = keys[i];
            const row = this._instances[mobKey];
            if (!row || typeof row !== "object") {
                continue;
            }
            if (row.dead === true) {
                /**
                 * Dynamic spawning model: dead mobs are removed, not re-placed at a patrol anchor.
                 * A short grace window after {@code diedAt} lets the kill animation + loot particles
                 * finish on all clients before the row disappears. Next spawn pass will top up the
                 * nearby player's ring.
                 */
                this._pendingMobHit.delete(mobKey);
                this._mobChaseUid.delete(mobKey);
                this._mobAttackMs.delete(mobKey);
                this._mobAttackHoldUntil.delete(mobKey);
                this._wander.delete(mobKey);
                const diedAt = Number(row.diedAt);
                const graceMs = 2500;
                if (Number.isFinite(diedAt) && now - diedAt >= graceMs) {
                    delete this._instances[mobKey];
                    void remove(ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances/${mobKey}`)).catch((e) =>
                        console.warn("[FUS] mob corpse remove", e),
                    );
                }
                continue;
            }
            let x = Number(row.x);
            let y = Number(row.y);
            let z = Number(row.z);
            let ry = Number(row.ry);
            if (![x, y, z].every((n) => Number.isFinite(n))) {
                continue;
            }

            /** Cylinder (XZ + limited Y) so hilltop players still wake AI; pure 3D was skipping nearby XZ. */
            if (targets.length > 0 && !this._anyPlayerInAiCylinder(x, y, z, targets, MOB_AI_ACTIVE_RADIUS, AGGRO_MAX_VERTICAL + 32)) {
                continue;
            }

            const pax = Number.isFinite(Number(row.patrolAx)) ? Number(row.patrolAx) : x;
            const paz = Number.isFinite(Number(row.patrolAz)) ? Number(row.patrolAz) : z;
            const typeIdStr = String(row.typeId || "spider_mob");
            const step = PATROL_STEP * fusMobMoveStepMul(typeIdStr);
            const aggroR = fusMobAggroRadius(typeIdStr);
            const acquireR2 = aggroR * aggroR;
            /**
             * Chase-drop distance (was 2 × aggroR — made mobs feel like they "never let you run").
             * Trimmed to 1.4 × so once the player opens a small gap they break the lock. Combined
             * with the ~25 % movement speed cut in the registry, outrunning a mob is now viable.
             */
            const dropR = aggroR * 1.4;
            const dropR2 = dropR * dropR;

            const pend = this._pendingMobHit.get(mobKey);
            if (pend != null && now >= pend.fireAt) {
                this._pendingMobHit.delete(mobKey);
                const tgt = targets.find((p) => p.uid === pend.toUid);
                if (tgt) {
                    const tdx = tgt.x - x;
                    const tdy = tgt.y - y;
                    const tdz = tgt.z - z;
                    const rHit = ATTACK_R + MOB_ATTACK_HIT_PAD;
                    /** Horizontal reach + narrow vertical band — prevents "hit from 3 blocks overhead". */
                    if (tdx * tdx + tdz * tdz <= rHit * rHit && Math.abs(tdy) <= ATTACK_Y_RANGE) {
                        void push(ref(rtdb, `${MOB_HITS}/${this.worldId}`), {
                            toUid: pend.toUid,
                            dmgHalf: fusMobDmgHalfForLevel(pend.typeId, pend.level, MOB_DMG_HALF),
                            mobKey,
                            mobName: fusMobTypeById(pend.typeId).displayName,
                            mx: x,
                            my: y + 1.2,
                            mz: z,
                            clientTs: now,
                            ts: serverTimestamp(),
                        }).catch((e) => console.warn("[FUS] mob hit push", e));
                    }
                }
            }

            let lockedUid = this._mobChaseUid.get(mobKey);
            if (lockedUid != null) {
                const lp = targets.find((p) => p.uid === lockedUid);
                if (!lp) {
                    this._mobChaseUid.delete(mobKey);
                    lockedUid = null;
                } else {
                    const dx = lp.x - x;
                    const dz = lp.z - z;
                    const h2 = dx * dx + dz * dz;
                    if (h2 > dropR2 || Math.abs(lp.y - y) > AGGRO_MAX_VERTICAL + 10) {
                        this._mobChaseUid.delete(mobKey);
                        lockedUid = null;
                    }
                }
            }

            let best = null;
            let bestHoriz2 = Infinity;
            if (lockedUid != null) {
                const lp = targets.find((p) => p.uid === lockedUid);
                if (lp) {
                    best = lp;
                }
            } else {
                for (let t = 0; t < targets.length; t++) {
                    const p = targets[t];
                    const dx = p.x - x;
                    const dy = p.y - y;
                    const dz = p.z - z;
                    if (Math.abs(dy) > AGGRO_MAX_VERTICAL) {
                        continue;
                    }
                    const horiz2 = dx * dx + dz * dz;
                    if (horiz2 <= acquireR2 && horiz2 < bestHoriz2) {
                        bestHoriz2 = horiz2;
                        best = p;
                    }
                }
                if (best != null) {
                    this._mobChaseUid.set(mobKey, best.uid);
                }
            }

            const holdUntil = this._mobAttackHoldUntil.get(mobKey);
            if (holdUntil != null && now < holdUntil) {
                let faceRy = Number.isFinite(ry) ? ry : 0;
                if (best != null) {
                    faceRy = fusMobYawDegFace(x, z, best.x, best.z);
                }
                const fp = best != null;
                if (!mobAiRowMatches(row, x, y, z, faceRy, "attack", false, fp)) {
                    void update(ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances/${mobKey}`), {
                        x,
                        y,
                        z,
                        ry: faceRy,
                        anim: "attack",
                        moving: false,
                        facePlayer: fp,
                        updatedAt: serverTimestamp(),
                    }).catch((e) => console.warn("[FUS] mob hold", e));
                }
                continue;
            }

            let anim = "idle";
            let moving = false;
            /** Horizontal distance — attack/chase thresholds are horizontal, matches hit test. */
            const horizDist =
                best != null
                    ? Math.sqrt((best.x - x) * (best.x - x) + (best.z - z) * (best.z - z))
                    : dropR + 999;
            const vertGap = best != null ? Math.abs(best.y - y) : 0;
            const startX = x;
            const startZ = z;

            if (best && horizDist < ATTACK_R && vertGap <= ATTACK_Y_RANGE) {
                const last = this._mobAttackMs.get(mobKey) || 0;
                if (now - last >= MOB_ATTACK_COOLDOWN_MS) {
                    this._mobAttackMs.set(mobKey, now);
                    this._mobAttackHoldUntil.set(mobKey, now + MOB_ATTACK_HOLD_MS);
                    anim = "attack";
                    ry = fusMobYawDegFace(x, z, best.x, best.z);
                    const ent = this._ents.get(mobKey);
                    if (ent) {
                        ent.fusAttackAnimTicks = 8;
                    }
                    this._pendingMobHit.set(mobKey, {
                        fireAt: now + MOB_ATTACK_HIT_DELAY_MS,
                        toUid: best.uid,
                        typeId: String(row.typeId || "spider_mob"),
                        level: Math.max(1, Math.floor(Number(row.level)) || 1),
                    });
                } else {
                    ry = fusMobYawDegFace(x, z, best.x, best.z);
                }
            } else if (best) {
                /**
                 * Sub-stepped chase: cover up to {@link CHASE_STEP_DISTANCE} blocks per AI tick but
                 * hop in small increments so {@link fusMobTryStepXZ} can nudge around corners and
                 * step onto 1-block ledges. Stop early once we enter attack range.
                 */
                const perHopMax = fusMobMoveStepMul(typeIdStr);
                const hopSize = (CHASE_STEP_DISTANCE * perHopMax) / CHASE_SUBSTEPS;
                for (let s = 0; s < CHASE_SUBSTEPS; s++) {
                    const dx = best.x - x;
                    const dz = best.z - z;
                    const len = Math.sqrt(dx * dx + dz * dz);
                    if (len < ATTACK_R - 0.1) {
                        break;
                    }
                    const nx = x + (dx / Math.max(len, 1e-4)) * hopSize;
                    const nz = z + (dz / Math.max(len, 1e-4)) * hopSize;
                    const moved = fusMobTryStepXZ(w, x, z, nx, nz, MOB_CAP_HALF, MOB_CAP_H, y);
                    if (!moved) {
                        break;
                    }
                    x = moved.x;
                    y = moved.y;
                    z = moved.z;
                    anim = "walk";
                    moving = true;
                }
                ry = fusMobYawDegFace(x, z, best.x, best.z);
            } else {
                let wand = this._wander.get(mobKey);
                if (!wand || now > wand.until) {
                    const ang = Math.random() * Math.PI * 2;
                    const r = 1.5 + Math.random() * 5;
                    wand = {
                        tx: pax + Math.cos(ang) * r,
                        tz: paz + Math.sin(ang) * r,
                        until: now + 3500 + Math.random() * 2000,
                    };
                    this._wander.set(mobKey, wand);
                }
                const dx = wand.tx - x;
                const dz = wand.tz - z;
                const len = Math.max(Math.sqrt(dx * dx + dz * dz), 1e-4);
                if (len > 0.35) {
                    const nx = x + (dx / len) * step * 0.85;
                    const nz = z + (dz / len) * step * 0.85;
                    const moved = fusMobTryStepXZ(w, x, z, nx, nz, MOB_CAP_HALF, MOB_CAP_H, y);
                    if (moved) {
                        x = moved.x;
                        y = moved.y;
                        z = moved.z;
                        ry = (Math.atan2(dx, dz) * 180) / Math.PI;
                        anim = "walk";
                        moving = true;
                    }
                }
            }

            /**
             * Stuck kick: when chasing a player but making no progress for a few ticks, randomize
             * a perpendicular nudge and widen the wander target so the mob breaks out of edge
             * corners / 2-block walls it cannot solve with simple slides.
             */
            if (best && moving) {
                const dxm = x - startX;
                const dzm = z - startZ;
                const travelled2 = dxm * dxm + dzm * dzm;
                if (travelled2 < 0.02 * 0.02) {
                    moving = false;
                    anim = "idle";
                }
            }
            if (best) {
                const stuck = (this._mobStuck || (this._mobStuck = new Map()));
                const dxm = x - startX;
                const dzm = z - startZ;
                const travelled2 = dxm * dxm + dzm * dzm;
                if (travelled2 < 0.02 * 0.02 && horizDist >= ATTACK_R) {
                    const cur = (stuck.get(mobKey) || 0) + 1;
                    stuck.set(mobKey, cur);
                    if (cur >= 2) {
                        /** Perpendicular unstick: sidestep + try to step up onto neighbor. */
                        const bdx = best.x - x;
                        const bdz = best.z - z;
                        const blen = Math.max(Math.hypot(bdx, bdz), 1e-4);
                        const px1 = -bdz / blen;
                        const pz1 = bdx / blen;
                        const dir = cur % 2 === 0 ? 1 : -1;
                        const trySide = [
                            [x + px1 * dir * 0.9, z + pz1 * dir * 0.9],
                            [x + px1 * dir * 0.6 + (bdx / blen) * 0.4, z + pz1 * dir * 0.6 + (bdz / blen) * 0.4],
                            [x + (bdx / blen) * 0.5, z + (bdz / blen) * 0.5],
                        ];
                        for (const [tx2, tz2] of trySide) {
                            const moved = fusMobTryStepXZ(w, x, z, tx2, tz2, MOB_CAP_HALF, MOB_CAP_H, y);
                            if (moved) {
                                x = moved.x;
                                y = moved.y;
                                z = moved.z;
                                anim = "walk";
                                moving = true;
                                stuck.set(mobKey, 0);
                                break;
                            }
                        }
                        if (cur >= 5) {
                            /** Totally blocked — drop chase and wander elsewhere for a bit. */
                            this._mobChaseUid.delete(mobKey);
                            stuck.set(mobKey, 0);
                        }
                    }
                } else {
                    stuck.set(mobKey, 0);
                }
            }

            if (best != null) {
                ry = fusMobYawDegFace(x, z, best.x, best.z);
            }

            const fp = best != null;
            /** @type {'idle'|'walk'|'attack'} */
            const animNorm = anim === "attack" || anim === "walk" ? anim : "idle";
            if (!mobAiRowMatches(row, x, y, z, ry, animNorm, moving, fp)) {
                void update(ref(rtdb, `${MOB_ROOT}/${this.worldId}/instances/${mobKey}`), {
                    x,
                    y,
                    z,
                    ry,
                    anim,
                    moving,
                    facePlayer: fp,
                    updatedAt: serverTimestamp(),
                }).catch((e) => console.warn("[FUS] mob ai", e));
            }
        }
    }

    async destroy() {
        this.minecraft.fusMobSyncRef = null;
        this._aiStopped = true;
        if (this._aiTo) {
            clearTimeout(this._aiTo);
            this._aiTo = null;
        }
        if (this._aiIv) {
            clearInterval(this._aiIv);
            this._aiIv = null;
        }
        if (this._lodIv) {
            clearInterval(this._lodIv);
            this._lodIv = null;
        }
        for (const uns of [this._unsubMobAdd, this._unsubMobChg, this._unsubMobRm]) {
            if (!uns) continue;
            try { uns(); } catch (_) { /* ignore */ }
        }
        this._unsubMobAdd = null;
        this._unsubMobChg = null;
        this._unsubMobRm = null;
        if (this._unsubPresence) {
            try {
                this._unsubPresence();
            } catch (_) {
                /* ignore */
            }
        }
        this._unsubPresence = null;
        if (this._unsubHits) {
            try {
                this._unsubHits();
            } catch (_) {
                /* ignore */
            }
        }
        this._unsubHits = null;
        this._pendingMobHit.clear();
        this._mobChaseUid.clear();

        const w = this.minecraft.world;
        if (w) {
            for (const ent of this._ents.values()) {
                try {
                    ent.renderer?.fusDispose?.();
                } catch (_) {
                    /* ignore */
                }
                w.removeEntityById(ent.id);
            }
        }
        this._ents.clear();
        this._mobLodState.clear();
    }
}
