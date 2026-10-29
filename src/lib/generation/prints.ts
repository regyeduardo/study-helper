// Prints of the Ata: a still from the video with red boxes, numbered labels and a caption bar.
// Built as SVG (pure, testable) and turned into a JPEG through a canvas.
import type { Mark } from '@/lib/generation/ata-types'

const BASE_WIDTH = 1280
const RED = '#ff2828'
const FONT = 'sans-serif'

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
const esc = (s: string) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attr = (s: string) => esc(s).replace(/"/g, '&quot;')
const num = (v: number) => String(Math.round(v * 100) / 100)

function wrap(text: string, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of String(text ?? '').split(/\s+/)) {
    if (!word) continue
    const next = line ? `${line} ${word}` : word
    if (next.length > max && line) {
      out.push(line)
      line = word
    } else line = next
  }
  if (line) out.push(line)
  return out
}

const isValid = (mark: Mark) => !!mark && Array.isArray(mark.box) && mark.box.length === 4 && mark.box.every(v => typeof v === 'number' && Number.isFinite(v))

/** Height of the dark caption bar under the image, for a print `width` px wide. */
export function captionBarHeight(caption: string, width: number): number {
  const k = width / BASE_WIDTH
  return Math.round((70 + 26 * Math.max(0, wrap(caption, 110).length - 1)) * k)
}

