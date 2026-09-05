import { Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import MDEditor from '@uiw/react-md-editor'
import { splitMarkdown } from '@/components/output/MarkdownViewer'

/**
 * PDF export — renders the lesson markdown off-screen on a light background
 * (mermaid blocks become inline SVG, like in the viewer), rasterizes it with
 * html2canvas and slices the bitmap into A4 pages with jsPDF.
 *
 * The heavy deps (jspdf, html2canvas) are imported dynamically so they only
 * load when the user actually exports.
 */

/** Off-screen render width, in CSS pixels. Drives the text/diagram scale in the PDF. */
const RENDER_WIDTH = 820

/** A4 in millimeters, plus the page margin used on every side. */
const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = 297
const MARGIN_MM = 10

/** Renders one mermaid diagram to an SVG string. Returns null when it fails. */
async function renderMermaid(code: string): Promise<string | null> {
  const mermaid = (window as unknown as { mermaid?: { render: (id: string, code: string) => Promise<{ svg: string }> } }).mermaid
  if (!mermaid) return null

  const id = `pdf-mermaid-${Math.random().toString(36).substring(2, 11)}`
  try {
    const { svg } = await mermaid.render(id, code)
    return svg
  } catch (error) {
    console.warn('Erro ao renderizar diagrama Mermaid para o PDF:', error)
    document.getElementById(id)?.remove()
    return null
  }
}

/** Waits for the browser to paint what React just rendered. */
function nextPaint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/**
 * html2canvas needs explicit pixel dimensions on inline SVGs — without them
 * mermaid diagrams come out blank or stretched.
 */
function pinSvgSize(host: HTMLElement): void {
  // A diagram taller than one page cannot be paginated without slicing a shape, so it
  // is capped here, at render time. 12% is left over for the heading above it.
  const alturaMaxima = RENDER_WIDTH * ((A4_HEIGHT_MM - MARGIN_MM * 2) / (A4_WIDTH_MM - MARGIN_MM * 2)) * 0.88

  for (const svg of Array.from(host.querySelectorAll('svg'))) {
    const box = svg.getBoundingClientRect()
    if (!box.width || !box.height) continue
    let width = Math.min(box.width, RENDER_WIDTH - 64)
    let height = (box.height / box.width) * width
    if (height > alturaMaxima) {
      width = width * (alturaMaxima / height)
      height = alturaMaxima
    }
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    svg.style.maxWidth = '100%'
  }
}

/** Builds the off-screen node holding the rendered document. */
async function mountDocument(markdown: string): Promise<{ host: HTMLElement; unmount: () => void }> {
  const segments = splitMarkdown(markdown)
  const diagrams = await Promise.all(
    segments.map(seg => (seg.type === 'mermaid' ? renderMermaid(seg.content) : Promise.resolve(null))),
  )

  const host = document.createElement('div')
  host.setAttribute('data-color-mode', 'light')
  host.className = 'wmde-markdown-var pdf-host'

  // The library theme was not written for paper: without this, a short column such as
  // "sem dono" wraps onto two lines and inflates the height of every row.
  const estilo = document.createElement('style')
  estilo.textContent = `
    .pdf-host .wmde-markdown table {
      display: table; width: 100%; max-width: 100%;
      table-layout: auto; border-collapse: collapse; margin: 12px 0;
    }
    .pdf-host .wmde-markdown table th, .pdf-host .wmde-markdown table td {
      border: 1px solid #cbd2d9; padding: 8px 10px;
      text-align: left; vertical-align: middle;
    }
    .pdf-host .wmde-markdown table th {
      background: #eef1f4; font-weight: 600; border-bottom: 2px solid #9aa5b1;
    }
    /* Colunas curtas encolhem até o conteúdo; a primeira fica com o resto. */
    .pdf-host .wmde-markdown table th:not(:first-child),
    .pdf-host .wmde-markdown table td:not(:first-child) { width: 1%; }
    /* O zebrado da biblioteca criava faixas irregulares entre linhas de alturas diferentes. */
    .pdf-host .wmde-markdown table tr, .pdf-host .wmde-markdown table tr:nth-child(2n) {
      background: #ffffff;
    }
    .pdf-host .wmde-markdown table th:not(:first-child),
    .pdf-host .wmde-markdown table td:not(:first-child) { white-space: nowrap; }
  `
  // Must live outside the host: React clears the container's children when it mounts,
  // so a <style> placed inside was destroyed before it could apply to anything.
  document.head.appendChild(estilo)
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    left: '-20000px',
    width: `${RENDER_WIDTH}px`,
    padding: '32px',
    background: '#ffffff',
    color: '#111827',
    fontSize: '15px',
    lineHeight: '1.6',
    zIndex: '-1',
  })
  document.body.appendChild(host)

  const root = createRoot(host)
  root.render(
    <div data-color-mode="light">
      {segments.map((seg, i) =>
        seg.type === 'markdown' ? (
          <MDEditor.Markdown key={i} source={seg.content} style={{ background: '#ffffff', color: '#111827' }} />
        ) : diagrams[i] ? (
          <div
            key={i}
            className="pdf-diagrama"
            style={{ margin: '16px 0', textAlign: 'center' }}
            dangerouslySetInnerHTML={{ __html: diagrams[i] as string }}
          />
        ) : (
          <Fragment key={i} />
        ),
      )}
    </div>,
  )

  await nextPaint()
  if (document.fonts?.ready) await document.fonts.ready
  pinSvgSize(host)
  await nextPaint()

  return { host, unmount: () => { root.unmount(); host.remove(); estilo.remove() } }
}

