import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { TOOLS_PACK_GLB_URL } from '@/game/blockWorldToolsRegistry'
import {
  applyHandHeldLightingLift,
  applySrgbColorMaps,
  configureRemoteToolMaterials,
  flipToolRootWindingX,
  FP_TOOL_MAX_DIM,
  orientPickaxeForFirstPerson,
  REMOTE_TOOL_MAX_DIM,
  scaleGltfToMaxDimension,
  stampFpHandPresentation,
} from '@/game/toolGltfUtils'

let packScene: THREE.Group | null = null
let loadPromise: Promise<THREE.Group> | null = null

const GLTF_MAP_KEYS = [
  'map',
  'emissiveMap',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'lightMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'specularMap',
  'envMap',
  'clearcoatNormalMap',
] as const

function setTextureNearest(tex: THREE.Texture) {
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
}

/** Voxel tools: GLTF defaults often use linear mipmaps — force crisp pixels like `terrain.png`. */
function setNearestOnAllMaterialTextures(root: THREE.Object3D) {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) {
      if (!m || typeof m !== 'object') continue
      const rec = m as unknown as Record<string, unknown>
      for (const k of GLTF_MAP_KEYS) {
        const t = rec[k]
        if (t instanceof THREE.Texture) setTextureNearest(t)
      }
    }
  })
}

function configureFpToolMaterials(
  root: THREE.Object3D,
  presentation: 'blockworld' | 'laby' = 'blockworld',
) {
  const laby = presentation === 'laby'
  root.traverse((o) => {
    o.frustumCulled = false
    if (o instanceof THREE.Mesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      const next = mats.map((m) => {
        if (laby) {
          /** Laby overlay pass has no lights — lit Standard materials read as black/grey. */
          if (
            m instanceof THREE.MeshPhysicalMaterial ||
            m instanceof THREE.MeshStandardMaterial ||
            m instanceof THREE.MeshLambertMaterial ||
            m instanceof THREE.MeshPhongMaterial ||
            m instanceof THREE.MeshBasicMaterial
          ) {
            const src = m as { map?: THREE.Texture | null | undefined; color?: THREE.Color }
            const c = new THREE.MeshBasicMaterial({
              map: src.map ?? undefined,
              color: src.color?.clone() ?? new THREE.Color(0xffffff),
              side: THREE.FrontSide,
              depthTest: false,
              depthWrite: false,
            })
            if (c.map) {
              c.map.colorSpace = THREE.NoColorSpace
              setTextureNearest(c.map)
            }
            return c
          }
          return m
        }
        if (m instanceof THREE.MeshPhysicalMaterial) {
          const c = m.clone()
          c.toneMapped = true
          applySrgbColorMaps(c)
          applyHandHeldLightingLift(c)
          c.side = THREE.FrontSide
          stampFpHandPresentation(c)
          for (const k of GLTF_MAP_KEYS) {
            const t = (c as unknown as Record<string, unknown>)[k]
            if (t instanceof THREE.Texture) setTextureNearest(t)
          }
          return c
        }
        if (m instanceof THREE.MeshStandardMaterial) {
          const c = m.clone()
          c.toneMapped = true
          applySrgbColorMaps(c)
          applyHandHeldLightingLift(c)
          c.side = THREE.FrontSide
          stampFpHandPresentation(c)
          for (const k of GLTF_MAP_KEYS) {
            const t = (c as unknown as Record<string, unknown>)[k]
            if (t instanceof THREE.Texture) setTextureNearest(t)
          }
          return c
        }
        if (m instanceof THREE.MeshBasicMaterial) {
          const c = new THREE.MeshStandardMaterial({
            map: m.map ?? undefined,
            color: m.color?.clone() ?? new THREE.Color(0xffffff),
            roughness: 0.72,
            metalness: 0.05,
            side: THREE.FrontSide,
          })
          if (c.map) {
            c.map.colorSpace = THREE.SRGBColorSpace
            setTextureNearest(c.map)
          }
          applyHandHeldLightingLift(c)
          stampFpHandPresentation(c)
          return c
        }
        return m
      })
      o.material = next.length === 1 ? next[0]! : next
    }
  })
}

/** Load `tools.glb` once; returns hidden template scene (do not add to world). */
export function loadBlockWorldToolsPackScene(): Promise<THREE.Group> {
  if (packScene) return Promise.resolve(packScene)
  if (!loadPromise) {
    loadPromise = (async () => {
      const gltf = await new GLTFLoader().loadAsync(TOOLS_PACK_GLB_URL)
      const scene = gltf.scene as THREE.Group
      packScene = scene
      scene.visible = false
      scene.traverse((o) => {
        o.frustumCulled = false
      })
      setNearestOnAllMaterialTextures(scene)
      return scene
    })().catch((e) => {
      loadPromise = null
      throw e
    })
  }
  return loadPromise
}

function findNamedToolRoot(scene: THREE.Group, meshName: string): THREE.Object3D | null {
  const o = scene.getObjectByName(meshName)
  return o ?? null
}

/** First-person: scaled + lit + oriented like the legacy pickaxe. */
export async function cloneToolForFirstPerson(
  meshName: string,
  orientParent: THREE.Object3D,
  presentation: 'blockworld' | 'laby' = 'blockworld',
): Promise<THREE.Object3D> {
  const scene = await loadBlockWorldToolsPackScene()
  const src = findNamedToolRoot(scene, meshName)
  if (!src) {
    console.warn('[toolsPack] missing mesh', meshName)
    const g = new THREE.Group()
    return g
  }
  const clone = src.clone(true)
  scaleGltfToMaxDimension(clone, FP_TOOL_MAX_DIM)
  configureFpToolMaterials(clone, presentation)
  orientPickaxeForFirstPerson(clone, orientParent)
  flipToolRootWindingX(clone)
  if (presentation === 'laby') {
    // Lower + tuck toward bottom-right (vanilla hand slot); Block World camera path unchanged.
    clone.position.set(0.06, -0.16, 0.02)
  } else {
    clone.position.set(0.08, 0.04, 0.06)
  }
  clone.frustumCulled = false
  return clone
}

/**
 * Remote avatar hand: same pack / scale / materials as configured in `toolGltfUtils`.
 * Call {@link orientHeldToolGripToWorldDir} with {@link remoteToolHeadDirWorld} **after** parenting
 * the clone under `handSwingPivot`.
 */
export async function cloneToolForRemote(meshName: string): Promise<THREE.Object3D> {
  const scene = await loadBlockWorldToolsPackScene()
  const src = findNamedToolRoot(scene, meshName)
  if (!src) {
    console.warn('[toolsPack] missing mesh (remote)', meshName)
    return new THREE.Group()
  }
  const clone = src.clone(true)
  scaleGltfToMaxDimension(clone, REMOTE_TOOL_MAX_DIM)
  configureRemoteToolMaterials(clone)
  clone.frustumCulled = false
  return clone
}
