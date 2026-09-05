import { useEffect, useRef } from 'react'
import { escapeHtml } from '@/lib/utils'
import {
  TransformWrapper,
  TransformComponent,
  useControls,
} from 'react-zoom-pan-pinch'

interface MermaidRendererProps {
  code: string
}

/**
 * ZoomControls — overlay buttons rendered inside TransformWrapper's context
 * so useControls() can access the zoom/pan state.
 */
function ZoomControls() {
  const { zoomIn, zoomOut, resetTransform } = useControls()

  return (
    <div className="absolute bottom-2 right-2 flex items-center gap-1 z-10">
      <button
        type="button"
        onClick={() => zoomIn()}
        aria-label="+"
        className="flex items-center justify-center w-8 h-8 rounded bg-white/80 text-slate-700 shadow hover:bg-white text-lg leading-none"
      >
        +
      </button>
      <button
        type="button"
        onClick={() => zoomOut()}
        aria-label="–"
        className="flex items-center justify-center w-8 h-8 rounded bg-white/80 text-slate-700 shadow hover:bg-white text-lg leading-none"
      >
        –
      </button>
      <button
        type="button"
        onClick={() => resetTransform()}
        aria-label="reset"
        className="flex items-center justify-center w-8 h-8 rounded bg-white/80 text-slate-700 shadow hover:bg-white text-xs font-medium"
      >
        reset
      </button>
    </div>
  )
}

/**
 * MermaidRenderer — renders a single Mermaid diagram as inline SVG.
 *
 * Uses IntersectionObserver (rootMargin 200px) so each diagram renders
 * only when it approaches the viewport. While the SVG isn't ready, the
 * container keeps a fixed minHeight (300px) as a skeleton.
 *
 * On render error: the container is left empty — no amber box, no
 * user-visible message. console.error stays for diagnostics.
 */
// Every diagram box is the same height, so the page reads as one system. A diagram too
// dense to read at this size is explored with the zoom controls that already exist.
const DIAGRAM_BOX_HEIGHT = 420

export default function MermaidRenderer({ code }: MermaidRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderedRef = useRef(false)
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || !code) return

    let cancelled = false
    renderedRef.current = false

    // Show skeleton immediately
    el.style.minHeight = '300px'
    el.innerHTML = ''

    const doRender = async () => {
      if (cancelled || renderedRef.current) return
      renderedRef.current = true

      let id = ''

      try {
        const mermaid = (window as any).mermaid
        if (!mermaid) {
          el.innerHTML = `<div class="text-xs text-slate-400 p-3">📊 Mermaid não disponível</div>`
          el.style.minHeight = ''
          return
        }

        mermaid.initialize({ startOnLoad: false, theme: 'default' })

        id = `mermaid-${Math.random().toString(36).substring(2, 11)}`
        const { svg } = await mermaid.render(id, code)

        if (cancelled) return

        el.innerHTML = svg
        el.style.minHeight = ''

        // Ensure SVG scales properly
        const svgEl = el.querySelector('svg')
        if (svgEl) {
          // A viewBox plus "meet" makes the diagram fit the box without distorting:
          // a small one is not stretched, a large one is not squashed.
          svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet')
          svgEl.style.maxWidth = '100%'
          svgEl.style.width = '100%'
          svgEl.style.height = '100%'
          svgEl.style.backgroundColor = 'white'
        }
      } catch (error) {
        if (cancelled) return
        const errMsg = error instanceof Error ? error.message : String(error)
        console.warn('Erro ao renderizar diagrama Mermaid:', errMsg)
        // Leave container empty — no error UI visible to the user
        el.innerHTML = ''
        // Remove any leaked mermaid error element from the DOM
        document.getElementById(id)?.remove()
        el.style.minHeight = ''
      }
    }

    // Set up IntersectionObserver — render when approaching the viewport
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          doRender()
          observer.unobserve(el)
        }
      },
      { rootMargin: '200px' },
    )

    observer.observe(el)
    observerRef.current = observer

    return () => {
      cancelled = true
      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }
    }
  }, [code])

  return (
    <TransformWrapper>
      <TransformComponent
        wrapperStyle={{ width: '100%', height: DIAGRAM_BOX_HEIGHT, margin: '1rem 0' }}
        contentStyle={{ width: '100%', height: '100%' }}
      >
        <div
          ref={containerRef}
          className="flex items-center justify-center w-full h-full mermaid-container"
        />
      </TransformComponent>
      <ZoomControls />
    </TransformWrapper>
  )
}
