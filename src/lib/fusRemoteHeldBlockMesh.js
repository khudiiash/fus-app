import * as THREE from '@labymc/libraries/three.module.js'
import Block from '@labymc/src/js/net/minecraft/client/world/block/Block.js'
import EnumBlockFace from '@labymc/src/js/net/minecraft/util/EnumBlockFace.js'
import { readTerrainAtlasMetrics, tileUvsForLinearIndex, toLinearMacrotileIndex } from '@labymc/src/js/net/minecraft/client/render/TerrainAtlasUV.js'

/**
 * Third-person held block for remote avatars: one mesh, terrain atlas UVs (same layout as
 * {@link BlockRenderer}), unlit + per-face tint/shade. Does not own the terrain texture.
 *
 * @param {number} heldId
 * @param {import('three').Texture} textureTerrain
 * @returns {THREE.Mesh | null}
 */
export function fusCreateRemoteHeldBlockMesh(heldId, textureTerrain) {
  if (!textureTerrain) return null
  const block = Block.getById(heldId) || Block.getById(1)
  if (!block) return null

  const m = readTerrainAtlasMetrics(textureTerrain)
  const h = 2.5
  const minX = -h
  const maxX = h
  const minY = -h
  const maxY = h
  const minZ = -h
  const maxZ = h

  const positions = []
  const uvs = []
  const colors = []
  const indices = []

  const pushV = (x, y, z, u, v, r, g, b) => {
    positions.push(x, y, z)
    uvs.push(u, v)
    colors.push(r, g, b)
  }

  const faceRgb = (face) => {
    let c = 0xffffff
    try {
      c = block.getColor(null, 0, 0, 0, face)
    } catch {
      c = 0xffffff
    }
    const r0 = ((c >> 16) & 255) / 255
    const g0 = ((c >> 8) & 255) / 255
    const b0 = (c & 255) / 255
    const sh = face.getShading()
    return [r0 * sh, g0 * sh, b0 * sh]
  }

  const faces = EnumBlockFace.values()
  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi]
    const ti = block.getTextureForFace(face)
    const linear = toLinearMacrotileIndex(ti, m.tilesX)
    let { minU, maxU, minV, maxV } = tileUvsForLinearIndex(linear, m.w, m.h, m.tilesX, m.tilesY)
    if (block.getId() === 2 && face !== EnumBlockFace.TOP && face !== EnumBlockFace.BOTTOM) {
      const tv = minV
      minV = maxV
      maxV = tv
    }
    const [r, g, b] = faceRgb(face)

    const b0 = positions.length / 3
    if (face === EnumBlockFace.BOTTOM) {
      pushV(maxX, minY, maxZ, maxU, maxV, r, g, b)
      pushV(maxX, minY, minZ, maxU, minV, r, g, b)
      pushV(minX, minY, minZ, minU, minV, r, g, b)
      pushV(minX, minY, maxZ, minU, maxV, r, g, b)
    } else if (face === EnumBlockFace.TOP) {
      pushV(minX, maxY, maxZ, minU, maxV, r, g, b)
      pushV(minX, maxY, minZ, minU, minV, r, g, b)
      pushV(maxX, maxY, minZ, maxU, minV, r, g, b)
      pushV(maxX, maxY, maxZ, maxU, maxV, r, g, b)
    } else if (face === EnumBlockFace.NORTH) {
      pushV(minX, maxY, minZ, minU, minV, r, g, b)
      pushV(minX, minY, minZ, minU, maxV, r, g, b)
      pushV(maxX, minY, minZ, maxU, maxV, r, g, b)
      pushV(maxX, maxY, minZ, maxU, minV, r, g, b)
    } else if (face === EnumBlockFace.SOUTH) {
      pushV(minX, maxY, maxZ, maxU, minV, r, g, b)
      pushV(maxX, maxY, maxZ, minU, minV, r, g, b)
      pushV(maxX, minY, maxZ, minU, maxV, r, g, b)
      pushV(minX, minY, maxZ, maxU, maxV, r, g, b)
    } else if (face === EnumBlockFace.WEST) {
      pushV(minX, minY, maxZ, minU, maxV, r, g, b)
      pushV(minX, minY, minZ, maxU, maxV, r, g, b)
      pushV(minX, maxY, minZ, maxU, minV, r, g, b)
      pushV(minX, maxY, maxZ, minU, minV, r, g, b)
    } else if (face === EnumBlockFace.EAST) {
      pushV(maxX, maxY, maxZ, maxU, minV, r, g, b)
      pushV(maxX, maxY, minZ, minU, minV, r, g, b)
      pushV(maxX, minY, minZ, minU, maxV, r, g, b)
      pushV(maxX, minY, maxZ, maxU, maxV, r, g, b)
    }
    indices.push(b0, b0 + 2, b0 + 1, b0, b0 + 3, b0 + 2)
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geom.setIndex(indices)

  const mat = new THREE.MeshBasicMaterial({
    map: textureTerrain,
    vertexColors: true,
    side: THREE.DoubleSide,
    /** Opaque + depth so the cube occludes and is occluded by players (avoids "through" other avatars). */
    transparent: false,
    alphaTest: 0.4,
    depthTest: true,
    depthWrite: true,
    fog: false,
    toneMapped: false,
  })

  const mesh = new THREE.Mesh(geom, mat)
  mesh.userData.fusRemoteHeldBlock = true
  mesh.renderOrder = 0
  return mesh
}

/** Geometry + material only — does not dispose {@code textureTerrain}. */
export function fusDisposeRemoteHeldBlockMesh(mesh) {
  if (!mesh) return
  try {
    mesh.geometry?.dispose?.()
  } catch {
    /* ignore */
  }
  const m = mesh.material
  if (m) {
    m.map = null
    try {
      m.dispose?.()
    } catch {
      /* ignore */
    }
  }
}
