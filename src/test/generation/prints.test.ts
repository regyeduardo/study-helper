import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Mark } from '@/lib/generation/ata-types'
import { annotatedSvg, captionBarHeight, renderPrint } from '@/lib/generation/prints'

const IMAGE = 'data:image/jpeg;base64,QUJD'

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml')
const texts = (doc: Document, cls: string) => Array.from(doc.querySelectorAll(`text.${cls}`)).map(t => t.textContent)
const boxes = (doc: Document, cls: string) => Array.from(doc.querySelectorAll(`rect.${cls}`)).map(r => ['x', 'y', 'width', 'height'].map(a => parseFloat(r.getAttribute(a) ?? 'NaN')))

describe('annotatedSvg', () => {
  it('embeds the image, one red box and numbered badges per valid mark', () => {
    const marks: Mark[] = [
      { box: [100, 100, 300, 250], label: 'Botão salvar' },
      { box: [600, 500, 800, 700], label: 'Campo de busca' },
      { box: [1, 2, 3], label: 'faltando um número' },
      { box: [1, 2, Number.NaN, 4], label: 'NaN' },
      { box: ['1', '2', '3', '4'] as unknown as number[], label: 'texto' },
    ]
    const svg = annotatedSvg(IMAGE, marks, 'Tela de cadastro.', 1280, 720)
    const doc = parse(svg)
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(svg).toContain(`href="${IMAGE}"`)
    const red = Array.from(doc.querySelectorAll('rect.marca'))
    expect(red).toHaveLength(2)
    red.forEach(r => expect(r.getAttribute('stroke')).toBe('#ff2828'))
    expect(texts(doc, 'selo').sort()).toEqual(['1', '1', '2', '2'])
    expect(texts(doc, 'texto-rotulo')).toEqual(['Botão salvar', 'Campo de busca'])
    expect(svg).not.toContain('faltando')
    expect(svg).not.toContain('NaN')
  })

  it('escapes labels and caption', () => {
    const svg = annotatedSvg(IMAGE, [{ box: [100, 100, 200, 200], label: 'Use <b>& depois' }], 'Legenda com <script> & "aspas"', 1280, 720)
    expect(svg).toContain('Use &lt;b&gt;&amp; depois')
    expect(svg).not.toContain('<b>')
    expect(svg).not.toContain('<script>')
    const doc = parse(svg)
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(texts(doc, 'texto-rotulo')).toEqual(['Use <b>& depois'])
    expect(texts(doc, 'legenda')).toEqual(['Legenda com <script> & "aspas"'])
  })

  it('wraps a long caption into several lines and grows the bar', () => {
    const caption = Array.from({ length: 60 }, (_, i) => `palavra${i}`).join(' ')
    const svg = annotatedSvg(IMAGE, [], caption, 1280, 720)
    const lines = texts(parse(svg), 'legenda')
    expect(lines.length).toBeGreaterThan(2)
    lines.forEach(line => expect(line!.length).toBeLessThanOrEqual(110))
    expect(lines.join(' ')).toBe(caption)
    expect(captionBarHeight(caption, 1280)).toBe(70 + 26 * (lines.length - 1))
    expect(captionBarHeight('curta', 1280)).toBe(70)
    expect(svg).toContain(`height="${720 + captionBarHeight(caption, 1280)}"`)
  })

  it('places labels of two close marks without overlapping them', () => {
    const marks: Mark[] = [
      { box: [100, 100, 200, 200], label: 'Primeiro item marcado na tela' },
      { box: [210, 100, 310, 200], label: 'Segundo item, logo ao lado do primeiro' },
      { box: [150, 210, 260, 300], label: 'Terceiro logo abaixo' },
    ]
    const doc = parse(annotatedSvg(IMAGE, marks, 'Três marcas juntas.', 1280, 720))
    const labels = boxes(doc, 'rotulo')
    expect(labels).toHaveLength(3)
    const overlap = (a: number[], b: number[]) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) expect(overlap(labels[i], labels[j])).toBe(false)
    const red = boxes(doc, 'marca')
    labels.forEach(l => red.forEach(r => expect(overlap(l, r)).toBe(false)))
    labels.forEach(([x, y, w, h]) => {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(1280)
      expect(y + h).toBeLessThanOrEqual(720)
    })
  })

  it('scales sizes with the width', () => {
    const marks: Mark[] = [{ box: [100, 100, 300, 300], label: 'Item' }]
    const big = parse(annotatedSvg(IMAGE, marks, 'Legenda', 1280, 720))
    const small = parse(annotatedSvg(IMAGE, marks, 'Legenda', 640, 360))
    expect(big.querySelector('rect.marca')!.getAttribute('stroke-width')).toBe('5')
    expect(small.querySelector('rect.marca')!.getAttribute('stroke-width')).toBe('2.5')
    expect(small.querySelector('text.legenda')!.getAttribute('font-size')).toBe('9.5')
    expect(captionBarHeight('Legenda', 640)).toBe(35)
    const [bx, by, bw] = boxes(big, 'rotulo')[0]
    const [sx, sy, sw] = boxes(small, 'rotulo')[0]
    expect(sx).toBeCloseTo(bx / 2, 1)
    expect(sy).toBeCloseTo(by / 2, 1)
    expect(sw).toBeCloseTo(bw / 2, 1)
  })
})

