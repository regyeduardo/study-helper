// Draws a map with Mermaid, loaded only when a map is shown, with zoom, "Ajustar" and dragging to move around; on the phone, pinch and double tap too.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { MapDiagram, MapNode } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { useIsNarrow } from '@/hooks/use-is-narrow'
import { HIGHLIGHT_CLASS, mapToMermaid } from '@/lib/generation/map-render'
import { isDarkTheme } from '@/lib/theme'

const STEP = 1.25
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
/** "Ajustar" never blows a small map up past this: huge letters read worse than a map with room around it. */
const FIT_MAX = 1.25
/** Room around the drawing, in px; the same as `.map-stage` in app.css. */
const PAD = 24
/** On the phone a map opens at this zoom, legible without zooming, when fitting it whole would shrink it below (FR-054). */
const READ_ZOOM = 1
/** Two taps this close, in ms and px, are a double tap; a finger that moves more than TAP_SLOP px is dragging, not tapping. */
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_PX = 30
const TAP_SLOP = 10
/** The center of the map in Mermaid's drawing: the root of the tree and flow forms, the center of the radial one. The timeline has none: it opens at its start. */
const CENTER = '[id$="flowchart-m0-0"], .mindmap-node.section-root'

let renders = 0

const clamp = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))

function labelOf(node: MapNode): string {
  return node.mark ? `${node.mark} ${node.text}` : node.text
}

/** Mermaid writes width="100%": the real size is in the viewBox. */
function sizeOf(svg: string): { width: number; height: number } {
  const box = /viewBox="([^"]*)"/.exec(/<svg\b[^>]*>/.exec(svg)?.[0] ?? '')?.[1] ?? ''
  const [, , width = 0, height = 0] = box
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return width > 0 && height > 0 ? { width, height } : { width: 800, height: 600 }
}

/** The app's colors, read from its tokens, so the drawing follows the theme; the fallbacks are the light and dark tokens of app.css. */
function themeVariables(dark: boolean): Record<string, string | boolean> {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, light: string, night: string) => style.getPropertyValue(name).trim() || (dark ? night : light)
  const fg = token('--fg', '#1f2328', '#f0f6fc')
  const bg = token('--bg', '#ffffff', '#0d1117')
  const subtle = token('--bg-subtle', '#f6f8fa', '#151b23')
  const border = token('--border', '#d1d9e0', '#3d444d')
  const accent = token('--accent', '#0969da', '#4493f8')
  // Sections of the radial map and the timeline: the soft tones of the app, never the rainbow of Mermaid.
  const soft = [
    token('--acc1-soft', '#ddf4ff', '#12243d'),
    token('--acc4-soft', '#e1f2ef', '#12302b'),
    token('--acc3-soft', '#eceefc', '#23264a'),
    token('--acc2-soft', '#fbe9e6', '#3a1d1a'),
    token('--warn-soft', '#fff8c5', '#342a0b'),
    token('--ok-soft', '#dafbe1', '#12301b'),
  ]
  const peers = [
    token('--acc1', '#0969da', '#4493f8'),
    token('--acc4', '#1d6f63', '#4fb8a6'),
    token('--acc3', '#5e6ad2', '#8d95f2'),
    token('--acc2', '#b8433a', '#f07a6e'),
    token('--warn', '#9a6700', '#d29922'),
    token('--ok', '#1a7f37', '#3fb950'),
  ]
  const scale: Record<string, string> = {}
  for (let index = 0; index < 12; index++) {
    scale[`cScale${index}`] = soft[index % soft.length]
    scale[`cScalePeer${index}`] = peers[index % peers.length]
    // the line under a timeline item: the strong tone of its section, not Mermaid's inverted one
    scale[`cScaleInv${index}`] = peers[index % peers.length]
    scale[`cScaleLabel${index}`] = fg
  }
  return {
    darkMode: dark,
    background: bg,
    fontFamily: token('--sys', 'system-ui, sans-serif', 'system-ui, sans-serif'),
    fontSize: '14px',
    primaryColor: subtle,
    primaryTextColor: fg,
    primaryBorderColor: border,
    secondaryColor: token('--accent-soft', '#ddf4ff', '#12243d'),
    tertiaryColor: token('--bg-muted', '#eef1f4', '#1b222c'),
    mainBkg: subtle,
    nodeBorder: border,
    textColor: fg,
    lineColor: token('--fg-faint', '#818b98', '#6e7781'),
    clusterBkg: token('--bg-muted', '#eef1f4', '#1b222c'),
    clusterBorder: token('--border-muted', '#e4e8ec', '#262c36'),
    titleColor: fg,
    edgeLabelBackground: bg,
    git0: accent,
    // the label on the accent root: the page color, so it reads in dark too (white on the light accent is 3:1)
    gitBranchLabel0: bg,
    ...scale,
  }
}

