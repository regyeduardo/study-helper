import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const renderMarkdown = vi.fn()
const mermaidRender = vi.fn()
const mermaidInitialize = vi.fn()

vi.mock('@/controllers/github.controller', () => ({ renderMarkdownController: (...args: unknown[]) => renderMarkdown(...args) }))
vi.mock('mermaid', () => ({ default: { initialize: (...args: unknown[]) => mermaidInitialize(...args), render: (...args: unknown[]) => mermaidRender(...args) } }))

import { paperDocument, printMarkdownAsPdf } from '@/lib/exports/pdf'

interface CapturedFrame {
  srcdoc: string
  print: ReturnType<typeof vi.fn>
}

const MERMAID_BLOCK = '<div class="highlight highlight-source-mermaid"><pre>graph TD\nA--&gt;B</pre></div>'

function captureFrames(): CapturedFrame[] {
  const frames: CapturedFrame[] = []
  const print = vi.fn()
  Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', {
    configurable: true,
    get(this: HTMLIFrameElement & { captured?: string }) {
      return this.captured ?? ''
    },
    set(this: HTMLIFrameElement & { captured?: string }, value: string) {
      this.captured = value
      frames.push({ srcdoc: value, print })
      queueMicrotask(() => this.onload?.(new Event('load')))
    },
  })
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get() {
      return { document: { fonts: { ready: Promise.resolve() } }, focus: vi.fn(), print }
    },
  })
  return frames
}

describe('pdf export', () => {
  let frames: CapturedFrame[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    renderMarkdown.mockReset()
    mermaidRender.mockReset()
    mermaidInitialize.mockReset()
    frames = captureFrames()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('replaces mermaid blocks with rendered svg diagrams and prints the paper', async () => {
    renderMarkdown.mockResolvedValue(`<h2>Flow</h2>${MERMAID_BLOCK}<p>After diagram</p>`)
    mermaidRender.mockResolvedValue({ svg: '<svg id="rendered-diagram"><g><text>A</text></g></svg>' })

    await printMarkdownAsPdf('## Flow\n\n```mermaid\ngraph TD\nA-->B\n```\n\nAfter diagram', 'Lesson <One>', 'gh-token')

    expect(renderMarkdown).toHaveBeenCalledWith(expect.stringContaining('```mermaid'), 'gh-token')
    expect(mermaidRender).toHaveBeenCalledTimes(1)
    expect(mermaidRender.mock.calls[0][1]).toBe('graph TD\nA-->B')
    expect(frames).toHaveLength(1)
    const doc = new DOMParser().parseFromString(frames[0].srcdoc, 'text/html')
    expect(doc.querySelector('.pdf-diagrama svg#rendered-diagram')).not.toBeNull()
    expect(doc.querySelector('.highlight-source-mermaid')).toBeNull()
    expect(doc.querySelector('h1.paper-title')?.textContent).toBe('Lesson <One>')
    expect(doc.querySelector('h2')?.textContent).toBe('Flow')
    expect(doc.body.textContent).toContain('After diagram')
    expect(doc.querySelector('style')?.textContent).toContain('@page')
    expect(frames[0].print).toHaveBeenCalledTimes(1)
  })

  it('keeps the code block when a diagram fails to render', async () => {
    renderMarkdown.mockResolvedValue(`${MERMAID_BLOCK}${MERMAID_BLOCK}`)
    mermaidRender.mockRejectedValueOnce(new Error('bad syntax')).mockResolvedValueOnce({ svg: '<svg id="second"></svg>' })

    await printMarkdownAsPdf('x', 'T', '')

    const doc = new DOMParser().parseFromString(frames[0].srcdoc, 'text/html')
    expect(doc.querySelectorAll('.highlight-source-mermaid')).toHaveLength(1)
    expect(doc.querySelector('.pdf-diagrama svg#second')).not.toBeNull()
  })

  it('does not load mermaid when there is no diagram', async () => {
    renderMarkdown.mockResolvedValue('<p>Plain</p>')
    await printMarkdownAsPdf('Plain', 'Plain title', '')
    expect(mermaidInitialize).not.toHaveBeenCalled()
    expect(frames[0].srcdoc).toContain('<p>Plain</p>')
  })

  it('builds an escaped paper document with the date', () => {
    const html = paperDocument('<p>x</p>', 'A & "B"', new Date(2026, 0, 15))
    expect(html).toContain('<h1 class="paper-title">A &amp; &quot;B&quot;</h1>')
    expect(html).toContain('<p class="paper-date">15/01/2026</p>')
    expect(html.startsWith('<!doctype html>')).toBe(true)
  })
})
