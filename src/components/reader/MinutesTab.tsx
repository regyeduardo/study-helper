import type { MouseEvent, ReactNode } from 'react'

import type { ScreenFrame } from '@/types/domain'
import { clockTime } from '@/lib/transcription/export'

const MOMENT = /^#t=(\d+(?:\.\d+)?)$/

function momentIn(event: MouseEvent): number | null {
  for (const node of event.nativeEvent.composedPath()) {
    const href = (node as Element).getAttribute?.('href')
    const found = href ? MOMENT.exec(href) : null
    if (found) return Number(found[1])
  }
  return null
}

/** "#t1" links of the Ata's task list: the target lives inside the viewer's shadow root. */
function jumpToAnchor(event: MouseEvent): boolean {
  for (const node of event.nativeEvent.composedPath()) {
    const href = (node as Element).getAttribute?.('href')
    if (!href || !href.startsWith('#') || MOMENT.test(href) || href.length < 2) continue
    const root = (node as Element).getRootNode?.() as Document | ShadowRoot | undefined
    const target = root?.getElementById?.(decodeURIComponent(href.slice(1)))
    if (!target) return false
    event.preventDefault()
    target.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    return true
  }
  return false
}

export function MinutesTab({ children, frames = [], onMoment }: { children: ReactNode; frames?: ScreenFrame[]; onMoment(seconds: number): void }) {
  return (
    <div
      className="minutes"
      onClick={event => {
        if (jumpToAnchor(event)) return
        const seconds = momentIn(event)
        if (seconds === null) return
        event.preventDefault()
        onMoment(seconds)
      }}
    >
      {children}
      {frames.length > 0 && (
        <section className="minutes-screens" aria-label="Na tela">
          <h3>Na tela</h3>
          {frames.map(frame => (
            <figure key={frame.at}>
              <a href={`#t=${frame.at}`} title={`Tocar a partir de ${clockTime(frame.at)}`}>
                <img src={frame.image} alt={frame.text} loading="lazy" />
              </a>
              <figcaption>
                {frame.text} <a href={`#t=${frame.at}`}>▸ {clockTime(frame.at)}</a>
              </figcaption>
            </figure>
          ))}
        </section>
      )}
    </div>
  )
}
