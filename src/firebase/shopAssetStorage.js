/**
 * Upload shop binary assets to Firebase Storage and return download URLs for Firestore.
 * Keeps large GLB/PNG out of the Vite production bundle.
 */
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { storage } from './config'

function safeStorageFileName(name) {
  const base = (name || 'asset').split(/[/\\]/).pop()
  return base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'asset'
}

/**
 * @param {'room' | 'accessory' | 'pet'} category
 * @param {string} filename — original file name (sanitized for path)
 * @param {Blob|File|ArrayBuffer} data
 * @returns {Promise<string>} download URL with token
 */
export async function uploadShopGlb(category, filename, data) {
  const safe = safeStorageFileName(filename)
  const path = `shop-models/${category}/${safe}`
  const storageRef = ref(storage, path)
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'model/gltf-binary' })
  await uploadBytes(storageRef, blob, { contentType: 'model/gltf-binary' })
  return getDownloadURL(storageRef)
}

/**
 * @param {string} filename
 * @param {Blob|File|ArrayBuffer} data
 * @returns {Promise<string>}
 */
export async function uploadSkinTextureFile(filename, data) {
  const safe = safeStorageFileName(filename)
  const path = `skin-textures/${safe}`
  const storageRef = ref(storage, path)
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/png' })
  await uploadBytes(storageRef, blob, { contentType: 'image/png' })
  return getDownloadURL(storageRef)
}
