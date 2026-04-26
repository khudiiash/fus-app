import BlockRenderer from "./BlockRenderer.js";
import EntityRenderManager from "./entity/EntityRenderManager.js";
import MathHelper from "../../util/MathHelper.js";
import Block from "../world/block/Block.js";
import Tessellator from "./Tessellator.js";
import ChunkSection from "../world/ChunkSection.js";
import Random from "../../util/Random.js";
import Vector3 from "../../util/Vector3.js";
import * as THREE from "../../../../../../libraries/three.module.js";

/** Match classic js-minecraft + older three: atlas + vertex AO are authored for linear sampling (no extra sRGB decode). */
if (typeof THREE.ColorManagement !== "undefined") {
    THREE.ColorManagement.enabled = false;
}

export default class WorldRenderer {

    static THIRD_PERSON_DISTANCE = 4;

    constructor(minecraft, window) {
        this.minecraft = minecraft;
        this.window = window;
        this.chunkSectionUpdateQueue = [];
        /** FUS: O(1) membership for the queue — `Array#includes` was O(n) per section per frame. */
        this._fusChunkInUpdateQueue = new Set();

        this.tessellator = new Tessellator();

        // FUS: classic {@code terrain/terrain.png} macrotile sheet; {@link TerrainAtlasUV}
        this.textureTerrain = minecraft.getThreeTexture('terrain/terrain.png');
        this.textureTerrain.magFilter = THREE.NearestFilter;
        this.textureTerrain.minFilter = THREE.NearestFilter;

        // Load sun texture
        this.textureSun = minecraft.getThreeTexture('terrain/sun.png');
        this.textureSun.magFilter = THREE.NearestFilter;
        this.textureSun.minFilter = THREE.NearestFilter;

        // Load moon texture
        this.textureMoon = minecraft.getThreeTexture('terrain/moon.png');
        this.textureMoon.magFilter = THREE.NearestFilter;
        this.textureMoon.minFilter = THREE.NearestFilter;

        // Block Renderer
        this.blockRenderer = new BlockRenderer(this);

        // Entity render manager
        this.entityRenderManager = new EntityRenderManager(this);

        this.equippedProgress = 0;
        this.prevEquippedProgress = 0;
        this.itemToRender = 0;

        this.prevFogBrightness = 0;
        this.fogBrightness = 0;

        this.flushRebuild = false;

        this.lastHitResult = null;

        /** FUS: see {@link #renderChunks} — increment each call; sort every other frame. */
        this._fusRenderChunksCount = 0;
        /**
         * FUS: one reusable column AABB per chunk (world XZ footprint × full height) for
         * {@link #renderChunks} so we can reject all 16 sections with a single frustum test.
         */
        this._fusChunkColumnBox = new THREE.Box3();

        /**
         * Full-viewport red tint (see {@link #queueFusDamageFlash}) — wall-clock hold + fade
         * so high-refresh displays still show a visible flash (frame-stepped decay was ~3–7 ms on
         * 144 Hz). Replaces a legacy HTML radial vignette.
         */
        this._fusDmgFlash = { active: 0, peak: 0, holdEndMs: 0, fadeEndMs: 0 };
        this._fusDamageScreenMesh = null;

        /** FUS Laby: cube env map from `src/resources/sky/*.png` — no tessellated sky disc. */
        this._fusLabySkyboxMode = false;
        this._fusLabyCubeTex = null;

        this.initialize();
    }

