import Gui from "../Gui.js";
import Block from "../../world/block/Block.js";
import ChatOverlay from "./ChatOverlay.js";
import Minecraft from "../../Minecraft.js";
import EnumBlockFace from "../../../util/EnumBlockFace.js";
import MathHelper from "../../../util/MathHelper.js";
import FontRenderer from "../../render/gui/FontRenderer.js";
import EnumSkyBlock from "../../../util/EnumSkyBlock.js";
import PlayerListOverlay from "./PlayerListOverlay.js";
import Keyboard from "../../../util/Keyboard.js";

export default class IngameOverlay extends Gui {

    constructor(minecraft, window) {
        super();
        this.minecraft = minecraft;
        this.window = window;

        this.chatOverlay = new ChatOverlay(minecraft);
        this.playerListOverlay = new PlayerListOverlay(minecraft, this);

        this.textureCrosshair = minecraft.resources["gui/icons.png"];
        this.textureHotbar = minecraft.resources["gui/gui.png"];

        this.ticksRendered = 0;
    }

    render(stack, mouseX, mouseY, partialTicks) {
        // Render crosshair
        if (this.minecraft.hasInGameFocus()) {
            this.renderCrosshair(stack, this.window.width / 2, this.window.height / 2)
        }

        if (typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__) {
            this.renderFusEmbedHealthBar(stack);
        }

        // Render hotbar (9 vanilla slots + FUS overflow slot — keep geometry in sync with GameWindow.js fusHotbarSlotAt)
        this.renderHotbar(stack, this.window.width / 2 - 91, this.window.height - 22);

        // Render chat canvas
        stack.drawImage(this.window.canvasChat, 0, 0);

        // Render debug canvas on stack
        if (this.minecraft.settings.debugOverlay) {
            stack.drawImage(this.window.canvasDebug, 0, 0);
        }

        // Render player list
        if (Keyboard.isKeyDown(this.minecraft.settings.keyPlayerList) && !this.minecraft.isSingleplayer()) {
            this.playerListOverlay.renderPlayerList(stack, this.window.width);
        }
    }

    onTick() {
        this.chatOverlay.onTick();

        // Render debug overlay on tick
        if (this.minecraft.settings.debugOverlay) {
            let stack = this.window.canvasDebug.getContext('2d');

            // Render debug overlay each tick if the player is moving
            if (this.ticksRendered % 10 === 0) {
                // Clear debug canvas
                stack.clearRect(0, 0, this.window.width, this.window.height);

                // Render debug information
                this.renderLeftDebugOverlay(stack);
                this.renderRightDebugOverlay(stack);
            } else if (this.minecraft.player.isMoving()) {
                // Render debug information
                this.renderLeftDebugOverlay(stack, [5, 6, 7, 8]);
            }

            this.ticksRendered++;
        }

        // Render chat on tick if dirty
        if (this.chatOverlay.isDirty()) {
            let stack = this.window.canvasChat.getContext('2d');
            stack.clearRect(0, 0, this.window.width, this.window.height);
            this.chatOverlay.render(stack, 0, 0, 0);
        }
    }

    renderCrosshair(stack, x, y) {
        let size = 15;
        this.drawSprite(stack, this.textureCrosshair, 0, 0, 15, 15, x - size / 2, y - size / 2, size, size, 0.6);
    }

