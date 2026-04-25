import { GUI } from "dat.gui";
import {
    bumpFusTpToolTuningRebuild,
    fusFpToolTuning,
    fusFpToolSwingTuning,
    fusTpToolTuning,
} from "./FusToolsGltfFirstPerson.js";
import { installFusToolGuiInputShield } from "./FusToolGuiInputShield.js";
import { fusToolTuningGuiBegin, fusToolTuningGuiEnd } from "./FusToolTuningViewRef.js";

/**
 * dat.gui for {@link fusTpToolTuning} — third-person / **remote** held tools (other players in
 * Laby). Live position/rotation updates apply on the next frame; changing {@link
 * fusTpToolTuning#scaleTarget} rebuilds the mesh (bumps {@link bumpFusTpToolTuningRebuild}).
 *
 * The FP panel ({@link installFusFpToolTuningGui}) is separate: this only edits TP/remote
 * transform so you can line up tools on other players' skins.
 *
 * @param {import("../Minecraft.js").default} mc
 */
export function installFusTpToolTuningGui(mc) {
    if (typeof window === "undefined") {
        return;
    }
    if (mc._fusTpToolTuningGui) {
        const prev = mc._fusTpToolTuningGui;
        fusToolTuningGuiEnd(mc);
        try {
            prev.domElement.remove();
        } catch (_) {
            /* ignore */
        }
        try {
            prev.destroy();
        } catch (_) {
            /* ignore */
        }
        mc._fusTpToolTuningGui = null;
    }

    const gui = new GUI({ name: "FUS TP / remote tool", width: 320, autoPlace: false });
    mc._fusTpToolTuningGui = gui;

    const el = gui.domElement;
    el.style.position = "fixed";
    el.style.top = "8px";
    el.style.left = "8px";
    el.style.zIndex = "10050";
    installFusToolGuiInputShield(el);
    document.body.appendChild(el);
    fusToolTuningGuiBegin(mc);

    const T = fusTpToolTuning;
    const scaleF = gui.addFolder("Scale (rebuilds mesh)");
    scaleF
        .add(T, "scaleTarget", 1, 50, 0.25)
        .onChange(() => {
            bumpFusTpToolTuningRebuild();
        });
    scaleF.open();

    const posF = gui.addFolder("Holder position (arm-local units)");
    posF.add(T, "posX", -30, 30, 0.1);
    posF.add(T, "posY", -30, 30, 0.1);
    posF.add(T, "posZ", -30, 30, 0.1);
    posF.open();

    const rotF = gui.addFolder("Holder rotation (deg)");
    rotF.add(T, "rotXDeg", -180, 180, 0.5);
    rotF.add(T, "rotYDeg", -180, 180, 0.5);
    rotF.add(T, "rotZDeg", -180, 180, 0.5);
    rotF.open();

    const innerF = gui.addFolder("Tool mesh rotation (deg, inner)");
    innerF.add(T, "innerRotXDeg", -180, 180, 0.5);
    innerF.add(T, "innerRotYDeg", -180, 180, 0.5);
    innerF.add(T, "innerRotZDeg", -180, 180, 0.5);
    innerF.open();

    gui.add(
        {
            copyTpJson() {
                try {
                    void navigator.clipboard?.writeText(JSON.stringify({ tp: fusTpToolTuning }, null, 2));
                } catch (_) {
                    /* ignore */
                }
            },
        },
        "copyTpJson",
    );

    gui.add(
        {
            /** Second arg to {@link GUI#add} must be this exact key — not a label string. */
            copyFpSwingTpJson() {
                try {
                    void navigator.clipboard?.writeText(
                        JSON.stringify(
                            { fp: fusFpToolTuning, swing: fusFpToolSwingTuning, tp: fusTpToolTuning },
                            null,
                            2,
                        ),
                    );
                } catch (_) {
                    /* ignore */
                }
            },
        },
        "copyFpSwingTpJson",
    );

    gui.add(
        {
            closePanel() {
                try {
                    gui.domElement.remove();
                } catch (_) {
                    /* ignore */
                }
                try {
                    gui.destroy();
                } catch (_) {
                    /* ignore */
                }
                if (mc._fusTpToolTuningGui === gui) {
                    mc._fusTpToolTuningGui = null;
                }
                fusToolTuningGuiEnd(mc);
            },
        },
        "closePanel",
    );
}
