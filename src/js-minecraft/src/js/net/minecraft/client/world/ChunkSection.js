import EnumSkyBlock from "../../util/EnumSkyBlock.js";
import Block from "./block/Block.js";
import * as THREE from "../../../../../../libraries/three.module.js";

export default class ChunkSection {

    static SIZE = 16;

    constructor(world, chunk, x, y, z) {
        this.world = world;
        this.chunk = chunk;

        this.x = x;
        this.y = y;
        this.z = z;

        this.boundingBox = new THREE.Box3();
        this.boundingBox.min.x = x * ChunkSection.SIZE;
        this.boundingBox.min.y = y * ChunkSection.SIZE;
        this.boundingBox.min.z = z * ChunkSection.SIZE;
        this.boundingBox.max.x = x * ChunkSection.SIZE + ChunkSection.SIZE;
        this.boundingBox.max.y = y * ChunkSection.SIZE + ChunkSection.SIZE;
        this.boundingBox.max.z = z * ChunkSection.SIZE + ChunkSection.SIZE;

        this.group = new THREE.Object3D();
        this.group.position.x = this.x * ChunkSection.SIZE;
        this.group.position.y = this.y * ChunkSection.SIZE;
        this.group.position.z = this.z * ChunkSection.SIZE;
        this.group.updateMatrix();
        this.group.matrixAutoUpdate = false;
        this.isModified = true;

        this.blocks = [];
        this.blocksData = [];
        this.blockLight = [];
        this.skyLight = [];
        this.empty = true;
    }

    render() {

    }

    /**
     * Recompute {@link #_fusNonAirBlockCount} and delete stale 0 keys from the sparse
     * {@link #blocks} map (legacy / bulk fills sometimes stored air explicitly).
     */
    _ensureNonAirTally() {
        if (this._fusNonAirBlockCount != null) {
            return;
        }
        let c = 0;
        for (const ks in this.blocks) {
            if ((this.blocks[ks] | 0) === 0) {
                delete this.blocks[ks];
            } else {
                c++;
            }
        }
        this._fusNonAirBlockCount = c;
        this.empty = c === 0;
    }

    /**
     * Iterates only placed non-air blocks. Uses sparse key iteration when the section is
     * not nearly full, falling back to the classic 16³ scan when almost every cell is
     * occupied (faster to walk a tight grid than 4k string keys).
     * @param {(x: number, y: number, z: number, typeId: number) => void} fn
     */
    forEachPlacedBlock(fn) {
        this._ensureNonAirTally();
        const n = this._fusNonAirBlockCount | 0;
        if (n === 0) {
            return;
        }
        const baseX = this.x * ChunkSection.SIZE;
        const baseY = this.y * ChunkSection.SIZE;
        const baseZ = this.z * ChunkSection.SIZE;
        if (n < 3200) {
            for (const ks in this.blocks) {
                const typeId = this.blocks[ks] | 0;
                if (typeId === 0) {
                    continue;
                }
                const index = +ks;
                const lx = index & 15;
                const lz = (index >> 4) & 15;
                const ly = (index >> 8) & 15;
                fn(lx, ly, lz, typeId, baseX + lx, baseY + ly, baseZ + lz);
            }
        } else {
            for (let x = 0; x < ChunkSection.SIZE; x++) {
                for (let y = 0; y < ChunkSection.SIZE; y++) {
                    for (let z = 0; z < ChunkSection.SIZE; z++) {
                        const typeId = this.getBlockAt(x, y, z);
                        if (typeId !== 0) {
                            fn(x, y, z, typeId, baseX + x, baseY + y, baseZ + z);
                        }
                    }
                }
            }
        }
    }

