const UA_MAP = {
  а:'a', б:'b', в:'v', г:'h', ґ:'g', д:'d', е:'e', є:'ie',
  ж:'zh', з:'z', и:'y', і:'i', ї:'i', й:'j', к:'k', л:'l',
  м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u',
  ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh', щ:'shch',
  ю:'yu', я:'ya', ь:'', ъ:'',
}

function transliterate(str) {
  return str
    .toLowerCase()
    .split('')
    .map(ch => UA_MAP[ch] ?? ch)
    .join('')
}

export function nameToEmail(name) {
  const latin = transliterate(name)
  const local = latin
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9.]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
  return (local || 'user') + '@fus.ua'
}
