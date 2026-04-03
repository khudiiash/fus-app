/**
 * GLTFLoader uses FileLoader; with Cache enabled, repeated loads of the same URL
 * reuse the downloaded buffer in this tab (no second network fetch).
 */
import * as THREE from 'three'

THREE.Cache.enabled = true
