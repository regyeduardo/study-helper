import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MapArtifact } from '@/types/domain'
import { newMapArtifact } from '@/lib/artifacts'
import { copyMapCode, downloadMap, mapCode, mapSvg, svgToPng } from '@/lib/exports/map-export'
import { HIGHLIGHT_CLASS, mapToMermaid } from '@/lib/generation/map-render'
import { readBlob } from '@/test/storage/fake-drive'
import { downloadBlob } from '@/utils/download'

// jsdom has no layout (no getBBox), so the real Mermaid cannot draw here: this one hands back an SVG shaped like Mermaid's.
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, code: string) => ({ svg: `<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 400px;" viewBox="0 0 400 200"><text>${code.split('\n').length}</text></svg>` })),
}))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('@/utils/download', async original => ({ ...(await original<typeof import('@/utils/download')>()), downloadBlob: vi.fn() }))

const svgOf = (width: number, height: number) => `<svg id="m" width="100%" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><g/></svg>`

function map(): MapArtifact {
  const diagram: MapArtifact['diagram'] = { form: 'arvore', root: { id: 'r', text: 'Limites', children: [{ id: 'a', text: 'Laterais: "esquerda" e [direita]', children: [] }] } }
  return { ...newMapArtifact({ name: 'Limites / continuidade', diagram }), highlight: ['a'] }
}

/** jsdom draws nothing on a canvas: the fake records what was drawn, in order. */
function fakeCanvas(context: object | null = {}) {
  const steps: string[] = []
  const images: string[] = []
  const drawing = context && {
    fillStyle: '',
    fillRect(_x: number, _y: number, width: number, height: number) {
      steps.push(`fundo ${this.fillStyle} ${width}x${height}`)
    },
    drawImage(image: { src: string }, _x: number, _y: number, width: number, height: number) {
      images.push(image.src)
      steps.push(`mapa ${width}x${height}`)
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(drawing as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback) {
    done(new Blob([`${this.width}x${this.height}`], { type: 'image/png' }))
  })
  return { steps, images }
}

class LoadingImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private url = ''
  get src() {
    return this.url
  }
  set src(value: string) {
    this.url = value
    queueMicrotask(() => this.onload?.())
  }
}

beforeEach(() => {
  vi.stubGlobal('Image', LoadingImage)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.mocked(downloadBlob).mockClear()
})

describe('código Mermaid', () => {
  it('é o do mapa, sem o piscar do último pedido', () => {
    const one = map()
    expect(mapToMermaid(one.diagram, one.highlight)).toContain(HIGHLIGHT_CLASS)
    expect(mapCode(one)).toBe(mapToMermaid(one.diagram))
    expect(mapCode(one)).not.toContain(HIGHLIGHT_CLASS)
  })

  it('copiar entrega esse código', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await copyMapCode(map())
    expect(writeText).toHaveBeenCalledWith(mapCode(map()))
  })
})

describe('SVG', () => {
  it('sai do desenho do Mermaid, com o texto em SVG e tamanho fixo', async () => {
    const svg = await mapSvg(map())
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), mapCode(map()))
    // HTML labels (foreignObject) would taint the canvas and the PNG could not be read back
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ htmlLabels: false }))
    expect(svg).toMatch(/^<svg width="400" height="200" id="m"/)
    expect(svg).not.toContain('width="100%"')
  })

  it('baixa como .svg com o nome do mapa', async () => {
    await downloadMap(map(), 'svg')
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0]
    expect(filename).toBe('Limites - continuidade.svg')
    expect(blob.type).toBe('image/svg+xml')
    expect(await readBlob(blob)).toContain('width="400" height="200"')
  })
})

describe('PNG', () => {
  it('é o SVG desenhado num canvas, sobre fundo branco, no dobro do tamanho', async () => {
    const { steps, images } = fakeCanvas()
    const png = await svgToPng(svgOf(400, 200))
    expect(png.type).toBe('image/png')
    expect(await readBlob(png)).toBe('800x400')
    expect(steps).toEqual(['fundo #ffffff 800x400', 'mapa 800x400'])
    expect(images[0]).toMatch(/^data:image\/svg\+xml/)
    expect(decodeURIComponent(images[0])).toContain('<svg width="400" height="200"')
  })

  it('um mapa enorme sai menor, na mesma proporção, para o navegador não recusar o canvas', async () => {
    fakeCanvas()
    const [width, height] = (await readBlob(await svgToPng(svgOf(6000, 4000)))).split('x').map(Number)
    expect(width * height).toBeLessThanOrEqual(16_000_000)
    expect(width / height).toBeCloseTo(1.5, 2)
  })

  it('baixa como .png com o nome do mapa', async () => {
    fakeCanvas()
    await downloadMap(map(), 'png')
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0]
    expect(filename).toBe('Limites - continuidade.png')
    expect(blob.type).toBe('image/png')
  })

  it('sem canvas, avisa em vez de baixar um arquivo vazio', async () => {
    fakeCanvas(null)
    await expect(downloadMap(map(), 'png')).rejects.toThrow('Este navegador não gera PNG. Baixe em SVG.')
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})
