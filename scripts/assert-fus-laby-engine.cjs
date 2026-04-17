/**
 * Fails `npm run build` if the js-minecraft submodule tree does not contain the FUS fork patches.
 * (Otherwise CI / deploy can ship an old submodule SHA and it looks like “nothing changed”.)
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const files = [
  [
    path.join(root, 'third-party/js-minecraft/src/js/net/minecraft/client/render/WorldRenderer.js'),
    ['fusSyncFpToolIntoFirstPerson', '__FUS_LABY_ENGINE_PATCH'],
  ],
  [
    path.join(root, 'third-party/js-minecraft/src/js/net/minecraft/client/render/entity/entity/PlayerRenderer.js'),
    ['fusIsUnderFpToolPivot'],
  ],
]

let ok = true
for (const [p, needles] of files) {
  if (!fs.existsSync(p)) {
    console.error(`[assert-fus-laby-engine] Missing file (submodule not checked out?): ${path.relative(root, p)}`)
    ok = false
    continue
  }
  const s = fs.readFileSync(p, 'utf8')
  for (const n of needles) {
    if (!s.includes(n)) {
      console.error(`[assert-fus-laby-engine] Expected "${n}" in ${path.relative(root, p)}`)
      ok = false
    }
  }
}

if (!ok) {
  console.error(
    '[assert-fus-laby-engine] Fix: commit + push changes inside `third-party/js-minecraft`, then in the parent repo `git add third-party/js-minecraft && git commit` so CI records the new submodule commit.',
  )
  process.exit(1)
}
