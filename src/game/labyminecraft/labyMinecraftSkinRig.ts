/**
 * Minecraft-style skin rig for Laby's {@link THREE} build — same layout as
 * {@link SkinObject} in `minecraft-character/model.js`, but {@link THREE.MeshBasicMaterial}
 * so it stays visible without scene lighting.
 */
import * as THREE from '@labymc/libraries/three.module.js'

function setUVs(
  box: THREE.BoxGeometry,
  u: number,
  v: number,
  width: number,
  height: number,
  depth: number,
  textureWidth: number,
  textureHeight: number,
) {
  const toFaceVertices = (x1: number, y1: number, x2: number, y2: number) => [
    new THREE.Vector2(x1 / textureWidth, 1.0 - y2 / textureHeight),
    new THREE.Vector2(x2 / textureWidth, 1.0 - y2 / textureHeight),
    new THREE.Vector2(x2 / textureWidth, 1.0 - y1 / textureHeight),
    new THREE.Vector2(x1 / textureWidth, 1.0 - y1 / textureHeight),
  ]
  const top = toFaceVertices(u + depth, v, u + width + depth, v + depth)
  const bottom = toFaceVertices(u + width + depth, v, u + width * 2 + depth, v + depth)
  const left = toFaceVertices(u, v + depth, u + depth, v + depth + height)
  const front = toFaceVertices(u + depth, v + depth, u + width + depth, v + depth + height)
  const right = toFaceVertices(u + width + depth, v + depth, u + width + depth * 2, v + height + depth)
  const back = toFaceVertices(u + width + depth * 2, v + depth, u + width * 2 + depth * 2, v + height + depth)
  const uvAttr = box.attributes.uv as THREE.BufferAttribute
  const uvRight = [right[3], right[2], right[0], right[1]]
  const uvLeft = [left[3], left[2], left[0], left[1]]
  const uvTop = [top[3], top[2], top[0], top[1]]
  const uvBottom = [bottom[0], bottom[1], bottom[3], bottom[2]]
  const uvFront = [front[3], front[2], front[0], front[1]]
  const uvBack = [back[3], back[2], back[0], back[1]]
  const newUVData: number[] = []
  for (const uvArray of [uvRight, uvLeft, uvTop, uvBottom, uvFront, uvBack]) {
    for (const uv of uvArray) {
      newUVData.push(uv.x, uv.y)
    }
  }
  uvAttr.set(new Float32Array(newUVData))
  uvAttr.needsUpdate = true
}

function setSkinUVs(
  box: THREE.BoxGeometry,
  u: number,
  v: number,
  width: number,
  height: number,
  depth: number,
  texW: number,
  texH: number,
) {
  setUVs(box, u, v, width, height, depth, texW, texH)
}

/** Body part: inner + outer layer meshes (matches skinview naming). */
class BodyPart extends THREE.Group {
  constructor(
    readonly innerLayer: THREE.Mesh,
    readonly outerLayer: THREE.Mesh,
  ) {
    super()
    innerLayer.name = 'inner'
    outerLayer.name = 'outer'
  }
}

export class LabyMinecraftSkinRig extends THREE.Group {
  readonly head: BodyPart
  readonly body: BodyPart
  readonly rightArm: BodyPart
  readonly leftArm: BodyPart
  readonly rightLeg: BodyPart
  readonly leftLeg: BodyPart

  private readonly layer1: THREE.MeshBasicMaterial
  private readonly layer2: THREE.MeshBasicMaterial
  private readonly layer1Biased: THREE.MeshBasicMaterial
  private readonly layer2Biased: THREE.MeshBasicMaterial
  private readonly uvRefreshers: Array<() => void>
  private texW = 64
  private texH = 64

