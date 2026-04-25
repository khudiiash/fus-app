import * as THREE from "../../../../../../libraries/three.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { toolGridLinearIndexFromMeshName } from "./FusToolSpriteCoords.js";

/**
 * Normalize for loose matching (Blender often adds `.001` or different casing).
 * @param {string} s
 */
function normalizeToolNameKey(s) {
    return String(s || "")
        .trim()
        .replace(/\.\d+$/, "")
        .replace(/\s+/g, "_")
        .toLowerCase();
}

/**
 * @param {THREE.Object3D} root
 * @param {string} meshName e.g. `Iron_Pickaxe`
 * @returns {THREE.Object3D | null}
 */
export function findToolObjectByMeshName(root, meshName) {
    const want = String(meshName || "").trim();
    if (!want) {
        return null;
    }
    const spaced = want.replace(/_/g, " ");
    const wantKey = normalizeToolNameKey(want);

    let found = root.getObjectByName(want);
    if (found) {
        return found;
    }
    found = root.getObjectByName(spaced);
    if (found) {
        return found;
    }
    root.traverse((o) => {
        if (found || !o.name) {
            return;
        }
        if (o.name === want || o.name === spaced) {
            found = o;
            return;
        }
        const nk = normalizeToolNameKey(o.name);
        if (nk === wantKey) {
            found = o;
        }
    });
    return found || null;
}

/**
 * One-time debug: log unique object names from tools.glb if nothing matches in FP.
 * @param {THREE.Object3D} root
 * @returns {string[]}
 */
export function collectFusToolsGltfObjectNames(root) {
    /** @type {Set<string>} */
    const set = new Set();
    root.traverse((o) => {
        if (o.name) {
            set.add(o.name);
        }
    });
    return [...set];
}

/**
 * Bundled `tools.glb` (Blender) often names meshes `ALL MINECRAFT TOOLS.NNN` instead of `Iron_Pickaxe`.
 * Collect those meshes sorted by NNN (001, 002, …) so index `i` matches {@link toolGridLinearIndexFromMeshName}
 * when the file contains all 30 tools; shorter files use index clamp / sprite fallback.
 * @param {THREE.Object3D} root
 * @returns {THREE.Mesh[]}
 */
export function collectBundledGltfToolMeshesSorted(root) {
    /** @type {{ n: number, o: THREE.Mesh }[]} */
    const list = [];
    root.traverse((o) => {
        if (!o.isMesh || !o.name) {
            return;
        }
        const m = o.name.match(/^ALL MINECRAFT TOOLS\.(\d+)$/i);
        if (!m) {
            return;
        }
        list.push({ n: parseInt(m[1], 10), o: /** @type {THREE.Mesh} */ (o) });
    });
    list.sort((a, b) => a.n - b.n);
    return list.map((x) => x.o);
}

/**
 * Resolve which object to show for FP: exact name first, then bundled grid index → `ALL MINECRAFT TOOLS.NNN` list.
 * @param {THREE.Object3D} root
 * @param {string} meshName e.g. `Iron_Pickaxe`
 * @returns {THREE.Object3D | null}
 */
export function resolveFusToolsGltfObjectForFp(root, meshName) {
    const byName = findToolObjectByMeshName(root, meshName);
    if (byName) {
        return byName;
    }
    const meshes = collectBundledGltfToolMeshesSorted(root);
    if (meshes.length === 0) {
        return null;
    }
    const idx = toolGridLinearIndexFromMeshName(meshName);
    if (idx >= 0 && idx < meshes.length) {
        return meshes[idx];
    }
    return null;
}

/**
 * @param {THREE.Object3D} obj
 */
export function disposeFusFpToolSubtree(obj) {
    obj.traverse((o) => {
        if (o.geometry) {
            o.geometry.dispose?.();
        }
        if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
                if (m.map) {
                    m.map.dispose?.();
                }
                m.dispose?.();
            }
        }
    });
}

/**
 * Clone for instancing in the hand; uses {@link cloneSkinned} so SkinnedMesh copies correctly.
 * @param {THREE.Object3D} source
 * @returns {THREE.Object3D}
 */
export function cloneToolForFirstPerson(source) {
    return cloneSkinned(source);
}

/**
 * Live-tuned first-person tool transform (dat.gui in dev). Edit defaults here after tuning.
 * @typedef {{
 *   unitScale: number,
 *   strikeX: number, strikeY: number, strikeZ: number,
 *   alignBlade: boolean,
 *   extraToolRotXDeg: number, extraToolRotYDeg: number, extraToolRotZDeg: number,
 *   groupX: number, groupY: number, groupZ: number,
 *   groupRotXDeg: number, groupRotYDeg: number, groupRotZDeg: number,
 * }} FusFpToolTuning
 */
