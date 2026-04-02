/**
 * Застосовує storage-cors.json до GCS bucket Firebase Storage (потрібен gsutil + gcloud auth).
 *
 *   node scripts/apply-storage-cors.mjs
 *   node scripts/apply-storage-cors.mjs fusapp-5217f.firebasestorage.app
 *
 * Bucket береться з аргументу або з FIREBASE_STORAGE_BUCKET / VITE_FIREBASE_STORAGE_BUCKET у середовищі.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const corsPath = resolve(root, 'storage-cors.json')

function loadEnvFile(name) {
  const p = resolve(root, name)
  if (!existsSync(p)) return
  const text = readFileSync(p, 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

loadEnvFile('.env')
loadEnvFile('.env.local')

const argBucket = process.argv[2]
const envBucket =
  process.env.FIREBASE_STORAGE_BUCKET ||
  process.env.VITE_FIREBASE_STORAGE_BUCKET ||
  ''
const bucket = (argBucket || envBucket).replace(/^gs:\/\//, '').trim()

if (!bucket) {
  console.error(
    'Вкажіть bucket: node scripts/apply-storage-cors.mjs YOUR_PROJECT.firebasestorage.app\n' +
      'або задайте VITE_FIREBASE_STORAGE_BUCKET у .env',
  )
  process.exit(1)
}

if (!existsSync(corsPath)) {
  console.error('Не знайдено', corsPath)
  process.exit(1)
}

const gsUrl = `gs://${bucket}`

function runOrThrow(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

let ok = false
try {
  console.log('Спроба: gcloud storage buckets update', gsUrl)
  runOrThrow('gcloud', ['storage', 'buckets', 'update', gsUrl, `--cors-file=${corsPath}`])
  ok = true
} catch {
  try {
    console.log('Спроба: gsutil cors set …', gsUrl)
    runOrThrow('gsutil', ['cors', 'set', corsPath, gsUrl])
    ok = true
  } catch (e) {
    console.error(
      '\nНе вдалося викликати gcloud або gsutil. Встановіть Google Cloud SDK: https://cloud.google.com/sdk\n' +
        'або у Cloud Shell https://shell.cloud.google.com виконайте (з файлом storage-cors.json у cwd):\n' +
        `  gcloud storage buckets update ${gsUrl} --cors-file=storage-cors.json\n`,
    )
    process.exit(1)
  }
}

if (ok) {
  console.log('Готово. Перезавантажте сторінку (WebGL/Canvas потребують CORS для cross-origin текстур).')
}
