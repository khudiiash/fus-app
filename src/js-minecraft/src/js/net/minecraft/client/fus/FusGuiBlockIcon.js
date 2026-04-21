import terrainPngUrl from "../../../../../../src/resources/terrain/terrain.png";
import { BlockRegistry } from "../world/block/BlockRegistry.js";

/**
 * 2D-canvas block-icon renderer. Reconstructed after a local-history loss — this is intentionally
 * a thin path (no 3-face GL preview) so the shop / hotbar / inventory always have a visible tile
 * even when the heavier GL path isn't wired up.
 *
 * Atlas layout: {@code terrain.png} is a 16×16 grid of 16px tiles (see {@code BlockRenderer.renderGuiItem}).
 */

const ATLAS_GRID = 16;

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
    21: 11, // FUS indestructible — reuses bedrock tile until a dedicated texture ships
    50: 9, // torch
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
        img.onerror = () => reject(new Error("FusGuiBlockIcon: terrain.png load failed"));
        img.src = terrainPngUrl;
    });
    return _terrainImgPromise;
}

// Warm cache on first import so the first draw doesn't always miss.
void loadTerrainImage().catch(() => {});

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
 * Render a 2D canvas showing the block's top-face tile at the requested pixel size.
 * Returns {@code null} if the engine id can't be resolved or the atlas isn't ready yet.
 *
 * @param {import("../Minecraft.js").default | null | undefined} mc — unused; kept for API parity
 *   with the GL version so callers don't have to branch.
 * @param {number} engineBlockId
 * @param {number} size — target CSS-pixel size (device pixel ratio is applied internally).
 * @returns {HTMLCanvasElement | null}
 */
export function renderFusGuiBlockIconToCanvas(mc, engineBlockId, size) {
    void mc;
    const img = _terrainImg;
    if (!img) {
        // Trigger load so the next call likely hits.
        loadTerrainImage().catch(() => {});
        return null;
    }
    const px = Math.max(8, size | 0);
    const dpr = Math.max(1, Math.min(3, (globalThis.devicePixelRatio || 1) | 0));
    const canvas = document.createElement("canvas");
    canvas.width = px * dpr;
    canvas.height = px * dpr;
    canvas.style.width = `${px}px`;
    canvas.style.height = `${px}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;

    const slot = resolveTopTextureSlot(engineBlockId) & 0xff;
    const col = slot % ATLAS_GRID;
    const row = (slot / ATLAS_GRID) | 0;
    const tileW = img.naturalWidth / ATLAS_GRID;
    const tileH = img.naturalHeight / ATLAS_GRID;
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
