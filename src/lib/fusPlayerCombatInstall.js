import {
  onChildAdded,
  push as dbPush,
  ref as dbRef,
  remove as dbRemove,
  set as dbSet,
  query,
  orderByChild,
  equalTo,
} from 'firebase/database'
import { pvpDamageHalfForMeshName } from './blockWorldToolCatalog.js'

/**
 * Resolve the player's outgoing attack damage in HALF-HEARTS (2 halves = 1 HP) given the
 * currently-held hotbar item and their FUS level.
 *
 * Damage model (user request, 2026-04):
 *   • Fist = baseline (weakest). 1 half-heart at L1, ramping up with level.
 *   • Tool: tier/kind scaling via {@link pvpDamageHalfForMeshName} (Wooden Sword = 4
 *     halves, Netherite Sword = 10). Same curve used for PvP and PvE so weapon choice
 *     matters against both players and mobs.
 *   • Level multiplier: +2 % per level → L1 = 1.0×, L50 = 1.98×. Linear to keep the
 *     "fist is always weak" feel — a level-50 player's fist still loses to a level-1
 *     swordsman at close-enough levels.
 *
 * Exported so the mob installer can use the same number — a previously flat 8 HP/hit was
 * one-shotting level-1 mobs with bare hands, which the user flagged as obviously wrong.
 *
 * @param {any} mc
 * @returns {number} integer half-hearts, clamped to ≥1 (never a zero-damage whiff).
 */
export function fusAttackDamageHalfHearts(mc) {
  const inv = mc?.player?.inventory
  const sel = typeof inv?.selectedSlotIndex === 'number' ? inv.selectedSlotIndex : 0
  const meta = mc?.fusHotbarSlotMeta?.[sel]
  let base = 1 /** fist baseline — always the minimum. */
  if (meta && meta.kind === 'tool' && typeof meta.toolMeshName === 'string') {
    try {
      const v = pvpDamageHalfForMeshName(meta.toolMeshName)
      if (Number.isFinite(v) && v > 0) base = v
    } catch {
      /* ignore — fall back to fist. */
    }
  }
  const lv = Math.max(1, Math.floor(Number(mc?.fusLevel) || 1))
  const mult = 1 + (lv - 1) * 0.02
  return Math.max(1, Math.round(base * mult))
}

/** HP-flavoured convenience wrapper. Mob HP is stored in HP units, so this is what the
 *  mob damage path wants. 1 half-heart = 0.5 HP. */
export function fusAttackDamageHp(mc) {
  return fusAttackDamageHalfHearts(mc) * 0.5
}

/**
 * PvP / PK combat wiring.
 *
 * The PvP *karma* module ({@link installFusPvpKarma}) only tracks state — mode, karma,
 * colour lookups for nametags. It deliberately doesn't touch the actual hit mechanics
 * because those need:
 *   • a player-target resolver (raycast against remote avatars, not just mobs),
 *   • an RTDB mailbox so the victim actually takes damage on *their* client,
 *   • a death pipeline that notifies the karma module so red mode activates on PK.
 *
 * This installer is that layer. It chains after {@link installFusSimpleMobs} (which owns
 * `mc.fusTryRemoteMelee` for mob-melee) by capturing the existing hook and replacing it
 * with one that tries player targets first, then falls back to the mob hook. The engine's
 * left-click path ({@link Minecraft#onMouseClicked}) checks `fusTryRemoteMelee` before
 * trying to destroy a block, so the priority is: player hit → mob hit → block hit. That
 * mirrors what a user expects when they tap "attack" with a crosshair over another
 * player.
 *
 * Mailbox model:
 *   Attacker writes `worldCombatHits/{worldId}/{pushId}` with
 *     `{ fromUid, fromName, toUid, dmgHalf, clientTs }`.
 *   Victim subscribes to its own inbox via a `query + orderByChild('toUid') + equalTo(uid)`
 *   and applies damage. After applying, the victim deletes the entry (rule-allowed as of
 *   the sibling patch in `database.rules.json`).
 *
 * Why a mailbox and not "attacker mutates `worldPresence/{victim}.hp`"?
 *   • Presence writes are owned by the victim's own uid — RTDB rules won't let anyone
 *     else touch their pose/HP fields, and lifting that restriction would let any
 *     authenticated user teleport/kill any other user at will.
 *   • The server-time deduped inbox also gives us a durable audit trail that
 *     {@link installFusPvpKarma} uses to trigger its `onDeath` + karma flip.
 *
 * Scope kept intentionally small:
 *   • Damage is level-scaled (see {@link fusLabyLevelStats}) but otherwise flat — no
 *     weapon multipliers yet. Extending this to per-tool damage is mechanical: read
 *     `mc.fusHotbarSlotMeta[sel].toolDamage` and multiply.
 *   • Invulnerability window after hit is 500 ms so a rapid double-tap doesn't stack.
 *   • We stop processing inbox hits while the local player's health is 0 — the respawn
 *     path heals + teleports, then resumes. Ghost-killing a dead player is a feel-bad.
 *
 * @param {any} mc
 * @param {{ worldId: string, uid: string, rtdb: any, displayName?: string }} opts
 * @returns {() => void}
 */
