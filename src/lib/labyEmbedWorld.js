import { sharedWorldSeedsToLabyLong, normalizeSharedWorldSeeds } from '@/lib/labyWorldSeed'

/**
 * @param {import('@labymc/src/js/net/minecraft/client/Minecraft.js').default} mc
 * @param {ReturnType<typeof normalizeSharedWorldSeeds>} seeds
 * @param {{ x: number, y: number, z: number } | null} labySpawn
 */
export async function createLabyWorldAndLoad(mc, seeds, labySpawn) {
  const { default: World } = await import('@labymc/src/js/net/minecraft/client/world/World.js')
  const { default: ChunkProviderGenerate } = await import(
    '@labymc/src/js/net/minecraft/client/world/provider/ChunkProviderGenerate.js',
  )

  const n = normalizeSharedWorldSeeds(seeds)
  const seedLong = sharedWorldSeedsToLabyLong(n)
  const world = new World(mc)
  world.setChunkProvider(new ChunkProviderGenerate(world, seedLong))

  const ls = labySpawn
  if (ls && Number.isFinite(ls.x) && Number.isFinite(ls.z)) {
    if (Number.isFinite(ls.y)) {
      world.spawn.x = ls.x
      world.spawn.y = ls.y
      world.spawn.z = ls.z
    } else {
      world.setSpawn(ls.x, ls.z)
    }
  } else {
    world.getChunkProvider().findSpawn()
  }

  mc.loadWorld(world)
}
