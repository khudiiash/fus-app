import { GUI } from "dat.gui";
import { fusFpToolSwingTuning, fusFpToolTuning } from "./FusToolsGltfFirstPerson.js";
import { installFusToolGuiInputShield } from "./FusToolGuiInputShield.js";
import { fusToolTuningGuiBegin, fusToolTuningGuiEnd } from "./FusToolTuningViewRef.js";

/**
 * Dev-only dat.gui for {@link fusFpToolTuning}. Calls `mc.fusBumpFpToolGltfRebuild` on change.
 * @param {import("../Minecraft.js").default} mc
 */
export function installFusFpToolTuningGui(mc) {
    if (typeof window === "undefined") {
        return;
    }
    if (mc._fusFpToolTuningGui) {
        const prev = mc._fusFpToolTuningGui;
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
        mc._fusFpToolTuningGui = null;
    }

    const gui = new GUI({ name: "FUS FP tool", width: 320, autoPlace: false });
    mc._fusFpToolTuningGui = gui;

    const el = gui.domElement;
    el.style.position = "fixed";
    el.style.top = "8px";
    el.style.left = "8px";
    el.style.zIndex = "10050";
    installFusToolGuiInputShield(el);
    document.body.appendChild(el);
    fusToolTuningGuiBegin(mc);

    const bump = () => {
        if (typeof mc.fusBumpFpToolGltfRebuild === "function") {
            mc.fusBumpFpToolGltfRebuild();
        }
    };

    const T = fusFpToolTuning;

    const scale = gui.addFolder("Scale");
    /** Widened upper bound from 250 → 300: useful when tuning a blade-style tool where
     *  0.42 × unitScale × 0.0625 ≈ 7.8 blocks, so values beyond 250 still have reasonable
     *  meaning. Step of 1 is fine for unit scale; sub-integer values don't meaningfully
     *  change the visual result. */
    scale.add(T, "unitScale", 1, 300, 1).onChange(bump);
    scale.open();

    const strike = gui.addFolder("Blade align (+Y → strike)");
    strike.add(T, "alignBlade").onChange(bump);
    strike.add(T, "strikeX", -1, 1, 0.01).onChange(bump);
    strike.add(T, "strikeY", -1, 1, 0.01).onChange(bump);
    strike.add(T, "strikeZ", -1, 1, 0.01).onChange(bump);
    strike.open();

    const tool = gui.addFolder("Tool extra (deg, local)");
    tool.add(T, "extraToolRotXDeg", -180, 180, 0.5).onChange(bump);
    tool.add(T, "extraToolRotYDeg", -180, 180, 0.5).onChange(bump);
    tool.add(T, "extraToolRotZDeg", -180, 180, 0.5).onChange(bump);
    tool.open();

    const grp = gui.addFolder("Group (hand offset)");
    /** Widened hand-offset sliders from [-10, 10] → [-30, 30]. In stack units (1 stack
     *  unit ≈ 1/16 block) the previous ±10 range was too narrow to explore "push the tool
     *  fully to the right edge of the screen" or "pull it back behind the hand" — the
     *  user's most recent attempt to tune those values set `groupX=16` which the old
     *  slider couldn't even reach. Finer 0.1 step still lets you land on whole integers. */
    grp.add(T, "groupX", -30, 30, 0.1).onChange(bump);
    grp.add(T, "groupY", -30, 30, 0.1).onChange(bump);
    grp.add(T, "groupZ", -30, 30, 0.1).onChange(bump);
    grp.add(T, "groupRotXDeg", -180, 180, 0.5).onChange(bump);
    grp.add(T, "groupRotYDeg", -180, 180, 0.5).onChange(bump);
    grp.add(T, "groupRotZDeg", -180, 180, 0.5).onChange(bump);
    grp.open();

    /** Swing animation compensator — fine-tunes the vanilla FP arm swing at strike time
     *  (user: "must go more forward and down"). No bump() needed: values are read live
     *  every frame, so edits take effect on the next swing. */
    const S = fusFpToolSwingTuning;
    const sw = gui.addFolder("Swing animation (strike)");
    sw.add(S, "counterYawDeg", -40, 40, 0.5);
    sw.add(S, "counterRollDeg", -40, 40, 0.5);
    sw.add(S, "extraPitchDeg", -60, 60, 0.5);
    sw.add(S, "forwardZ", -6, 6, 0.1);
    sw.add(S, "downY", -6, 6, 0.1);
    sw.open();

    gui.add(
        {
            copyJson() {
                try {
                    void navigator.clipboard?.writeText(
                        JSON.stringify(
                            { rest: fusFpToolTuning, swing: fusFpToolSwingTuning },
                            null,
                            2,
                        ),
                    );
                } catch (_) {
                    /* ignore */
                }
            },
        },
        "copyJson",
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
                if (mc._fusFpToolTuningGui === gui) {
                    mc._fusFpToolTuningGui = null;
                }
                fusToolTuningGuiEnd(mc);
            },
        },
        "closePanel",
    );
}
