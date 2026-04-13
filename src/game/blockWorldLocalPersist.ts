import * as THREE from 'three'

const STORAGE_PREFIX = 'fus:blockWorld:lastPose:'

export function lastPoseStorageKey(worldId: string, uid: string) {
  return `${STORAGE_PREFIX}${worldId}:${uid}`
}

export type StoredCameraPose = {
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
}

function isValidPose(p: unknown): p is StoredCameraPose {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  for (const k of ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const) {
    const v = o[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
  }
  const { x, y, z } = o as StoredCameraPose
  if (y < -120 || y > 450) return false
  if (Math.abs(x) > 100_000 || Math.abs(z) > 100_000) return false
  return true
}

export function loadLastCameraPose(
  worldId: string,
  uid: string,
): StoredCameraPose | null {
  try {
    const raw = localStorage.getItem(lastPoseStorageKey(worldId, uid))
    if (!raw) return null
    const p = JSON.parse(raw) as unknown
    return isValidPose(p) ? p : null
  } catch {
    return null
  }
}

export function saveLastCameraPose(
  worldId: string,
  uid: string,
  camera: THREE.PerspectiveCamera,
) {
  try {
    const q = camera.quaternion
    const data: StoredCameraPose = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
    }
    localStorage.setItem(lastPoseStorageKey(worldId, uid), JSON.stringify(data))
  } catch {
    /* quota / private mode */
  }
}

export function applyStoredPoseToCamera(
  camera: THREE.PerspectiveCamera,
  pose: StoredCameraPose,
) {
  camera.position.set(pose.x, pose.y, pose.z)
  camera.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw).normalize()
}
