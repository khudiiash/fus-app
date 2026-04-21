/**
 * Maps tool mesh names (e.g. {@code Iron_Pickaxe}) onto the 6×5 grid in
 * {@code src/resources/gui/tools.png}. Columns: wood → netherite. Rows: hoe, shovel, axe, pickaxe, sword.
 */

export const TOOL_SPRITE_COLS = 6;
export const TOOL_SPRITE_ROWS = 5;

const TIER_COL = {
    Wooden: 0,
    Stone: 1,
    Iron: 2,
    Golden: 3,
    Diamond: 4,
    Netherite: 5,
};

const TYPE_ROW = {
    Hoe: 0,
    Shovel: 1,
    Axe: 2,
    Pickaxe: 3,
    Sword: 4,
};

const FALLBACK = { row: TYPE_ROW.Pickaxe, col: TIER_COL.Iron };

/**
 * @param {string} meshName e.g. {@code Iron_Pickaxe}. Any Blender numeric suffix (e.g. {@code .001})
 *   is stripped before matching.
 * @returns {{ row: number, col: number }}
 */
export function toolSpriteCellFromMeshName(meshName) {
    const clean = String(meshName || "").split(".")[0];
    const m = clean.match(
        /^(Wooden|Stone|Iron|Golden|Diamond|Netherite)_(Hoe|Shovel|Axe|Pickaxe|Sword)$/,
    );
    if (!m) return { ...FALLBACK };
    const col = TIER_COL[m[1]];
    const row = TYPE_ROW[m[2]];
    if (col === undefined || row === undefined) return { ...FALLBACK };
    return { row, col };
}

/**
 * Row-major linear index into the 6×5 grid (`row * 6 + col`), or -1 if the mesh name can't be parsed.
 * Used to pick the matching mesh from a flat list in `tools.glb`.
 * @param {string} meshName
 * @returns {number}
 */
export function toolGridLinearIndexFromMeshName(meshName) {
    const clean = String(meshName || "").split(".")[0];
    const m = clean.match(
        /^(Wooden|Stone|Iron|Golden|Diamond|Netherite)_(Hoe|Shovel|Axe|Pickaxe|Sword)$/,
    );
    if (!m) return -1;
    const col = TIER_COL[m[1]];
    const row = TYPE_ROW[m[2]];
    if (col === undefined || row === undefined) return -1;
    return row * TOOL_SPRITE_COLS + col;
}
