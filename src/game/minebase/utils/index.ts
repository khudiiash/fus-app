export const htmlToDom = (html: string) => {
  const templateDom = document.createElement('template')
  templateDom.innerHTML = html
  window.document.body.appendChild(templateDom.content)
}

export const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(
  navigator.userAgent
)

/** Primary touch / phone UI (joystick): UA or coarse pointer (tablets, touch laptops). */
export function useTouchGameControls(): boolean {
  if (typeof window === 'undefined') return false
  if (isMobile) return true
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}
