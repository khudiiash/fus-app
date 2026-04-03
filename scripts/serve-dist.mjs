/**
 * Cloud Run / Firebase App Hosting: must listen on process.env.PORT (default 8080)
 * and bind 0.0.0.0. Static Vite output has no server otherwise.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import process from 'node:process'

const port = process.env.PORT || '8080'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const serveCli = path.join(root, 'node_modules', 'serve', 'build', 'main.js')

const child = spawn(
  process.execPath,
  [serveCli, 'dist', '-s', '-n', '-l', `tcp://0.0.0.0:${port}`],
  { stdio: 'inherit', cwd: root, env: process.env },
)

child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})
