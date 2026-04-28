import * as THREE from '@labymc/libraries/three.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Block from '@/js-minecraft/src/js/net/minecraft/client/world/block/Block.js'
import EnumBlockFace from '@/js-minecraft/src/js/net/minecraft/util/EnumBlockFace.js'
import {
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  ref as dbRef,
  remove as dbRemove,
  push as dbPush,
  set as dbSet,
  runTransaction,
} from 'firebase/database'
import { FUS_GAME_COIN_PICKUP_MAX, resolveBwSeedKeyWorldDropVisual } from '@/firebase/collections'
import {
  resolveFusToolsGltfObjectForFp,
  cloneToolForFirstPerson,
  applyFusTpToolMaterialPolicy,
  disposeFusFpToolSubtree,
} from '@/js-minecraft/src/js/net/minecraft/client/fus/FusToolsGltfFirstPerson.js'
import { fusLabyIsWithinAnimProcessRangeXz, fusLabyIsWithinPlayerInterestXz } from './fusLabyEntityTerrainWindow.js'

/**
 * World loot drops — physical coins and items sitting in the world, rotating / bobbing,
 * picked up by walking close.
 *
 * User request (2026-04): "coins (and potentially other items) must drop physically
 * into the world". "All must drop around the killed PK physically, as rotating items
 * on the ground, same as coins".
 *
 * Data model (RTDB, path `worldLootDrops/{worldId}/{dropId}`):
 *   ```
 *   {
 *     type: 'coin' | 'item',
 *     subtype?: 'tool' | 'skin' | 'block' | 'accessory',  // item-only
 *     coins?: number,                                      // coin stack 1..FUS_GAME_COIN_PICKUP_MAX
 *     payload?: object,                                    // { bwSeedKey?, skinId?, ... }
 *     x: number, y: number, z: number,
 *     droppedAt: number,        // Date.now() when created
 *     expiresAt: number,        // droppedAt + {@link DROP_LIFETIME_MS}
 *     winnerUid?: string,       // if set, only this uid can claim (PvP 1-coin transfer)
 *     loserUid?: string,        // source of PK/PvP drop — that user may never claim (no looting own corpse)
 *     claimedBy?: string,       // set during the claim transaction; node is then deleted
 *   }
 *   ```
 *
 * Pickup contract:
 *   • Local player walking within {@link PICKUP_RADIUS} of a drop triggers a claim
 *     `runTransaction` on `worldLootDrops/{worldId}/{dropId}`.
 *   • Transaction sets `claimedBy = uid` iff no-one else claimed and the winner-gate
 *     passes. On commit we dispatch `window.__FUS_GRANT_LOOT__` locally, then delete
 *     the node so every peer's observer removes the mesh.
 *   • If the drop already expired, any client may just delete it.
 *
 * Rendering:
 *   • Coins use the shipped `coin.glb` (loaded once, cloned per drop). The GLB has a
 *     natural gold disc mesh that reads well from any angle.
 *   • Items use a per-subtype box (coloured tool/skin/accessory, or **textured** block
 *     faces from the same `terrain/terrain.png` sheet as the world, via
 *     `Block.getTextureForFace` + per-face `MeshBasicMaterial`s).
 *   • Every drop rotates slowly around Y and bobs ±0.15 on Y. We set
 *     `THREE.MeshBasicMaterial` so the no-light minecraft scene still shows them at
 *     full brightness — mirrors {@link installFusSimpleMobs}.
 *   • Tiny coloured billboard above the drop shows the label ("+1 coin", "Rare item",
 *     etc.) so a PK loot pile is legible from across the map.
 *
 * Expiry / cleanup:
 *   • Drops use a long {@link DROP_LIFETIME_MS} (world “furniture” / PK piles must stay
 *     until someone picks them up). A periodic sweeper removes expired nodes so RTDB
 *     cannot grow unbounded if nobody visits an old drop.
 *
 * Public imperative API (callers decide when loot exists):
 *   • `mc.fusDropCoinAt(x, y, z, { coins, winnerUid })`
 *   • `mc.fusDropItemAt(x, y, z, { subtype, payload, label })`
 *
 * @param {any} mc
 * @param {{ worldId: string, uid: string, rtdb: any }} opts
 * @returns {() => void} dispose
 */
