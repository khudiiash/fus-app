/**
 * Runs patch-package only after a real install (node_modules present).
 * Firebase App Hosting runs `npm install --package-lock-only` first, which
 * does not install deps but still triggers postinstall — plain `patch-package`
 * then fails with "not found".
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const cli = path.join('node_modules', 'patch-package', 'index.js')
if (!fs.existsSync(cli)) {
  process.exit(0)
}

const r = spawnSync(process.execPath, [cli], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
  env: process.env,
})
process.exit(r.status === null ? 1 : r.status)
