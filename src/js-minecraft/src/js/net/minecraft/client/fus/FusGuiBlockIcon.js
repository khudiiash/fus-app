import terrainPngUrl from "../../../../../../src/resources/terrain/terrain.png";
import * as THREE from "../../../../../../libraries/three.module.js";
import { BlockRegistry } from "../world/block/BlockRegistry.js";
import Block from "../world/block/Block.js";
import BlockRenderer from "../render/BlockRenderer.js";

/**
 * Block icons for Vue (inventory / profile): the same 3-face path as {@link BlockRenderer#renderGuiBlock}
 * used by {@link import("../render/gui/ItemRenderer.js")} for the in-game hotbar, rendered to an
 * offscreen WebGL context so the terrain texture is not “fetched” as separate URLs and matches the
 * hotbar. Falls back to a 2D top-face blit if GL cannot run.
 *
 * Terrain reference (2D fallback): {@code terrain/terrain.png} 16×16 macrotiles.
 */

const ATLAS_TILE_PX = 16;

/**
 * Fallback engine-id → top-face texture-slot map, used only when {@code BlockRegistry} can't
 * resolve the block (e.g. during cold boot before {@link BlockRegistry.create}).
 * Values mirror the constants in {@link ../world/block/BlockRegistry.js}.
 */
const ENGINE_ID_TO_SLOT_FALLBACK = {
    1: 0, // stone
    2: 1, // grass
    3: 2, // dirt
    4: 14, // cobblestone
    5: 10, // wood/planks
    7: 11, // bedrock
    9: 7, // water
    12: 8, // sand
    13: 13, // gravel
    17: 4, // log
    18: 6, // leaves (colored via color channel)
    20: 12, // glass
    21: 24, // FUS indestructible — obsidian macrotile
    50: 9, // torch
    51: 15, // gold ore (tinted in world)
};

/** @type {HTMLImageElement | null} */
let _terrainImg = null;
/** @type {Promise<HTMLImageElement> | null} */
let _terrainImgPromise = null;

function loadTerrainImage() {
    if (_terrainImg) return Promise.resolve(_terrainImg);
    if (_terrainImgPromise) return _terrainImgPromise;
    _terrainImgPromise = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            _terrainImg = img;
            resolve(img);
        };
        img.onerror = () => reject(new Error("FusGuiBlockIcon: terrain/terrain.png load failed"));
        img.src = terrainPngUrl;
    });
    return _terrainImgPromise;
}

// Warm cache on first import so the first draw doesn't always miss.
void loadTerrainImage().catch(() => {});

/** @type {THREE.WebGLRenderer | null} */
let _iconGl = null;
/** @type {THREE.Scene | null} */
let _iconScene = null;
/** @type {THREE.OrthographicCamera | null} */
let _iconCam = null;
/** @type {BlockRenderer | null} */
let _iconBlockRenderer = null;

/**
 * @param {import("../Minecraft.js").default} mc
 * @returns {{ r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.OrthographicCamera, br: BlockRenderer } | null}
 */
function ensureIconGlPipeline(mc) {
    if (!mc?.worldRenderer?.textureTerrain) return null;
    if (_iconGl && _iconScene && _iconCam && _iconBlockRenderer) {
        return { r: _iconGl, scene: _iconScene, cam: _iconCam, br: _iconBlockRenderer };
    }
    const canvas = document.createElement("canvas");
    const r = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
    });
    r.autoClear = true;
    r.setClearColor(0, 0);
    // Same as {@link WorldRenderer#initialize} / {@link ItemRenderer#initialize} — atlas is
    // NoColorSpace; LinearSRGB + Neutral keeps Minecraft-style saturation (avoids pale blocks).
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1;
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-14, 14, 14, -14, 0.1, 200);
    cam.position.set(0, 0, 28);
    cam.lookAt(0, 0, 0);
    const br = new BlockRenderer(mc.worldRenderer);
    _iconGl = r;
    _iconScene = scene;
    _iconCam = cam;
    _iconBlockRenderer = br;
    return { r, scene, cam, br };
}

/**
 * @param {THREE.Object3D} group
 */
