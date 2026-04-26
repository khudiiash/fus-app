import BoundingBox from "../../../../util/BoundingBox.js";
import Block from "../Block.js";
import EnumBlockFace from "../../../../util/EnumBlockFace.js";
import BlockRenderType from "../../../../util/BlockRenderType.js";

export default class BlockTorch extends Block {

    constructor(id, textureSlotId) {
        super(id, textureSlotId);

        this.boundingBox = new BoundingBox(0.4, 0.0, 0.4, 0.6, 0.6, 0.6);

        // Sound
        this.sound = Block.sounds.wood;

        // Create data faces
        this.dataFaces = [
            EnumBlockFace.WEST,
            EnumBlockFace.EAST,
            EnumBlockFace.NORTH,
            EnumBlockFace.SOUTH,
            EnumBlockFace.BOTTOM,
        ]
    }

    getLightValue() {
        return 14;
    }

    isSolid() {
        return false;
    }

    isTranslucent() {
        return true;
    }

    /**
     * Inherits {@link Block#getOpacity} = 1.0 otherwise, which made {@link MetadataChunkBlock}
     * treat the cell as almost opaque: {@code newLevel -= 255} killed propagation from the
     * touch’s {@link #getLightValue} in neighbours — caves stayed black (FUS Laby, 2026-04).
     */
    getOpacity() {
        return 0.0;
    }

    getRenderType() {
        return BlockRenderType.TORCH;
    }

    onBlockAdded(world, x, y, z) {
        for (let i = this.dataFaces.length - 1; i >= 0; i--) {
            let dataFace = this.dataFaces[i];

            if (world.isSolidBlockAt(x + dataFace.x, y + dataFace.y, z + dataFace.z)) {
                let data = i + 1;

                // Update block data in world
                world.setBlockDataAt(x, y, z, data);
                break;
            }
        }
    }

    onBlockPlaced(world, x, y, z, face) {
        let data = world.getBlockDataAt(x, y, z);

        for (let i in this.dataFaces) {
            let dataFace = this.dataFaces[i];

            if (face === dataFace.opposite() && world.isSolidBlockAt(x + dataFace.x, y + dataFace.y, z + dataFace.z)) {
                data = parseInt(i) + 1;
                break;
            }
        }

        // Update block data in chunk section directly to avoid notify
        world.getChunkSectionAt(x >> 4, y >> 4, z >> 4).setBlockDataAt(x & 15, y & 15, z & 15, data);
    }

    collisionRayTrace(world, x, y, z, start, end) {
        let data = world.getBlockDataAt(x, y, z) & 7;

        switch (data) {
            case 1:
                this.boundingBox = new BoundingBox(0.0, 0.2, 0.35, 0.3, 0.8, 0.65);
                break;
            case 2:
                this.boundingBox = new BoundingBox(0.7, 0.2, 0.35, 1.0, 0.8, 0.65);
                break;
            case 3:
                this.boundingBox = new BoundingBox(0.35, 0.2, 0.0, 0.65, 0.8, 0.3);
                break;
            case 4:
                this.boundingBox = new BoundingBox(0.35, 0.2, 0.7, 0.65, 0.8, 1.0);
                break;
            default:
                this.boundingBox = new BoundingBox(0.4, 0.0, 0.4, 0.6, 0.6, 0.6);
                break;
        }

        return super.collisionRayTrace(world, x, y, z, start, end);
    }
}