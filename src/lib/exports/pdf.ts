import { renderMarkdownController } from '@/controllers/github.controller'

const PAPER_STYLE = `
@page { size: A4; margin: 18mm 16mm; @bottom-right { content: counter(page) "/" counter(pages); font: 8pt "Liberation Sans", Arial, sans-serif; color: #6b7280; } }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
body { margin: 0; background: #fff; color: #111827; font: 11pt/1.55 "Liberation Sans", Arial, Helvetica, sans-serif; }
h1.paper-title { font-size: 20pt; line-height: 1.2; margin: 0 0 3mm; }
p.paper-date { margin: 0 0 10mm; color: #6b7280; font-size: 9pt; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; margin: 7mm 0 2.5mm; line-height: 1.25; }
p, li { orphans: 3; widows: 3; }
ul, ol { padding-left: 6mm; }
table { width: 100%; border-collapse: collapse; margin: 4mm 0; font-size: 10pt; }
thead { display: table-header-group; }
tr, pre, blockquote, img, svg, .pdf-diagrama { break-inside: avoid; }
th, td { border: 1px solid #cbd5e1; padding: 2mm 2.5mm; text-align: left; vertical-align: top; }
th { background: #f1f5f9; font-weight: 600; }
img, svg { max-width: 100%; height: auto; }
.pdf-diagrama { margin: 5mm 0; text-align: center; }
.pdf-diagrama svg { max-height: 200mm; }
pre { background: #f8fafc; border: 1px solid #e2e8f0; padding: 3mm; white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-family: "Liberation Mono", monospace; font-size: 9.5pt; }
a { color: #1d4ed8; text-decoration: none; }
a.anchor, .octicon-link { display: none; }
.markdown-alert { border-left: 3px solid #94a3b8; padding: 1mm 4mm; margin: 4mm 0; }
.markdown-alert-title { font-weight: 600; display: flex; gap: 2mm; align-items: center; }
`

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
}

async function withDiagrams(html: string): Promise<string> {
  const holder = document.createElement('div')
  holder.innerHTML = html
  const blocks = [...holder.querySelectorAll('.highlight-source-mermaid')]
  if (!blocks.length) return html
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' })
  for (const [index, block] of blocks.entries()) {
    const code = block.querySelector('pre')?.textContent ?? ''
    try {
      const { svg } = await mermaid.render(`pdf-diagram-${index}-${Date.now()}`, code)
      const figure = document.createElement('div')
      figure.className = 'pdf-diagrama'
      figure.innerHTML = svg
      block.replaceWith(figure)
    } catch {
      continue
    }
  }
  return holder.innerHTML
}

export function paperDocument(html: string, title: string, today = new Date()): string {
  const date = today.toLocaleDateString('pt-BR')
  const header = title ? `<h1 class="paper-title">${escapeHtml(title)}</h1><p class="paper-date">${date}</p>` : ''
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PAPER_STYLE}</style></head><body>${header}${html}</body></html>`
}

export async function printMarkdownAsPdf(markdown: string, title: string, githubToken: string): Promise<void> {
  const html = await withDiagrams(await renderMarkdownController(markdown, githubToken))
  const frame = document.createElement('iframe')
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' })
  document.body.appendChild(frame)
  await new Promise<void>(resolve => {
    frame.onload = () => resolve()
    frame.srcdoc = paperDocument(html, title)
  })
  const view = frame.contentWindow!
  await view.document.fonts?.ready
  view.focus()
  view.print()
  setTimeout(() => frame.remove(), 60000)
}
