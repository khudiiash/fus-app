import * as THREE from "../../../../../../libraries/three.module.js";

export default class Tessellator {

    constructor() {
        this.material = new THREE.MeshBasicMaterial({
            side: THREE.FrontSide,
            transparent: true,
            depthTest: true,
            vertexColors: true
        });

        this.red = 0;
        this.green = 0;
        this.blue = 0;
        this.alpha = 0;
    }

    bindTexture(texture) {
        this.material.map = texture;
    }

    startDrawing() {
        this.addedVertices = 0;
        this.vertices = [];
        this.uv = [];
        this.colors = [];
    }

    setColorRGB(red, green, blue) {
        this.red = red;
        this.green = green;
        this.blue = blue;
    }

    setColor(red, green, blue, alpha = 1) {
        this.setColorRGB(red, green, blue);
        this.setAlpha(alpha);
    }

    multiplyColor(red, green, blue, alpha = 1) {
        this.red *= red;
        this.green *= green;
        this.blue *= blue;
        this.alpha *= alpha;
    }

    setAlpha(alpha) {
        this.alpha = alpha;
    }

    addVertex(x, y, z) {
        this.addedVertices++;

        // Add vertex
        this.vertices.push(x);
        this.vertices.push(y);
        this.vertices.push(z);

        // Add colors
        this.colors.push(this.red);
        this.colors.push(this.green);
        this.colors.push(this.blue);
        this.colors.push(this.alpha);
    }

    addVertexWithUV(x, y, z, u, v) {
        this.addVertex(x, y, z);

        // Add UV
        this.uv.push(u);
        this.uv.push(v);
    }

    transformBrightness(brightness) {
        for (let i = 0; i < this.colors.length / 4; i++) {
            this.colors[i * 4 + 0] *= brightness;
            this.colors[i * 4 + 1] *= brightness;
            this.colors[i * 4 + 2] *= brightness;
        }
    }

    /**
     * @param {THREE.Object3D} group
     * @param {string} [chunkPass] When {@code 'solid'} / {@code 'trans'} (FUS column merge), stored on the mesh.
     */
    draw(group, chunkPass) {
        const verticesPerFace = 4;
        if (this.addedVertices < verticesPerFace) {
            return null;
        }

        const positionArray = new Float32Array(this.vertices);
        const colorArray = new Float32Array(this.colors);
        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 4));
        if (this.uv.length > 0) {
            geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
        }

        // Triangle index list for quads (4 verts each → 6 indices). Pre-sized typed array
        // avoids the JS `push` hot path in chunk meshing.
        const nFaces = this.addedVertices / verticesPerFace;
        if (nFaces > 0) {
            const index = new Uint32Array(nFaces * 6);
            let w = 0;
            for (let i = 0; i < nFaces; i++) {
                const b = i * verticesPerFace;
                index[w++] = b + 0;
                index[w++] = b + 2;
                index[w++] = b + 1;
                index[w++] = b + 0;
                index[w++] = b + 3;
                index[w++] = b + 2;
            }
            geometry.setIndex(new THREE.BufferAttribute(index, 1));
        }

        let mesh = new THREE.Mesh(geometry, this.material);
        if (chunkPass === "solid" || chunkPass === "trans") {
            mesh.userData.fusChunkPass = chunkPass;
        }
        group.matrixAutoUpdate = false;
        group.add(mesh);
        return mesh;
    }

}