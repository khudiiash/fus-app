import Minecraft from './net/minecraft/client/Minecraft.js';
import * as aesjs from '../../libraries/aes.js';

/** When embedded in FUS (Vite), `window.__LABY_MC_ASSET_BASE__` is set before launch (e.g. `/labyminecraft/`). */
function labyMcAssetBase() {
    if (typeof window !== 'undefined' && window.__LABY_MC_ASSET_BASE__) {
        return String(window.__LABY_MC_ASSET_BASE__).replace(/\/?$/, '/');
    }
    return '';
}

function fusAssetVersionQuery() {
    if (typeof window === 'undefined') return '';
    const raw = window.__FUS_ASSET_REV__ || window.__APP_BUILD_ID__ || window.__FUS_BUILD_ID__;
    if (raw == null) return '';
    const v = String(raw).trim();
    if (!v) return '';
    const enc = encodeURIComponent(v);
    return `?v=${enc}`;
}

class Start {

    loadTextures(textures) {
        let resources = [];
        let index = 0;
        const base = labyMcAssetBase();
        const versionQuery = fusAssetVersionQuery();

        const loadOneTexture = (texturePath, attempt = 0) => new Promise((resolve, reject) => {
            const image = new Image();
            const src = base + 'src/resources/' + texturePath + versionQuery;
            image.onload = () => {
                resources[texturePath] = image;
                resolve();
            };
            image.onerror = () => {
                const error = new Error(`[Laby] Texture failed to load: ${src}`);
                if (attempt < 2) {
                    setTimeout(() => {
                        loadOneTexture(texturePath, attempt + 1).then(resolve).catch(reject);
                    }, 250 * (attempt + 1));
                    return;
                }
                reject(error);
            };
            image.src = src;
            index++;
        });

        return textures.reduce((currentPromise, texturePath) => {
            return currentPromise.then(() => {
                return loadOneTexture(texturePath);
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