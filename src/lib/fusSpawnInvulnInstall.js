/**
 * 5s spawn / respawn invulnerability: no outgoing hits, no incoming PvE/PvP damage, no mob aggro.
 * Drives `mc.fusSpawnInvulnUntilMs` (wall ms) and relies on `fusPlayerCombatInstall`,
 * `fusSimpleMobsInstall`, `WorldRenderer`, `fusPresenceWriterInstall`, and `fusRemoteAvatarsInstall`.
 */
export const FUS_SPAWN_INVULN_MS = 5000

/**
 * @param {any} mc
 * @returns {() => void} dispose
 */
export function installFusSpawnInvuln(mc) {
  if (!mc) return () => {}

  const refresh = () => {
    mc.fusSpawnInvulnUntilMs = Date.now() + FUS_SPAWN_INVULN_MS
    try {
      mc.fusForcePresenceWrite?.()
    } catch {
      /* ignore */
    }
  }
  mc.fusRefreshSpawnInvuln = refresh
  const dispose = () => {
    delete mc.fusRefreshSpawnInvuln
    delete mc.fusSpawnInvulnUntilMs
    delete mc.fusDisposeSpawnInvuln
  }
  mc.fusDisposeSpawnInvuln = dispose
  refresh()

  return dispose
}
