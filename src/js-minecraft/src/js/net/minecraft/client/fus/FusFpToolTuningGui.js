import { GUI } from "dat.gui";
import { fusFpToolTuning } from "./FusToolsGltfFirstPerson.js";

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
    el.style.top = "52px";
    el.style.left= "12px";
    el.style.zIndex = "10050";
    document.body.appendChild(el);

    const bump = () => {
        if (typeof mc.fusBumpFpToolGltfRebuild === "function") {
            mc.fusBumpFpToolGltfRebuild();
        }
    };

    const T = fusFpToolTuning;

    const scale = gui.addFolder("Scale");
    scale.add(T, "unitScale", 1, 250, 1).onChange(bump);
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
    grp.add(T, "groupX", -10, 10, 0.005).onChange(bump);
    grp.add(T, "groupY", -10, 10, 0.005).onChange(bump);
    grp.add(T, "groupZ", -10, 10, 0.005).onChange(bump);
    grp.add(T, "groupRotXDeg", -180, 180, 0.5).onChange(bump);
    grp.add(T, "groupRotYDeg", -180, 180, 0.5).onChange(bump);
    grp.add(T, "groupRotZDeg", -180, 180, 0.5).onChange(bump);
    grp.open();

    gui.add(
        {
            copyJson() {
                try {
                    void navigator.clipboard?.writeText(JSON.stringify(fusFpToolTuning, null, 2));
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
            },
        },
        "closePanel",
    );
}