function disposeGroupContents(group) {
    group.traverse((o) => {
        if (o.geometry) {
            try {
                o.geometry.dispose();
            } catch {
                /* ignore */
            }
        }
    });
}

/**
 * @param {number} engineBlockId
 * @returns {number}
 */
function resolveTopTextureSlot(engineBlockId) {
    const id = engineBlockId | 0;
    try {
        for (const key of Object.keys(BlockRegistry)) {
            const block = BlockRegistry[key];
            if (block && typeof block === "object" && block.id === id) {
                if (typeof block.getTextureIndex === "function") {
                    // face=1 (top) for grass-style blocks; others ignore the arg.
                    const slot = block.getTextureIndex(1);
                    if (Number.isFinite(slot)) return slot | 0;
                }
                if (Number.isFinite(block.textureSlotId)) return block.textureSlotId | 0;
            }
        }
    } catch {
        /* fall through to map */
    }
    const mapped = ENGINE_ID_TO_SLOT_FALLBACK[id];
    return Number.isFinite(mapped) ? mapped : 0;
}

/**
 * 2D fallback: single top (or NORTH) tile – used when the WebGL path is not available.
 *
 * @param {number} engineBlockId
 * @param {number} px
 * @param {number} dpr
 * @returns {HTMLCanvasElement | null}
 */
function renderTopFace2dFallback(engineBlockId, px, dpr) {
    const img = _terrainImg;
    if (!img) {
        loadTerrainImage().catch(() => {});
        return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = px * dpr;
    canvas.height = px * dpr;
    canvas.style.width = `${px}px`;
    canvas.style.height = `${px}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    const slot = resolveTopTextureSlot(engineBlockId) >>> 0;
    const tilesX = Math.max(1, (img.naturalWidth / ATLAS_TILE_PX) | 0);
    const col = slot % tilesX;
    const row = (slot / tilesX) | 0;
    const tileW = ATLAS_TILE_PX;
    const tileH = ATLAS_TILE_PX;
    ctx.drawImage(
        img,
        col * tileW,
        row * tileH,
        tileW,
        tileH,
        0,
        0,
        canvas.width,
        canvas.height,
    );
    return canvas;
}

/**
 * Renders a block the same way as the in-game hotbar: {@link BlockRenderer#renderGuiBlock} (TOP +
 * NORTH + EAST) into an offscreen buffer, then copies to a new canvas. Falls back to a 2D
 * top-face blit if GL is not ready.
 *
 * @param {import("../Minecraft.js").default | null | undefined} mc
 * @param {number} engineBlockId
 * @param {number} size — target CSS pixel size; internal buffer uses size × DPR.
 * @returns {HTMLCanvasElement | null}
 */
export function renderFusGuiBlockIconToCanvas(mc, engineBlockId, size) {
    const px = Math.max(8, size | 0);
    const dpr = Math.max(1, Math.min(3, (globalThis.devicePixelRatio || 1) | 0));
    const id = engineBlockId | 0;
    const block = Block.getById(id);
    if (!block) {
        return renderTopFace2dFallback(id, px, dpr);
    }

    const pipe = ensureIconGlPipeline(/** @type {import("../Minecraft.js").default} */ (mc));
    if (pipe) {
        const { r, scene, cam, br } = pipe;
        const group = new THREE.Group();
        try {
            br.renderGuiBlock(group, block, 0, 0, 10, 1);
        } catch (e) {
            console.warn("FusGuiBlockIcon: renderGuiBlock failed", e);
        }

        if (group.children.length > 0) {
            while (scene.children.length) {
                scene.remove(scene.children[0]);
            }
            scene.add(group);
            r.setSize(px * dpr, px * dpr, false);
            r.setPixelRatio(1);
            r.clear();
            r.render(scene, cam);
            const out = document.createElement("canvas");
            out.width = px * dpr;
            out.height = px * dpr;
            out.style.width = `${px}px`;
            out.style.height = `${px}px`;
            const octx = out.getContext("2d");
            if (octx) {
                octx.imageSmoothingEnabled = false;
                octx.drawImage(r.domElement, 0, 0, out.width, out.height);
            }
            disposeGroupContents(group);
            scene.remove(group);
            return out;
        }
    }

    return renderTopFace2dFallback(id, px, dpr);
}
