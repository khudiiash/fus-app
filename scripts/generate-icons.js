import sharp from 'sharp'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '../public/icons')
mkdirSync(outDir, { recursive: true })

const svgBuffer = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#7c3aed"/>
      <stop offset="100%" style="stop-color:#4c1d95"/>
    </linearGradient>
    <linearGradient id="bolt" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#fcd34d"/>
      <stop offset="100%" style="stop-color:#f59e0b"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <polygon points="290,60 180,290 250,290 222,452 350,220 272,220 320,60" fill="url(#bolt)" stroke="none"/>
</svg>
`)

const sizes = [72, 96, 128, 144, 152, 192, 384, 512]

await Promise.all(sizes.map(size =>
  sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toFile(join(outDir, `icon-${size}.png`))
))

// Maskable (with padding)
const maskableSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#4c1d95"/>
  <rect x="40" y="40" width="432" height="432" rx="80" fill="#7c3aed"/>
  <polygon points="285,110 185,275 248,275 224,402 338,235 268,235 310,110" fill="#fcd34d"/>
</svg>
`)

await sharp(maskableSvg).resize(512, 512).png().toFile(join(outDir, 'icon-maskable.png'))
await sharp(maskableSvg).resize(192, 192).png().toFile(join(outDir, 'icon-192.png'))
await sharp(svgBuffer).resize(512, 512).png().toFile(join(outDir, 'icon-512.png'))

console.log('Icons generated!')