    /**
     * FUS Laby: hearts from bundled `hearts_sh.png` (same 3-frame strip as Block World HUD / remotes).
     *
     * Heart count scales with the player's current max HP so a level-50 player (69 HP /
     * ~34 hearts) actually sees every heart they have. We cap the display at
     * {@link FUS_EMBED_HEARTS_MAX_PER_ROW} hearts per row and stack extra rows upwards so
     * tall bars don't bleed into the chat / hotbar. Beyond
     * {@link FUS_EMBED_HEARTS_MAX_ROWS} we switch to a compact `+N` suffix on the last
     * visible heart to keep the HUD predictable on phones.
     */
    renderFusEmbedHealthBar(stack) {
        const w = this.window.width;
        const h = this.window.height;
        const pl = this.minecraft.player;
        const maxHp = Math.max(2, Math.ceil((pl?.maxHealth ?? 20)));
        const hp = Math.max(0, Math.min(maxHp, Math.ceil(pl?.health || 0)));
        const totalHearts = Math.ceil(maxHp / 2);
        const FUS_EMBED_HEARTS_MAX_PER_ROW = 10;
        const FUS_EMBED_HEARTS_MAX_ROWS = 2;
        const perRow = FUS_EMBED_HEARTS_MAX_PER_ROW;
        const heartsShown = Math.min(totalHearts, perRow * FUS_EMBED_HEARTS_MAX_ROWS);
        const rows = Math.ceil(heartsShown / perRow);
        const img = this.minecraft.fusHeartsSheet;

        const extraHearts = totalHearts - heartsShown;
        const img_loaded = img && img.complete && img.naturalWidth > 0;

        const slotW = 11;
        const slotH = Math.round((slotW * 16) / 18);
        const gap = 2;
        const rowGap = 2;
        const cx = w / 2;

        stack.imageSmoothingEnabled = false;
        for (let r = 0; r < rows; r++) {
            const rowHearts = r === rows - 1
                ? heartsShown - r * perRow
                : perRow;
            const rowW = rowHearts * (slotW + gap) - gap;
            /** Stack rows upwards — row 0 is the bottom (closest to hotbar). */
            const rowY = h - 22 - 12 - (rows - 1 - r) * (slotH + rowGap);
            const xStart = cx - rowW / 2;
            for (let i = 0; i < rowHearts; i++) {
                const heartIndex = r * perRow + i;
                const hx = xStart + i * (slotW + gap);
                const left = hp > heartIndex * 2;
                const right = hp > heartIndex * 2 + 1;
                if (img_loaded) {
                    const iw = img.naturalWidth;
                    const ih = img.naturalHeight;
                    const frameW = iw / 3;
                    let sx = frameW * 2;
                    if (left && right) sx = 0;
                    else if (left) sx = frameW;
                    stack.drawImage(img, sx, 0, frameW, ih, hx, rowY, slotW, slotH);
                } else {
                    const tex = this.textureCrosshair;
                    if (left && right) {
                        this.drawSprite(stack, tex, 52, 0, 9, 9, hx, rowY, 9, 9, 1);
                    } else if (left) {
                        this.drawSprite(stack, tex, 61, 0, 9, 9, hx, rowY, 9, 9, 1);
                    } else {
                        this.drawSprite(stack, tex, 52, 9, 9, 9, hx, rowY, 9, 9, 1);
                    }
                }
            }
        }

        /** Overflow badge: `+N` next to the top row when the player has more hearts than
         *  we could fit. Drawn with the overlay's canvas font so it matches HUD text.
         *  We don't draw a remaining-HP aware variant (e.g. `+3/+5`) because the user-
         *  facing message is "you still have more" — the cap is a UI decision, not a
         *  stat. */
        if (extraHearts > 0) {
            const topRow = 0;
            const rowHearts = rows === 1 ? heartsShown : perRow;
            const rowW = rowHearts * (slotW + gap) - gap;
            const rowY = h - 22 - 12 - (rows - 1 - topRow) * (slotH + rowGap);
            const xEnd = cx + rowW / 2 + 4;
            stack.font = "10px sans-serif";
            stack.fillStyle = "#ffd24a";
            stack.textBaseline = "top";
            stack.fillText("+" + extraHearts, xEnd, rowY);
        }
    }