  constructor(private readonly slim: boolean = false) {
    super()
    this.name = 'laby-skin-rig'

    this.layer1 = new THREE.MeshBasicMaterial({ side: THREE.FrontSide })
    this.layer2 = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      alphaTest: 1e-3,
      depthWrite: true,
    })
    this.layer1Biased = this.layer1.clone()
    this.layer1Biased.polygonOffset = true
    this.layer1Biased.polygonOffsetFactor = 1
    this.layer1Biased.polygonOffsetUnits = 1
    this.layer2Biased = this.layer2.clone()
    this.layer2Biased.polygonOffset = true
    this.layer2Biased.polygonOffsetFactor = 1
    this.layer2Biased.polygonOffsetUnits = 1

    const tw = () => this.texW
    const th = () => this.texH
    const m = () => tw() / 64

    this.uvRefreshers = []

    const headBox = new THREE.BoxGeometry(8, 8, 8)
    const headMesh = new THREE.Mesh(headBox, this.layer1)
    const head2Box = new THREE.BoxGeometry(9, 9, 9)
    const head2Mesh = new THREE.Mesh(head2Box, this.layer2)
    this.uvRefreshers.push(() => {
      const s = m()
      setSkinUVs(headBox, 0 * s, 0 * s, 8 * s, 8 * s, 8 * s, tw(), th())
      setSkinUVs(head2Box, 32 * s, 0 * s, 8 * s, 8 * s, 8 * s, tw(), th())
    })
    this.head = new BodyPart(headMesh, head2Mesh)
    this.head.name = 'head'
    this.head.add(headMesh, head2Mesh)
    headMesh.position.y = 4
    head2Mesh.position.y = 4
    this.add(this.head)

    const bodyBox = new THREE.BoxGeometry(8, 12, 4)
    const bodyMesh = new THREE.Mesh(bodyBox, this.layer1)
    const body2Box = new THREE.BoxGeometry(8.5, 12.5, 4.5)
    const body2Mesh = new THREE.Mesh(body2Box, this.layer2)
    this.uvRefreshers.push(() => {
      const s = m()
      setSkinUVs(bodyBox, 16 * s, 16 * s, 8 * s, 12 * s, 4 * s, tw(), th())
      setSkinUVs(body2Box, 16 * s, 32 * s, 8 * s, 12 * s, 4 * s, tw(), th())
    })
    this.body = new BodyPart(bodyMesh, body2Mesh)
    this.body.name = 'body'
    this.body.add(bodyMesh, body2Mesh)
    this.body.position.y = -6
    this.add(this.body)

    const rightArmBox = new THREE.BoxGeometry()
    const rightArmMesh = new THREE.Mesh(rightArmBox, this.layer1Biased)
    const rightArm2Box = new THREE.BoxGeometry()
    const rightArm2Mesh = new THREE.Mesh(rightArm2Box, this.layer2Biased)
    const rightArmPivot = new THREE.Group()
    rightArmPivot.add(rightArmMesh, rightArm2Mesh)
    this.uvRefreshers.push(() => {
      const s = m()
      const wx = this.slim ? 3 : 4
      rightArmMesh.scale.set(this.slim ? 3 : 4, 12, 4)
      rightArm2Mesh.scale.set(this.slim ? 3.5 : 4.5, 12.5, 4.5)
      setSkinUVs(rightArmBox, 40 * s, 16 * s, wx * s, 12 * s, 4 * s, tw(), th())
      setSkinUVs(rightArm2Box, 40 * s, 32 * s, wx * s, 12 * s, 4 * s, tw(), th())
      rightArmPivot.position.x = this.slim ? -0.5 : -1
    })
    rightArmPivot.position.y = -4
    this.rightArm = new BodyPart(rightArmMesh, rightArm2Mesh)
    this.rightArm.name = 'rightArm'
    this.rightArm.add(rightArmPivot)
    this.rightArm.position.set(-5, -2, 0)
    this.add(this.rightArm)

    const leftArmBox = new THREE.BoxGeometry()
    const leftArmMesh = new THREE.Mesh(leftArmBox, this.layer1Biased)
    const leftArm2Box = new THREE.BoxGeometry()
    const leftArm2Mesh = new THREE.Mesh(leftArm2Box, this.layer2Biased)
    const leftArmPivot = new THREE.Group()
    leftArmPivot.add(leftArmMesh, leftArm2Mesh)
    this.uvRefreshers.push(() => {
      const s = m()
      const wx = this.slim ? 3 : 4
      leftArmMesh.scale.set(this.slim ? 3 : 4, 12, 4)
      leftArm2Mesh.scale.set(this.slim ? 3.5 : 4.5, 12.5, 4.5)
      setSkinUVs(leftArmBox, 32 * s, 48 * s, wx * s, 12 * s, 4 * s, tw(), th())
      setSkinUVs(leftArm2Box, 48 * s, 48 * s, wx * s, 12 * s, 4 * s, tw(), th())
      leftArmPivot.position.x = this.slim ? 0.5 : 1
    })
    leftArmPivot.position.y = -4
    this.leftArm = new BodyPart(leftArmMesh, leftArm2Mesh)
    this.leftArm.name = 'leftArm'
    this.leftArm.add(leftArmPivot)
    this.leftArm.position.set(5, -2, 0)
    this.add(this.leftArm)

    const rightLegBox = new THREE.BoxGeometry(4, 12, 4)
    const rightLegMesh = new THREE.Mesh(rightLegBox, this.layer1Biased)
    const rightLeg2Box = new THREE.BoxGeometry(4.5, 12.5, 4.5)
    const rightLeg2Mesh = new THREE.Mesh(rightLeg2Box, this.layer2Biased)
    const rightLegPivot = new THREE.Group()
    rightLegPivot.add(rightLegMesh, rightLeg2Mesh)
    this.uvRefreshers.push(() => {
      const s = m()
      setSkinUVs(rightLegBox, 0 * s, 16 * s, 4 * s, 12 * s, 4 * s, tw(), th())
      setSkinUVs(rightLeg2Box, 0 * s, 32 * s, 4 * s, 12 * s, 4 * s, tw(), th())
    })
    rightLegPivot.position.y = -6
    this.rightLeg = new BodyPart(rightLegMesh, rightLeg2Mesh)
    this.rightLeg.name = 'rightLeg'
    this.rightLeg.add(rightLegPivot)
    this.rightLeg.position.set(-1.9, -12, -0.1)
    this.add(this.rightLeg)

    const leftLegBox = new THREE.BoxGeometry(4, 12, 4)
    const leftLegMesh = new THREE.Mesh(leftLegBox, this.layer1Biased)
    const leftLeg2Box = new THREE.BoxGeometry(4.5, 12.5, 4.5)
    const leftLeg2Mesh = new THREE.Mesh(leftLeg2Box, this.layer2Biased)
    const leftLegPivot = new THREE.Group()
    leftLegPivot.add(leftLegMesh, leftLeg2Mesh)
    this.uvRefreshers.push(() => {
      const s = m()
      setSkinUVs(leftLegBox, 16 * s, 48 * s, 4 * s, 12 * s, 4 * s, tw(), th())
      setSkinUVs(leftLeg2Box, 0 * s, 48 * s, 4 * s, 12 * s, 4 * s, tw(), th())
    })
    leftLegPivot.position.y = -6
    this.leftLeg = new BodyPart(leftLegMesh, leftLeg2Mesh)
    this.leftLeg.name = 'leftLeg'
    this.leftLeg.add(leftLegPivot)
    this.leftLeg.position.set(1.9, -12, -0.1)
    this.add(this.leftLeg)

    this.refreshUVs()

    this.traverse((o) => {
      if (o instanceof THREE.Mesh) o.frustumCulled = false
    })
  }

  private refreshUVs() {
    for (const fn of this.uvRefreshers) fn()
  }

  /**
   * Skin PNG width/height (64 or 128). Updates per-face UVs for HD layouts.
   */
  setTexturePixelSize(w: number, h: number) {
    const nw = Number.isFinite(w) && w >= 32 ? Math.floor(w) : 64
    const nh = Number.isFinite(h) && h >= 32 ? Math.floor(h) : 64
    if (nw === this.texW && nh === this.texH) return
    this.texW = nw
    this.texH = nh
    this.refreshUVs()
  }

  /** Assigns the same map to all skin layers. Does not dispose previous maps — caller owns textures. */
  setSkinMap(map: THREE.Texture | null) {
    for (const m of [this.layer1, this.layer2, this.layer1Biased, this.layer2Biased]) {
      m.map = map
      m.needsUpdate = true
    }
  }

  resetPose() {
    this.head.rotation.set(0, 0, 0)
    this.leftArm.rotation.set(0, 0, 0)
    this.rightArm.rotation.set(0, 0, 0)
    this.leftLeg.rotation.set(0, 0, 0)
    this.rightLeg.rotation.set(0, 0, 0)
    this.body.rotation.set(0, 0, 0)
    this.head.position.y = 0
    this.body.position.set(0, -6, 0)
    this.rightArm.position.set(-5, -2, 0)
    this.leftArm.position.set(5, -2, 0)
    this.rightLeg.position.set(-1.9, -12, -0.1)
    this.leftLeg.position.set(1.9, -12, -0.1)
  }

  disposeGeometriesAndMaterials() {
    this.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose()
      }
    })
    for (const m of [this.layer1, this.layer2, this.layer1Biased, this.layer2Biased]) {
      m.map = null
      m.dispose()
    }
  }
}

/** Wrapper matching block-world remote {@link PlayerObject} placement (scale + lift). */
export function createLabyPresencePlayerWrapper(
  skinRig: LabyMinecraftSkinRig,
  modelScale: number,
  worldHalfHeight: number,
): THREE.Group {
  const wrap = new THREE.Group()
  wrap.name = 'laby-presence-player-wrap'
  skinRig.position.y = 8
  wrap.add(skinRig)
  wrap.scale.setScalar(modelScale)
  wrap.position.y = worldHalfHeight
  return wrap
}