describe('renderPrint', () => {
  let fail = ''
  const loaded: string[] = []
  const createObjectURL = vi.fn((_: Blob) => 'blob:print-1')
  const revokeObjectURL = vi.fn()
  const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
  let toDataURL: ReturnType<typeof vi.fn>
  let canvasSize: number[] = []

  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 1600
    naturalHeight = 900
    width = 1600
    height = 900
    private current = ''
    get src() {
      return this.current
    }
    set src(value: string) {
      this.current = value
      loaded.push(value)
      setTimeout(() => (fail && value.includes(fail) ? this.onerror?.() : this.onload?.()), 0)
    }
  }

  class FakeURL extends URL {
    static createObjectURL = createObjectURL
    static revokeObjectURL = revokeObjectURL
  }

  beforeEach(() => {
    fail = ''
    loaded.length = 0
    canvasSize = []
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('URL', FakeURL)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    toDataURL = vi.fn(function (this: HTMLCanvasElement) {
      canvasSize = [this.width, this.height]
      return 'data:image/jpeg;base64,AAA'
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(toDataURL as unknown as HTMLCanvasElement['toDataURL'])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    ctx.fillRect.mockClear()
    ctx.drawImage.mockClear()
  })

  it('draws the svg on a canvas and returns a jpeg', async () => {
    const caption = 'Tela de cadastro com o botão salvar destacado.'
    const out = await renderPrint(IMAGE, [{ box: [100, 100, 300, 300], label: 'Salvar' }], caption)
    expect(out).toBe('data:image/jpeg;base64,AAA')
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85)
    const height = 720 + captionBarHeight(caption, 1280)
    expect(canvasSize).toEqual([1280, height])
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, 1280, height)
    expect(loaded).toEqual([IMAGE, 'blob:print-1'])
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('image/svg+xml;charset=utf-8')
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blob)
    })
    expect(text).toContain(`href="${IMAGE}"`)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:print-1')
  })

  it('honors width and quality options', async () => {
    await renderPrint(IMAGE, [], 'Legenda', { width: 640, quality: 0.6 })
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.6)
    expect(canvasSize).toEqual([640, 360 + captionBarHeight('Legenda', 640)])
  })

  it('falls back to a data url when createObjectURL is missing', async () => {
    class NoBlobURL extends URL {
      static createObjectURL = undefined as unknown as typeof URL.createObjectURL
    }
    vi.stubGlobal('URL', NoBlobURL)
    await renderPrint(IMAGE, [], 'Legenda')
    expect(loaded[1].startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(decodeURIComponent(loaded[1].slice('data:image/svg+xml;charset=utf-8,'.length))).toContain('<svg')
  })

  it('rejects when the frame does not load', async () => {
    fail = IMAGE
    await expect(renderPrint(IMAGE, [], 'Legenda')).rejects.toThrow('Não deu para abrir o quadro do vídeo.')
    expect(toDataURL).not.toHaveBeenCalled()
  })

  it('revokes the blob url even when the svg fails to load', async () => {
    fail = 'blob:'
    await expect(renderPrint(IMAGE, [], 'Legenda')).rejects.toThrow()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:print-1')
  })
})