    /**
     * @param {*} renderer WorldRenderer
     * @param {boolean} isTranslucentRenderPhase
     */
    _tessellatePass(renderer, isTranslucentRenderPhase) {
        const ambientOcclusion = this.world.minecraft.settings.ambientOcclusion;
        const tessellator = renderer.blockRenderer.tessellator;
        const world = this.world;
        const br = renderer.blockRenderer;
        tessellator.startDrawing();
        this.forEachPlacedBlock((x, y, z, typeId, ax, ay, az) => {
            const block = Block.getById(typeId);
            if (block == null || block.isTranslucent() !== isTranslucentRenderPhase) {
                return;
            }
            br.renderBlock(world, block, ambientOcclusion, ax, ay, az);
        });
        tessellator.draw(this.group, isTranslucentRenderPhase ? "trans" : "solid");
    }

    /**
     * Full one-shot mesh build (e.g. settings "reload" / {@link Chunk#rebuild}).
     * @param {*} renderer WorldRenderer
     */
    rebuild(renderer) {
        this._fusRebuildSplit = 0;
        this.isModified = false;
        this.group.clear();
        this._tessellatePass(renderer, false);
        this._tessellatePass(renderer, true);
    }

    /**
     * FUS: first half of a split rebuild — solid geometry only, clears the section group.
     * @param {*} renderer WorldRenderer
     */
    _fusRebuildSolidOnly(renderer) {
        this.isModified = false;
        this.group.clear();
        this._tessellatePass(renderer, false);
    }

    /**
     * FUS: second half — translucent (water, etc.) added without clearing the solid mesh.
     * @param {*} renderer WorldRenderer
     */
    _fusRebuildTranslucentOnly(renderer) {
        this._tessellatePass(renderer, true);
    }

    getBlockAt(x, y, z) {
        let index = y << 8 | z << 4 | x;
        return !this.empty && index in this.blocks ? this.blocks[index] : 0;
    }

    getBlockDataAt(x, y, z) {
        let index = y << 8 | z << 4 | x;
        return !this.empty && index in this.blocksData ? this.blocksData[index] : 0;
    }

    setBlockAt(x, y, z, typeId) {
        let index = y << 8 | z << 4 | x;
        let old = 0;
        if (index in this.blocks) {
            old = this.blocks[index] | 0;
        }
        if (typeId === 0) {
            if (old !== 0) {
                delete this.blocks[index];
                this._fusNonAirBlockCount = Math.max(0, (this._fusNonAirBlockCount | 0) - 1);
            } else if (index in this.blocks) {
                delete this.blocks[index];
            }
        } else {
            this.blocks[index] = typeId;
            if (old === 0) {
                this._fusNonAirBlockCount = (this._fusNonAirBlockCount | 0) + 1;
            }
        }
        this.empty = (this._fusNonAirBlockCount | 0) === 0;
        this._fusRebuildSplit = 0;
        this.isModified = true;
    }

    setBlockDataAt(x, y, z, data) {
        let index = y << 8 | z << 4 | x;
        this.blocksData[index] = data;
        this.isModified = true;
    }

    setLightAt(sourceType, x, y, z, lightLevel) {
        let index = y << 8 | z << 4 | x;

        if (sourceType === EnumSkyBlock.SKY) {
            this.skyLight[index] = lightLevel;
        }
        if (sourceType === EnumSkyBlock.BLOCK) {
            this.blockLight[index] = lightLevel;
        }

        this.isModified = true;
    }

    getTotalLightAt(x, y, z) {
        let index = y << 8 | z << 4 | x;
        let skyLight = (index in this.skyLight ? this.skyLight[index] : (this.empty ? 15 : 14)) - this.world.skylightSubtracted;
        let blockLight = index in this.blockLight ? this.blockLight[index] : 0;
        if (blockLight > skyLight) {
            skyLight = blockLight;
        }
        return skyLight;
    }

    getLightAt(sourceType, x, y, z) {
        let index = y << 8 | z << 4 | x;
        if (sourceType === EnumSkyBlock.SKY) {
            return index in this.skyLight ? this.skyLight[index] : (this.empty ? 15 : 14);
        }
        if (sourceType === EnumSkyBlock.BLOCK) {
            return index in this.blockLight ? this.blockLight[index] : 0;
        }
        return 0;
    }

    isEmpty() {
        return this.empty;
    }
}