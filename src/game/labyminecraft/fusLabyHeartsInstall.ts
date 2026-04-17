import heartsUrl from '@/game/assets/hearts_sh.png'

type McHearts = {
  fusHeartsSheet: HTMLImageElement | null
}

/** Same atlas as Block World HUD (`hearts_sh.png`) for Laby 2D overlay hearts. */
export function installFusLabyHeartsSprite(mc: McHearts): void {
  mc.fusHeartsSheet = null
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    mc.fusHeartsSheet = img
  }
  img.onerror = () => {
    console.warn('[labyminecraft] hearts_sh.png failed to load for Laby HUD')
  }
  img.src = heartsUrl as unknown as string
}
