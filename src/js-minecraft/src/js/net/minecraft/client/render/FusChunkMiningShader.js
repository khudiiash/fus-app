import * as THREE from "../../../../../../libraries/three.module.js";

/**
 * Mining feedback: multiply sampled terrain color toward {@code fusNoiseMap} as damage 0→1 increases.
 *
 * @param {import("three").MeshBasicMaterial} material
 * @param {import("three").Texture | null | undefined} noiseTex
 */
export function patchChunkTerrainMaterialForMiningDestroy(material, noiseTex) {
    if (!material || material.userData.fusMiningDestroyPatched) {
        return;
    }
    material.userData.fusMiningDestroyPatched = true;

    const map =
        noiseTex ||
        (() => {
            const data = new Uint8Array([255, 255, 255, 255]);
            const t = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
            t.needsUpdate = true;
            t.magFilter = THREE.NearestFilter;
            t.minFilter = THREE.NearestFilter;
            return t;
        })();

    material.userData.fusNoiseMap = map;

    material.customProgramCacheKey = function () {
        return "fusMiningDestroyV8";
    };
    material.onBeforeCompile = (shader) => {
        shader.uniforms.fusNoiseMap = { value: map };

        shader.vertexShader = shader.vertexShader
            .replace(
                "#include <common>",
                `#include <common>
attribute float destroyStage;
varying float vMiningDamage;`,
            )
            .replace(
                "#include <uv_vertex>",
                `#include <uv_vertex>
vMiningDamage = destroyStage;`,
            );

        shader.fragmentShader = shader.fragmentShader
            .replace(
                "#include <common>",
                `#include <common>
uniform sampler2D fusNoiseMap;
varying float vMiningDamage;`,
            )
            .replace(
                "#include <color_fragment>",
                `#ifdef USE_MAP
	if ( vMiningDamage > 0.001 ) {
		vec2 tileUv = fract( vMapUv);
		vec2 nuv = fract( tileUv * 8.0);
		float n = texture2D( fusNoiseMap, nuv ).r;
		float w = clamp( vMiningDamage, 0.0, 1.0 );
		vec3 base = diffuseColor.rgb;
		diffuseColor.rgb = base * mix( vec3( 1.0 ), vec3( n ), w * 0.95 );
	}
#endif
#include <color_fragment>`,
            );
    };
}
