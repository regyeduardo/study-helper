/**
 * On an iPhone the keyboard shrinks the visual viewport but not the layout one, so a window sized in `dvh` ends under the keyboard.
 * `--vvh` is the height of what the person can see: the dialogs use it (with `100dvh` as the fallback) to stay above the keyboard.
 */
export function watchVisualViewport(): () => void {
  const viewport = window.visualViewport
  if (!viewport || !window.matchMedia('(pointer: coarse)').matches) return () => undefined
  const root = document.documentElement
  const apply = () => root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`)
  apply()
  viewport.addEventListener('resize', apply)
  return () => {
    viewport.removeEventListener('resize', apply)
    root.style.removeProperty('--vvh')
  }
}
