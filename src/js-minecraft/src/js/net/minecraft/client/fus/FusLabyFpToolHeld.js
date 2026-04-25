import * as THREE from "../../../../../../libraries/three.module.js";
import toolsPng from "../../../../../../src/resources/gui/tools.png";
import heartsPng from "../../../../../../src/resources/gui/hearts_sh.png";
import toolsGlbUrl from "../../../../../../src/resources/models/tools.glb?url";
import {
    TOOL_SPRITE_COLS,
    TOOL_SPRITE_ROWS,
    toolSpriteCellFromMeshName,
} from "./FusToolSpriteCoords.js";
import {
    applyFusFpToolMaterialPolicy,
    cloneToolForFirstPerson,
    disposeFusFpToolSubtree,
    fitToolForFirstPersonHand,
    fusFpToolSwingTuning,
    loadFusToolsGlbTemplateScene,
    resolveFusToolsGltfObjectForFp,
} from "./FusToolsGltfFirstPerson.js";

/**
 * @param {string} meshName
 * @param {number} iw
 * @param {number} ih
 * @returns {{ sx: number, sy: number, sw: number, sh: number }}
 */
export function fusToolSpriteSrcRectPixels(meshName, iw, ih) {
    const cell = toolSpriteCellFromMeshName(meshName);
    const sw = iw / TOOL_SPRITE_COLS;
    const sh = ih / TOOL_SPRITE_ROWS;
    return { sx: cell.col * sw, sy: cell.row * sh, sw, sh };
}

/**
 * @param {import("../Minecraft.js").default} mc
 */
