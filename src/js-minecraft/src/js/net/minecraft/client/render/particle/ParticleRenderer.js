import MathHelper from "../../../util/MathHelper.js";
import Block from "../../world/block/Block.js";
import ParticleDigging from "./particle/ParticleDigging.js";

export default class ParticleRenderer {

    constructor(minecraft) {
        this.minecraft = minecraft;
        this.particles = [];
    }

    /** @returns {number} */
    _maxDiggingParticles() {
        const m = this.minecraft;
        if (m && m.fusLowTierMobile) return 80;
        if (typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__) return 120;
        return 320;
    }

    spawnParticle(particle) {
        const cap = this._maxDiggingParticles();
        while (this.particles.length >= cap) {
            const dead = this.particles.shift();
            if (dead && !dead.isDead) try { dead.kill(); } catch (_) { /* ignore */ }
        }
        this.particles.push(particle);
    }

    onTick() {
        for (let i = 0; i < this.particles.length; i++) {
            const particle = this.particles[i];
            particle.onUpdate();

            if (particle.isDead) {
                this.particles.splice(i, 1);
                i--;
            }
        }
    }

    renderParticles(cameraEntity, partialTicks) {
        let yaw = cameraEntity.prevRotationYaw + (cameraEntity.rotationYaw - cameraEntity.prevRotationYaw) * partialTicks;
        let pitch = cameraEntity.prevRotationPitch + (cameraEntity.rotationPitch - cameraEntity.prevRotationPitch) * partialTicks;

        let rotationX = MathHelper.toRadians(pitch);
        let rotationY = -MathHelper.toRadians(yaw);

        for (let i = 0; i < this.particles.length; i++) {
            const particle = this.particles[i];

            particle.render(rotationX, rotationY, 0, partialTicks);
        }
    }

    /**
     * @param {*} world
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} [typeIdAtBreak] When set (e.g. FUS progressive break), use this instead of
     *        {@code world.getBlockAt} so particles still spawn if the cell is already air in the client world.
     */
    spawnBlockBreakParticle(world, x, y, z, typeIdAtBreak) {
        let typeId =
            typeIdAtBreak !== undefined && typeIdAtBreak !== null
                ? typeIdAtBreak | 0
                : world.getBlockAt(x, y, z);
        if (typeId === 0) {
            return;
        }

        let block = Block.getById(typeId);
        /** 4³=64 was very heavy on mobile (each particle = scene mesh + tessellated quad). */
        const m = this.minecraft;
        const range =
            m && m.fusLowTierMobile
                ? 2
                : typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__
                  ? 3
                  : 4;
        for (let offsetX = 0; offsetX < range; offsetX++) {
            for (let offsetY = 0; offsetY < range; offsetY++) {
                for (let offsetZ = 0; offsetZ < range; offsetZ++) {

                    let targetX = x + (offsetX + 0.5) / range;
                    let targetY = y + (offsetY + 0.5) / range;
                    let targetZ = z + (offsetZ + 0.5) / range;

                    let motionX = targetX - x - 0.5;
                    let motionY = targetY - y - 0.5;
                    let motionZ = targetZ - z - 0.5;

                    this.spawnParticle(new ParticleDigging(
                        this.minecraft,
                        world,
                        targetX,
                        targetY,
                        targetZ,
                        motionX,
                        motionY,
                        motionZ,
                        block
                    ));
                }
            }
        }
    }


}