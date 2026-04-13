/**
 * Names / sprites for `tools.glb` + `tools.png` (6 material columns × 5 tool rows).
 * GLB node names follow Blender: `Diamond_Pickaxe`, `Wooden_Hoe`, …
 */

export const TOOLS_PACK_GLB_URL = new URL('./assets/tools.glb', import.meta.url)
  .href
export const TOOLS_SPRITE_SHEET_URL = new URL('./assets/tools.png', import.meta.url)
  .href

export const TOOL_SPRITE_COLS = 6
export const TOOL_SPRITE_ROWS = 5

/** Columns left → right in the spritesheet / tier order. */
export const TIER_PREFIXES = [
  'Wooden',
  'Stone',
  'Iron',
  'Golden',
  'Diamond',
  'Netherite',
] as const

/** Rows top → bottom in the spritesheet. */
export const TOOL_SUFFIXES = [
  'Hoe',
  'Shovel',
  'Axe',
  'Pickaxe',
  'Sword',
] as const

export type ToolTier = (typeof TIER_PREFIXES)[number]
export type ToolKind = (typeof TOOL_SUFFIXES)[number]

const SUFFIX_SORTED = [...TOOL_SUFFIXES].sort((a, b) => b.length - a.length)

/** Parse `Iron_Pickaxe` → { tier: 'Iron', tool: 'Pickaxe' }. */
export function parseToolMeshBaseName(name: string): {
  tier: ToolTier
  tool: ToolKind
} | null {
  const n = name.trim()
  for (const suf of SUFFIX_SORTED) {
    const sufWith = `_${suf}`
    if (n.endsWith(sufWith)) {
      const tierStr = n.slice(0, -sufWith.length)
      const tier = TIER_PREFIXES.find((t) => t === tierStr) as ToolTier | undefined
      if (!tier) return null
      return { tier, tool: suf as ToolKind }
    }
  }
  return null
}

export function toolSpriteCellFromMeshName(
  meshName: string,
): { row: number; col: number } | null {
  const p = parseToolMeshBaseName(meshName)
  if (!p) return null
  const row = TOOL_SUFFIXES.indexOf(p.tool)
  const col = TIER_PREFIXES.indexOf(p.tier)
  if (row < 0 || col < 0) return null
  return { row, col }
}

export function isKnownToolMeshName(name: string): boolean {
  return toolSpriteCellFromMeshName(name) != null
}

const TIER_INDEX: Record<string, number> = Object.fromEntries(
  TIER_PREFIXES.map((t, i) => [t, i]),
)

/** Mining damage per swing (tuned for {@link blockTypeBreakHp}). */
export function defaultMineDamageForMesh(meshName: string): number {
  const p = parseToolMeshBaseName(meshName)
  if (!p) return 3.2
  const ti = TIER_INDEX[p.tier] ?? 0
  const base = [1.75, 2.35, 2.95, 2.55, 3.85, 4.35][ti] ?? 3.2
  const mul =
    p.tool === 'Pickaxe'
      ? 1.08
      : p.tool === 'Axe'
        ? 1.02
        : p.tool === 'Shovel'
          ? 0.98
          : p.tool === 'Hoe'
            ? 0.72
            : 0.88 // sword — poor vs stone, OK vs entities
  return Math.round(base * mul * 100) / 100
}

/** Half-heart PvP damage (0 = no player damage). */
export function defaultPvpHalfForMesh(meshName: string): number {
  const p = parseToolMeshBaseName(meshName)
  if (!p) return 2
  if (p.tool === 'Hoe' || p.tool === 'Shovel') return 0
  const ti = TIER_INDEX[p.tier] ?? 0
  const tierPvp = [1, 1, 2, 2, 2, 3][ti] ?? 2
  if (p.tool === 'Sword') return Math.min(6, tierPvp + 1)
  if (p.tool === 'Axe') return tierPvp
  if (p.tool === 'Pickaxe') return tierPvp
  return 0
}

/** Default Firestore `blockWorld` for a tool row in the shop seed. */
export function defaultBlockWorldToolDoc(meshName: string) {
  return {
    kind: 'tool' as const,
    toolMeshName: meshName,
    mineDamage: defaultMineDamageForMesh(meshName),
    pvpDamageHalf: defaultPvpHalfForMesh(meshName),
  }
}

/** All mesh names present in `tools.glb` (scene root nodes). */
export const ALL_TOOL_MESH_NAMES = [
  'Wooden_Hoe',
  'Stone_Hoe',
  'Iron_Hoe',
  'Golden_Hoe',
  'Diamond_Hoe',
  'Netherite_Hoe',
  'Wooden_Shovel',
  'Stone_Shovel',
  'Iron_Shovel',
  'Golden_Shovel',
  'Diamond_Shovel',
  'Netherite_Shovel',
  'Wooden_Axe',
  'Stone_Axe',
  'Iron_Axe',
  'Golden_Axe',
  'Diamond_Axe',
  'Netherite_Axe',
  'Wooden_Pickaxe',
  'Stone_Pickaxe',
  'Iron_Pickaxe',
  'Golden_Pickaxe',
  'Diamond_Pickaxe',
  'Netherite_Pickaxe',
  'Wooden_Sword',
  'Stone_Sword',
  'Iron_Sword',
  'Golden_Sword',
  'Diamond_Sword',
  'Netherite_Sword',
] as const
