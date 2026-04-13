/**
 * Skins stored in Firestore must be fetchable from any client (no blob:/data: URLs).
 * Relative paths are resolved against the current origin so phone ↔ desktop dev works.
 */
function stripInvisibleAndBom(s: string) {
  return s
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
}

export function normalizeSkinUrlForPresence(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const u = stripInvisibleAndBom(url)
  if (!u) return null
  if (u.startsWith('blob:') || u.startsWith('data:')) return null
  if (/^https?:\/\//i.test(u)) return u
  if (u.startsWith('//')) return `https:${u}`
  if (u.startsWith('/') && typeof window !== 'undefined') {
    return `${window.location.origin}${u}`
  }
  // Host/path without scheme (some stored URLs omit "https:")
  if (/^[a-z0-9][a-z0-9+.-]*\.[a-z]{2,}\//i.test(u)) {
    return `https://${u}`
  }
  return u
}
