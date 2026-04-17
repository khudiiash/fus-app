/**
 * Expands legacy 2:1 skins to a square 1.8+ atlas so the same UV math as
 * `minecraft-character/model.js` applies. Logic from skinview-utils `process.ts`
 * (https://github.com/bs-community/skinview-utils), MIT-style license there.
 */
type CanvasCtx = CanvasRenderingContext2D

function computeSkinScale(width: number): number {
  return width / 64.0
}

/** Copies arm/leg regions from the legacy top half into the lower 1.8 layout (mirrored). */
function convertSkinTo1_8(context: CanvasCtx, width: number): void {
  const scale = computeSkinScale(width)
  context.save()
  context.scale(-1, 1)
  const copySkin = (
    sX: number,
    sY: number,
    w: number,
    h: number,
    dX: number,
    dY: number,
  ): void =>
    context.drawImage(
      context.canvas,
      sX * scale,
      sY * scale,
      w * scale,
      h * scale,
      -dX * scale,
      dY * scale,
      -w * scale,
      h * scale,
    )
  copySkin(4, 16, 4, 4, 20, 48)
  copySkin(8, 16, 4, 4, 24, 48)
  copySkin(0, 20, 4, 12, 24, 52)
  copySkin(4, 20, 4, 12, 20, 52)
  copySkin(8, 20, 4, 12, 16, 52)
  copySkin(12, 20, 4, 12, 28, 52)
  copySkin(44, 16, 4, 4, 36, 48)
  copySkin(48, 16, 4, 4, 40, 48)
  copySkin(40, 20, 4, 12, 40, 52)
  copySkin(44, 20, 4, 12, 36, 52)
  copySkin(48, 20, 4, 12, 32, 52)
  copySkin(52, 20, 4, 12, 44, 52)
  context.restore()
}

function readBitmapSize(image: HTMLImageElement | HTMLCanvasElement): { w: number; h: number } {
  if (image instanceof HTMLCanvasElement) {
    return { w: image.width, h: image.height }
  }
  const w = image.naturalWidth || image.width
  const h = image.naturalHeight || image.height
  return { w, h }
}

/**
 * @returns Square canvas (64×64 or 128×128 typically) ready for {@link THREE.CanvasTexture}.
 */
export function normalizeMinecraftSkinToCanvas(
  image: HTMLImageElement | HTMLCanvasElement,
): HTMLCanvasElement {
  const { w: iw, h: ih } = readBitmapSize(image)
  const isOldFormat = iw !== ih && iw === 2 * ih
  if (iw !== ih && !isOldFormat) {
    throw new Error(`Bad skin size: ${iw}x${ih}`)
  }
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('no 2d context')
  if (isOldFormat) {
    const side = iw
    canvas.width = side
    canvas.height = side
    context.clearRect(0, 0, side, side)
    context.drawImage(image, 0, 0, side, side / 2)
    convertSkinTo1_8(context, side)
  } else {
    canvas.width = iw
    canvas.height = ih
    context.clearRect(0, 0, iw, ih)
    context.drawImage(image, 0, 0, iw, ih)
  }
  return canvas
}
