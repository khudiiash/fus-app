import * as THREE from 'three'

const _fwd = new THREE.Vector3()

/**
 * Horizontal yaw (radians) from camera look direction on XZ.
 * Prefer this over `camera.rotation.y` when the camera uses a quaternion (PointerLock / touch look):
 * default Euler `rotation.y` is not a stable yaw when pitch changes.
 */
export function cameraYawFromQuaternion(q: THREE.Quaternion): number {
  _fwd.set(0, 0, -1).applyQuaternion(q)
  return Math.atan2(_fwd.x, _fwd.z)
}