    renderHotbar(stack, x, y) {
        // Keep in sync with GameWindow.registerFusEmbedTouchInputBridge (fusHotbarSlotAt).
        const padLeft = 10;
        const hbX = x - padLeft;

        // Render background (main strip)
        this.drawSprite(stack, this.textureHotbar, 0, 0, 200, 22, hbX, y, 200, 22);

        const sel = this.minecraft.player.inventory.selectedSlotIndex;
        if (sel >= 0 && sel < 9) {
            this.drawSprite(
                stack,
                this.textureHotbar,
                0, 22,
                24, 24,
                hbX + sel * 20 - 1, y - 1,
                24, 24
            );
        }

        // To make the items darker
        let brightness = this.minecraft.isPaused() ? 0.5 : 1; // TODO find a better solution

        this.minecraft.itemRenderer.prepareRender("hotbar");

        // Render items (slots 0–8)
        for (let i = 0; i < 9; i++) {
            let typeId = this.minecraft.player.inventory.getItemInSlot(i);
            if (typeId !== 0) {
                let block = Block.getById(typeId);
                this.minecraft.itemRenderer.renderItemInGui("hotbar", i, block, Math.floor(hbX + i * 20 + 11), y + 11, brightness);
            }
        }

        // FUS: tool icons from bundled `tools.png` (same sheet as Block World modal)
        if (typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__) {
            let tex = this.minecraft.fusToolsSpriteSheet;
            let getRect = this.minecraft.fusGetToolSpriteSrcRect;
            let meta = this.minecraft.fusHotbarSlotMeta;
            if (tex && tex.complete && tex.naturalWidth > 0 && typeof getRect === "function" && Array.isArray(meta)) {
                for (let ti = 0; ti < 9; ti++) {
                    let m = meta[ti];
                    if (!m || m.kind !== "tool") continue;
                    let name = m.toolMeshName;
                    if (typeof name !== "string") continue;
                    let r = getRect(name);
                    if (!r) continue;
                    let sw = 16;
                    let sh = 16;
                    let cx = Math.floor(hbX + ti * 20 + 10 - sw / 2);
                    let cy = Math.floor(y + 11 - sh / 2);
                    this.drawSprite(stack, tex, r.sx, r.sy, r.sw, r.sh, cx, cy, sw, sh, brightness);
                }
            }
        }

        // Non-embed: optional overflow column + “⋯”. Laby embed uses HTML inventory instead.
        if (typeof window === "undefined" || !window.__LABY_MC_FUS_EMBED__) {
            const extraGap = 2;
            const extraW = 20;
            this.drawSprite(stack, this.textureHotbar, 0, 0, extraW, 22, hbX + 200 + extraGap, y, extraW, 22);
            const dotsX = hbX + 200 + extraGap + extraW / 2;
            const dotsY = y + 7;
            this.drawCenteredString(stack, "\u2022\u2022\u2022", Math.floor(dotsX), Math.floor(dotsY), 0xffe8e8f0);
        }
    }

