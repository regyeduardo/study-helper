import { marked } from 'marked'
import { useEffect, useRef, useState } from 'react'

import type { HighlightColor } from '@/types/domain'
import { renderMarkdownController } from '@/controllers/github.controller'
import { copyButtons, headingAnchors } from '@/lib/github/chrome'
import { mountDiagrams } from '@/lib/github/diagrams'
import { APP_PALETTE } from '@/lib/github/palette'
import { useLibraryStore } from '@/stores/library'

export interface PaintedQuote {
  quote: string
  color: HighlightColor | 'explained'
  targetId?: string
}

export interface ReaderSelection {
  text: string
  rect: DOMRect
}

interface GithubMarkdownViewProps {
  markdown: string
  live?: boolean
  quotes?: PaintedQuote[]
  onSelection?: (selection: ReaderSelection | null) => void
  onQuoteClick?: (targetId: string) => void
  onHeadings?: (headings: { id: string; level: number; text: string }[]) => void
  onHeading?: (heading: ReaderSelection | null) => void
}

const HEADINGS = 'h1, h2, h3, h4, h5, h6'
const TOUCH_SELECTION_DELAY_MS = 350

function blockOf(node: Element): Element {
  return node.closest('.markdown-heading') ?? node
}

function headingLevel(block: Element): number | null {
  const heading = block.matches(HEADINGS) ? block : block.querySelector(HEADINGS)
  return heading ? Number(heading.tagName[1]) : null
}

function sectionText(heading: Element): string {
  const level = Number(heading.tagName[1])
  const parts = [heading.textContent?.trim() ?? '']
  let node = blockOf(heading).nextElementSibling
  while (node) {
    const other = headingLevel(node)
    if (other !== null && other <= level) break
    const text = node.textContent?.trim()
    if (text) parts.push(text)
    node = node.nextElementSibling
  }
  return parts.join('\n\n')
}

let sheetsPromise: Promise<string[]> | null = null

function sheetNames(): Promise<string[]> {
  if (!sheetsPromise) {
    sheetsPromise = fetch(`${import.meta.env.BASE_URL}gh-viewer/css.json`)
      .then(response => response.json() as Promise<string[]>)
      .catch(() => [])
  }
  return sheetsPromise
}

function paint(root: ShadowRoot, sheets: string[], html: string): HTMLElement {
  root.innerHTML = ''
  for (const name of sheets) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `${import.meta.env.BASE_URL}gh-viewer/css/${name}`
    root.appendChild(link)
  }
  const palette = document.createElement('style')
  palette.textContent = APP_PALETTE
  root.appendChild(palette)
  const theme = document.createElement('div')
  theme.className = 'js-snippet-clipboard-copy-unpositioned'
  theme.setAttribute('data-color-mode', 'dark')
  theme.setAttribute('data-dark-theme', 'dark')
  theme.setAttribute('data-a11y-link-underlines', 'true')
  const article = document.createElement('article')
  article.className = 'markdown-body entry-content'
  article.innerHTML = html
  theme.appendChild(article)
  root.appendChild(theme)
  return article
}

function clearMarks(container: HTMLElement): void {
  for (const mark of Array.from(container.querySelectorAll('mark[data-quote]'))) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    parent.normalize()
  }
}

function markQuote(container: HTMLElement, quote: PaintedQuote): void {
  const text = quote.quote.trim()
  if (text.length < 3) return
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest('pre, code, mark')) continue
    const index = node.data.indexOf(text)
    if (index < 0) continue
    const middle = node.splitText(index)
    middle.splitText(text.length)
    const mark = document.createElement('mark')
    mark.className = `hl-${quote.color}`
    mark.dataset.quote = 'true'
    if (quote.targetId) mark.dataset.target = quote.targetId
    mark.textContent = middle.data
    middle.parentNode?.replaceChild(mark, middle)
    return
  }
}