/** Light or dark, following the app's choice and, on "Sistema", the device. */
function useDark(): boolean {
  const [dark, setDark] = useState(isDarkTheme)
  useEffect(() => {
    const update = () => setDark(isDarkTheme())
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', update)
    const watch = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update)
    watch?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => {
      media?.removeEventListener?.('change', update)
      watch?.disconnect()
    }
  }, [])
  return dark
}

/** The map as a nested list: what a screen reader reads, and what shows when Mermaid cannot draw. */
function Outline({ root, lit, shown }: { root: MapNode; lit: Set<string>; shown: boolean }) {
  const item = (node: MapNode, path: string): ReactNode => (
    <li key={path}>
      <span className={lit.has(node.id) ? HIGHLIGHT_CLASS : undefined}>{labelOf(node)}</span>
      {lit.has(node.id) && <span className="sr-only"> (mudou)</span>}
      {node.children.length > 0 && <ul>{node.children.map((child, index) => item(child, `${path}.${index}`))}</ul>}
    </li>
  )
  return (
    <ul className={shown ? 'map-outline' : 'map-outline sr-only'} aria-label="Itens do mapa">
      {item(root, '0')}
    </ul>
  )
}

interface MapViewProps {
  diagram: MapDiagram
  /** Ids of the nodes changed by the last request: they blink. */
  highlight?: string[]
  /** Buttons that go on the left of the zoom, in the same bar. */
  tools?: ReactNode
}