export function installFusPlayerCombat(mc, { worldId, uid, rtdb, displayName }) {
  if (!mc || !mc.player || !rtdb || !worldId || !uid) {
    /** Quiet info rather than warn: the install is re-invoked on every Vite HMR cycle
     *  (the `LabyJsMinecraftView` setup is re-run on accept) and during the first few
     *  frames of a normal boot before `mc.player` exists. Flooding the console with
     *  "missing prereqs" warnings was drowning out real issues — log once at debug
     *  level so devs can still spot truly-unrecoverable states. */
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('[fusPlayerCombat] skip install — prereqs not ready', {
        hasMc: !!mc,
        hasPlayer: !!mc?.player,
        hasRtdb: !!rtdb,
        hasWorldId: !!worldId,
        hasUid: !!uid,
      })
    }
    return () => {}
  }

  /** ~8 HP per hit at level 1 = 16 dmgHalf units (engine stores HP, RTDB stores half-hearts). */
  const BASE_DMG_HP = 8
  /** Upper bound — the RTDB rule caps `dmgHalf` at 40. We never send more than that. */
  const DMG_HALF_MAX = 40
  /** Melee range vs **players** (world units ≈ blocks). Tight: ~1 m so you cannot connect
   *  from several blocks away. Mob hits use a separate, longer range in
   *  {@link installFusSimpleMobs}. */
  const ATTACK_RANGE = 3.5
  /** PvP must use the *same* look vector as the engine (`getVectorForRotation` + eyes from
   *  `getPositionEyes`) or the hit test and the on-screen crosshair never agree. This is
   *  cos(θ) for angle θ between that look **unit** and the vector to the peer’s chest.
   *  0.9 ≈ 26° off-axis max — you must face the target, not 45° to the side. */
  const ATTACK_CONE_COS = 0.9
  /** After being hit, this many ms pass before the next hit can land — prevents
   *  fast attackers (or latency spikes firing two hits at once) from one-shotting
   *  a player. */
  const IFRAME_MS = 500
  /** If we die on an incoming hit, we rebirth at the spawn with full HP after this
   *  many ms. Short enough that a kill doesn't feel like a lockout. */
  const RESPAWN_DELAY_MS = 1200

  /** Records who last hit us + when, so the death-handling path can credit a killer. */
  let lastHitFromUid = null
  let lastHitAtMs = 0
  let iframeUntilMs = 0

  /**
   * Resolve the nearest remote-avatar uid we're aiming at, if any. Mirrors
   * {@link installFusSimpleMobs}'s `tryMelee` but over `mc.fusRemoteAvatars` — a Map of
   * peer uid → `Avatar`. Avatars expose `root.position` (world-space, updated each
   * frame by the interpolation tick), which is what we raycast against.
   *
   * @returns {{ uid: string, mode: 'white'|'purple'|'red' } | null}
   */
  const findPlayerTarget = () => {
    const pl = mc.player
    const avatars = mc.fusRemoteAvatars
    if (!pl || !avatars || avatars.size === 0) return null
    /** Must match {@link PlayerEntity#getVectorForRotation} and {@link PlayerEntity#getPositionEyes}
     *  so “what the crosshair points at” is what we test — the previous hand-rolled
     *  sin/cos of yaw used the wrong convention and PvP never lined up. */
    if (typeof pl.getVectorForRotation !== 'function' || typeof pl.getPositionEyes !== 'function') {
      return null
    }
    const look = pl.getVectorForRotation(pl.rotationPitch, pl.rotationYaw)
    const lLen = Math.hypot(look.x, look.y, look.z)
    if (!Number.isFinite(lLen) || lLen < 1e-6) return null
    const dirX = look.x / lLen
    const dirY = look.y / lLen
    const dirZ = look.z / lLen
    const eyes = pl.getPositionEyes(1.0)
    if (!eyes) return null
    const ex = eyes.x
    const ey = eyes.y
    const ez = eyes.z

    let bestUid = null
    let bestMode = 'white'
    let bestScore = -Infinity
    for (const [peerUid, av] of avatars) {
      if (!av || !av.root) continue
      /** Skip dead peers — their hp is 0 and we already showed the death in nametag.
       *  Deliberately do NOT gate on `root.visible`: the death VFX hides the root to show
       *  the corpse-particle-burst, but a fresh respawn restores visibility before the next
       *  tick arrives; being slightly permissive here avoids a one-frame window where a
       *  live-again peer can't be targeted. */
      if (typeof av.hp === 'number' && av.hp <= 0) continue
      const pos = av.root.position
      /** Aim at mid-torso (feet y + ~1.1), from real eye pos — same as block reach / ray. */
      const dx = pos.x - ex
      const dy = pos.y + 1.1 - ey
      const dz = pos.z - ez
      const dist = Math.hypot(dx, dy, dz)
      if (dist > ATTACK_RANGE || dist < 1e-4) continue
      const dot = (dx * dirX + dy * dirY + dz * dirZ) / dist
      if (dot < ATTACK_CONE_COS) continue
      const score = dot * 10 - dist
      if (score > bestScore) {
        bestScore = score
        bestUid = peerUid
        bestMode = av.pvpMode || 'white'
      }
    }
    return bestUid ? { uid: bestUid, mode: bestMode } : null
  }

  /** Write a single hit entry to the inbox. Fire-and-forget; failures just log. */
  const writeHit = (targetUid, dmgHp) => {
    const dmgHalf = Math.max(1, Math.min(DMG_HALF_MAX, Math.round(dmgHp * 2)))
    const inbox = dbRef(rtdb, `worldCombatHits/${worldId}`)
    const row = {
      fromUid: uid,
      fromName: String(displayName || 'Player').slice(0, 48),
      toUid: targetUid,
      dmgHalf,
      clientTs: Date.now(),
    }
    dbPush(inbox, row).catch((e) => console.warn('[fusPlayerCombat] push hit failed', e))
  }

  /**
   * Outgoing: wrap `fusTryRemoteMelee` so player targets are checked before mobs. The
   * wrapped hook must remain **synchronous boolean** (the engine's
   * `onMouseClicked(0)` returns immediately on `true` to skip block-breaking) — so we
   * kick off the RTDB push async and return `true` without awaiting it.
   */
  const prevRemoteMelee = typeof mc.fusTryRemoteMelee === 'function' ? mc.fusTryRemoteMelee : null
  const chainedMelee = () => {
    /** Dead men don't swing. The death-screen overlay already captures the click events
     *  that bubble to the Vue layer, but the engine's `onMouseClicked(0)` runs on the
     *  canvas and still reaches here — without this guard, the player can continue
     *  fighting (and damaging peers / mobs) while the overlay says they're dead. */
    if (typeof mc.fusIsDead === 'function' && mc.fusIsDead()) return false
    if (Number.isFinite(mc.fusSpawnInvulnUntilMs) && Date.now() < mc.fusSpawnInvulnUntilMs) {
      return false
    }
    const target = findPlayerTarget()
    if (target) {
      const dmgHp = damageForLevel(mc)
      try {
        mc.fusMarkCombatForRegen?.()
      } catch {
        /* ignore */
      }
      writeHit(target.uid, dmgHp)
      /** Optimistic local FX: flash the target avatar red + spawn a hit puff at their
       *  chest. Waiting for the RTDB round-trip would eat ~150 ms which feels unresponsive
       *  on a click/tap. If the hit doesn't land (e.g. they disconnected), the FX was
       *  cheap and self-expiring. */
      const av = mc.fusRemoteAvatars?.get?.(target.uid)
      if (av) {
        /** The Avatar class exposes {@code triggerFlash} — the earlier `flashHit` call
         *  was a typo that silently noop'd (optional-chained on an undefined method),
         *  so the attacker never saw the red tint on their victim. Swap to the real
         *  name to restore the instant visual confirmation that the hit registered. */
        try {
          av.triggerFlash?.()
        } catch {
          /* ignore */
        }
        const pos = av.root?.position
        if (pos) {
          try {
            mc.fusFxHit?.(pos.x, pos.y + 1.1, pos.z, { count: 8 })
          } catch {
            /* ignore */
          }
        }
      }
      /** Locally: swing arm, flash the attacker purple in the karma module (so the
       *  attacker's nametag goes purple *immediately*, even before the RTDB write
       *  round-trips back). */
      try {
        mc.player?.swingArm?.()
      } catch {
        /* not all forks expose swingArm */
      }
      /** Belt & suspenders: directly stamp the presence writer's swing timestamp. The writer
       *  already infers swings from {@code swingProgressInt}, but on a cold install or after
       *  a hot reload the inference can miss the first click — an explicit mark guarantees
       *  peers see the arm arc start. */
      try {
        mc.fusMarkSwing?.()
      } catch {
        /* ignore — presence writer may not be installed (solo dev) */
      }
      try {
        mc.fusPvp?.onHitPlayer?.(target.uid, target.mode)
      } catch (e) {
        console.warn('[fusPlayerCombat] onHitPlayer threw', e)
      }
      return true
    }
    return prevRemoteMelee ? prevRemoteMelee() : false
  }
  mc.fusTryRemoteMelee = chainedMelee

  /**
   * Incoming: subscribe to our own inbox partition. Firebase's `orderByChild` +
   * `equalTo` requires an index on `toUid` for efficiency at scale — for the tiny
   * player counts this project ships with (single-digit concurrent players), the
   * default full-scan is fine. If we grow, add
   * `"worldCombatHits/$worldId": { ".indexOn": ["toUid"] }` to the rules.
   */
  const inboxQuery = query(
    dbRef(rtdb, `worldCombatHits/${worldId}`),
    orderByChild('toUid'),
    equalTo(uid),
  )

  /**
   * "Join time" cutoff — anything older than our session start is either stale
   * (attacker's write before we reloaded) or already applied. `onChildAdded` fires for
   * every existing child on attach, so we MUST filter by `clientTs` or we'd replay
   * hours of old hits the moment the subscription opens. Using local wall-clock is
   * good enough; attackers stamp `clientTs` with `Date.now()` and we only skip rows
   * stamped before our subscribe moment.
   */
  const joinTs = Date.now()

  const handleIncomingHit = (snap) => {
    const pushId = snap.key
    const row = snap.val()
    if (!row || typeof row !== 'object') {
      cleanup(pushId)
      return
    }
    const clientTs = Number(row.clientTs) || 0
    if (clientTs < joinTs) {
      /** Stale — silently garbage-collect so the inbox doesn't grow unbounded. */
      cleanup(pushId)
      return
    }
    const fromUid = typeof row.fromUid === 'string' ? row.fromUid : null
    const dmgHalf = Number(row.dmgHalf) || 0
    if (!fromUid || fromUid === uid || dmgHalf <= 0) {
      cleanup(pushId)
      return
    }
    const now = Date.now()
    if (Number.isFinite(mc.fusSpawnInvulnUntilMs) && now < mc.fusSpawnInvulnUntilMs) {
      cleanup(pushId)
      return
    }
    /** Respect local i-frames so a burst doesn't stack — but still delete the pushId
     *  so the sender's mailbox stays clean. */
    if (now < iframeUntilMs) {
      cleanup(pushId)
      return
    }
    iframeUntilMs = now + IFRAME_MS
    lastHitFromUid = fromUid
    lastHitAtMs = now

    /** Feed the death-screen resolver so the overlay can credit the right killer if this
     *  hit is the fatal one. Safe no-op when the death screen installer isn't mounted. */
    try {
      mc.fusRecordDamageFrom?.({
        type: 'player',
        name: typeof row.fromName === 'string' ? row.fromName : '',
        uid: fromUid,
      })
    } catch (e) {
      console.warn('[fusPlayerCombat] record damage threw', e)
    }

    const pl = mc.player
    if (pl && typeof pl.health === 'number') {
      const dmg = dmgHalf / 2
      const before = pl.health
      pl.health = Math.max(0, pl.health - dmg)
      /** Trigger the existing damage-flash VFX if installed — it listens on
       *  `mc.fusOnTakeDamage` if we expose one. Fall back to a direct
       *  `player.hurtTime` bump so the first-person camera shakes like vanilla. */
      try {
        if (typeof mc.fusOnTakeDamage === 'function') {
          mc.fusOnTakeDamage(Math.max(1, Math.round(dmg)))
        } else if (typeof pl.hurtTime === 'number') {
          pl.hurtTime = 10
          pl.hurtDirection = 0
        }
      } catch (e) {
        console.warn('[fusPlayerCombat] damage flash failed', e)
      }
      /** Hit sparkle around the victim (us). Drawn in world space at chest height so both
       *  first-person (even though camera is inside the player) and third-person cameras
       *  see the puff if they exist. */
      try {
        mc.fusFxHit?.(pl.x, pl.y + 1.1, pl.z, { count: 7, spread: 0.35 })
      } catch {
        /* ignore */
      }
      /**
       * Only the attacker is flagged purple via {@code mc.fusPvp.onHitPlayer} in the
       * outgoing-melee path. The victim must stay white until they hit another player
       * (or retaliate) — do not call {@code onHitPlayer} here.
       */
      if (before > 0 && pl.health <= 0) {
        /** Death puff for the local player — red-tinted so peers reading this FX via
         *  shared scene know it was a human (not a grey-dust mob). */
        try {
          mc.fusFxDeath?.(pl.x, pl.y + 1.0, pl.z, { count: 22, color: 0xdc2626, spread: 1.0 })
        } catch {
          /* ignore */
        }
        /** Push {@code hp: 0} to {@code worldPresence} immediately so peers' avatars
         *  get death VFX; otherwise a throttle/race can skip the zero frame. */
        void (async () => {
          try {
            await mc.fusForcePresenceWrite?.()
            handleLocalDeath(fromUid)
            await mc.fusForcePresenceWrite?.()
          } catch (e) {
            console.warn('[fusPlayerCombat] death presence/chain', e)
          }
        })()
      }
    }
    cleanup(pushId)
  }

  /**
   * Delete a processed inbox entry. Either the sender or receiver can delete under
   * the updated RTDB rule. Failures are non-fatal (Firebase will retry once the
   * connection heals; we just leave a tombstone behind).
   */
  const cleanup = (pushId) => {
    if (!pushId) return
    dbRemove(dbRef(rtdb, `worldCombatHits/${worldId}/${pushId}`)).catch(() => {
      /* ignore — stale permissions or already-deleted */
    })
  }

  /**
   * Local-death pipeline:
   *   1. Read our victim state and the attacker's mode at time of kill (so karma
   *      flips only on white-kills; killing a purple / red is legal).
   *   2. Call `mc.fusPvp.onDeath(killerUid, dropContext)` so karma decrements & drop
   *      hook fires.
   *   3. Write a `worldCombatDeaths` entry so observers (scoreboards, server-side
   *      logs, future PK-loot drops) can react. We also call the killer's karma
   *      module *via a side-channel*: the killer will read this death row, see
   *      their kill, and flip red locally.
   *   4. Schedule a respawn that heals HP and teleports to the spawn.
   */
  const handleLocalDeath = (killerUid) => {
    const self = mc.fusPvpSelfState
    const selfMode = self?.mode || 'white'
    const deathPos = (() => {
      const p = mc.player
      if (!p) return null
      return { x: p.x, y: p.y + 0.2, z: p.z }
    })()
    try {
      mc.fusPvp?.onDeath?.(killerUid, {
        worldId,
        deathAtMs: Date.now(),
        /** Hand the drop-handler the world-space spot it should spawn loot at — without
         *  this, the PK pile would fire at the origin because `mc.player` is already
         *  frozen / teleported by the death overlay by the time the hook processes. */
        x: deathPos?.x,
        y: deathPos?.y,
        z: deathPos?.z,
      })
    } catch (e) {
      console.warn('[fusPlayerCombat] onDeath hook threw', e)
    }
    /** Simple-PvP coin transfer (non-PK). Winner gets **1–5** coins from the loser by
     *  level gap (see {@link debitPvpCoinFromUser}); capped by loser's balance. Red (PK)
     *  deaths use {@code __FUS_ON_PK_DEATH_DROPS__} instead.
     *
     *  Deferred to Vue via `window.__FUS_ON_PVP_DEATH_DROP__` for Firestore debit +
     *  {@link mc.fusDropCoinAt} tagged with the killer's uid. */
    /**
     * World drop + Firestore debit: only if the victim was in **purple** (flagged for
     * PvP), not white or PK (red uses {@code __FUS_ON_PK_DEATH_DROPS__}).
     */
    if (selfMode === 'purple' && killerUid && killerUid !== uid && deathPos) {
      if (
        typeof window !== 'undefined' &&
        typeof window.__FUS_ON_PVP_DEATH_DROP__ === 'function'
      ) {
        try {
          window.__FUS_ON_PVP_DEATH_DROP__({
            worldId,
            loserUid: uid,
            killerUid,
            x: deathPos.x,
            y: deathPos.y,
            z: deathPos.z,
          })
        } catch (e) {
          console.warn('[fusPlayerCombat] pvp drop hook threw', e)
        }
      }
    }
    /** Publish the death for the killer's client to pick up (see "Incoming kill"
     *  below). Best-effort — a failed publish just means the killer doesn't flip
     *  red this session; they'll flip on the next successful death write. */
    const deathRow = {
      victimUid: uid,
      killerUid: killerUid || 'unknown',
      clientTs: Date.now(),
      victimInnocent: selfMode === 'white',
      victimPk: selfMode === 'red',
      bothPvp: selfMode === 'purple',
      victimPkills: 0,
      victimKarma: Math.max(0, Math.min(100000, Number(self?.karma) || 0)),
    }
    const deathRef = dbPush(dbRef(rtdb, `worldCombatDeaths/${worldId}`))
    dbSet(deathRef, deathRow).catch((e) =>
      console.warn('[fusPlayerCombat] death write failed', e),
    )

    /** The actual respawn is driven by the death-screen overlay — {@link installFusDeathScreen}
     *  shows "Ви загинули" with the killer's name and a "Відродитися" button that calls
     *  `mc.fusRespawnNow()`. The previous auto-respawn-after-1200ms path fought with the
     *  overlay for control of `player.health`; we now just let the overlay drive.
     *  Clear our own combat-invariant state so an immediate re-hit after respawn doesn't
     *  get eaten by a stale i-frame. */
    lastHitFromUid = null
    iframeUntilMs = 0
    void RESPAWN_DELAY_MS
  }

  /**
   * Incoming kill: watch `worldCombatDeaths/{worldId}` for rows where the killer uid
   * is ours. When the victim was white, we're a PK → karma module's `onKillPlayer`
   * flips us red. We consume the row on match (sender or same-death receiver).
   *
   * Using `onChildAdded` without `orderBy` because each row is small and the
   * rate is bounded by the player death count (low). Same `joinTs` cutoff keeps
   * us from re-processing history.
   */
  const deathsQuery = dbRef(rtdb, `worldCombatDeaths/${worldId}`)
  const handleIncomingDeath = (snap) => {
    const row = snap.val()
    const pushId = snap.key
    if (!row || typeof row !== 'object') return
    const clientTs = Number(row.clientTs) || 0
    if (clientTs < joinTs) return
    if (row.killerUid !== uid) return
    const victimMode = row.victimInnocent
      ? 'white'
      : row.victimPk
        ? 'red'
        : row.bothPvp
          ? 'purple'
          : 'white'
    try {
      mc.fusPvp?.onKillPlayer?.(row.victimUid, victimMode)
    } catch (e) {
      console.warn('[fusPlayerCombat] onKillPlayer threw', e)
    }
    /** Cleanup isn't rule-permitted on deaths (the rule is append-only) — leaving the
     *  row behind is fine; it's valuable as a scoreboard artifact. */
    void pushId
  }

  const hitsUnsub = onChildAdded(inboxQuery, handleIncomingHit)
  const deathsUnsub = onChildAdded(deathsQuery, handleIncomingDeath)

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      hitsUnsub?.()
    } catch {
      /* ignore */
    }
    try {
      deathsUnsub?.()
    } catch {
      /* ignore */
    }
    /** Restore the previous melee hook so a later install order still works on hot-reload. */
    mc.fusTryRemoteMelee = prevRemoteMelee
  }
  mc.fusDisposePlayerCombat = dispose
  return dispose
}

/**
 * Outgoing per-attack damage in HP units, composed from:
 *   • the hotbar-selected tool (or fist if empty) → {@link fusAttackDamageHalfHearts},
 *   • a linear per-level multiplier baked into that helper.
 *
 * Earlier version was a flat "8 HP at level 1" which ignored both the held item and the
 * user's "fist is baseline, deals least damage" requirement — a bare-handed level-1 player
 * was one-shotting level-1 mobs, and level-50 golden-sword players were only marginally
 * stronger than level-1 fist-fighters.
 */
function damageForLevel(mc) {
  return fusAttackDamageHp(mc)
}
