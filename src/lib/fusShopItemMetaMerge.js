/**
 * Merge shop catalog + user inventory rows for the same item id. Mystery-box rolls and
 * profile inventory often only have one source populated; 3D thumbnails need `modelData`
 * from the shop catalog when the user store row is sparse.
 *
 * @param {Array<{ id: string }> | null | undefined} shopItems
 * @param {Array<{ id: string }> | null | undefined} userItems
 * @param {string} id
 * @returns {{ id: string, name?: string, modelData?: unknown, skinUrl?: string, [k: string]: unknown }}
 */
export function mergeItemMetaById(shopItems, userItems, id) {
  const fromShop = Array.isArray(shopItems) ? shopItems.find((i) => i.id === id) : null
  const fromUser = Array.isArray(userItems) ? userItems.find((i) => i.id === id) : null
  if (!fromShop && !fromUser) return { id, name: id }
  return {
    ...fromUser,
    ...fromShop,
    id,
    name: (fromShop && fromShop.name) || (fromUser && fromUser.name) || id,
    modelData: (fromShop && fromShop.modelData) || (fromUser && fromUser.modelData),
    skinUrl: (fromShop && fromShop.skinUrl) || (fromUser && fromUser.skinUrl),
  }
}
