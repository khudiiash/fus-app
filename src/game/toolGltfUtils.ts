import * as THREE from 'three'

/**
 * Pickaxe GLB helpers.
 *
 * Blender: pivot at handle bottom, pickaxe standing “up” is fine — export as glTF
 * and set {@link TOOL_GRIP_TO_HEAD} to the axis from that pivot toward the head
 * in **file** space (often +Y after Y-up export). No need to match Three.js axes in Blender.
 */

/**
 * Uniform scale so the largest AABB edge equals `maxDim`.
 * Does **not** re-center: keep Blender origin (e.g. grip at handle tip).
 */
export function scaleGltfToMaxDimension(root: THREE.Object3D, maxDim: number) {
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const m = Math.max(size.x, size.y, size.z, 1e-4)
  root.scale.setScalar(maxDim / m)
}

/** First-person tool max AABB edge (world units); keep modest so GLB tools do not dominate the view. */
export const FP_TOOL_MAX_DIM = 0.78
/**
 * Remote rig arm is tiny in world space — scale held tool vs FP so it reads at distance.
 * Was 3× FP; now **6× FP** (2× the previous remote size per design request).
 */
export const REMOTE_TOOL_MAX_DIM = FP_TOOL_MAX_DIM * 6

/**
 * In your GLB, unit vector from **grip (origin)** toward **pickaxe head**.
 *
 * Blender: vertical pickaxe with pivot at handle bottom → after glTF export
 * the long axis is usually **+Y** (Y-up). If the tool is invisible or edge-on,
 * try `(0, -1, 0)` or `(0, 0, 1)` here to match your file.
 */
export const TOOL_GRIP_TO_HEAD = new THREE.Vector3(0, 1, 0)

/**
 * First-person “view” grip→head direction (same frame as used with {@link orientPickaxeForFirstPerson}
 * and the camera-hand `root`). Tweak this when tuning FP tools; remotes rotate it by body yaw.
 */
export const FP_TOOL_HEAD_DIR_CAM = new THREE.Vector3(8.18, -1, -2.18).normalize()

const _invQ = new THREE.Quaternion()
const _dir = new THREE.Vector3()
const _tmpYawQ = new THREE.Quaternion()
const _yAxis = new THREE.Vector3(0, 1, 0)

/**
 * Orients `tool` (child of `parent`) so {@link TOOL_GRIP_TO_HEAD} aligns with
 * {@link FP_TOOL_HEAD_DIR_CAM} expressed in `parent` local space.
 */
export function orientPickaxeForFirstPerson(
  tool: THREE.Object3D,
  parent: THREE.Object3D,
) {
  _invQ.copy(parent.quaternion).invert()
  _dir.copy(FP_TOOL_HEAD_DIR_CAM).applyQuaternion(_invQ).normalize()
  tool.quaternion.setFromUnitVectors(TOOL_GRIP_TO_HEAD.clone().normalize(), _dir)
}

/**
 * Orients a held tool whose **immediate parent** is `immediateParent`, so that
 * {@link TOOL_GRIP_TO_HEAD} points along `headDirWorld` (unit vector in world space).
 */
export function orientHeldToolGripToWorldDir(
  tool: THREE.Object3D,
  immediateParent: THREE.Object3D,
  headDirWorld: THREE.Vector3,
) {
  immediateParent.updateMatrixWorld(true)
  const pw = new THREE.Quaternion()
  immediateParent.getWorldQuaternion(pw)
  _invQ.copy(pw).invert()
  _dir.copy(headDirWorld).applyQuaternion(_invQ).normalize()
  tool.quaternion.setFromUnitVectors(TOOL_GRIP_TO_HEAD.clone().normalize(), _dir)
}

/** World-space tool head direction for a remote body yaw (matches FP aim vs facing). */
export function remoteToolHeadDirWorld(bodyYaw: number, out = new THREE.Vector3()) {
  _tmpYawQ.setFromAxisAngle(_yAxis, bodyYaw)
  return out.copy(FP_TOOL_HEAD_DIR_CAM).applyQuaternion(_tmpYawQ).normalize()
}

/**
 * Strong emissive + albedo multiply reads as “washed white” under ACES; keep fill tiny so
 * {@link applySrgbColorMaps} textures stay the dominant color, with slightly lower roughness for sun.
 */
const HAND_NEUTRAL_FILL = new THREE.Color(0xffffff)
const HAND_NEUTRAL_FILL_INTENSITY = 0.028

export function applyHandHeldLightingLift(
  m: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
) {
  m.emissive.copy(HAND_NEUTRAL_FILL)
  m.emissiveIntensity = HAND_NEUTRAL_FILL_INTENSITY
  m.emissiveMap = null
  m.roughness = Math.min(0.78, (m.roughness ?? 0.88) * 0.86)
}

/** Color maps must be sRGB so lit materials match the block world (Linear looks muddy / wrong). */
export function applySrgbColorMaps(
  m: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
) {
  if (m.map) m.map.colorSpace = THREE.SRGBColorSpace
  if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.SRGBColorSpace
}

/**
 * One-time axis flip on the tool root fixes inverted faces on many Blender → glTF voxel exports.
 * Compose after scale + orientation. If the pickaxe still looks inside-out, change to
 * `new THREE.Vector3(1, -1, 1)` or `(1, 1, -1)` to match your file.
 */
export function flipToolRootWindingX(root: THREE.Object3D) {
  root.scale.multiply(new THREE.Vector3(-1, 1, 1))
}

/**
 * Remote held pickaxe: lit, correct color space, front faces only, mild polygon offset.
 * Call after {@link flipToolRootWindingX} if you use it on the same root.
 */
export function configureRemoteToolMaterials(root: THREE.Object3D) {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    const next = mats.map((m) => {
      if (m instanceof THREE.MeshPhysicalMaterial || m instanceof THREE.MeshStandardMaterial) {
        const c = m.clone()
        applySrgbColorMaps(c)
        applyHandHeldLightingLift(c)
        c.side = THREE.FrontSide
        c.polygonOffset = true
        c.polygonOffsetFactor = -0.6
        c.polygonOffsetUnits = -0.6
        return c
      }
      if (m instanceof THREE.MeshBasicMaterial) {
        const c = new THREE.MeshStandardMaterial({
          map: m.map ?? undefined,
          color: m.color?.clone() ?? new THREE.Color(0xffffff),
          roughness: 0.72,
          metalness: 0.05,
          side: THREE.FrontSide,
          polygonOffset: true,
          polygonOffsetFactor: -0.6,
          polygonOffsetUnits: -0.6,
        })
        if (c.map) c.map.colorSpace = THREE.SRGBColorSpace
        applyHandHeldLightingLift(c)
        return c
      }
      return m
    })
    o.material = next.length === 1 ? next[0]! : next
  })
}