    initialize() {
        // Create world camera
        this.camera = new THREE.PerspectiveCamera(0, 1, 0.001, 1000);
        this.camera.rotation.order = 'ZYX';
        this.camera.up = new THREE.Vector3(0, 0, 1);

        // Frustum
        this.frustum = new THREE.Frustum();

        // Background (sky) must render in its own `Scene` + pass: sharing one `Scene` with
        // `scene.background` + sky meshes + world broke fog/overlay compositing (entities, lines, flags
        // looked like sky) when `webRenderer` uses `autoClear: false` between passes.
        this.background = new THREE.Scene();
        this.background.matrixAutoUpdate = false;

        this.scene = new THREE.Scene();
        this.scene.matrixAutoUpdate = false;

        /** FUS: one GPU fog + one clear color, updated in place — per-frame `new Fog`/`new Color` tanked mobile GC. */
        this._fusFrustumViewProj = new THREE.Matrix4();
        this._fusBackgroundColor = new THREE.Color(0, 0, 0);
        /** Sky pass: must not be the same `Color` ref as {@link #_fusBackgroundColor} — `setupFog` mutates that for world fog, which was painting a false solid “sky” if the cubemap 404s. */
        this._fusSkyPassClear = new THREE.Color(0, 0, 0);
        this._fusSceneFog = new THREE.Fog(0x000000, 0.0025, 512);
        this.scene.fog = this._fusSceneFog;
        this.background.background = this._fusSkyPassClear;
        this.background.fog = this._fusSceneFog;
        this._fusCameraDirScratch = new THREE.Vector3();

        // Create overlay for first person model rendering
        this.overlay = new THREE.Scene();
        this.overlay.matrixAutoUpdate = false;

        const labyEmbed = typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__;
        this.webRenderer = new THREE.WebGLRenderer({
            canvas: this.window.canvasWorld,
            antialias: false,
            powerPreference: "high-performance",
        });

        // Settings
        this.webRenderer.setSize(this.window.width, this.window.height);
        this.webRenderer.autoClear = false;
        /** FUS: was `false` (classic fork). With {@link Tessellator}'s {@code transparent: true} on
         *  all chunk geometry, leaving sorting off made transparent draw order follow scene-graph
         *  insertion only — break-decal meshes could never rely on {@link Object3D#renderOrder}. */
        this.webRenderer.sortObjects = true;
        this.webRenderer.setClearColor(0x000000, 0);
        this.webRenderer.clear();

        // r152+ defaults + tone mapping wash out Minecraft-style atlas / vertex colors; keep output sRGB, no filmic curve.
        this.webRenderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        this.webRenderer.toneMapping = THREE.NeutralToneMapping;

        // Create sky
        this.generateSky();

        // Create block hit box
        let geometry = new THREE.BoxGeometry(1, 1, 1);
        let edges = new THREE.EdgesGeometry(geometry);
        this.blockHitBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
            color: 0x000000
        }));
        this.scene.add(this.blockHitBox);

        /** FUS: camera-space full-screen plane — drawn after the world, brief solid red (no radial). */
        {
            const g = new THREE.PlaneGeometry(1, 1);
            const m = new THREE.MeshBasicMaterial({
                color: 0xd41616,
                transparent: true,
                opacity: 0,
                depthTest: false,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(g, m);
            mesh.name = "fusDamageFlash";
            mesh.renderOrder = 100000;
            mesh.frustumCulled = false;
            this._fusDamageScreenMesh = mesh;
            this.overlay.add(mesh);
        }

        // FUS: proves this file is the patched fork (see `window.__FUS_LABY_ENGINE_PATCH` in DevTools).
        if (typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__) {
            window.__FUS_LABY_ENGINE_PATCH = "2026-04-24-skybox-staticday";
        }
    }

    /**
     * FUS Laby: chunk radius (2..10) matching the capped in-game render slider. Used by
     * {@link FusMobSync} so mob LOD radii track the same distance the player actually sees.
     */
    getEffectiveViewDistanceChunks() {
        const vd = Number(this.minecraft?.settings?.viewDistance);
        const c = Number.isFinite(vd) && vd > 0 ? Math.round(vd) : 5;
        return Math.max(2, Math.min(10, c));
    }

    /**
     * FUS: `Chunk.unload()` only flips a flag; without removing the chunk from the provider map,
     * `getChunks()` grows forever as the player explores and the first pass of {@link #renderChunks}
     * devolves into O(loaded) work every frame (minutes-long sessions → single-digit FPS).
     * Also eject any pending section rebuild queue entries for this chunk.
     * @param {import("../world/Chunk.js").default} chunk
     * @param {import("../world/World.js").default} world
     * @param {import("../world/provider/ChunkProvider.js").default} provider
     */
    _fusUnsubscribeChunkFromScene(chunk, world, provider) {
        if (!chunk) return;
        for (const sec of chunk.sections) {
            if (sec) {
                this._fusChunkInUpdateQueue.delete(sec);
            }
        }
        try {
            world.group.remove(chunk.group);
        } catch {
            /* already detached */
        }
        provider.unloadChunk(chunk.x, chunk.z);
    }

    /**
     * Laby: re-run {@link GameWindow#updateWindowSize} after `fusIosSafari` / `fusLowTierMobile`
     * are set on `minecraft`, so WebGL `pixelRatio` (see GameWindow) matches the real device
     * tier. Safe to call multiple times.
     */
    applyFusMobileGraphicsProfile() {
        if (this.window && typeof this.window.updateWindowSize === "function") {
            this.window.updateWindowSize();
        }
    }

    /** Min time at full opacity so the flash is noticeable (ms). */
    static FUS_DAMAGE_FLASH_HOLD_MS = 100;
    /** Fade-out after hold (ms). */
    static FUS_DAMAGE_FLASH_FADE_MS = 40;

    /**
     * Brief full-viewport red tint in WebGL (camera-space quad, {@link #_fusSyncDamageFlashOpacity}
     * drives opacity from wall-clock time).
     * @param {number} [strength] 0..1 — higher for bigger HP drops; clamped to a visible range.
     */
    queueFusDamageFlash(strength = 0.5) {
        const now =
            typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now();
        const s = this._fusDmgFlash;
        const peak = Math.min(0.55, Math.max(0.12, Number(strength) || 0.35));
        s.peak = Math.max(s.peak, peak);
        s.holdEndMs = now + WorldRenderer.FUS_DAMAGE_FLASH_HOLD_MS;
        s.fadeEndMs = now + WorldRenderer.FUS_DAMAGE_FLASH_HOLD_MS + WorldRenderer.FUS_DAMAGE_FLASH_FADE_MS;
        s.active = 1;
    }

    /** Instantly hide the red tint (e.g. on death screen). */
    clearFusDamageFlash() {
        const s = this._fusDmgFlash;
        s.active = 0;
        s.peak = 0;
        s.holdEndMs = 0;
        s.fadeEndMs = 0;
        if (this._fusDamageScreenMesh && this._fusDamageScreenMesh.material) {
            this._fusDamageScreenMesh.material.opacity = 0;
        }
    }

    /**
     * Full-viewport quad in front of the camera — {@link THREE.Object3D#lookAt} keeps the
     * red face toward the eye regardless of Z-up vs Y-up quirks.
     */
    _fusUpdateDamageFlashScreenQuad() {
        const mesh = this._fusDamageScreenMesh;
        if (!mesh) return;
        const cam = this.camera;
        const dist = 0.12;
        const dir = this._fusCameraDirScratch;
        cam.getWorldDirection(dir);
        mesh.position.copy(cam.position).addScaledVector(dir, dist);
        mesh.lookAt(cam.position);
        const vFov = (cam.fov * Math.PI) / 180;
        const h = 2 * Math.tan(vFov / 2) * dist;
        const w = h * (this.window.width / Math.max(1, this.window.height));
        mesh.scale.set(w, h, 1);
    }

    _fusSyncDamageFlashOpacity() {
        const s = this._fusDmgFlash;
        const mesh = this._fusDamageScreenMesh;
        if (!mesh || !mesh.material) return;
        if (!s.active) {
            mesh.material.opacity = 0;
            return;
        }
        const now =
            typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now();
        if (now >= s.fadeEndMs) {
            s.active = 0;
            s.peak = 0;
            s.holdEndMs = 0;
            s.fadeEndMs = 0;
            mesh.material.opacity = 0;
            return;
        }
        if (now < s.holdEndMs) {
            mesh.material.opacity = s.peak;
        } else {
            const fd = s.fadeEndMs - s.holdEndMs;
            const t = fd > 0 ? (s.fadeEndMs - now) / fd : 0;
            mesh.material.opacity = s.peak * Math.max(0, Math.min(1, t));
        }
    }

    render(partialTicks) {
        if (typeof this.minecraft.fusCombatFxTick === "function") {
            try {
                this.minecraft.fusCombatFxTick();
            } catch {
                /* ignore */
            }
        }
        if (typeof this.minecraft.fusWorldDropsTick === "function") {
            try {
                this.minecraft.fusWorldDropsTick();
            } catch {
                /* ignore */
            }
        }
        if (typeof this.minecraft.fusSimpleMobsFrameTick === "function") {
            try {
                this.minecraft.fusSimpleMobsFrameTick();
            } catch {
                /* ignore */
            }
        }
        // Setup camera
        this.orientCamera(partialTicks);

        this._fusUpdateDamageFlashScreenQuad();
        this._fusSyncDamageFlashOpacity();

        // Render chunks
        let player = this.minecraft.player;
        let cameraChunkX = Math.floor(player.x) >> 4;
        let cameraChunkZ = Math.floor(player.z) >> 4;
        this.renderChunks(cameraChunkX, cameraChunkZ);

        // Render sky
        this.renderSky(partialTicks);

        // Render target block
        this.renderBlockHitBox(player, partialTicks);

        // Render particles
        this.minecraft.particleRenderer.renderParticles(player, partialTicks);

        // Hide all entities and make them visible during rendering
        for (let entity of this.minecraft.world.entities) {
            entity.renderer.group.visible = false;
        }

        // Render entities
        for (let entity of this.minecraft.world.entities) {
            if (entity === player && this.minecraft.settings.thirdPersonView === 0) {
                continue;
            }

            // Render entity
            entity.renderer.render(entity, partialTicks);
            const inv =
                entity === player &&
                Number.isFinite(this.minecraft.fusSpawnInvulnUntilMs) &&
                Date.now() < this.minecraft.fusSpawnInvulnUntilMs
            if (inv) {
                entity.renderer.group.visible = (Math.floor(Date.now() / 150) & 1) === 0
            } else {
                entity.renderer.group.visible = true
            }
        }

        // Render hand
        this.renderHand(partialTicks);

        // Pass 1: sky / horizon (own scene). Pass 2: world + entities (fog here only — matches classic fork).
        // `Scene.background` as a `CubeTexture` is drawn with depthTest/depthWrite false, and WebGLBackground
        // does *not* set `forceClear` (only `Color` backgrounds do). With `webRenderer.autoClear = false` the
        // depth buffer was never reset, so the world pass depth-tested against the *previous* frame and most
        // geometry disappeared (skybox-only + edge artifacts). Clear once per frame before the sky pass.
        if (this._fusLabySkyboxMode) {
            this.webRenderer.clear(true, true, true);
        }
        this.webRenderer.render(this.background, this.camera);
        this.webRenderer.render(this.scene, this.camera);

        // Render overlay with a static FOV
        this.camera.fov = 70;
        this.camera.updateProjectionMatrix();
        this.webRenderer.render(this.overlay, this.camera);
    }

    /**
     * Pops one chunk section from the update queue and rebuilds it. When
     * {@code minecraft.fusChunkSplitSectionRebuild} is not false (default: on), a section
     * is meshed in two steps — solid, then translucent — on separate queue operations so
     * each main-thread slice does roughly half the work (better frame times while moving).
     * Set {@code fusChunkSplitSectionRebuild = false} to restore a single monolithic
     * mesh build per section.
     */
    _fusDequeueAndRebuildOneChunkSection() {
        if (this.chunkSectionUpdateQueue.length === 0) {
            return;
        }
        let chunkSection = this.chunkSectionUpdateQueue.shift();
        if (chunkSection == null) {
            return;
        }
        const split = this.minecraft.fusChunkSplitSectionRebuild !== false;
        if (!split) {
            try {
                this._fusChunkInUpdateQueue.delete(chunkSection);
            } catch {
                /* ignore */
            }
            chunkSection.rebuild(this);
        } else if (chunkSection._fusRebuildSplit !== 1) {
            try {
                this._fusChunkInUpdateQueue.delete(chunkSection);
            } catch {
                /* ignore */
            }
            chunkSection._fusRebuildSolidOnly(this);
            chunkSection._fusRebuildSplit = 1;
            this.chunkSectionUpdateQueue.unshift(chunkSection);
            this._fusChunkInUpdateQueue.add(chunkSection);
        } else {
            try {
                this._fusChunkInUpdateQueue.delete(chunkSection);
            } catch {
                /* ignore */
            }
            chunkSection._fusRebuildTranslucentOnly(this);
            chunkSection._fusRebuildSplit = 0;
        }
    }

    onTick() {
        /**
         * Chunk mesh rebuilds per tick. Each step walks placed blocks in a 16×16×16
         * section (sparse iteration when the section is not full) to build geometry, which
         * is the dominant per-tick cost when new terrain streams in. `fusLowTierMobile`
         * uses a budget of 1; otherwise 2, unless Laby sets `fusChunkRebuildsPerTick`.
         * {@code flushRebuild} uses `fusChunkFlushRebuildCap` for the block edit catch-up
         * path.
         */
        let rebuildsPerTick = this.minecraft.fusLowTierMobile ? 1 : 2;
        if (typeof this.minecraft.fusChunkRebuildsPerTick === "number" && Number.isFinite(this.minecraft.fusChunkRebuildsPerTick)) {
            /** Laby: optional override to cap per-tick mesh work when streaming terrain (1–2). */
            rebuildsPerTick = Math.max(1, Math.min(2, Math.floor(this.minecraft.fusChunkRebuildsPerTick)));
        }
        for (let i = 0; i < rebuildsPerTick; i++) {
            this._fusDequeueAndRebuildOneChunkSection();
        }

        this.prevFogBrightness = this.fogBrightness;
        this.prevEquippedProgress = this.equippedProgress;

        let player = this.minecraft.player;
        let itemStack = player.inventory.getItemInSelectedSlot();

        let showHand = false;
        if (this.itemToRender != null && itemStack != null) {
            if (this.itemToRender !== itemStack) {
                showHand = true;
            }
        } else if (this.itemToRender == null && itemStack == null) {
            showHand = false;
        } else {
            showHand = true;
        }

        // Update equip progress
        this.equippedProgress += MathHelper.clamp((showHand ? 0.0 : 1.0) - this.equippedProgress, -0.4, 0.4);

        if (this.equippedProgress < 0.1) {
            this.itemToRender = itemStack;
        }

        // Update fog brightness
        let brightnessAtPosition = this.minecraft.world.getLightBrightnessForEntity(player);
        let renderDistance = this.minecraft.settings.viewDistance / 32.0;
        let fogBrightness = brightnessAtPosition * (1.0 - renderDistance) + renderDistance;
        this.fogBrightness += (fogBrightness - this.fogBrightness) * 0.1;
    }

    orientCamera(partialTicks) {
        let player = this.minecraft.player;

        // Reset rotation stack
        let stack = this.camera;

        // Position
        let x = player.prevX + (player.x - player.prevX) * partialTicks;
        let y = player.prevY + (player.y - player.prevY) * partialTicks + player.getEyeHeight();
        let z = player.prevZ + (player.z - player.prevZ) * partialTicks;

        // Rotation
        let yaw = player.prevRotationYaw + (player.rotationYaw - player.prevRotationYaw) * partialTicks;
        let pitch = player.prevRotationPitch + (player.rotationPitch - player.prevRotationPitch) * partialTicks;

        // Add camera offset
        let mode = this.minecraft.settings.thirdPersonView;
        if (mode !== 0) {
            let distance = WorldRenderer.THIRD_PERSON_DISTANCE;
            let frontView = mode === 2;

            // Calculate vector of yaw and pitch
            let vector = player.getVectorForRotation(pitch, yaw);

            // Calculate max possible position of the third person camera
            let maxX = x - vector.x * distance * (frontView ? -1 : 1);
            let maxY = y - vector.y * distance * (frontView ? -1 : 1);
            let maxZ = z - vector.z * distance * (frontView ? -1 : 1);

            // Make 8 different ray traces to make sure we don't get stuck in walls
            for (let i = 0; i < 8; i++) {
                // Calculate all possible offset variations (Basically a binary counter)
                let offsetX = ((i & 1) * 2 - 1) * 0.1;
                let offsetY = ((i >> 1 & 1) * 2 - 1) * 0.1;
                let offsetZ = ((i >> 2 & 1) * 2 - 1) * 0.1;

                // Calculate ray trace from and to position
                let from = new Vector3(x, y, z);
                let to = new Vector3(maxX, maxY, maxZ);

                // Add offset of this variation
                from = from.addVector(offsetX, offsetY, offsetZ);
                to = to.addVector(offsetX, offsetY, offsetZ);

                // Make ray trace
                let target = this.minecraft.world.rayTraceBlocks(from, to);
                if (target === null) {
                    continue;
                }

                // Calculate distance to collision
                let distanceToCollision = target.vector.distanceTo(new Vector3(x, y, z));
                if (distanceToCollision < distance) {
                    distance = distanceToCollision;
                }
            }

            // Move camera to third person sphere
            x -= vector.x * distance * (frontView ? -1 : 1);
            y -= vector.y * distance * (frontView ? -1 : 1);
            z -= vector.z * distance * (frontView ? -1 : 1);

            // Flip camera around if front view is enabled
            if (frontView) {
                pitch *= -1;
                yaw += 180;
            }
        }

        // Update camera rotation
        stack.rotation.x = -MathHelper.toRadians(pitch);
        stack.rotation.y = -MathHelper.toRadians(yaw + 180);
        stack.rotation.z = 0;

        // Update camera position
        stack.position.set(x, y, z);

        // Apply bobbing animation
        if (mode === 0 && this.minecraft.settings.viewBobbing) {
            this.bobbingAnimation(player, stack, partialTicks);
        }

        // Update FOV
        this.camera.fov = this.minecraft.settings.fov + player.getFOVModifier();
        this.camera.updateProjectionMatrix();

        // Update frustum
        this._fusFrustumViewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this._fusFrustumViewProj);

        // Setup fog
        this.setupFog(x, z, player.isHeadInWater(), partialTicks);
    }

    generateSky() {
        // Create background center group
        this.backgroundCenter = new THREE.Object3D();
        this.background.add(this.backgroundCenter);

        const labyEmbed = typeof window !== "undefined" && window.__LABY_MC_FUS_EMBED__;
        if (labyEmbed) {
            this._fusLabySkyboxMode = true;
            this.listSky = null;
            this.listSunset = null;
            this.listStars = null;
            this.listVoid = null;
            this.cycleGroup = new THREE.Object3D();
            this.sun = null;
            this.moon = null;
            const base =
                typeof window !== "undefined" && window.__LABY_MC_ASSET_BASE__
                    ? String(window.__LABY_MC_ASSET_BASE__).replace(/\/?$/, "/")
                    : "/";
            const loader = new THREE.CubeTextureLoader();
            loader.setPath(base + "src/resources/sky/");
            const self = this;
            loader.load(
                ["px.png", "nx.png", "py.png", "ny.png", "pz.png", "nz.png"],
                (tex) => {
                    if (typeof THREE.SRGBColorSpace !== "undefined") {
                        tex.colorSpace = THREE.LinearSRGBColorSpace;
                    }
                    self.background.background = tex;
                    self._fusLabyCubeTex = tex;
                },
                undefined,
                (err) => {
                    if (typeof console !== "undefined" && console.warn) {
                        const p = base + "src/resources/sky/*.png";
                        console.warn("[FUS Laby] skybox load failed; check " + p, err);
                    }
                }
            );
            this.backgroundCenter.add(this.cycleGroup);
            return;
        }

        this._fusLabySkyboxMode = false;

        let size = 64;
        let scale = 256 / size + 2;

        // Generate sky color
        {
            let y = 16;
            this.listSky = new THREE.Object3D();
            this.tessellator.startDrawing();
            this.tessellator.setColor(1, 1, 1);
            for (let x = -size * scale; x <= size * scale; x += size) {
                for (let z = -size * scale; z <= size * scale; z += size) {
                    this.tessellator.addVertex(x + size, y, z);
                    this.tessellator.addVertex(x, y, z);
                    this.tessellator.addVertex(x, y, z + size);
                    this.tessellator.addVertex(x + size, y, z + size);
                }
            }
            let mesh = this.tessellator.draw(this.listSky);
            mesh.material.depthTest = false;
            this.backgroundCenter.add(this.listSky);
        }

        // Generate sunrise/sunset color
        {
            this.listSunset = new THREE.Object3D();
            this.tessellator.startDrawing();

            let amount = 16;
            let width = (Math.PI * 2.0) / amount;

            for (let index = 0; index < amount; index++) {
                let rotation = (index * Math.PI * 2.0) / amount;

                let x1 = Math.sin(rotation);
                let y1 = Math.cos(rotation);

                let x2 = Math.sin(rotation + width);
                let y2 = Math.cos(rotation + width);

                this.tessellator.setColor(1, 1, 1, 1);
                this.tessellator.addVertex(0.0, 100, 0.0);
                this.tessellator.addVertex(0.0, 100, 0.0);

                this.tessellator.setColor(1, 1, 1, 0);
                this.tessellator.addVertex(x1 * 120, y1 * 120, -y1 * 40);
                this.tessellator.addVertex(x2 * 120, y2 * 120, -y2 * 40);
            }

            let mesh = this.tessellator.draw(this.listSunset);
            mesh.material = mesh.material.clone();
            mesh.material.depthTest = false;
            mesh.material.opacity = 0.6;
            mesh.material.side = THREE.DoubleSide;
            this.backgroundCenter.add(this.listSunset);
        }

        // Create cycle group
        this.cycleGroup = new THREE.Object3D();

        // Generate stars
        {
            this.listStars = new THREE.Object3D();
            this.tessellator.startDrawing();
            this.tessellator.setColor(1, 1, 1);

            // Generate 1500 stars
            let random = new Random(10842);
            for (let i = 0; i < 1500; i++) {
                // Random vector
                let vectorX = random.nextFloat() * 2.0 - 1.0;
                let vectorY = random.nextFloat() * 2.0 - 1.0;
                let vectorZ = random.nextFloat() * 2.0 - 1.0;

                // Skip invalid vectors
                let distance = vectorX * vectorX + vectorY * vectorY + vectorZ * vectorZ;
                if (distance >= 1.0 || distance <= 0.01) {
                    continue;
                }

                // Create sphere
                distance = 1.0 / Math.sqrt(distance);
                vectorX *= distance;
                vectorY *= distance;
                vectorZ *= distance;

                // Increase sphere size
                let x = vectorX * 100;
                let y = vectorY * 100;
                let z = vectorZ * 100;

                // Rotate the stars on the sphere
                let rotationX = Math.atan2(vectorX, vectorZ);
                let sinX = Math.sin(rotationX);
                let cosX = Math.cos(rotationX);

                // Face the stars to the middle of the sphere
                let rotationY = Math.atan2(Math.sqrt(vectorX * vectorX + vectorZ * vectorZ), vectorY);
                let sinY = Math.sin(rotationY);
                let cosY = Math.cos(rotationY);

                // Tilt the stars randomly
                let rotationZ = random.nextFloat() * Math.PI * 2;
                let sinZ = Math.sin(rotationZ);
                let cosZ = Math.cos(rotationZ);

                // Random size of the star
                let size = 0.25 + random.nextFloat() * 0.25;

                // Add vertices for each edge of the star
                for (let edge = 0; edge < 4; edge++) {
                    // Calculate the position of the edge on a 2D plane
                    let tileX = ((edge & 2) - 1) * size;
                    let tileZ = ((edge + 1 & 2) - 1) * size;

                    // Project tile position onto the sphere
                    let sphereX = tileX * cosZ - tileZ * sinZ;
                    let sphereY = tileZ * cosZ + tileX * sinZ;
                    let sphereZ = -sphereX * cosY;

                    // Calculate offset of the edge on the sphere
                    let offsetX = sphereZ * sinX - sphereY * cosX;
                    let offsetY = sphereX * sinY;
                    let offsetZ = sphereY * sinX + sphereZ * cosX;

                    // Add vertex for the edge of the star
                    this.tessellator.addVertex(x + offsetX, y + offsetY, z + offsetZ);
                }
            }

            let mesh = this.tessellator.draw(this.listStars);
            mesh.material = mesh.material.clone();
            mesh.material.depthTest = true;
            mesh.material.side = THREE.BackSide;
            this.cycleGroup.add(this.listStars);
        }

        // Create sun
        let geometry = new THREE.PlaneGeometry(1, 1);
        let materialSun = new THREE.MeshBasicMaterial({
            side: THREE.FrontSide,
            map: this.textureSun,
            alphaMap: this.textureSun,
            blending: THREE.AdditiveBlending,
            transparent: true
        });
        this.sun = new THREE.Mesh(geometry, materialSun);
        this.sun.translateZ(-2);
        this.sun.material.depthTest = false;
        this.cycleGroup.add(this.sun);

        // Create moon
        let materialMoon = new THREE.MeshBasicMaterial({
            side: THREE.BackSide,
            map: this.textureMoon,
            alphaMap: this.textureMoon,
            blending: THREE.AdditiveBlending,
            transparent: true
        });
        this.moon = new THREE.Mesh(geometry, materialMoon);
        this.moon.translateZ(2);
        this.moon.material.depthTest = false;
        this.cycleGroup.add(this.moon);

        // Add cycle group before the void to hide the cycling elements behind the void
        this.backgroundCenter.add(this.cycleGroup);

        // Generate void color
        {
            let y = -16;
            this.listVoid = new THREE.Object3D();
            this.tessellator.startDrawing();
            this.tessellator.setColor(1, 1, 1);
            for (let x = -size * scale; x <= size * scale; x += size) {
                for (let z = -size * scale; z <= size * scale; z += size) {
                    this.tessellator.addVertex(x, y, z);
                    this.tessellator.addVertex(x + size, y, z);
                    this.tessellator.addVertex(x + size, y, z + size);
                    this.tessellator.addVertex(x, y, z + size);
                }
            }
            let mesh = this.tessellator.draw(this.listVoid);
            mesh.material = mesh.material.clone();
            mesh.material.depthTest = false;
            mesh.material.opacity = 1;
            this.backgroundCenter.add(this.listVoid);
        }
    }

    renderSky(partialTicks) {
        // Center sky
        this.backgroundCenter.position.copy(this.camera.position);

        if (this._fusLabySkyboxMode) {
            return;
        }

        // Rotate sky cycle
        let angle = this.minecraft.world.getCelestialAngle(partialTicks);
        this.cycleGroup.rotation.set(angle * Math.PI * 2 + Math.PI / 2, 0, 0);
    }

    setupFog(x, z, inWater, partialTicks) {
        const bg = this._fusBackgroundColor;
        const fog = this._fusSceneFog;
        if (inWater) {
            bg.setRGB(0.2, 0.2, 0.4);
            fog.color.copy(bg);
            fog.near = 0.0025;
            fog.far = 5;
        } else {
            let world = this.minecraft.world;

            let viewDistance = this.minecraft.settings.viewDistance * ChunkSection.SIZE;

            if (this._fusLabySkyboxMode) {
                bg.setRGB(0.53, 0.72, 0.92);
                fog.color.copy(bg);
                fog.near = 0.0025;
                fog.far = viewDistance * 2;
                return;
            }

            let viewFactor = 1.0 - Math.pow(0.25 + 0.75 * this.minecraft.settings.viewDistance / 32.0, 0.25);

            let angle = world.getCelestialAngle(partialTicks);

            let skyColor = world.getSkyColor(x, z, partialTicks);
            let fogColor = world.getFogColor(partialTicks);
            let sunsetColor = world.getSunriseSunsetColor(partialTicks);

            let starBrightness = world.getStarBrightness(partialTicks);
            let brightness = this.prevFogBrightness + (this.fogBrightness - this.prevFogBrightness) * partialTicks;

            let red = (fogColor.x + (skyColor.x - fogColor.x) * viewFactor) * brightness;
            let green = (fogColor.y + (skyColor.y - fogColor.y) * viewFactor) * brightness;
            let blue = (fogColor.z + (skyColor.z - fogColor.z) * viewFactor) * brightness;

            bg.setRGB(red, green, blue);
            fog.color.copy(bg);
            fog.near = 0.0025;
            fog.far = viewDistance * 2;

            let skyMesh = this.listSky.children[0];
            let voidMesh = this.listVoid.children[0];
            let starsMesh = this.listStars.children[0];
            let sunsetMesh = this.listSunset.children[0];

            // Update sky and void color (in-place, no per-frame `new Color`)
            skyMesh.material.color.set(skyColor.x, skyColor.y, skyColor.z);
            voidMesh.material.color.set(
                skyColor.x * 0.2 + 0.04,
                skyColor.y * 0.2 + 0.04,
                skyColor.z * 0.6 + 0.1
            );

            // Update star brightness
            if (starBrightness > 0) {
                starsMesh.material.opacity = starBrightness;
                starsMesh.material.color.set(starBrightness, starBrightness, starBrightness);
            }
            this.listStars.visible = starBrightness > 0;

            // Update sunset
            if (sunsetColor !== null) {
                sunsetMesh.material.opacity = sunsetColor.w;
                sunsetMesh.material.color.set(sunsetColor.x, sunsetColor.y, sunsetColor.z);
                sunsetMesh.rotation.x = MathHelper.toRadians(angle <= 0.5 ? 90 : 135);
            }
            sunsetMesh.visible = sunsetColor !== null;
        }
    }

    renderChunks(cameraChunkX, cameraChunkZ) {
        let world = this.minecraft.world;
        let renderDistance = this.minecraft.settings.viewDistance;
        const provider = world.getChunkProvider();
        const colBox = this._fusChunkColumnBox;
        const lowMob = this.minecraft.fusLowTierMobile || this.minecraft.fusIosSafari;

        /**
         * FUS: was `for (chunk of all loaded)` + distance check — on large shared worlds that
         * accrue hundreds of out-of-radius chunks, every frame paid O(loaded × 16) frustum tests
         * for chunks that are never on screen. Pass 1 only does O(loaded) int math; pass 2 walks
         * the (2·rd−1)² *near* cells (≤81 when rd=5) and may skip 16 section tests with one column
         * frustum reject.
         */
        const toPurge = [];
        for (const [, cFar] of provider.getChunks()) {
            const distanceX = Math.abs(cameraChunkX - cFar.x);
            const distanceZ = Math.abs(cameraChunkZ - cFar.z);
            if (distanceX < renderDistance && distanceZ < renderDistance) {
                continue;
            }
            cFar.group.visible = false;
            if (cFar.loaded) {
                cFar.unload();
                toPurge.push(cFar);
            }
        }
        if (toPurge.length) {
            const s = new Set(toPurge);
            this.chunkSectionUpdateQueue = this.chunkSectionUpdateQueue.filter((q) => !q || !s.has(q.chunk));
            for (const cFar of toPurge) {
                this._fusUnsubscribeChunkFromScene(cFar, world, provider);
            }
        }

        const maxD = renderDistance - 1;
        for (let ddx = -maxD; ddx <= maxD; ddx++) {
            for (let ddz = -maxD; ddz <= maxD; ddz++) {
                if (Math.abs(ddx) >= renderDistance || Math.abs(ddz) >= renderDistance) {
                    continue;
                }
                const nx = cameraChunkX + ddx;
                const nz = cameraChunkZ + ddz;
                /**
                 * Must call {@link ChunkProvider#getChunkAt} even when the column is not in the
                 * map yet — that is what runs {@link ChunkProvider#loadChunk} and terrain
                 * generation. Skipping when {@link ChunkProvider#chunkExists} is false was a
                 * mistaken micro-optimisation: it disabled streaming, so only chunks created
                 * during the boot loader (or by rare block queries) ever existed — a vertical
                 * void “wall” at the edge of that set (see FUS Laby, 2026-04).
                 */
                const chunk = provider.getChunkAt(nx, nz);
                chunk.group.visible = true;
                chunk.loaded = true;

                colBox.min.set(nx * 16, 0, nz * 16);
                colBox.max.set(nx * 16 + 16, 256, nz * 16 + 16);
                if (!this.frustum.intersectsBox(colBox)) {
                    for (const y in chunk.sections) {
                        chunk.sections[y].group.visible = false;
                    }
                    continue;
                }

                for (let y in chunk.sections) {
                    let chunkSection = chunk.sections[y];
                    if (this.frustum.intersectsBox(chunkSection.boundingBox) && !chunkSection.isEmpty()) {
                        chunkSection.group.visible = true;
                        chunkSection.render();
                        if (chunkSection.isModified && !this._fusChunkInUpdateQueue.has(chunkSection)) {
                            this._fusChunkInUpdateQueue.add(chunkSection);
                            this.chunkSectionUpdateQueue.push(chunkSection);
                        }
                    } else {
                        chunkSection.group.visible = false;
                    }
                }
            }
        }

        // Sort update queue, chunk sections that are closer to the camera get a higher priority
        /** FUS: `render` runs every frame; on chunk streaming, sorting the queue + `world.group`
         *  children is pure CPU. Touch: sort less often; use diff² (no `Math.pow`). */
        this._fusRenderChunksCount++;
        const vd = this.getEffectiveViewDistanceChunks();
        const sortEvery =
            typeof this.minecraft.fusChunkRenderSortEvery === "number" && Number.isFinite(this.minecraft.fusChunkRenderSortEvery)
                ? Math.max(1, Math.min(20, Math.floor(this.minecraft.fusChunkRenderSortEvery)))
                : lowMob
                    ? vd >= 4
                        ? 8
                        : 5
                    : 2;
        if (this._fusRenderChunksCount % sortEvery === 1) {
            const cx = cameraChunkX;
            const cz = cameraChunkZ;
            this.chunkSectionUpdateQueue.sort((s1, s2) => {
                const d1x = s1.x - cx;
                const d1z = s1.z - cz;
                const d2x = s2.x - cx;
                const d2z = s2.z - cz;
                return d1x * d1x + d1z * d1z - (d2x * d2x + d2z * d2z);
            });
            world.group.children.sort((a, b) => {
                const d1x = a.chunkX - cx;
                const d1z = a.chunkZ - cz;
                const d2x = b.chunkX - cx;
                const d2z = b.chunkZ - cz;
                return d2x * d2x + d2z * d2z - (d1x * d1x + d1z * d1z);
            });
        }

        // Flush by rebuilding several chunk sections (block break / place catch-up).
        if (this.flushRebuild) {
            this.flushRebuild = false;

            const flushCap = typeof this.minecraft.fusChunkFlushRebuildCap === "number" && Number.isFinite(this.minecraft.fusChunkFlushRebuildCap)
                ? Math.max(1, Math.min(12, Math.floor(this.minecraft.fusChunkFlushRebuildCap)))
                : 8;
            for (let i = 0; i < flushCap; i++) {
                this._fusDequeueAndRebuildOneChunkSection();
            }
        }
    }

    rebuildAll() {
        let world = this.minecraft.world;
        for (let [index, chunk] of world.getChunkProvider().getChunks()) {
            chunk.setModifiedAllSections();
        }
    }

    renderHand(partialTicks) {
        // Hide hand before rendering
        let player = this.minecraft.player;
        let stack = player.renderer.firstPersonGroup;
        stack.visible = false;

        let firstPerson = this.minecraft.settings.thirdPersonView === 0;
        let itemId = firstPerson ? this.itemToRender : player.inventory.getItemInSelectedSlot();
        let hasItem = itemId !== 0;

        // Hide in third person
        if (!firstPerson) {
            return;
        }

        // Apply matrix mode (Put object in front of camera)
        stack.position.copy(this.camera.position);
        stack.rotation.copy(this.camera.rotation);
        stack.rotation.order = 'ZYX';

        // Scale down
        stack.scale.set(0.0625, 0.0625, 0.0625);

        let equipProgress = this.prevEquippedProgress + (this.equippedProgress - this.prevEquippedProgress) * partialTicks;
        let swingProgress = player.getSwingProgress(partialTicks);

        let pitchArm = player.prevRenderArmPitch + (player.renderArmPitch - player.prevRenderArmPitch) * partialTicks;
        let yawArm = player.prevRenderArmYaw + (player.renderArmYaw - player.prevRenderArmYaw) * partialTicks;

        // Bobbing animation
        if (this.minecraft.settings.viewBobbing) {
            this.bobbingAnimation(player, stack, partialTicks);
        }

        let factor = 0.8;
        let zOffset = Math.sin(swingProgress * Math.PI);
        let yOffset = Math.sin(Math.sqrt(swingProgress) * Math.PI * 2.0);
        let xOffset = Math.sin(Math.sqrt(swingProgress) * Math.PI);

        let sqrtRotation = Math.sin(Math.sqrt(swingProgress) * Math.PI);
        let powRotation = Math.sin(swingProgress * swingProgress * Math.PI);

        // Camera rotation movement
        stack.rotateX(MathHelper.toRadians((player.rotationPitch - pitchArm) * 0.1));
        stack.rotateY(MathHelper.toRadians((player.rotationYaw - yawArm) * 0.1));

        if (hasItem) {
            // Initial offset on screen
            this.translate(stack, -xOffset * 0.4, yOffset * 0.2, -zOffset * 0.2);
            this.translate(stack, 0.7 * factor, -0.65 * factor - (1.0 - equipProgress) * 0.6, -0.9 * factor);

            // Rotation of hand
            stack.rotateY(MathHelper.toRadians(45));
            stack.rotateY(MathHelper.toRadians(-powRotation * 20));
            stack.rotateZ(MathHelper.toRadians(-sqrtRotation * 20));
            stack.rotateX(MathHelper.toRadians(-sqrtRotation * 80));

            // Scale down
            stack.scale.x *= 0.4;
            stack.scale.y *= 0.4;
            stack.scale.z *= 0.4;

            // Render item
            player.renderer.updateFirstPerson(player);
        } else {
            // Initial offset on screen
            this.translate(stack, -xOffset * 0.3, yOffset * 0.4, -zOffset * 0.4);
            this.translate(stack, 0.8 * factor, -0.75 * factor - (1.0 - equipProgress) * 0.6, -0.9 * factor);

            // Rotation of hand
            stack.rotateY(MathHelper.toRadians(45));
            stack.rotateY(MathHelper.toRadians(sqrtRotation * 70));
            stack.rotateZ(MathHelper.toRadians(-powRotation * 20));

            // Post transform
            this.translate(stack, -1, 3.6, 3.5);
            stack.rotateZ(MathHelper.toRadians(120));
            stack.rotateX(MathHelper.toRadians(200));
            stack.rotateY(MathHelper.toRadians(-135));
            this.translate(stack, 5.6, 0.0, 0.0);

            // Render hand
            player.renderer.renderRightHand(player, partialTicks);
        }
        if (typeof this.minecraft.fusSyncFpToolIntoFirstPerson === 'function') {
            this.minecraft.fusSyncFpToolIntoFirstPerson(player, stack, partialTicks, hasItem);
        }
        const inv1p =
            Number.isFinite(this.minecraft.fusSpawnInvulnUntilMs) &&
            Date.now() < this.minecraft.fusSpawnInvulnUntilMs
        if (inv1p) {
            stack.visible = (Math.floor(Date.now() / 150) & 1) === 0
        } else {
            stack.visible = true
        }
    }

    renderBlockHitBox(player, partialTicks) {
        let hitResult = player.rayTrace(5, partialTicks);
        let hitBoxVisible = !(hitResult === null);
        if ((this.blockHitBox.visible = hitBoxVisible)) {
            let x = hitResult.x;
            let y = hitResult.y;
            let z = hitResult.z;

            // Get block type
            let world = this.minecraft.world;
            let typeId = world.getBlockAt(x, y, z);
            let block = Block.getById(typeId);

            if (typeId !== 0) {
                let boundingBox = block.getBoundingBox(world, x, y, z);

                let offset = 0.01;

                let width = boundingBox.width() + offset;
                let height = boundingBox.height() + offset;
                let depth = boundingBox.depth() + offset;

                // Update size of hit box
                this.blockHitBox.scale.set(
                    width,
                    height,
                    depth
                );

                // Update position of hit box
                this.blockHitBox.position.set(
                    x + width / 2 / width - 0.5 + boundingBox.maxX - width / 2 + offset / 2,
                    y + height / 2 / height - 0.5 + boundingBox.maxY - height / 2 + offset / 2,
                    z + depth / 2 / depth - 0.5 + boundingBox.maxZ - depth / 2 + offset / 2,
                );
            }
        }

        this.lastHitResult = hitResult;
    }

    translate(stack, x, y, z) {
        stack.translateX(x);
        stack.translateY(y);
        stack.translateZ(z);
    }

    bobbingAnimation(player, stack, partialTicks) {
        let walked = -(player.prevDistanceWalked + (player.distanceWalked - player.prevDistanceWalked) * partialTicks);
        let yaw = player.prevCameraYaw + (player.cameraYaw - player.prevCameraYaw) * partialTicks;
        let pitch = player.prevCameraPitch + (player.cameraPitch - player.prevCameraPitch) * partialTicks;

        this.translate(
            stack,
            Math.sin(walked * 3.141593) * yaw * 0.5,
            -Math.abs(Math.cos(walked * Math.PI) * yaw),
            0.0
        );

        stack.rotateZ(MathHelper.toRadians(Math.sin(walked * Math.PI) * yaw * 3.0));
        stack.rotateX(MathHelper.toRadians(Math.abs(Math.cos(walked * Math.PI - 0.2) * yaw) * 5.0));
        stack.rotateX(MathHelper.toRadians(pitch));
    }

    reset() {
        if (this.minecraft.world !== null) {
            this.scene.remove(this.minecraft.world.group);
        }
        this.webRenderer.clear();
        this.overlay.clear();
    }

    /**
     * FUS Laby: pre-mesh a box of chunks at the current player position (same window as
     * {@link #renderChunks}) by marking sections modified, enqueueing without frustum
     * culling, then draining the mesh queue in bursts per rAF. Run while the boot loader
     * is up so the first minutes of play don’t pay all rebuild cost at once.
     *
     * @param {{ maxTotalMs?: number, stepsPerRaf?: number }} [opts]
     * @returns {Promise<void>}
     */
    async fusPrewarmSpawnAreaMeshes(opts = {}) {
        const maxTotalMs = Number.isFinite(opts.maxTotalMs) ? opts.maxTotalMs : 10000;
        const stepsPerRaf = Math.max(4, Math.min(80, Math.floor(opts.stepsPerRaf) || 28));
        const player = this.minecraft.player;
        const world = this.minecraft.world;
        if (!player || !world) {
            return;
        }
        const cx = Math.floor(player.x) >> 4;
        const cz = Math.floor(player.z) >> 4;
        const rd = this.minecraft.settings?.viewDistance;
        if (!Number.isFinite(rd) || rd <= 0) {
            return;
        }
        for (let ndx = -(rd - 1); ndx <= rd - 1; ndx++) {
            for (let ndz = -(rd - 1); ndz <= rd - 1; ndz++) {
                if (Math.abs(ndx) >= rd || Math.abs(ndz) >= rd) {
                    continue;
                }
                const chunk = world.getChunkAt(cx + ndx, cz + ndz);
                if (chunk) {
                    chunk.setModifiedAllSections();
                }
            }
        }
        for (const [, chunk] of world.getChunkProvider().getChunks()) {
            const ddx = Math.abs(cx - chunk.x);
            const ddz = Math.abs(cz - chunk.z);
            if (ddx >= rd || ddz >= rd) {
                continue;
            }
            chunk.group.visible = true;
            chunk.loaded = true;
            for (const y in chunk.sections) {
                const section = chunk.sections[y];
                if (section.isEmpty()) {
                    continue;
                }
                section.group.visible = true;
                if (section.isModified && !this._fusChunkInUpdateQueue.has(section)) {
                    this._fusChunkInUpdateQueue.add(section);
                    this.chunkSectionUpdateQueue.push(section);
                }
            }
        }
        this.chunkSectionUpdateQueue.sort((a, b) => {
            const d1 = (a.x - cx) * (a.x - cx) + (a.z - cz) * (a.z - cz);
            const d2 = (b.x - cx) * (b.x - cx) + (b.z - cz) * (b.z - cz);
            return d1 - d2;
        });

        return new Promise((resolve) => {
            const t0 = typeof performance !== "undefined" ? performance.now() : 0;
            const step = () => {
                for (let s = 0; s < stepsPerRaf && this.chunkSectionUpdateQueue.length > 0; s++) {
                    this._fusDequeueAndRebuildOneChunkSection();
                }
                const now = typeof performance !== "undefined" ? performance.now() : t0;
                if (this.chunkSectionUpdateQueue.length > 0 && now - t0 < maxTotalMs) {
                    if (typeof requestAnimationFrame === "function") {
                        requestAnimationFrame(step);
                    } else {
                        setTimeout(step, 0);
                    }
                } else {
                    resolve();
                }
            };
            if (typeof requestAnimationFrame === "function") {
                requestAnimationFrame(step);
            } else {
                step();
            }
        });
    }
}