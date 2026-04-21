# js-minecraft (FUS fork)

**Engine repo:** [khudiiash/js-minecraft](https://github.com/khudiiash/js-minecraft) (fork of [LabyStudio/js-minecraft](https://github.com/LabyStudio/js-minecraft)).

**In FUSAPP:** this tree is a **git submodule** at `third-party/js-minecraft`. After clone, run `git submodule update --init --recursive` from the app repo root.

Upstream is an educational browser sandbox, not an official Mojang product.

## License (important)

The upstream `LICENSE` in this folder is **Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0)**.

- You **must keep** the license file and give **attribution** when sharing this material.
- **Non-commercial** use only, unless you obtain a separate license from the rights holder or your use qualifies under applicable law.

FUSAPP maintainers: confirm with your legal counsel before shipping this code path in any **commercial** or fee-based product context.

## FUS integration

- Runtime assets (textures, sounds) are served from `public/labyminecraft/src/resources/` so URLs resolve as `/labyminecraft/src/resources/...` under the Vite dev server and production `BASE_URL`.
- Before booting the client, the host sets `window.__LABY_MC_ASSET_BASE__ = import.meta.env.BASE_URL + 'labyminecraft/'`.
- `Start.js` was adjusted to use that base, return the `Minecraft` instance from `launch()`, and **not** auto-start on `pageshow` (the SPA owns the lifecycle).

### Shared world (Firebase, same contract as Block World Next)

- **World id:** `fus-world-laby` (`src/game/labyminecraft/fusSharedWorldLabyId.ts`).
- **Firestore:** `sharedWorlds/fus-world-laby` — `seeds` (five floats) + optional `customBlocks` mirror.
- **RTDB:** `worldBlockEdits/fus-world-laby/customBlocks` when RTDB is configured (same path pattern as `sharedWorldFirestore.ts`).
- **Laby terrain:** `SharedWorldSeeds` are hashed to a single `Long` world seed for `ChunkProviderGenerate` so all clients generate the same Alpha-style terrain.
- **Edits:** `src/game/labyminecraft/createFusLabySharedBridge.ts` wraps `World#setBlockAt`, keeps a local cell map, merges with remote via exported `mergeCustomBlockLists`, applies deltas to the mesh, and flushes with `scheduleFlushSharedWorldBlocksList` (same debounced RTDB transaction as world-next).
- **UI:** `/student/world-laby` — immersive student chrome via `useBlockWorldSession`; tab bar entry **«Світ Laby»**.

### Done vs planned

| Done | Planned (later PRs) |
|------|---------------------|
| Shared seeds + RTDB/Firestore block list ↔ Laby world | RTDB **presence** poses → other players in-scene |
| FUS `SerializedBlock.type` ↔ Laby block IDs (see `labyBlockMapping.ts`) | **Mobs** as synced actors + simple render |
| Auth display name → in-game username | **Coins / shop** as Vue overlay + existing Pinia (keep out of Laby inventory for now) |

## Next steps (upstream / legal)

- Bridge sessions / usernames to your auth store.
- Replace or proxy `Minecraft.PROXY` multiplayer WebSocket if you run your own gateway.
- Gradually TypeScript-wrap or fork subsystems instead of editing vendored files when upstream updates matter.
