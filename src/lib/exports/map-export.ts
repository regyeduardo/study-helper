// Exports a map: the SVG Mermaid draws, a PNG of that SVG and the Mermaid code.
import type { MapArtifact } from '@/types/domain'
import { mapToMermaid } from '@/lib/generation/map-render'
import { downloadBlob, safeFilename } from '@/utils/download'

const PNG_SCALE = 2
/** Safari refuses a canvas above ~16.7 million pixels: a huge map comes out smaller instead of blank. */
const MAX_PIXELS = 16_000_000
const FALLBACK = { width: 800, height: 600 }

let renders = 0

/** The map's Mermaid code, as copied: without the blink of the last request. */
export function mapCode(map: MapArtifact): string {
  return mapToMermaid(map.diagram)
}

function viewBoxSize(root: string): { width: number; height: number } | null {
  const [, , width = 0, height = 0] = (/viewBox="([^"]*)"/.exec(root)?.[1] ?? '').trim().split(/[\s,]+/).map(Number)
  return width > 0 && height > 0 ? { width, height } : null
}

/** Mermaid writes width="100%": an image, and so the canvas, needs the real size from the viewBox. */
function sized(svg: string): { svg: string; width: number; height: number } {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0]
  const size = root ? viewBoxSize(root) : null
  if (!root || !size) return { svg, ...FALLBACK }
  const tag = root.replace(/\s(width|height)="[^"]*"/g, '').replace(/^<svg/, `<svg width="${size.width}" height="${size.height}"`)
  return { svg: svg.replace(root, () => tag), ...size }
}

/** Light theme, and text as SVG text: HTML labels (foreignObject) would taint the canvas and the PNG could not be read back. */
export async function mapSvg(map: MapArtifact): Promise<string> {
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false })
  const { svg } = await mermaid.render(`map-export-${++renders}`, mapCode(map))
  return sized(svg).svg
}

function loaded(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Não consegui desenhar o mapa em PNG.'))
    image.src = src
  })
}

/** On white, since a transparent map is unreadable in a dark viewer; twice the size, so it stays sharp. */
export async function svgToPng(svg: string): Promise<Blob> {
  const drawn = sized(svg)
  const scale = Math.min(PNG_SCALE, Math.sqrt(MAX_PIXELS / (drawn.width * drawn.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(drawn.width * scale)
  canvas.height = Math.floor(drawn.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Este navegador não gera PNG. Baixe em SVG.')
  const image = await loaded(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawn.svg)}`)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Não consegui gerar o PNG do mapa.'))), 'image/png'))
}

export async function downloadMap(map: MapArtifact, format: 'svg' | 'png'): Promise<void> {
  const svg = await mapSvg(map)
  const blob = format === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await svgToPng(svg)
  downloadBlob(blob, `${safeFilename(map.name)}.${format}`)
}

export async function copyMapCode(map: MapArtifact): Promise<void> {
  if (!navigator.clipboard) throw new Error('Este navegador não deixou copiar.')
  await navigator.clipboard.writeText(mapCode(map))
}