/**
 * First-person tool tuning.
 *
 * Scale math: the parent {@link WorldRenderer#renderHand} stack is at world-scale 0.0625
 * (16 pixels per block). After {@link fitToolForFirstPersonHand} fits the tool, its max
 * dimension is `0.42 × unitScale × 0.0625` blocks.
 *
 * Position math: `groupX/Y/Z` are in stack units (1 stack unit = 1/16 block). The stack
 * origin has already been translated/rotated through the engine's FP arm sequence
 * (see {@link WorldRenderer#renderHand}), so these values shift the tool relative to the
 * palm pivot — positive X pushes the tool toward the screen's right side, positive Y
 * upward, negative Z further forward (away from the camera).
 *
 * User-reported history: the previous aggressive shrink (`unitScale=24`, `groupX=16`)
 * pushed the tool entirely off-screen — "Tools are not visible at all". Reverted to a
 * known-visible baseline (52, 10, 6, -10) that renders a tool "too big but visible" and
 * exposed via {@link installFusFpToolTuningGui} so the user can interactively tune with
 * dat.gui. The sliders cover the full practical range so both shrinking further and
 * re-inflating are reachable without code changes.
 */
export const fusFpToolTuning = {
    unitScale: 40,
    strikeX: 0,
    strikeY: 0,
    strikeZ: 0,
    alignBlade: true,
    extraToolRotXDeg: 147,
    extraToolRotYDeg: -14,
    extraToolRotZDeg: 180,
    groupX: -4.9,
    groupY: 11.1,
    groupZ: -8.4,
    groupRotXDeg: 0,
    groupRotYDeg: 0,
    groupRotZDeg: 0,
};

/**
 * Swing-animation compensator applied on top of the engine's vanilla FP arm swing.
 *
 * The engine's {@link WorldRenderer#renderHand} swings `stack` by rotating it heavily
 * around Y (yaw, −powRotation·20°) and Z (roll, −sqrtRotation·20°) and then pitching
 * it by −80° around X at peak. That pitch is so large that by strike-time the stack's
 * local axes no longer resemble screen-space forward/up/right — local +Z points mostly
 * toward the camera while local −Y points roughly forward-and-down.
 *
 * Sign convention used by {@link applySwingCompensator} below:
 *
 *   • {@code counterYawDeg}  — positive cancels the engine's −yaw (less left swing).
 *   • {@code counterRollDeg} — positive cancels the engine's −roll (less left tilt).
 *   • {@code extraPitchDeg}  — positive adds MORE pitch, which pushes the blade tip past
 *     vertical toward the camera. We apply the negated value so that positive values in
 *     the slider feel like "more chop forward/down". (Implementation applies −pitch to
 *     reduce the engine's −80° overshoot, not add to it.)
 *   • {@code forwardZ}       — positive pushes the tool away from the camera at strike
 *     peak (applied along local +Z, which empirically resolves to screen-forward after
 *     the engine's strike-time rotation chain).
 *   • {@code downY}          — positive shifts the tool downward in screen space
 *     (applied along local +Y).
 *
 * User-reported tuning history:
 *   1. "swings too much to the left, must go more forward and down" → introduced this
 *      compensator with counter-yaw / counter-roll plus forward-down pushes.
 *   2. "it hits towards the player, must be the other way around" → discovered the
 *      naïve "negate engine axes" math was wrong because of the strike-time pitch
 *      composition. Flipped sign of forwardZ and downY application (now translate along
 *      local −Z / −Y) and reduced extraPitchDeg magnitude; strike now reads as a chop
 *      into the scene rather than a backswing into the face.
 */
export const fusFpToolSwingTuning = {
    /** Cancels most of the 20° yaw the engine adds at peak — tune down to keep a bit of
     *  side swing, up past 20 to invert the swing direction entirely. */
    counterYawDeg: -15,
    /** Cancels most of the 20° roll — at 20 the blade stays upright through the swing. */
    counterRollDeg: -20,
    /** Positive = reduce the engine's −80° pitch overshoot so the blade stays forward-
     *  facing instead of flopping back toward the camera. Small default (8°) because the
     *  engine's own pitch is already the primary chop motion. */
    extraPitchDeg: 44,
    /** Positive = push the tool away from the camera at strike peak. 1.5 stack units
     *  (~0.1 blocks in world space after the stack's 0.025 combined scale) adds enough
     *  reach for the chop to feel directional without losing the hand pivot. */
    forwardZ: 1.5,
    /** Positive = push the tool downward at strike peak. */
    downY: 1.8,
};