/**
 * Exports the given markdown as a PDF download.
 *
 * @param markdown lesson content, with mermaid diagrams in ```mermaid blocks
 * @param filename file name without the .pdf extension
 */
export async function exportMarkdownToPdf(markdown: string, filename: string): Promise<void> {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ])

  const { host, unmount } = await mountDocument(markdown)

  try {
    const ESCALA = 2
    const canvas = await html2canvas(host, {
      scale: ESCALA,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: RENDER_WIDTH,
    })

    const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
    const contentWidthMm = A4_WIDTH_MM - MARGIN_MM * 2
    const contentHeightMm = A4_HEIGHT_MM - MARGIN_MM * 2
    // Pixels of the source bitmap that fit on one page.
    const pageHeightPx = Math.floor((contentHeightMm / contentWidthMm) * canvas.width)

    // Bottom edge of each block, in bitmap pixels. Cutting a page here instead of at a
    // fixed interval is what stops a line of text or a diagram from being sliced in half.
    const topoHost = host.getBoundingClientRect().top
    const fundo = (el: Element) => Math.round((el.getBoundingClientRect().bottom - topoHost) * ESCALA)
    // A diagram is indivisible: a boundary landing inside one would slice a shape in half.
    const faixasAtomicas = [...host.querySelectorAll('.pdf-diagrama')].map(el => ({
      topo: Math.round((el.getBoundingClientRect().top - topoHost) * ESCALA),
      base: fundo(el),
    }))
    const bordas = [...host.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,table,pre,blockquote,hr,.pdf-diagrama')]
      .map(fundo)
      .filter(borda => borda > 0 && !faixasAtomicas.some(f => borda > f.topo + 1 && borda < f.base - 1))
      .sort((a, b) => a - b)

    for (let offset = 0, page = 0; offset < canvas.height; page++) {
      const limite = offset + pageHeightPx
      const corte = bordas.filter(borda => borda > offset && borda <= limite).pop()
      const proxima = bordas.find(borda => borda > offset)
      // Block taller than a whole page (a big diagram): it goes in scaled down instead
      // of being sliced through the middle of a shape.
      const blocoGigante = corte === undefined && proxima !== undefined && proxima - offset > pageHeightPx
      const sliceHeight = blocoGigante
        ? Math.min(proxima - offset, canvas.height - offset)
        : Math.min((corte ?? limite) - offset, canvas.height - offset)

      const slice = document.createElement('canvas')
      slice.width = canvas.width
      slice.height = sliceHeight
      const ctx = slice.getContext('2d')
      if (!ctx) break
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, slice.width, slice.height)
      ctx.drawImage(canvas, 0, offset, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)

      if (page > 0) pdf.addPage()
      const alturaMm = (sliceHeight / canvas.width) * contentWidthMm
      const escala = blocoGigante ? Math.min(1, contentHeightMm / alturaMm) : 1
      const larguraFinal = contentWidthMm * escala
      pdf.addImage(
        slice.toDataURL('image/jpeg', 0.92),
        'JPEG',
        MARGIN_MM + (contentWidthMm - larguraFinal) / 2,
        MARGIN_MM,
        larguraFinal,
        alturaMm * escala,
      )
      offset += sliceHeight
    }

    pdf.save(`${filename}.pdf`)
  } finally {
    unmount()
  }
}
