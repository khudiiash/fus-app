/**
 * Ensure git submodules are populated before `vite build` runs.
 *
 * Context:
 *  • `src/js-minecraft` is a submodule (see .gitmodules). Local checkouts already have
 *    it populated via `git clone --recurse-submodules`, but Firebase App Hosting /
 *    Cloud Build do a plain clone — leaving the directory empty and breaking Vite
 *    imports like `@/js-minecraft/...`.
 *  • Running this as a `prebuild` hook keeps it idempotent and safe for local dev:
 *    if the submodule is already populated, `git submodule update` is a no-op.
 *
 * Behavior:
 *  • In a git worktree: runs `git submodule update --init --recursive`.
 *  • In environments where git is unavailable (unlikely on App Hosting, but
 *    defensive) or when the submodule dir already has content, it logs and exits.
 *  • Never fails the build if the engine is already present — we verify that first.
 */
'use strict'

const { execSync } = require('node:child_process')
const { existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

const SUBMODULE_PATH = 'src/js-minecraft'
/** Any of these tells us the submodule is usable. */
const SENTINEL_ENTRIES = ['package.json', 'src', 'libraries']

function enginePopulated() {
  const root = join(process.cwd(), SUBMODULE_PATH)
  if (!existsSync(root)) return false
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return false
  }
  if (entries.length === 0) return false
  return SENTINEL_ENTRIES.some((name) => {
    const p = join(root, name)
    try {
      return statSync(p).isFile() || statSync(p).isDirectory()
    } catch {
      return false
    }
  })
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' })
}

function main() {
  if (enginePopulated()) {
    console.log(`[prebuild] ${SUBMODULE_PATH} already populated — skipping submodule init.`)
    return
  }
  if (!existsSync('.git')) {
    console.warn(
      `[prebuild] ${SUBMODULE_PATH} is empty and .git is missing — nothing to init. Build will likely fail.`,
    )
    return
  }
  console.log(`[prebuild] Initializing git submodules (${SUBMODULE_PATH} missing)...`)
  try {
    run('git submodule update --init --recursive')
    if (!enginePopulated()) {
      console.error(
        `[prebuild] ${SUBMODULE_PATH} is still empty after submodule update. Check .gitmodules.`,
      )
      process.exit(1)
    }
    console.log('[prebuild] Submodules ready.')
  } catch (err) {
    console.error(`[prebuild] git submodule update failed: ${err?.message || err}`)
    process.exit(1)
  }
}

main()
