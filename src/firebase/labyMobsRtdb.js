import { get, ref, remove } from 'firebase/database'
import { rtdb } from '@/firebase/config'
import { FUS_SHARED_WORLD_LABY_ID } from '@/firebase/sharedWorldLaby'

/**
 * Remove each direct child under `basePath` (one `remove()` per key). Needed for
 * `worldMobPlayerHits`: rules only allow `.write` on each `$pushId`, not on the
 * `worldId` parent, so `remove(parentPath)` is denied.
 */
async function removeAllChildren(basePath) {
  const base = ref(rtdb, basePath)
  const snap = await get(base)
  if (!snap.exists()) return
  const val = snap.val()
  if (val == null || typeof val !== 'object') return
  const keys = Object.keys(val)
  if (keys.length === 0) return
  await Promise.all(keys.map((k) => remove(ref(rtdb, `${basePath}/${k}`))))
}

/**
 * Delete every mob instance and pending hit for the shared Laby world.
 *
 * @param {string} [worldId]
 * @returns {Promise<void>}
 */
export async function clearLabySharedWorldMobsRtdb(worldId = FUS_SHARED_WORLD_LABY_ID) {
  const w = String(worldId || FUS_SHARED_WORLD_LABY_ID)
  await remove(ref(rtdb, `worldMobs/${w}/instances`))
  await removeAllChildren(`worldMobPlayerHits/${w}`)
}