export default function GithubMarkdownView({ markdown, live = false, quotes = [], onSelection, onQuoteClick, onHeadings, onHeading }: GithubMarkdownViewProps) {
  const githubToken = useLibraryStore(state => state.index.settings.githubToken)
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement | null>(null)
  const [painted, setPainted] = useState(0)

  useEffect(() => {
    let current = true
    setError('')
    if (live) {
      setHtml(marked.parse(markdown.replace(/<!-- diagram:\d+ -->/g, '_Desenhando o diagrama…_'), { async: false }) as string)
      return
    }
    renderMarkdownController(markdown, githubToken)
      .then(rendered => current && setHtml(rendered))
      .catch(failure => {
        if (!current) return
        setError(failure instanceof Error ? failure.message : String(failure))
        setHtml(marked.parse(markdown, { async: false }) as string)
      })
    return () => {
      current = false
    }
  }, [markdown, live, githubToken])

  useEffect(() => {
    const element = host.current
    if (!element || !html) return
    let unmount = () => {}
    let alive = true
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
    void sheetNames().then(sheets => {
      if (!alive) return
      const body = paint(root, sheets, html)
      article.current = body
      headingAnchors(body)
      copyButtons(body)
      if (!live) unmount = mountDiagrams(body)
      onHeadings?.(
        [...body.querySelectorAll('h1, h2, h3')].map((heading, index) => {
          if (!heading.id) heading.id = `secao-${index}`
          return { id: heading.id, level: Number(heading.tagName[1]), text: heading.textContent?.trim() ?? '' }
        }),
      )
      setPainted(value => value + 1)
    })
    return () => {
      alive = false
      unmount()
    }
  }, [html, live])

  useEffect(() => {
    const body = article.current
    if (!body) return
    clearMarks(body)
    for (const quote of quotes) markQuote(body, quote)
  }, [quotes, painted])

  useEffect(() => {
    const element = host.current
    const root = element?.shadowRoot
    if (!element || !root || !onSelection) return
    const report = () => {
      const selection = (root as unknown as { getSelection?: () => Selection | null }).getSelection?.() ?? window.getSelection()
      const text = selection?.toString().trim() ?? ''
      if (!text || !selection?.rangeCount) {
        onSelection(null)
        return
      }
      onSelection({ text, rect: selection.getRangeAt(0).getBoundingClientRect() })
    }
    const headingAt = (event: Event) => {
      const target = event.composedPath()[0] as Element | undefined
      return target?.closest?.(HEADINGS) ?? null
    }
    const pointHeading = (event: Event) => {
      const heading = headingAt(event)
      if (heading) onHeading?.({ text: sectionText(heading), rect: heading.getBoundingClientRect() })
    }
    const click = (event: Event) => {
      const mark = (event.target as HTMLElement).closest?.('mark[data-target]') as HTMLElement | null
      if (mark?.dataset.target) onQuoteClick?.(mark.dataset.target)
      pointHeading(event)
    }
    let pending = 0
    const touchSelection = () => {
      window.clearTimeout(pending)
      pending = window.setTimeout(report, TOUCH_SELECTION_DELAY_MS)
    }
    const touch = window.matchMedia('(pointer: coarse)').matches
    root.addEventListener('mouseup', report)
    root.addEventListener('keyup', report)
    root.addEventListener('click', click)
    root.addEventListener('pointerover', pointHeading)
    if (touch) document.addEventListener('selectionchange', touchSelection)
    return () => {
      window.clearTimeout(pending)
      root.removeEventListener('mouseup', report)
      root.removeEventListener('keyup', report)
      root.removeEventListener('click', click)
      root.removeEventListener('pointerover', pointHeading)
      document.removeEventListener('selectionchange', touchSelection)
    }
  }, [onSelection, onQuoteClick, onHeading, painted])

  return (
    <>
      {error && <div className="banner" role="status">{error} Mostrando uma versão simples.</div>}
      {!html && <div className="muted" style={{ fontSize: 14 }}>Desenhando o documento pelo GitHub…</div>}
      <div ref={host} data-testid="github-viewer" />
    </>
  )
}

export function scrollToHeading(viewer: HTMLElement | null, id: string): void {
  const target = viewer?.querySelector('[data-testid="github-viewer"]')?.shadowRoot?.getElementById(id)
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