/** SVG of the print: `image` (data URL) at width × height, the marks over it and the caption bar below. */
export function annotatedSvg(image: string, marks: Mark[], caption: string, width: number, height: number): string {
  const k = width / BASE_WIDTH
  const bar = captionBarHeight(caption, width)
  const valid = (marks ?? []).filter(isValid)
  const parts: string[] = []
  const taken: number[][] = []
  const hits = (r: number[]) => taken.some(t => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1])
  const inside = (v: number) => Math.min(1000, Math.max(0, v))
  const rects = valid.map(mark => {
    const [a, b, c, d] = mark.box.map(inside)
    return [(Math.min(a, c) / 1000) * width, (Math.min(b, d) / 1000) * height, (Math.max(a, c) / 1000) * width, (Math.max(b, d) / 1000) * height]
  })
  rects.forEach(r => taken.push([r[0] - 6 * k, r[1] - 6 * k, r[2] + 6 * k, r[3] + 6 * k]))
  rects.forEach(([x1, y1, x2, y2]) => parts.push(`<rect class="marca" x="${num(x1)}" y="${num(y1)}" width="${num(Math.max(8 * k, x2 - x1))}" height="${num(Math.max(8 * k, y2 - y1))}" fill="rgba(255,40,40,0.08)" stroke="${RED}" stroke-width="${num(5 * k)}" rx="${num(6 * k)}"/>`))
  valid.forEach((mark, index) => {
    const [x1, y1, x2, y2] = rects[index]
    const n = index + 1
    const lines = wrap(mark.label, 30)
    const w = Math.min(380, 30 + 9.4 * Math.max(1, ...lines.map(l => l.length))) * k
    const h = (16 + 22 * Math.max(1, lines.length)) * k
    const clampX = (x: number) => Math.max(0, Math.min(Math.max(10 * k, x), width - w - 10 * k))
    const clampY = (y: number) => Math.max(0, Math.min(Math.max(10 * k, y), height - h - 10 * k))
    const spots = [
      [clampX(x1), clampY(y2 + 40 * k)], [clampX(x1), clampY(y1 - 40 * k - h)], [clampX(x2 + 40 * k), clampY(y1)], [clampX(x1 - 40 * k - w), clampY(y1)],
      [clampX(x1), clampY(y2 + 110 * k)], [clampX(x1), clampY(y1 - 110 * k - h)], [clampX(x2 + 40 * k), clampY(y2 + 20 * k)], [clampX(x1 - 40 * k - w), clampY(y2 + 20 * k)],
      ...Array.from({ length: 24 }, (_, i) => [clampX(x1 + (-300 + (i % 6) * 120) * k), clampY(y1 + (-200 + Math.floor(i / 6) * 120) * k)]),
    ]
    let [lx, ly] = spots[0]
    for (const [sx, sy] of spots) {
      const r = [sx - 18 * k, sy - 18 * k, sx + w + 4 * k, sy + h + 4 * k]
      if (!hits(r) && !(r[0] < x2 && r[2] > x1 && r[1] < y2 && r[3] > y1)) {
        lx = sx
        ly = sy
        break
      }
    }
    taken.push([lx - 18 * k, ly - 18 * k, lx + w + 4 * k, ly + h + 4 * k])
    const tx = Math.min(Math.max(lx + w / 2, x1 + 6 * k), x2 - 6 * k)
    const ty = ly + h / 2 < y1 ? y1 - 4 * k : ly > y2 ? y2 + 4 * k : ly + h / 2
    const fx = lx + w / 2 < x1 ? lx + w : lx + w / 2 > x2 ? lx : lx + w / 2
    const fy = ly + h / 2 < y1 ? ly + h : ly > y2 ? ly : ly + h / 2
    parts.push(`<line class="seta" x1="${num(fx)}" y1="${num(fy)}" x2="${num(tx)}" y2="${num(ty)}" stroke="${RED}" stroke-width="${num(4 * k)}" marker-end="url(#seta)"/>`)
    parts.push(`<rect class="rotulo" x="${num(lx)}" y="${num(ly)}" width="${num(w)}" height="${num(h)}" rx="${num(8 * k)}" fill="#fff" stroke="${RED}" stroke-width="${num(3 * k)}"/>`)
    parts.push(`<circle cx="${num(lx)}" cy="${num(ly)}" r="${num(16 * k)}" fill="${RED}"/><text class="selo" x="${num(lx)}" y="${num(ly + 6 * k)}" font-size="${num(17 * k)}" font-weight="700" fill="#fff" text-anchor="middle" font-family="${FONT}">${n}</text>`)
    parts.push(`<circle cx="${num(x2)}" cy="${num(y1)}" r="${num(13 * k)}" fill="${RED}"/><text class="selo" x="${num(x2)}" y="${num(y1 + 5 * k)}" font-size="${num(14 * k)}" font-weight="700" fill="#fff" text-anchor="middle" font-family="${FONT}">${n}</text>`)
    lines.forEach((line, i) => parts.push(`<text class="texto-rotulo" x="${num(lx + 18 * k)}" y="${num(ly + (30 + 22 * i) * k)}" font-size="${num(17 * k)}" fill="#111" font-family="${FONT}" font-weight="600">${esc(line)}</text>`))
  })
  const caps = wrap(caption, 110).map((line, i) => `<text class="legenda" x="${num(18 * k)}" y="${num(height + (34 + 26 * i) * k)}" font-size="${num(19 * k)}" fill="#fff" font-family="${FONT}">${esc(line)}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + bar}" viewBox="0 0 ${width} ${height + bar}"><defs><marker id="seta" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${RED}"/></marker></defs><image href="${attr(image)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"/>${parts.join('')}<rect class="barra" x="0" y="${height}" width="${width}" height="${bar}" fill="#1b1f24"/>${caps}</svg>`
}

function loadImage(src: string, message: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(message))
    img.src = src
  })
}

/** Draws the print and returns it as a JPEG data URL, width × (scaled height + captionBarHeight). */
export async function renderPrint(image: string, marks: Mark[], caption: string, options: { width?: number; quality?: number } = {}): Promise<string> {
  const photo = await loadImage(image, 'Não deu para abrir o quadro do vídeo.')
  const naturalWidth = photo.naturalWidth || photo.width
  const naturalHeight = photo.naturalHeight || photo.height
  if (!naturalWidth || !naturalHeight) throw new Error('Não deu para abrir o quadro do vídeo.')
  const width = Math.round(options.width ?? BASE_WIDTH)
  const height = Math.max(1, Math.round((width * naturalHeight) / naturalWidth))
  const total = height + captionBarHeight(caption, width)
  const svg = annotatedSvg(image, marks, caption, width, height)
  const blobUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })) : null
  try {
    const drawing = await loadImage(blobUrl ?? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, 'Não deu para desenhar o print.')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = total
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Não deu para desenhar o print.')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, total)
    ctx.drawImage(drawing, 0, 0, width, total)
    return canvas.toDataURL('image/jpeg', options.quality ?? 0.85)
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl)
  }
}