/**
 * Third-person held tool (local + remote players): arm-local offset / rotation.
 * Tweak via {@link installFusTpToolTuningGui}; {@link fusTpToolTuningRevision} bumps when mesh scale must rebuild.
 * @typedef {{
 *   scaleTarget: number,
 *   posX: number, posY: number, posZ: number,
 *   rotXDeg: number, rotYDeg: number, rotZDeg: number,
 *   innerRotXDeg: number, innerRotYDeg: number, innerRotZDeg: number,
 * }} FusTpToolTuning
 */
export const fusTpToolTuning = {
    scaleTarget: 10.5,
    posX: 0.1,
    posY: 3.6,
    posZ: 7.6,
    rotXDeg: -103,
    rotYDeg: 180,
    rotZDeg: -92,
    innerRotXDeg: -20,
    innerRotYDeg: -128,
    innerRotZDeg: 180,
};

/** Incremented when {@link fusTpToolTuning}.scaleTarget changes so {@link PlayerRenderer} rebuilds the mesh. */
export let fusTpToolTuningRevision = 0;

export function bumpFusTpToolTuningRebuild() {
    fusTpToolTuningRevision++;
}

/**
 * Scale / orient a tool for the vanilla FP hand stack.
 * Pivots at the grip (bottom of AABB) so swing animation leads with the blade, not the handle.
 * Uses {@link fusFpToolTuning} (tweak via dat.gui in dev).
 * @param {THREE.Object3D} tool
 */
export function fitToolForFirstPersonHand(tool) {
    const T = fusFpToolTuning;
    const box = new THREE.Box3().setFromObject(tool);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const target = 0.42 * T.unitScale;
    const s = maxDim > 1e-4 ? target / maxDim : 0.35 * T.unitScale;
    tool.material.depthTest = true;
    tool.material.depthWrite = true;
    // Ensure the material uses nearest-neighbor filtering for its texture map
    if (tool.material && tool.material.map) {
        tool.material.map.magFilter = THREE.NearestFilter;
        tool.material.map.minFilter = THREE.NearestFilter;
        // mark texture for update in case it's already loaded
        tool.material.map.needsUpdate = true;
    }
    tool.scale.multiplyScalar(s);

    const b = new THREE.Box3().setFromObject(tool);
    const midX = (b.min.x + b.max.x) / 2;
    const midZ = (b.min.z + b.max.z) / 2;
    tool.position.set(-midX, -b.min.y, -midZ);

    const gripToTip = new THREE.Vector3(0, 1, 0);
    const strike = new THREE.Vector3(T.strikeX, T.strikeY, T.strikeZ);
    if (strike.lengthSq() < 1e-8) {
        strike.set(0, 0, -1);
    } else {
        strike.normalize();
    }

    const qAlign = new THREE.Quaternion().setFromUnitVectors(gripToTip, strike);
    const qEuler = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
            THREE.MathUtils.degToRad(T.extraToolRotXDeg),
            THREE.MathUtils.degToRad(T.extraToolRotYDeg),
            THREE.MathUtils.degToRad(T.extraToolRotZDeg),
            "XYZ",
        ),
    );
    if (T.alignBlade) {
        tool.quaternion.copy(qAlign);
    } else {
        tool.quaternion.identity();
    }
    tool.quaternion.multiply(qEuler);

    const group = new THREE.Group();
    group.add(tool);
    group.position.set(T.groupX, T.groupY, T.groupZ);
    group.rotation.set(
        THREE.MathUtils.degToRad(T.groupRotXDeg),
        THREE.MathUtils.degToRad(T.groupRotYDeg),
        THREE.MathUtils.degToRad(T.groupRotZDeg),
    );
    return group;
}

/**
 * Unlit overlay: FP stack has no lights — Standard/Physical materials read black. Prefer {@link THREE.MeshBasicMaterial}.
 * Does not dispose old materials (textures stay shared until subtree dispose).
 * @param {THREE.Material} m
 * @returns {THREE.MeshBasicMaterial}
 */