    renderLeftDebugOverlay(stack, filters = []) {
        let world = this.minecraft.world;
        let player = this.minecraft.player;
        let worldRenderer = this.minecraft.worldRenderer;

        let x = player.x;
        let y = player.y;
        let z = player.z;

        let yaw = MathHelper.wrapAngleTo180(player.rotationYaw);
        let pitch = player.rotationPitch;

        let facingIndex = (((yaw + 180) * 4.0 / 360.0) + 0.5) & 3;
        let facing = EnumBlockFace.values()[facingIndex + 2];

        let fixedX = x.toFixed(2);
        let fixedY = y.toFixed(2);
        let fixedZ = z.toFixed(2);

        let blockX = Math.floor(x);
        let blockY = Math.floor(y);
        let blockZ = Math.floor(z);

        let chunkX = blockX >> 4;
        let chunkY = blockY >> 4;
        let chunkZ = blockZ >> 4;

        let inChunkX = blockX & 0xF;
        let inChunkY = blockY & 0xF;
        let inChunkZ = blockZ & 0xF;

        let visibleChunks = 0;
        let loadedChunks = 0;
        for (let [index, chunk] of world.getChunkProvider().getChunks()) {
            for (let y in chunk.sections) {
                let chunkSection = chunk.sections[y];
                if (chunkSection.group.visible) {
                    visibleChunks++;
                }
                loadedChunks++;
            }
        }
        let visibleEntities = 0;
        for (let index in world.entities) {
            let entity = world.entities[index];
            if (entity.renderer.group.visible) {
                visibleEntities++;
            }
        }

        let fps = Math.floor(this.minecraft.fps);
        let viewDistance = this.minecraft.settings.viewDistance;
        let lightUpdates = world.lightUpdateQueue.length;
        let chunkUpdates = worldRenderer.chunkSectionUpdateQueue.length;
        let entities = world.entities.length;
        let particles = this.minecraft.particleRenderer.particles.length;
        let skyLight = world.getSavedLightValue(EnumSkyBlock.SKY, blockX, blockY, blockZ);
        let blockLight = world.getSavedLightValue(EnumSkyBlock.BLOCK, blockX, blockY, blockZ);
        let lightLevel = world.getTotalLightAt(blockX, blockY, blockZ);
        let biome = "T: " + world.getTemperature(blockX, blockY, blockZ) + " H: " + world.getHumidity(blockX, blockY, blockZ);

        let soundsLoaded = 0;
        let soundsPlaying = 0;
        let soundPool = this.minecraft.soundManager.soundPool;
        for (let [id, sounds] of Object.entries(soundPool)) {
            for (let sound of sounds) {
                soundsLoaded++;

                if (sound.isPlaying) {
                    soundsPlaying++;
                }
            }
        }

        let towards = "Towards " + (facing.isPositive() ? "positive" : "negative") + " " + (facing.isXAxis() ? "X" : "Z");

        let lines = [
            "js-minecraft " + Minecraft.VERSION,
            fps + " fps (" + chunkUpdates + " chunk updates) T: " + this.minecraft.maxFps,
            "C: " + visibleChunks + "/" + loadedChunks + " D: " + viewDistance + ", L: " + lightUpdates,
            "E: " + visibleEntities + "/" + entities + ", P: " + particles,
            "",
            "XYZ: " + fixedX + " / " + fixedY + " / " + fixedZ,
            "Block: " + blockX + " " + blockY + " " + blockZ,
            "Chunk: " + chunkX + " " + chunkY + " " + chunkZ + " in " + inChunkX + " " + inChunkY + " " + inChunkZ,
            "Facing: " + facing.getName() + " (" + towards + ") (" + yaw.toFixed(1) + " / " + pitch.toFixed(1) + ")",
            "Light: " + lightLevel + " (" + skyLight + " sky, " + blockLight + " block)",
            // "Biome: " + biome,
            "",
            "Sounds: " + soundsPlaying + "/" + soundsLoaded,
            "Time: " + world.time % 24000 + " (Day " + Math.floor(world.time / 24000) + ")",
            "Cursor: " + this.minecraft.window.focusState.getName()
        ]

        // Hit result
        let hit = worldRenderer.lastHitResult;
        if (hit !== null && hit.type !== 0) {
            lines.push("Looking at: " + hit.x + " " + hit.y + " " + hit.z);
        }

        // Draw lines
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].length === 0 || filters.length !== 0 && !filters.includes(i)) {
                continue;
            }

            // Clear the line
            if (filters.length !== 0) {
                stack.clearRect(
                    1,
                    1 + FontRenderer.FONT_HEIGHT * i,
                    this.getStringWidth(stack, lines[i]) + 1,
                    FontRenderer.FONT_HEIGHT
                );
            }

            // Draw background
            this.drawRect(stack,
                1,
                1 + FontRenderer.FONT_HEIGHT * i,
                1 + this.getStringWidth(stack, lines[i]) + 1,
                1 + FontRenderer.FONT_HEIGHT * i + FontRenderer.FONT_HEIGHT,
                '#50505090'
            );

            // Draw line
            this.drawString(stack, lines[i], 2, 2 + FontRenderer.FONT_HEIGHT * i, 0xffe0e0e0, false);
        }

    }

    renderRightDebugOverlay(stack) {
        let memoryLimit = this.minecraft.window.getMemoryLimit();
        let memoryUsed = this.minecraft.window.getMemoryUsed();
        let memoryAllocated = this.minecraft.window.getMemoryAllocated();

        let usedPercentage = Math.floor(memoryUsed / memoryLimit * 100);
        let allocatedPercentage = Math.floor(memoryAllocated / memoryLimit * 100);

        let width = this.window.canvas.width;
        let height = this.window.canvas.height;

        let lines = [
            "Mem: " + usedPercentage + "% " + this.humanFileSize(memoryUsed, memoryLimit),
            "Allocated: " + allocatedPercentage + "% " + this.humanFileSize(null, memoryAllocated),
            "",
            "Display: " + width + "x" + height,
            this.window.getGPUName()
        ];

        // Draw lines
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].length === 0) {
                continue;
            }

            // Draw background
            this.drawRect(stack,
                this.window.width - this.getStringWidth(stack, lines[i]) - 3,
                1 + FontRenderer.FONT_HEIGHT * i,
                this.window.width - 1,
                1 + FontRenderer.FONT_HEIGHT * i + FontRenderer.FONT_HEIGHT,
                '#50505090'
            );

            // Draw line
            this.drawRightString(stack, lines[i], this.window.width - 2, 2 + FontRenderer.FONT_HEIGHT * i, 0xffe0e0e0, false);
        }
    }

    humanFileSize(bytesUsed, bytesMax) {
        if (Math.abs(bytesMax) < 1000) {
            return (bytesUsed === null ? "" : bytesUsed + "/") + bytesMax + "B";
        }
        const units = ['kB', 'MB'];
        let u = -1;
        const r = 10;
        const thresh = 1000;

        do {
            if (bytesUsed !== null) {
                bytesUsed /= thresh;
            }
            bytesMax /= thresh;
            ++u;
        } while (Math.round(Math.abs(bytesMax) * r) / r >= thresh && u < units.length - 1);
        return (bytesUsed === null ? "" : bytesUsed.toFixed(0) + "/") + bytesMax.toFixed(0) + units[u];
    }
}