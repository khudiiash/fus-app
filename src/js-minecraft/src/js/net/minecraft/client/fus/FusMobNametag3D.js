import * as THREE from "../../../../../../libraries/three.module.js";

/**
 * MMO-style mob nametag: just a small name + level line with a slim HP pip underneath.
 * No background panel, no border, no numeric HP text. Readability comes from a tight text
 * shadow. Canvas is intentionally tiny (256×48 → ~1.6×0.3 world units) so overdraw on
 * mobile is negligible.
 *
 * Previous design drew a 256×96 black rectangle with a border + bold name + HP text + bar
 * (~2.5× the pixels of this one and visually heavy). User ask was explicitly: "just its name
 * and lvl, and slim hp line without hp count, without background, and name in smaller font".
 */

const CANVAS_W = 256;
const CANVAS_H = 48;
const PLANE_W = 1.6;
const PLANE_H = 0.3;

/** Max rendered title length before ellipsis — keeps all mob types on one line. */
const TITLE_MAX_LEN = 24;

function ellipsize(s, max) {
    const str = String(s || "");
    if (str.length <= max) return str;
    return str.slice(0, Math.max(1, max - 1)) + "…";
}

export class FusMobNametag3D {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     */
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.mesh = null;
        this.canvas = null;
        this.ctx = null;
        this.texture = null;
        this.material = null;
        this._name = "";
        this._level = 1;
        this._hp = 20;
        this._maxHp = 20;
        this._visible = true;
        this._lastTextSig = "";
    }

    _ensure() {
        if (this.mesh) return;
        this.canvas = document.createElement("canvas");
        this.canvas.width = CANVAS_W;
        this.canvas.height = CANVAS_H;
        this.ctx = this.canvas.getContext("2d");
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
        this.material = new THREE.MeshBasicMaterial({
            map: this.texture,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        const geo = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.renderOrder = 999;
        this.mesh.frustumCulled = false;
        this.scene.add(this.mesh);
        this._redraw();
    }

    dispose() {
        try {
            if (this.mesh) this.scene.remove(this.mesh);
        } catch (_) { /* ignore */ }
        try { this.material?.dispose?.(); } catch (_) { /* ignore */ }
        try { this.texture?.dispose?.(); } catch (_) { /* ignore */ }
        this.mesh = null;
        this.material = null;
        this.texture = null;
        this.canvas = null;
        this.ctx = null;
    }

    setVisible(v) {
        this._visible = !!v;
        if (this.mesh) this.mesh.visible = this._visible;
    }

    /**
     * @param {string} name
     * @param {number} level
     * @param {number} hp
     * @param {number} maxHp
     */
    setText(name, level, hp, maxHp) {
        const n = ellipsize(name, TITLE_MAX_LEN);
        const lv = Math.max(1, Math.floor(level) || 1);
        const h = Math.max(0, hp);
        const m = Math.max(1, maxHp);
        /** Quantize HP to int-percent: avoids redrawing the canvas on every 0.01 HP tick. */
        const pct = Math.round((h / m) * 100);
        const sig = `${n}|${lv}|${pct}|${m}`;
        if (sig === this._lastTextSig && this.texture) {
            return;
        }
        this._lastTextSig = sig;
        this._name = n;
        this._level = lv;
        this._hp = h;
        this._maxHp = m;
        this._ensure();
        this._redraw();
    }

    _redraw() {
        if (!this.ctx || !this.canvas || !this.texture) return;
        const ctx = this.ctx;
        const w = CANVAS_W;
        const h = CANVAS_H;
        ctx.clearRect(0, 0, w, h);

        /** Title (name + level). Small font, bold white, drop shadow for legibility vs terrain. */
        const title = `${this._name} Lv.${this._level}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 18px system-ui, Segoe UI, Arial";
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 1;
        ctx.shadowBlur = 3;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(title, w / 2, 14);
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        /** HP pip — 3 px tall, ~55% of canvas width, no background plate.
         *  We render a 1 px dark underlay (50% alpha) only behind the depleted portion so the
         *  remaining bar reads cleanly on any terrain. Full HP = no underlay visible. */
        const barW = Math.floor(w * 0.55);
        const barH = 3;
        const barX = Math.floor((w - barW) / 2);
        const barY = 30;
        const t = Math.max(0, Math.min(1, this._maxHp > 0 ? this._hp / this._maxHp : 0));

        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(barX, barY, barW, barH);
        const filledW = Math.round(barW * t);
        if (filledW > 0) {
            ctx.fillStyle = t > 0.5 ? "#3ddc84" : t > 0.2 ? "#ffb020" : "#ff4d4d";
            ctx.fillRect(barX, barY, filledW, barH);
        }

        this.texture.needsUpdate = true;
    }

    /**
     * @param {number} x
     * @param {number} y absolute world y where the label should sit — caller is responsible
     *   for adding any per-mob {@code nametagY} offset (see {@link fusMobNametagY}). Keeping
     *   the offset out of this method lets callers tune anchor height without an extra arg.
     * @param {number} z
     */
    updatePosition(x, y, z) {
        this._ensure();
        if (!this.mesh) return;
        this.mesh.position.set(x, y, z);
        if (this.camera) this.mesh.quaternion.copy(this.camera.quaternion);
        this.mesh.visible = this._visible;
    }
}
