import ModelPlayer from "../../model/model/ModelPlayer.js";
import EntityRenderer from "../EntityRenderer.js";
import Block from "../../../world/block/Block.js";
import * as THREE from "../../../../../../../../libraries/three.module.js";

export default class PlayerRenderer extends EntityRenderer {

    constructor(worldRenderer) {
        super(new ModelPlayer());

        this.worldRenderer = worldRenderer;

        // Load character texture
        this.textureCharacter = worldRenderer.minecraft.getThreeTexture('char.png');
        this.textureCharacter.magFilter = THREE.NearestFilter;
        this.textureCharacter.minFilter = THREE.NearestFilter;

        // First person right-hand holder
        this.handModel = null;
        this.firstPersonGroup = new THREE.Object3D();
        this.worldRenderer.overlay.add(this.firstPersonGroup);
    }

    rebuild(entity) {
        let isSelf = entity === this.worldRenderer.minecraft.player;
        let firstPerson = this.worldRenderer.minecraft.settings.thirdPersonView === 0;
        let itemId = firstPerson && isSelf ? this.worldRenderer.itemToRender : entity.inventory.getItemInSelectedSlot();
        let hasItem = itemId !== 0;

        // When a FUS tool is selected, the GLTF is rendered via {@code fusSyncFpToolIntoFirstPerson}.
        // The engine's per-item FP path below would also add the vanilla block mesh (or the fist),
        // leaving the user with *both* the fist/block and the tool on screen — user-reported
        // "can see both the fist and the tool" bug. Routing FUS-tool rebuilds down the hand
        // branch lets the existing `hideVanillaFpHand` traversal suppress the skin geometry,
        // so only the GLTF tool ends up visible.
        let hideVanillaFpHand = isSelf
            && typeof this.worldRenderer.minecraft.fusHideVanillaFpHand === 'function'
            && this.worldRenderer.minecraft.fusHideVanillaFpHand();

        if (firstPerson && hasItem && isSelf && !hideVanillaFpHand) {
            super.rebuild(entity);

            // Create new item group and add it to the hand
            this.firstPersonGroup.clear();
            let itemGroup = new THREE.Object3D();
            this.firstPersonGroup.add(itemGroup);

            // Render item in hand in first person
            let block = Block.getById(itemId);
            this.worldRenderer.blockRenderer.renderBlockInFirstPerson(itemGroup, block, entity.getEntityBrightness());

            // Copy material and update depth test of the item to render it always in front
            let mesh = itemGroup.children[0];
            mesh.material = mesh.material.clone();
            mesh.material.depthTest = false;
        } else {
            this.tessellator.bindTexture(this.textureCharacter);
            super.rebuild(entity);

            // Render item in hand in third person
            if (hasItem) {
                let block = Block.getById(itemId);
                let group = this.model.rightArm.bone;
                this.worldRenderer.blockRenderer.renderBlockInHandThirdPerson(group, block, entity.getEntityBrightness());
            }

            // Create first person right hand and attach it to the holder
            this.firstPersonGroup.clear();
            this.handModel = this.model.rightArm.clone();
            this.firstPersonGroup.add(this.handModel.bone);

            if (hideVanillaFpHand) {
                // FUS GLTF tool is attached to the {@link firstPersonGroup} directly by
                // {@link fusSyncFpToolIntoFirstPerson}, so we can safely hide the entire
                // vanilla arm-bone subtree. Previous per-mesh visibility toggles missed
                // nested outer-layer meshes on some skin model variants, which is why the
                // fist stayed visible behind the GLTF tool. A single flag on the root is
                // both faster and impossible to miss.
                this.handModel.bone.visible = false;
            } else {
                // Copy material and update depth test of the hand to render it always in front
                let mesh = this.handModel.bone.children[0];
                mesh.material = mesh.material.clone();
                mesh.material.depthTest = false;
            }
        }
    }

    render(entity, partialTicks) {
        let swingProgress = entity.swingProgress - entity.prevSwingProgress;
        if (swingProgress < 0.0) {
            swingProgress++;
        }
        this.model.swingProgress = entity.prevSwingProgress + swingProgress * partialTicks;
        this.model.hasItemInHand = entity.inventory.getItemInSelectedSlot() !== 0;
        this.model.isSneaking = entity.isSneaking();

        // TODO find a better way
        if (entity !== this.worldRenderer.minecraft.player) {
            this.firstPersonGroup.visible = false;
        }

        super.render(entity, partialTicks);
    }

    updateFirstPerson(player) {
        // Make sure the model is created
        this.prepareModel(player);

        // Make the group visible
        this.firstPersonGroup.visible = true;
    }

    renderRightHand(player, partialTicks) {
        this.updateFirstPerson(player);

        if (this.handModel == null) {
            return;
        }

        // Set transform of renderer
        this.model.swingProgress = 0;
        this.model.hasItemInHand = false;
        this.model.isSneaking = false;
        this.model.setRotationAngles(player, 0, 0, 0, 0, 0, 0);
        this.handModel.copyTransformOf(this.model.rightArm);

        // Render hand model (meshes may be hidden when FUS replaces the FP arm with a GLTF tool)
        this.handModel.render();
    }

    fillMeta(entity, meta) {
        super.fillMeta(entity, meta);

        let firstPerson = this.worldRenderer.minecraft.settings.thirdPersonView === 0;

        meta.firstPerson = firstPerson;
        meta.itemInHand = firstPerson ? this.worldRenderer.itemToRender : entity.inventory.getItemInSelectedSlot();

        // FUS: include the hotbar FUS-tool identity in the rebuild key so switching
        // between fist and a tool (or between two different tools) re-runs `rebuild()`
        // and flips {@link handModel.bone.visible} correctly. Without this, tools don't
        // change the vanilla {@code itemInHand} (they are not block items), so the
        // fist used to linger until a block was selected in between — user-reported
        // "when from fist I select a tool, fist remains there, it disappears only if
        // I choose a block first" bug.
        let isSelf = entity === this.worldRenderer.minecraft.player;
        if (isSelf) {
            let mc = this.worldRenderer.minecraft;
            let sel = entity && entity.inventory ? entity.inventory.selectedSlotIndex : -1;
            let hotbarMeta = mc && mc.fusHotbarSlotMeta ? mc.fusHotbarSlotMeta[sel] : null;
            meta.fusToolKey = hotbarMeta && hotbarMeta.kind === 'tool'
                ? `tool:${hotbarMeta.toolMeshName || sel}`
                : '';
        } else {
            meta.fusToolKey = '';
        }
    }

}