export function installFusWorldDrops(mc, { worldId, uid, rtdb }) {
  if (!mc || !mc.worldRenderer?.scene || !rtdb || !worldId || !uid) {
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('[fusWorldDrops] missing prereqs; skip install')
    }
    return () => {}
  }

  /** Long lifetime — coins/items are world state everyone should see and collect until
   *  claimed, not a short buff timer. */
  const DROP_LIFETIME_MS = 1000 * 60 * 60 * 24 * 7 /** 7 days */
  /** 1.5 blocks — matches vanilla Minecraft's pickup radius loosely. Tight enough that you
   *  have to *walk over* the coin, not wide enough to hoover up pickups from across a
   *  fight. */
  const PICKUP_RADIUS = 2.0
  const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS
  /** How often a drop's pickup check runs. 4 Hz is plenty — the claim is latency-bounded
   *  by RTDB anyway, and checking every frame burns CPU for no gain. */
  const PICKUP_CHECK_MS = 250
  /** How often the expiry sweeper runs across all drops we can see. */
  const SWEEP_MS = 4000

  const scene = mc.worldRenderer.scene

  /** @type {Map<string, { id: string, row: any, group: THREE.Group, label?: THREE.Mesh, bornAt: number, bobPhase: number, claiming: boolean, gone: boolean }>} */
  const drops = new Map()
  /**
   * Rows received over RTDB while the drop is outside local interest: no scene mesh until
   * the player moves close (PVP winner/loser gating in {@link addDrop} still applies).
   */
  /** @type {Map<string, any>} */
  const pendingDrops = new Map()

  /** Coin GLB template cache — one async load shared across every coin mesh. */
  /** @type {Promise<THREE.Group> | null} */
  let coinTemplatePromise = null
  const loadCoinTemplate = () => {
    if (coinTemplatePromise) return coinTemplatePromise
    const loader = new GLTFLoader()
    const base =
      typeof window !== 'undefined' && typeof window.__LABY_MC_ASSET_BASE__ === 'string'
        ? window.__LABY_MC_ASSET_BASE__
        : '/labyminecraft/'
    const revRaw =
      typeof window !== 'undefined'
        ? window.__FUS_ASSET_REV__ || window.__APP_BUILD_ID__ || window.__FUS_BUILD_ID__
        : ''
    const rev = String(revRaw || '').trim()
    const q = rev ? `?v=${encodeURIComponent(rev)}` : ''
    const url = `${base}src/resources/models/coin.glb${q}`
    const loadAttempt = (attempt = 0) =>
      new Promise((resolve) => {
        loader.load(
          url,
          (gltf) => {
          /** Replace PBR with unlit {@link THREE.MeshBasicMaterial} — no scene lights.
           *  If the mesh has vertex colors (`geometry.attributes.color`), set
           *  `vertexColors: true` and `color: 0xffffff` so exported colors are preserved; the
           *  material’s `color` tints the per-vertex color (multiply). */
            const root = gltf.scene
            root.traverse((o) => {
              if (!o.isMesh || !o.geometry) return
              const oldMat = o.material
              const newMat = new THREE.MeshBasicMaterial()
              newMat.copy(oldMat)
              o.material = newMat
            })
            try {
              const bbox = new THREE.Box3().setFromObject(root)
              const size = new THREE.Vector3()
              bbox.getSize(size)
              const h = Math.max(size.x, size.y, size.z)
              if (Number.isFinite(h) && h > 0.0001) {
                root.scale.setScalar(0.2 / h)
              }
            } catch {
              /* ignore */
            }
            resolve(root)
          },
          undefined,
          (err) => {
            if (attempt < 2) {
              setTimeout(() => {
                loadAttempt(attempt + 1).then(resolve)
              }, 300 * (attempt + 1))
              return
            }
            /** Network hiccup / 404 — fall back to a cylinder so the game still plays. */
            console.warn('[fusWorldDrops] coin.glb load failed, using fallback', err)
            const geom = new THREE.CylinderGeometry(0.12, 0.12, 0.04, 16)
            const mat = new THREE.MeshBasicMaterial({ color: 0xffcb40 })
            const mesh = new THREE.Mesh(geom, mat)
            mesh.rotation.x = Math.PI / 2
            const grp = new THREE.Group()
            grp.add(mesh)
            resolve(grp)
          },
        )
      })
    coinTemplatePromise = loadAttempt()
    return coinTemplatePromise
  }
  void loadCoinTemplate()

  /** Emissive per-subtype box for item drops. One shared geometry across all item drops. */
  const itemGeom = new THREE.BoxGeometry(0.38, 0.38, 0.38)
  const ITEM_COLORS = {
    tool: 0x9ca3af, /** grey-blue */
    skin: 0xa855f7, /** purple */
    block: 0x92400e, /** default if no blockId */
    accessory: 0xfbbf24, /** amber */
  }
  /**
   * Match hotbar/remote block cube colours ({@link heldIdToColor} in remote avatars).
   * @param {number} id
   * @returns {number} hex
   */
  /** Matches Three `BoxGeometry` + material index order: +X, −X, +Y, −Y, +Z, −Z. */
  const FUS_BOX_FACE_TO_ENUM = [
    EnumBlockFace.EAST,
    EnumBlockFace.WEST,
    EnumBlockFace.TOP,
    EnumBlockFace.BOTTOM,
    EnumBlockFace.SOUTH,
    EnumBlockFace.NORTH,
  ]

  /**
   * @param {THREE.Texture} terrain — {@link WorldRenderer#textureTerrain}
   * @param {number} slotIndex — 0..255, tile index in the 16×16 terrain atlas
   * @param {number} colorHex — biome/tint, multiplied with the tile
   * @returns {THREE.MeshBasicMaterial}
   */
  const makeTerrainTileMaterial = (terrain, slotIndex, colorHex) => {
    const t = terrain.clone()
    t.wrapS = THREE.ClampToEdgeWrapping
    t.wrapT = THREE.ClampToEdgeWrapping
    t.magFilter = THREE.NearestFilter
    t.minFilter = THREE.NearestFilter
    t.generateMipmaps = true
    t.repeat.set(1 / 16, 1 / 16)
    const s = ((slotIndex | 0) & 0xff) >>> 0
    const col = (s % 16) / 16
    const row = (s / 16) | 0
    t.offset.set(col, 1 - (row + 1) / 16)
    t.needsUpdate = true
    return new THREE.MeshBasicMaterial({
      map: t,
      color: (colorHex ?? 0xffffff) & 0xffffff,
      toneMapped: false,
    })
  }

  /**
   * One cube in world space, six tiles from the live terrain atlas (same as placed blocks).
   * @param {number} blockId
   * @returns {THREE.Group | null}
   */
  const buildTexturedBlockMesh = (blockId) => {
    const id = (blockId | 0) >>> 0
    if (id <= 0) return null
    const block = Block.getById(id)
    const terrain = mc.worldRenderer?.textureTerrain
    if (!block || !terrain) return null
    const materials = FUS_BOX_FACE_TO_ENUM.map((ef) => {
      const slot = (typeof block.getTextureForFace === 'function' ? block.getTextureForFace(ef) : block.textureSlotId) | 0
      const tint =
        typeof block.getColor === 'function' ? block.getColor(null, 0, 0, 0, ef) & 0xffffff : 0xffffff
      return makeTerrainTileMaterial(terrain, slot, tint)
    })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.38), materials)
    return mesh
  }

  /**
   * Scale/orient a cloned tools.glb subtree for a ground drop (~½ block footprint).
   * Models are authored lying on the XZ “floor” in Blender; {@link spinGroup} only spins
   * on world Y, so we wrap in {@code stand} with +90° on X so the tool stands upright and
   * the idle rotation reads as a natural tumble.
   * @param {THREE.Object3D} toolRoot
   */
  const fitToolMeshForWorldDrop = (toolRoot) => {
    applyFusTpToolMaterialPolicy(toolRoot)
    const box = new THREE.Box3().setFromObject(toolRoot)
    const size = new THREE.Vector3()
    box.getSize(size)
    const maxDim = Math.max(size.x, size.y, size.z, 1e-4)
    const target = 0.48
    toolRoot.scale.multiplyScalar(target / maxDim)
    const b = new THREE.Box3().setFromObject(toolRoot)
    const cx = (b.min.x + b.max.x) / 2
    const cz = (b.min.z + b.max.z) / 2
    toolRoot.position.set(-cx, -b.min.y, -cz)
    const stand = new THREE.Group()
    stand.rotation.x = Math.PI / 2
    stand.add(toolRoot)
    const g = new THREE.Group()
    g.userData.fusWorldDropTool = true
    g.add(stand)
    return g
  }

  const blockIdToDropColor = (id) => {
    const KNOWN = {
      1: 0x808080,
      2: 0x4caf50,
      3: 0x8d6e63,
      4: 0x6e6e6e,
      5: 0xb97a57,
      6: 0x8bc34a,
      7: 0x424242,
      8: 0x2196f3,
      9: 0x1565c0,
      10: 0xff5722,
      12: 0xf4e1a0,
      13: 0x9e9e9e,
      14: 0xffd54f,
      15: 0xbdbdbd,
      16: 0x424242,
      17: 0x6d4c41,
      18: 0x2e7d32,
      20: 0xe3f2fd,
      35: 0xffd54f,
      41: 0xffd700,
      42: 0xcfd8dc,
      49: 0x1b1b2d,
      50: 0xfde68a,
      56: 0x80deea,
      57: 0x4dd0e1,
    }
    return KNOWN[id] ?? 0xb0bec5
  }
  const buildItemMesh = (subtype, row) => {
    if (subtype === 'tool') {
      const meshName =
        typeof row?.payload?.toolMeshName === 'string' && row.payload.toolMeshName.trim()
          ? row.payload.toolMeshName.trim()
          : ''
      const tpl = mc.fusToolsGltfTemplate
      if (meshName && tpl) {
        try {
          const src = resolveFusToolsGltfObjectForFp(tpl, meshName)
          if (src) {
            const clone = cloneToolForFirstPerson(src)
            return fitToolMeshForWorldDrop(clone)
          }
        } catch (e) {
          console.warn('[fusWorldDrops] tool mesh failed', meshName, e)
        }
      }
    }
    if (subtype === 'block') {
      const bid = Math.floor(Number(row?.payload?.blockId))
      if (Number.isFinite(bid) && bid > 0) {
        const tx = buildTexturedBlockMesh(bid)
        if (tx) return tx
      }
    }
    let color = ITEM_COLORS[subtype] || 0xffffff
    if (subtype === 'block') {
      const bid = Math.floor(Number(row?.payload?.blockId))
      if (Number.isFinite(bid) && bid > 0) {
        color = blockIdToDropColor(bid)
      }
    }
    const mat = new THREE.MeshBasicMaterial({ color })
    const mesh = new THREE.Mesh(itemGeom, mat)
    /** Thin bright outline via a slightly-bigger back-face box so the item visibly pops
     *  against the terrain even in deep shade. Cheap — one draw, additive-ish. */
    const outline = new THREE.Mesh(
      new THREE.BoxGeometry(0.44, 0.44, 0.44),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.35,
        side: THREE.BackSide,
      }),
    )
    const grp = new THREE.Group()
    grp.add(outline)
    grp.add(mesh)
    return grp
  }

  /** Draw the floating label canvas as a billboard plane above the drop. Text is rendered
   *  once per drop (the label never changes) so the canvas dispose is trivial. */
  const buildLabel = (text, color = '#fef3c7') => {
    /** 2× resolution + trilinear + anisotropy for the same reason as player/mob
     *  nametags: keeps "+1 монета" / rarity labels readable when the player is far from
     *  a PK loot pile. The label never changes after creation so the single draw cost
     *  is irrelevant. */
    const cvs = document.createElement('canvas')
    cvs.width = 512
    cvs.height = 128
    const ctx = cvs.getContext('2d')
    if (!ctx) return null
    ctx.clearRect(0, 0, cvs.width, cvs.height)
    ctx.font = 'bold 60px Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 12
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(String(text).slice(0, 32), 256, 64)
    ctx.fillStyle = color
    ctx.fillText(String(text).slice(0, 32), 256, 64)
    const tex = new THREE.CanvasTexture(cvs)
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.generateMipmaps = true
    try {
      const cap = mc.worldRenderer?.webRenderer?.capabilities?.getMaxAnisotropy?.()
      if (Number.isFinite(cap) && cap > 0) tex.anisotropy = cap
    } catch {
      /* ignore */
    }
    tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: true,
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.33), mat)
    mesh.renderOrder = 4
    return mesh
  }

  /**
   * Build a THREE.Group for a drop row. Coins lazy-load from the GLB, items synchronously
   * get the box mesh. Returns immediately; the mesh populates once the GLB resolves.
   */
  const buildDropGroup = (row) => {
    const group = new THREE.Group()
    group.position.set(Number(row.x) || 0, Number(row.y) || 0, Number(row.z) || 0)
    const spinGroup = new THREE.Group()
    group.add(spinGroup)
    if (row.type === 'coin') {
      const phGeom = new THREE.CylinderGeometry(0.12, 0.12, 0.04, 16)
      const phMat = new THREE.MeshBasicMaterial({ color: 0xffcb40, toneMapped: false })
      const placeholder = new THREE.Mesh(phGeom, phMat)
      placeholder.rotation.x = Math.PI / 2
      spinGroup.add(placeholder)
      loadCoinTemplate()
        .then((template) => {
          try {
            const clone = template.clone(true)
            clone.rotation.set(0, 0, 0)
            spinGroup.remove(placeholder)
            phGeom.dispose()
            phMat.dispose()
            spinGroup.add(clone)
          } catch (e) {
            console.warn('[fusWorldDrops] coin visual swap failed', e)
          }
        })
        .catch(() => {
          /* Keep placeholder; loadCoinTemplate error path still resolves with a mesh. */
        })
      return { group, spinGroup, label: null, labelColor: '#fde68a' }
    }
    const subtype = row.subtype || 'item'
    const mesh = buildItemMesh(subtype, row)
    spinGroup.add(mesh)
    const labelText = typeof row.label === 'string' && row.label ? row.label : subtypeLabel(subtype)
    const label = buildLabel(labelText, '#e9d5ff')
    if (label) {
      label.position.set(0, 0.42, 0)
      group.add(label)
    }
    return { group, spinGroup, label, labelColor: '#e9d5ff' }
  }

  const subtypeLabel = (subtype) => {
    switch (subtype) {
      case 'tool':
        return 'Інструмент'
      case 'skin':
        return 'Скін'
      case 'block':
        return 'Блок'
      case 'accessory':
        return 'Аксесуар'
      default:
        return 'Предмет'
    }
  }

  /**
   * Add a drop to the local scene graph. Idempotent on dropId.
   */
  const addDrop = (dropId, row) => {
    if (!row || typeof row !== 'object') return
    if (drops.has(dropId)) return
    if (pendingDrops.has(dropId)) {
      pendingDrops.set(dropId, { ...row })
      const x = Number(row.x)
      const z = Number(row.z)
      if (Number.isFinite(x) && Number.isFinite(z) && fusLabyIsWithinPlayerInterestXz(mc, x, z)) {
        pendingDrops.delete(dropId)
      } else {
        return
      }
    }
    /** Winner-only drops are invisible to everyone else — a PvP coin transfer isn't a
     *  "loot pile", it's a direct handshake. Skipping the scene add for non-winners keeps
     *  the world clean; we still subscribe so we know when the winner picks it up. */
    if (row.winnerUid && row.winnerUid !== uid) return
    if (row.loserUid && row.loserUid === uid) return
    const x0 = Number(row.x)
    const z0 = Number(row.z)
    if (Number.isFinite(x0) && Number.isFinite(z0) && !fusLabyIsWithinPlayerInterestXz(mc, x0, z0)) {
      pendingDrops.set(dropId, { ...row })
      return
    }
    const built = buildDropGroup(row)
    scene.add(built.group)
    drops.set(dropId, {
      id: dropId,
      row,
      group: built.group,
      spinGroup: built.spinGroup,
      labelMesh: built.label || null,
      bornAt: Date.now(),
      bobPhase: Math.random() * Math.PI * 2,
      claiming: false,
      gone: false,
    })
    /** Mob drops often only carry {@code bwSeedKey} — resolve Firestore once for real block/tool meshes. */
    if (row.type === 'item') {
      const p = row.payload || {}
      const hasBlock = Number.isFinite(Number(p.blockId)) && Number(p.blockId) > 0
      const hasTool = typeof p.toolMeshName === 'string' && p.toolMeshName.trim().length > 0
      if (typeof p.bwSeedKey === 'string' && p.bwSeedKey && !hasBlock && !hasTool) {
        void resolveBwSeedKeyWorldDropVisual(p.bwSeedKey).then((hints) => {
          const d = drops.get(dropId)
          if (!d || d.gone || !d.spinGroup || !hints) return
          if (!hints.blockId && !hints.toolMeshName) return
          const mergedSubtype =
            hints.subtype === 'tool' || hints.subtype === 'block' ? hints.subtype : row.subtype || 'item'
          const mergedPayload = {
            ...p,
            ...(hints?.blockId ? { blockId: hints.blockId } : {}),
            ...(hints?.toolMeshName ? { toolMeshName: hints.toolMeshName } : {}),
          }
          const mergedRow = { ...row, subtype: mergedSubtype, payload: mergedPayload }
          const sg = d.spinGroup
          const disposeSpinChild = (c) => {
            if (c.userData?.fusWorldDropTool) {
              try {
                disposeFusFpToolSubtree(c)
              } catch {
                /* ignore */
              }
              return
            }
            c.traverse((o) => {
              if (o.isMesh || o.isSkinnedMesh) {
                o.geometry?.dispose?.()
                const mats = Array.isArray(o.material) ? o.material : [o.material]
                for (const m of mats) {
                  m?.map?.dispose?.()
                  m?.dispose?.()
                }
              }
            })
          }
          for (const c of [...sg.children]) {
            disposeSpinChild(c)
            sg.remove(c)
          }
          try {
            sg.add(buildItemMesh(mergedSubtype, mergedRow))
          } catch (e) {
            console.warn('[fusWorldDrops] enriched item mesh failed', e)
            sg.add(buildItemMesh(row.subtype || 'item', row))
          }
          d.row = mergedRow
        })
      }
    }
  }

  /** Remove a drop from the local scene + state. Safe no-op if unknown. */
  const removeDrop = (dropId) => {
    pendingDrops.delete(dropId)
    const d = drops.get(dropId)
    if (!d) return
    d.gone = true
    drops.delete(dropId)
    try {
      scene.remove(d.group)
      const sg = d.spinGroup
      if (sg && d.row?.type === 'item') {
        for (const c of [...sg.children]) {
          if (c.userData?.fusWorldDropTool) {
            try {
              disposeFusFpToolSubtree(c)
            } catch {
              /* ignore */
            }
            sg.remove(c)
          }
        }
      }
      d.group.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.geometry?.dispose?.()
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            for (const m of mats) {
              m?.map?.dispose?.()
              m?.dispose?.()
            }
          }
        }
      })
    } catch {
      /* ignore */
    }
  }

  /**
   * Atomically claim + delete a drop node via `runTransaction`. If the winner-gate
   * passes and we're the first claimer, locally grant the loot and fire an observable
   * event (`mc.fusOnDropPickedUp`) so toasts / analytics can respond.
   */
  const claimDrop = (dropId, row) => {
    const dropRef = dbRef(rtdb, `worldLootDrops/${worldId}/${dropId}`)
    const localRow = { ...row }
    return runTransaction(dropRef, (current) => {
      if (!current) return undefined /** gone already */
      if (current.claimedBy) return undefined /** someone else beat us */
      if (current.winnerUid && current.winnerUid !== uid) return undefined /** not ours */
      if (current.loserUid && current.loserUid === uid) return undefined /** not yours to take */
      current.claimedBy = uid
      return current
    }).then(async (result) => {
      if (!result.committed) return false
      const snap = result.snapshot
      if (!snap.exists()) return false
      const val = snap.val()
      if (!val || val.claimedBy !== uid) return false
      const committed = { ...localRow, ...val }
      /**
       * Apply Firestore grants **before** removing the RTDB node. Previously `__FUS_GRANT_LOOT__`
       * (async) was not awaited, so the mesh was deleted and the user could see “no drop”
       * while a queued/serialized `grantLabyMobCoinsCapped` had not finished yet. Await
       * keeps world removal in sync with the inventory write.
       */
      const grantFn = typeof window !== 'undefined' ? window.__FUS_GRANT_LOOT__ : null
      const awaitMaybe = (p) => (p && typeof p.then === 'function' ? p : Promise.resolve(p))
      try {
        if (typeof grantFn === 'function') {
          if (committed.type === 'coin') {
            const source = committed.source || (committed.winnerUid ? 'pk' : 'mob')
            const grantCoins = Math.max(
              1,
              Math.min(FUS_GAME_COIN_PICKUP_MAX, Math.floor(Number(committed.coins) || 1)),
            )
            await awaitMaybe(
              grantFn({
                kind: 'coins',
                coins: grantCoins,
                source,
              }),
            )
          } else if (committed.type === 'item') {
            const p = committed.payload || {}
            if (committed.subtype === 'skin' && p.skinId) {
              await awaitMaybe(grantFn({ kind: 'skin', skinId: p.skinId }))
            } else if (p.bwSeedKey) {
              await awaitMaybe(grantFn({ kind: 'item', bwSeedKey: p.bwSeedKey }))
            }
          }
        }
      } catch (e) {
        console.warn('[fusWorldDrops] grant after claim failed (drop will still be removed from world)', e)
        /** `claimedBy` is already on the node; delete so the scene doesn’t stay stuck. */
        dbRemove(dropRef).catch(() => {})
        return false
      }
      /** Delete the node so peers hide the mesh. */
      dbRemove(dropRef).catch(() => {})
      try {
        mc.fusOnDropPickedUp?.(committed)
      } catch {
        /* ignore */
      }
      return true
    }).catch((e) => {
      console.warn('[fusWorldDrops] claim transaction failed', e)
      return false
    })
  }

  /** Master-ish sweeper: any client can delete an expired drop. Collisions are fine — the
   *  transaction will just abort on a second client's run. */
  const sweepExpired = () => {
    const now = Date.now()
    for (const d of drops.values()) {
      const row = d.row || {}
      const expiresAt = Number(row.expiresAt) || (Number(row.droppedAt) || 0) + DROP_LIFETIME_MS
      if (expiresAt && now > expiresAt) {
        dbRemove(dbRef(rtdb, `worldLootDrops/${worldId}/${d.id}`)).catch(() => {})
      }
    }
  }

  /** Frame tick: rotate + bob every drop, and run the pickup proximity check on a slow
   *  cadence. Driven from {@link WorldRenderer#render} (not a second rAF) so weak devices
   *  do not run three separate animation loops (engine + mobs + drops + combat FX). */
  let lastPickupCheckMs = 0
  let prevTimeMs = performance.now()
  /** On low-tier Android, skip label↔camera sync every other frame (still looks fine; saves matrix work). */
  let labelFrameParity = 0
  const frame = () => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - prevTimeMs) / 1000)
    prevTimeMs = now
    const wall = Date.now()
    if (drops.size === 0 && pendingDrops.size === 0) {
      return
    }
    const pl = mc.player
    if (pl) {
      for (const [id, pr] of Array.from(pendingDrops.entries())) {
        const x = Number(pr?.x)
        const z = Number(pr?.z)
        if (Number.isFinite(x) && Number.isFinite(z) && fusLabyIsWithinPlayerInterestXz(mc, x, z)) {
          pendingDrops.delete(id)
          addDrop(id, pr)
        }
      }
    }

    const cam = mc.worldRenderer?.camera
    const low = !!mc.fusLowTierMobile
    const syncDropLabels = !low || (labelFrameParity++ & 1) === 0
    for (const d of drops.values()) {
      const yBase = Number(d.row?.y) || 0
      const dx = Number(d.row?.x) || 0
      const dz = Number(d.row?.z) || 0
      if (!fusLabyIsWithinAnimProcessRangeXz(mc, dx, dz)) {
        d.group.position.y = yBase
        continue
      }
      /** Spin mesh only; label + outer group stay upright (label faces camera). */
      const spin = d.row?.type === 'coin' ? 2.4 : 1.2
      const g = d.spinGroup || d.group
      g.rotation.y += spin * dt * (low ? 0.65 : 1)
      const bobY = Math.sin((now / 1000) * 2 + d.bobPhase) * 0.15
      d.group.position.y = yBase + bobY
      if (d.labelMesh && cam && syncDropLabels) {
        d.labelMesh.quaternion.copy(cam.quaternion)
      }
    }

    if (pl && wall - lastPickupCheckMs > PICKUP_CHECK_MS) {
      lastPickupCheckMs = wall
      const alive = typeof mc.fusIsDead !== 'function' || !mc.fusIsDead()
      if (alive) {
        for (const d of drops.values()) {
        if (d.claiming || d.gone) continue
        const row = d.row || {}
        const wdx = Number(row.x) || 0
        const wdz = Number(row.z) || 0
        if (!fusLabyIsWithinAnimProcessRangeXz(mc, wdx, wdz)) continue
        if (row.winnerUid && row.winnerUid !== uid) continue
        if (row.loserUid && row.loserUid === uid) continue
        const baseY = Number(row.y) || 0
        const dx = (Number(row.x) || 0) - pl.x
        /** Measure to the drop's resting Y (not bob-offset) so the pickup radius isn't
         *  modulated by the bob phase. Player's feet at pl.y; a drop sitting on the same
         *  floor has dy ≈ 0. Relax the Y tolerance to 2 blocks so players falling past a
         *  coin still grab it. */
        const dy = baseY - pl.y
        const dz = (Number(row.z) || 0) - pl.z
        if (Math.abs(dy) > 2.8) continue
        const distSq = dx * dx + dz * dz
        if (distSq > PICKUP_RADIUS_SQ) continue
        /** Local optimistic gate — flip `claiming` so a repeated frame doesn't fire two
         *  transactions. Cleared when the claim resolves. */
        d.claiming = true
        void claimDrop(d.id, row).finally(() => {
          d.claiming = false
        })
        }
      }
    }
  }
  mc.fusWorldDropsTick = frame

  const sweepIv = window.setInterval(sweepExpired, SWEEP_MS)

  /** RTDB subscription: watch the whole world node. Cheap — drops are small and rare. */
  const rootRef = dbRef(rtdb, `worldLootDrops/${worldId}`)
  const onAdded = onChildAdded(rootRef, (snap) => addDrop(snap.key, snap.val()))
  const onChanged = onChildChanged(rootRef, (snap) => {
    /** If someone else claimed this drop (claimedBy set), hide the mesh pre-emptively so
     *  the player doesn't see a ghost coin between "claim" and "delete". */
    const key = snap.key
    const row = snap.val() || {}
    if (key && pendingDrops.has(key)) {
      pendingDrops.set(key, row)
      if (row.claimedBy && row.claimedBy !== uid) {
        pendingDrops.delete(key)
      }
    }
    const d = drops.get(key)
    if (d && row.claimedBy && row.claimedBy !== uid) {
      removeDrop(key)
    }
  })
  const onRemoved = onChildRemoved(rootRef, (snap) => removeDrop(snap.key))

  /**
   * Public API: drop one coin at (x, y, z). `opts.winnerUid` makes it exclusive so PvP
   * coin transfers can't be poached by bystanders. `opts.source` tags the grant ledger
   * (defaults to 'mob' for monster coins, 'pk' for winner-tagged drops).
   */
  const dropCoinAt = (x, y, z, opts = {}) => {
    /** One world mesh, but the RTDB row can represent 1..N coins on pickup (mob/ore procs). */
    const coins = Math.max(1, Math.min(FUS_GAME_COIN_PICKUP_MAX, Math.floor(Number(opts.coins) || 1)))
    const now = Date.now()
    const row = {
      type: 'coin',
      x: Number(x) || 0,
      y: Number(y) || 0,
      z: Number(z) || 0,
      coins,
      droppedAt: now,
      expiresAt: now + DROP_LIFETIME_MS,
    }
    if (typeof opts.winnerUid === 'string' && opts.winnerUid) row.winnerUid = opts.winnerUid
    if (typeof opts.loserUid === 'string' && opts.loserUid) row.loserUid = opts.loserUid
    if (typeof opts.source === 'string' && opts.source) row.source = opts.source
    const newRef = dbPush(rootRef)
    dbSet(newRef, row).catch((e) => console.warn('[fusWorldDrops] coin drop failed', e))
    return newRef.key
  }

  /**
   * Public API: drop one item at (x, y, z). `subtype` drives colour/label, `payload`
   * is the grant-side metadata consumed by `__FUS_GRANT_LOOT__`.
   */
  const dropItemAt = (x, y, z, opts = {}) => {
    const subtype =
      opts.subtype === 'tool' ||
      opts.subtype === 'skin' ||
      opts.subtype === 'block' ||
      opts.subtype === 'accessory'
        ? opts.subtype
        : 'item'
    const now = Date.now()
    const row = {
      type: 'item',
      subtype,
      x: Number(x) || 0,
      y: Number(y) || 0,
      z: Number(z) || 0,
      droppedAt: now,
      expiresAt: now + DROP_LIFETIME_MS,
      payload: opts.payload || null,
      label: typeof opts.label === 'string' ? opts.label.slice(0, 32) : '',
    }
    if (typeof opts.winnerUid === 'string' && opts.winnerUid) row.winnerUid = opts.winnerUid
    if (typeof opts.loserUid === 'string' && opts.loserUid) row.loserUid = opts.loserUid
    const newRef = dbPush(rootRef)
    dbSet(newRef, row).catch((e) => console.warn('[fusWorldDrops] item drop failed', e))
    return newRef.key
  }

  mc.fusDropCoinAt = dropCoinAt
  mc.fusDropItemAt = dropItemAt

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    delete mc.fusWorldDropsTick
    window.clearInterval(sweepIv)
    try {
      onAdded?.()
    } catch {
      /* ignore */
    }
    try {
      onChanged?.()
    } catch {
      /* ignore */
    }
    try {
      onRemoved?.()
    } catch {
      /* ignore */
    }
    for (const id of Array.from(drops.keys())) removeDrop(id)
    pendingDrops.clear()
    mc.fusDropCoinAt = null
    mc.fusDropItemAt = null
  }
  mc.fusDisposeWorldDrops = dispose
  return dispose
}