function fusFpToolMaterialToBasic(m) {
    if (m instanceof THREE.MeshBasicMaterial) {
        const b = m;
        b.depthTest = false;
        b.depthWrite = false;
        b.side = THREE.DoubleSide;
        b.needsUpdate = true;
        return b;
    }

    const map = "map" in m ? m.map : null;
    const color = new THREE.Color(0xffffff);
    if (map && m.color) {
        color.copy(m.color);
    } else if (!map && "emissive" in m && m.emissive && typeof m.emissive.multiplyScalar === "function") {
        const ei = "emissiveIntensity" in m && typeof m.emissiveIntensity === "number" ? m.emissiveIntensity : 1;
        color.copy(m.emissive).multiplyScalar(Math.max(0, ei));
    } else if (m.color) {
        color.copy(m.color);
    }

    const opacity = typeof m.opacity === "number" ? m.opacity : 1;
    const alphaMap = "alphaMap" in m ? m.alphaMap : null;
    const transparent =
        Boolean(m.transparent) || opacity < 0.999 || (map && map.format === THREE.RGBAFormat) || Boolean(alphaMap);

    const basic = new THREE.MeshBasicMaterial({
        map,
        color,
        transparent,
        opacity,
        alphaMap,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
    });
    if ("vertexColors" in m && m.vertexColors) {
        basic.vertexColors = true;
    }
    basic.needsUpdate = true;
    return basic;
}

/**
 * FP overlay: draw on top of the world (same idea as block-in-hand).
 * @param {THREE.Object3D} root
 */
export function applyFusFpToolMaterialPolicy(root) {
    root.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) {
            return;
        }
        if (!o.material) {
            return;
        }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const next = mats.map((m) => fusFpToolMaterialToBasic(m));
        o.material = next.length === 1 ? next[0] : next;
    });
}

/**
 * Third-person held tool in the world scene — lit overlay style, depth on (unlike FP).
 * @param {THREE.Object3D} root
 */
export function applyFusTpToolMaterialPolicy(root) {
    root.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) {
            return;
        }
        if (!o.material) {
            return;
        }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const next = mats.map((m) => fusFpToolMaterialToBasic(m));
        for (const b of next) {
            b.depthTest = true;
            b.depthWrite = true;
            b.needsUpdate = true;
        }
        o.material = next.length === 1 ? next[0] : next;
    });
}

/**
 * Attach point matches {@link BlockRenderer#renderBlockInHandThirdPerson} (model units).
 * Uses {@link fusTpToolTuning}; live tweaks each frame via {@link applyFusTpToolTuningToTpHolder}.
 * @param {THREE.Object3D} toolObject
 */
export function fitToolForThirdPersonHand(toolObject) {
    const T = fusTpToolTuning;
    const box = new THREE.Box3().setFromObject(toolObject);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const target = T.scaleTarget;
    const s = maxDim > 1e-4 ? target / maxDim : 1;
    toolObject.scale.multiplyScalar(s);

    const b = new THREE.Box3().setFromObject(toolObject);
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    toolObject.position.set(-cx, -b.min.y, -cz);

    toolObject.rotation.order = "XYZ";
    toolObject.rotation.set(
        THREE.MathUtils.degToRad(T.innerRotXDeg),
        THREE.MathUtils.degToRad(T.innerRotYDeg),
        THREE.MathUtils.degToRad(T.innerRotZDeg),
    );

    const group = new THREE.Group();
    group.add(toolObject);
    group.userData.__fusTpHeldTool = true;
    applyFusTpToolTuningToTpHolder(group);
    return group;
}

/**
 * Applies {@link fusTpToolTuning} to the holder group (and inner mesh rotation) — called each
 * {@link PlayerRenderer#render} so dat.gui updates apply without rebuilding the skin mesh.
 * @param {THREE.Object3D} holder
 */
export function applyFusTpToolTuningToTpHolder(holder) {
    const T = fusTpToolTuning;
    holder.position.set(T.posX, T.posY, T.posZ);
    holder.rotation.order = "XYZ";
    holder.rotation.set(
        THREE.MathUtils.degToRad(T.rotXDeg),
        THREE.MathUtils.degToRad(T.rotYDeg),
        THREE.MathUtils.degToRad(T.rotZDeg),
    );
    const mesh = holder.children[0];
    if (mesh) {
        mesh.rotation.order = "XYZ";
        mesh.rotation.set(
            THREE.MathUtils.degToRad(T.innerRotXDeg),
            THREE.MathUtils.degToRad(T.innerRotYDeg),
            THREE.MathUtils.degToRad(T.innerRotZDeg),
        );
    }
}

/**
 * @param {string} glbUrl Resolved URL (Vite asset import or absolute path).
 * @returns {Promise<THREE.Group>}
 */
export function loadFusToolsGlbTemplateScene(glbUrl) {
    const loader = new GLTFLoader();
    return new Promise((resolve, reject) => {
        loader.load(
            glbUrl,
            (gltf) => {
                resolve(gltf.scene);
            },
            undefined,
            reject,
        );
    });
}