export function installFusLabyFpToolHooks(mc) {
    /** @type {HTMLImageElement | null} */
    let sheet = null;
    /** @type {Promise<HTMLImageElement> | null} */
    let loadPngPromise = null;

    const getSheet = () => {
        if (sheet?.complete && sheet.naturalWidth > 0) {
            return Promise.resolve(sheet);
        }
        if (!loadPngPromise) {
            loadPngPromise = new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    sheet = img;
                    resolve(img);
                };
                img.onerror = () => reject(new Error("tools.png load failed"));
                img.src = toolsPng;
            });
        }
        return loadPngPromise;
    };

    void getSheet().then((img) => {
        mc.fusToolsSpriteSheet = img;
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        mc.fusGetToolSpriteSrcRect = (name) => {
            const r = fusToolSpriteSrcRectPixels(typeof name === "string" ? name : "Iron_Pickaxe", iw, ih);
            return { sx: r.sx, sy: r.sy, sw: r.sw, sh: r.sh };
        };
        mc.itemRenderer?.scheduleDirty?.("hotbar");
        const pl = mc.player;
        if (pl?.renderer?.rebuild) {
            pl.renderer.rebuild(pl);
        }
    });

    /** Template scene from `resources/models/tools.glb`. */
    /** @type {THREE.Group | null} */
    let toolsGltfTemplate = null;
    /** @type {Promise<THREE.Group> | null} */
    let toolsGltfLoadPromise = null;
    const ensureToolsGltf = () => {
        if (toolsGltfTemplate) {
            return Promise.resolve(toolsGltfTemplate);
        }
        if (!toolsGltfLoadPromise) {
            toolsGltfLoadPromise = loadFusToolsGlbTemplateScene(toolsGlbUrl).then((scene) => {
                toolsGltfTemplate = scene;
                mc.fusToolsGltfTemplateLoaded = true;
                /** Expose the template so non-engine installers (e.g. remote avatars) can clone it. */
                mc.fusToolsGltfTemplate = scene;
                const pl = mc.player;
                if (pl?.renderer?.rebuild) {
                    pl.renderer.rebuild(pl);
                }
                return scene;
            });
        }
        return toolsGltfLoadPromise;
    };

    void ensureToolsGltf().catch((e) => {
        console.warn("[FUS] tools.glb load failed — FP tools fall back to sprite sheet", e);
        mc.fusToolsGltfLoadError = e;
    });

    const hi = new Image();
    hi.crossOrigin = "anonymous";
    hi.onload = () => {
        mc.fusHeartsSheet = hi;
    };
    hi.src = heartsPng;

    /** @type {THREE.Object3D | null} */
    let fpToolRoot = null;
    /** Last FP tool identity (slot + mesh name + mode gltf|sprite). */
    let lastFpToolKey = "";

    mc.fusHideVanillaFpHand = () => {
        const m = mc.fusHotbarSlotMeta?.[mc.player?.inventory?.selectedSlotIndex ?? 0];
        return m?.kind === "tool";
    };

    const disposeFpToolRoot = () => {
        if (!fpToolRoot) {
            return;
        }
        try {
            fpToolRoot.parent?.remove(fpToolRoot);
        } catch (_) {
            /* ignore */
        }
        disposeFusFpToolSubtree(fpToolRoot);
        fpToolRoot = null;
        lastFpToolKey = "";
    };

    mc.fusDisposeFpToolInFirstPerson = () => {
        disposeFpToolRoot();
    };

    /** Invalidate cached FP GLTF so {@link fitToolForFirstPersonHand} runs again (dat.gui tuning). */
    mc.fusBumpFpToolGltfRebuild = () => {
        lastFpToolKey = "";
        disposeFpToolRoot();
    };

    const buildSpriteBillboard = (meta, img) => {
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        const rect = fusToolSpriteSrcRectPixels(meta.toolMeshName, iw, ih);
        const out = 32;
        const c = document.createElement("canvas");
        c.width = out;
        c.height = out;
        const ctx = c.getContext("2d");
        if (!ctx) {
            return null;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, out, out);

        const tex = new THREE.CanvasTexture(c);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.needsUpdate = true;

        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(0.42, 0.42),
            new THREE.MeshBasicMaterial({
                map: tex,
                transparent: true,
                depthTest: false,
                depthWrite: false,
                side: THREE.DoubleSide,
            }),
        );
        mesh.position.set(0.05, -0.12, -0.52);
        mesh.rotation.set(0.2, 0.85, -0.35);

        const root = new THREE.Group();
        root.userData.__fusLabyFpToolRoot = true;
        root.userData.__fusFpToolMode = "sprite";
        root.renderOrder = 999;
        root.add(mesh);
        return root;
    };

    /**
     * Apply the swing compensator transform. The compensator is a child of `stack`
     * that parents the tuned FP tool; we animate its local rotation + translation per
     * frame based on the current swing curve, so the tool goes *more forward and down*
     * on a hit instead of wildly to the left.
     *
     * This is called from {@link mc.fusSyncFpToolIntoFirstPerson} on every FP frame
     * (not just on tool-change), so it stays cheap — a handful of sin calls and some
     * Euler / Vector writes, no allocations.
     *
     * @param {THREE.Object3D} comp  swing compensator group
     * @param {any} player
     * @param {number} partialTicks
     */
    const applySwingCompensator = (comp, player, partialTicks) => {
        if (!comp) return;
        const T = fusFpToolSwingTuning;
        let sp = 0;
        try {
            sp = player?.getSwingProgress?.(partialTicks) ?? 0;
        } catch (_) {
            sp = 0;
        }
        if (!Number.isFinite(sp) || sp <= 0) {
            comp.rotation.set(0, 0, 0);
            comp.position.set(0, 0, 0);
            return;
        }
        /** Matches the engine's own curves in {@link WorldRenderer#renderHand} so our
         *  compensation stays in lockstep with the stack's swing. */
        const sqrtRotation = Math.sin(Math.sqrt(sp) * Math.PI);
        const powRotation = Math.sin(sp * sp * Math.PI);
        /** Counter the engine's leftward yaw/roll. Pitch is subtracted (not added) to
         *  *reduce* the engine's 80° overshoot — adding more pitch sent the blade tip
         *  past vertical back toward the camera (user: "it hits towards the player,
         *  must be the other way around"). */
        comp.rotation.x = THREE.MathUtils.degToRad(sqrtRotation * T.extraPitchDeg);
        comp.rotation.y = THREE.MathUtils.degToRad(powRotation * T.counterYawDeg);
        comp.rotation.z = THREE.MathUtils.degToRad(sqrtRotation * T.counterRollDeg);
        /** At peak swing the stack has been rotated ~−80° around its X (plus camera
         *  pitch/yaw + rotateY(45)), so local axes are far from screen-space. Empirically
         *  after the previous "toward player" bug, translating along local +Z moves the
         *  tool outward/forward and along local +Y moves it downward relative to the
         *  player's view, so `forwardZ` / `downY` are applied positively. */
        comp.position.z = sqrtRotation * T.forwardZ;
        comp.position.y = sqrtRotation * T.downY;
    };

    mc.fusSyncFpToolIntoFirstPerson = (player, stack, partialTicks, _hasItem) => {
        const sel = player.inventory.selectedSlotIndex;
        const meta = mc.fusHotbarSlotMeta?.[sel];
        const img = mc.fusToolsSpriteSheet || sheet;

        if (!meta || meta.kind !== "tool") {
            disposeFpToolRoot();
            return;
        }

        const meshName = meta.toolMeshName || "";

        /** @type {"gltf" | "sprite"} */
        let mode = "sprite";
        /** @type {THREE.Object3D | null} */
        let gltfSrc = null;
        if (toolsGltfTemplate) {
            gltfSrc = resolveFusToolsGltfObjectForFp(toolsGltfTemplate, meshName);
            if (gltfSrc) {
                mode = "gltf";
            }
        }

        const key = `${sel}:${meshName}:${mode}`;
        if (key === lastFpToolKey && fpToolRoot) {
            if (fpToolRoot.parent !== stack) {
                try {
                    stack.add(fpToolRoot);
                } catch (_) {
                    /* ignore */
                }
            }
            /** Hot path: tool unchanged; just re-apply the swing compensator. The root
             *  itself is the compensator group when `mode === "gltf"`; the sprite fallback
             *  also passes (it's a Group with identity rotation so `applySwingCompensator`
             *  is a no-op when swing progress is 0 and harmless otherwise). */
            applySwingCompensator(fpToolRoot, player, partialTicks);
            return;
        }

        disposeFpToolRoot();

        /** @type {THREE.Object3D | null} */
        let built = null;
        if (mode === "gltf" && gltfSrc) {
            const inst = cloneToolForFirstPerson(gltfSrc);
            applyFusFpToolMaterialPolicy(inst);
            built = fitToolForFirstPersonHand(inst);
            built.userData.__fusLabyFpToolRoot = true;
            built.userData.__fusFpToolMode = "gltf";
            built.renderOrder = 999;
        } else {
            if (!img || !img.complete || img.naturalWidth <= 0) {
                return;
            }
            built = buildSpriteBillboard(meta, img);
        }
        if (!built) {
            return;
        }

        /** Wrap `built` in a swing compensator. The compensator sits at identity until
         *  {@link applySwingCompensator} adjusts it per frame; it keeps the user-tuned
         *  rest pose of `built` intact and only adds the swing-time delta. Mirror the
         *  rest-pose userData onto the outer wrapper so downstream code (dispose walker,
         *  PlayerRenderer checks) finds the FP tool root via either object. */
        const compensator = new THREE.Group();
        compensator.add(built);
        compensator.userData.__fusLabyFpToolRoot = true;
        compensator.userData.__fusFpToolMode = built.userData.__fusFpToolMode;
        compensator.renderOrder = built.renderOrder;

        stack.add(compensator);
        fpToolRoot = compensator;
        lastFpToolKey = key;

        applySwingCompensator(compensator, player, partialTicks);
    };
}
