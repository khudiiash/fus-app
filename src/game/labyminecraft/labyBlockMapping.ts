/**
 * Map minebase-style {@link BlockType} indices (stored in Firestore `SerializedBlock.type`)
 * to Laby js-minecraft block type IDs (see `BlockRegistry.js` in the vendored tree).
 */
export function fusBlockTypeToLabyTypeId(fusType: number): number {
  switch (fusType) {
    case 0:
      return 2
    case 1:
      return 12
    case 2:
      return 17
    case 3:
      return 18
    case 4:
      return 3
    case 5:
      return 1
    case 6:
      return 4
    case 7:
      return 5
    case 8:
      return 1
    case 9:
      return 1
    case 10:
      return 20
    case 11:
      return 7
    case 12:
      return 9
    default:
      return 1
  }
}

/** Best-effort inverse for blocks broken in-world (Laby type → stored FUS enum). */
export function labyTypeIdToFusBlockType(labyTypeId: number): number {
  switch (labyTypeId) {
    case 2:
      return 0
    case 12:
      return 1
    case 17:
      return 2
    case 18:
      return 3
    case 3:
      return 4
    case 1:
      return 5
    case 4:
      return 6
    case 5:
      return 7
    case 20:
      return 10
    case 7:
      return 11
    case 9:
      return 12
    default:
      return 5
  }
}
