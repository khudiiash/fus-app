import Minecraft from './net/minecraft/client/Minecraft.js';
import * as aesjs from '../../libraries/aes.js';

/** When embedded in FUS (Vite), `window.__LABY_MC_ASSET_BASE__` is set before launch (e.g. `/labyminecraft/`). */
function labyMcAssetBase() {
    if (typeof window !== 'undefined' && window.__LABY_MC_ASSET_BASE__) {
        return String(window.__LABY_MC_ASSET_BASE__).replace(/\/?$/, '/');
    }
    return '';
}

class Start {

    loadTextures(textures) {
        let resources = [];
        let index = 0;
        const base = labyMcAssetBase();

        return textures.reduce((currentPromise, texturePath) => {
            return currentPromise.then(() => {
                return new Promise((resolve, reject) => {
                    // Load texture
                    let image = new Image();
                    image.src = base + 'src/resources/' + texturePath;
                    image.onload = () => resolve();
                    resources[texturePath] = image;

                    index++;
                });
            });
        }, Promise.resolve()).then(() => {
            return resources;
        });
    }

    launch(canvasWrapperId) {
        return this.loadTextures([
            "misc/grasscolor.png",
            "gui/font.png",
            "gui/gui.png",
            "gui/background.png",
            "gui/icons.png",
            "terrain/terrain.png",
            "terrain/sun.png",
            "terrain/moon.png",
            "char.png",
            "gui/title/minecraft.png",
            "gui/title/background/panorama_0.png",
            "gui/title/background/panorama_1.png",
            "gui/title/background/panorama_2.png",
            "gui/title/background/panorama_3.png",
            "gui/title/background/panorama_4.png",
            "gui/title/background/panorama_5.png",
            "gui/container/creative.png"
        ]).then((resources) => {
            // Launch actual game on canvas (host may keep reference on window.app for dispose)
            const app = new Minecraft(canvasWrapperId, resources);
            window.app = app;
            return app;
        });
    }
}

export default Start;

export function require(module) {
    return window[module];
}