export function MapView({ diagram, highlight, tools }: MapViewProps) {
  const dark = useDark()
  const narrow = useIsNarrow()
  const code = useMemo(() => mapToMermaid(diagram, highlight ?? []), [diagram, highlight])
  const lit = useMemo(() => new Set(highlight ?? []), [highlight])
  const [drawing, setDrawing] = useState<{
    svg: string
    width: number
    height: number
  } | null>(null)
  const [failed, setFailed] = useState(false)
  // The same object while the drawing is the same: a new one would make React write the SVG again on every zoom step.
  const html = useMemo(() => (drawing ? { __html: drawing.svg } : undefined), [drawing])
  const [zoom, setZoom] = useState(1)
  const [fitted, setFitted] = useState(true)
  const canvas = useRef<HTMLDivElement>(null)
  const art = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const fittedRef = useRef(fitted)
  fittedRef.current = fitted
  /** Where the point under the cursor (or the middle) was before a zoom, to keep it there after. */
  const anchor = useRef<{
    x: number
    y: number
    px: number
    py: number
    ratio: number
  } | null>(null)
  /** On the phone, until the first drawing shows: it opens legible on the center instead of fitted (FR-054). */
  const reading = useRef(narrow)
  const centering = useRef(false)

  // The old drawing stays until the new one is ready, so a change does not blink the whole map.
  useEffect(() => {
    let alive = true
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: 'base',
          themeVariables: themeVariables(dark),
        })
        const { svg } = await mermaid.render(`map-view-${++renders}`, code)
        if (!alive) return
        setDrawing({ svg, ...sizeOf(svg) })
        setFailed(false)
      })
      .catch(() => {
        if (!alive) return
        setDrawing(null)
        setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [code, dark])

  const fitZoom = useCallback(() => {
    const box = canvas.current
    if (!box || !drawing) return 1
    const width = box.clientWidth - PAD * 2
    const height = box.clientHeight - PAD * 2
    if (width <= 0 || height <= 0) return 1
    return clamp(Math.min(width / drawing.width, height / drawing.height, FIT_MAX))
  }, [drawing])

  useLayoutEffect(() => {
    if (!fitted) return
    const fit = fitZoom()
    if (reading.current && drawing) {
      reading.current = false
      if (fit < READ_ZOOM) {
        centering.current = true
        setFitted(false)
        setZoom(READ_ZOOM)
        return
      }
    }
    setZoom(fit)
  }, [fitted, fitZoom, drawing])

  // A narrower window or the chat opening: a fitted map fits again.
  useEffect(() => {
    const box = canvas.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(() => fittedRef.current && setZoom(fitZoom()))
    watch.observe(box)
    return () => watch.disconnect()
  }, [fitZoom])

  // Mermaid's SVG gets the size of the zoom, so the canvas scrolls over the real drawing.
  useLayoutEffect(() => {
    const svg = art.current?.querySelector('svg')
    if (!svg || !drawing) return
    svg.removeAttribute('style')
    svg.setAttribute('width', String(Math.round(drawing.width * zoom)))
    svg.setAttribute('height', String(Math.round(drawing.height * zoom)))
    const box = canvas.current
    const kept = anchor.current
    anchor.current = null
    if (box && kept) {
      box.scrollLeft = kept.x * kept.ratio - kept.px
      box.scrollTop = kept.y * kept.ratio - kept.py
    }
    // the reading view: the center of the map in the middle of the screen (the browser stops the scroll at the edges)
    if (box && centering.current && zoom === READ_ZOOM) {
      centering.current = false
      const center = svg.querySelector(CENTER)
      if (!center) return
      const where = center.getBoundingClientRect()
      const frame = box.getBoundingClientRect()
      box.scrollLeft += where.left + where.width / 2 - frame.left - box.clientWidth / 2
      box.scrollTop += where.top + where.height / 2 - frame.top - box.clientHeight / 2
    }
  }, [drawing, zoom])

  const zoomTo = useCallback((next: number, at?: { x: number; y: number }) => {
    const box = canvas.current
    const target = clamp(next)
    if (box) {
      const rect = box.getBoundingClientRect()
      const px = at ? at.x - rect.left : box.clientWidth / 2
      const py = at ? at.y - rect.top : box.clientHeight / 2
      anchor.current = {
        x: box.scrollLeft + px,
        y: box.scrollTop + py,
        px,
        py,
        ratio: target / zoomRef.current,
      }
    }
    setFitted(false)
    setZoom(target)
  }, [])

  // Ctrl + wheel, which is also the trackpad pinch, zooms where the cursor is; the plain wheel scrolls.
  useEffect(() => {
    const box = canvas.current
    if (!box) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      zoomTo(zoomRef.current * Math.exp(-event.deltaY / 300), {
        x: event.clientX,
        y: event.clientY,
      })
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [zoomTo, drawing])

  // One finger or the mouse drags the map around; two fingers pinch; a double tap zooms in where it was, or fits the map again.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number; zoom: number } | null>(null)
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  const doubleTap = (at: { x: number; y: number }) => {
    if (fittedRef.current || zoomRef.current < READ_ZOOM) zoomTo(Math.max(READ_ZOOM, zoomRef.current * 2), at)
    else setFitted(true)
  }
  const spread = () => {
    const [one, other] = [...pointers.current.values()]
    return Math.hypot(one.x - other.x, one.y - other.y) || 1
  }
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    })
    event.currentTarget.classList.add('dragging')
    if (pointers.current.size === 2) pinch.current = { distance: spread(), zoom: zoomRef.current }
    // only a lone finger taps: a pinch is never half of a double tap
    press.current = event.pointerType === 'touch' && pointers.current.size === 1 ? { x: event.clientX, y: event.clientY, moved: false } : null
    if (pointers.current.size > 1) lastTap.current = null
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(event.pointerId)
    if (!last) return
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    })
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > TAP_SLOP) press.current.moved = true
    if (pinch.current && pointers.current.size === 2) {
      const [one, other] = [...pointers.current.values()]
      zoomTo((pinch.current.zoom * spread()) / pinch.current.distance, {
        x: (one.x + other.x) / 2,
        y: (one.y + other.y) / 2,
      })
      return
    }
    event.currentTarget.scrollLeft -= event.clientX - last.x
    event.currentTarget.scrollTop -= event.clientY - last.y
  }
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return
    if (pointers.current.size < 2) pinch.current = null
    if (!pointers.current.size) event.currentTarget.classList.remove('dragging')
    const tapped = event.type === 'pointerup' && press.current && !press.current.moved && !pointers.current.size
    press.current = null
    if (!tapped || !drawing) return
    const now = performance.now()
    const last = lastTap.current
    const at = { x: event.clientX, y: event.clientY }
    if (last && now - last.at < DOUBLE_TAP_MS && Math.hypot(at.x - last.x, at.y - last.y) < DOUBLE_TAP_PX) {
      lastTap.current = null
      doubleTap(at)
    } else lastTap.current = { at: now, ...at }
  }

  const percent = Math.round(zoom * 100)
  return (
    <div className="map-view">
      <div className="map-tools">
        {tools}
        <span className="grow" />
        {!failed && (
          <span className="map-zoom" role="group" aria-label="Zoom do mapa">
            <button className="ibtn" aria-label="Diminuir" title="Diminuir" disabled={!drawing || zoom <= MIN_ZOOM} onClick={() => zoomTo(zoom / STEP)}>
              <span className="map-minus" aria-hidden="true">
                −
              </span>
            </button>
            <span className="map-pct">{percent}%</span>
            <button className="ibtn" aria-label="Aumentar" title="Aumentar" disabled={!drawing || zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom * STEP)}>
              <Icon name="plus" />
            </button>
            <button className="btn quiet" aria-label="Ajustar à tela" title="Ajustar à tela" aria-pressed={fitted} disabled={!drawing} onClick={() => (fitted ? setZoom(fitZoom()) : setFitted(true))}>
              Ajustar
            </button>
          </span>
        )}
      </div>
      {failed ? (
        <div className="map-failed">
          <div className="banner" role="status">
            <Icon name="warn" />
            <span>Não consegui desenhar este mapa. Os itens estão em lista.</span>
          </div>
        </div>
      ) : (
        <div ref={canvas} className="map-canvas" role="img" aria-label="Desenho do mapa" tabIndex={0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
          {html ? (
            <div className="map-stage">
              <div ref={art} className="map-art" dangerouslySetInnerHTML={html} />
            </div>
          ) : (
            <div className="map-wait">
              <Icon name="sync" className="spinning" />
              Desenhando o mapa…
            </div>
          )}
        </div>
      )}
      <Outline root={diagram.root} lit={lit} shown={failed} />
    </div>
  )
}
