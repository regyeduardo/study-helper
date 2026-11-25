import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountMiniplayer } from '@/lib/recording/miniplayer'

const WIDTH = 200
const HEIGHT = 100
const GREEN = '#34d399'
const BLUE = '#60a5fa'

function meter(level: number): AnalyserNode {
  return {
    getByteTimeDomainData: (samples: Uint8Array) => samples.forEach((_, index) => (samples[index] = 128 + (index % 2 ? 1 : -1) * Math.round(level * 127))),
  } as unknown as AnalyserNode
}

function paintOnce(meters: { microphone: AnalyserNode | null; computer: AnalyserNode | null }): Record<string, number[]> {
  const waves: Record<string, number[]> = {}
  let current: number[] = []
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textBaseline: '',
    fillRect: vi.fn(),
    beginPath: () => (current = []),
    moveTo: (_x: number, y: number) => current.push(y),
    lineTo: (_x: number, y: number) => current.push(y),
    closePath: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    measureText: () => ({ width: 10 }),
    stroke() {
      waves[this.strokeStyle] = current
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as never)
  let frames = 0
  vi.stubGlobal('requestAnimationFrame', (paint: FrameRequestCallback) => (frames++ === 0 ? paint(0) : 0, 1))
  const container = document.createElement('div')
  document.body.appendChild(container)
  mountMiniplayer(container, { preview: null, meters, computerAudio: 'x' })()
  return waves
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(HEIGHT)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('miniplayer waves', () => {
  it('draws the computer sound above and the microphone below, so one never hides the other', () => {
    const waves = paintOnce({ microphone: meter(0.5), computer: meter(0.5) })
    expect(Math.max(...waves[GREEN])).toBeLessThanOrEqual(HEIGHT / 2)
    expect(Math.min(...waves[BLUE])).toBeGreaterThanOrEqual(HEIGHT / 2)
  })

  it('makes a quiet computer sound clearly visible', () => {
    const waves = paintOnce({ microphone: null, computer: meter(0.07) })
    const swing = Math.max(...waves[GREEN]) - Math.min(...waves[GREEN])
    expect(swing).toBeGreaterThanOrEqual(HEIGHT * 0.15)
  })

  it('keeps silence flat', () => {
    const waves = paintOnce({ microphone: meter(0), computer: meter(0) })
    expect(new Set(waves[GREEN]).size).toBe(1)
    expect(new Set(waves[BLUE]).size).toBe(1)
  })
})

// T175 (dono, 25/11; mocks/gravar-reuniao, opção I): na janelinha, a tela fica em cima, na largura toda, e as ondas numa faixa embaixo
// dela: com a tela, lado a lado (o microfone à esquerda, o som do PC à direita); sem a tela, uma embaixo da outra; cada onda começa
// depois do seu nome, que nunca fica por cima dela
describe('a faixa de ondas da janelinha', () => {
  interface Drawn {
    waves: Record<string, { x: number; y: number }[]>
    texts: { text: string; x: number; y: number }[]
  }

  function paintStrip(meters: { microphone: AnalyserNode | null; computer: AnalyserNode | null }, lanes: 'side' | 'stacked', width: number, height: number): Drawn {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height)
    const drawn: Drawn = { waves: {}, texts: [] }
    let current: { x: number; y: number }[] = []
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
      textBaseline: '',
      fillRect: vi.fn(),
      beginPath: () => (current = []),
      moveTo: (x: number, y: number) => current.push({ x, y }),
      lineTo: (x: number, y: number) => current.push({ x, y }),
      closePath: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      fillText: (text: string, x: number, y: number) => void drawn.texts.push({ text, x, y }),
      // 6 px a letter, about what 10.5 px of the system font measures
      measureText: (text: string) => ({ width: text.length * 6 }),
      stroke() {
        drawn.waves[this.strokeStyle] = current
      },
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as never)
    let frames = 0
    vi.stubGlobal('requestAnimationFrame', (paint: FrameRequestCallback) => (frames++ === 0 ? paint(0) : 0, 1))
    const container = document.createElement('div')
    document.body.appendChild(container)
    mountMiniplayer(container, { preview: null, meters, computerAudio: 'x' }, lanes)()
    return drawn
  }

  const xs = (points: { x: number }[]) => points.map(point => point.x)
  const ys = (points: { y: number }[]) => points.map(point => point.y)
  const label = (drawn: Drawn, text: string) => drawn.texts.find(item => item.text === text)!

  it('com a tela, lado a lado: o microfone na metade da esquerda, o som do PC na da direita', () => {
    const drawn = paintStrip({ microphone: meter(0.5), computer: meter(0.5) }, 'side', 316, 30)
    expect(Math.max(...xs(drawn.waves[BLUE]))).toBeLessThanOrEqual(158)
    expect(Math.min(...xs(drawn.waves[GREEN]))).toBeGreaterThanOrEqual(158)
    expect(label(drawn, 'Microfone').x).toBeLessThan(158)
    expect(label(drawn, 'Som do PC').x).toBeGreaterThanOrEqual(158)
  })

  it('sem a tela, uma embaixo da outra: o microfone em cima, o som do PC embaixo', () => {
    const drawn = paintStrip({ microphone: meter(0.5), computer: meter(0.5) }, 'stacked', 316, 52)
    expect(Math.max(...ys(drawn.waves[BLUE]))).toBeLessThanOrEqual(26)
    expect(Math.min(...ys(drawn.waves[GREEN]))).toBeGreaterThanOrEqual(26)
    expect(label(drawn, 'Microfone').y).toBeLessThan(26)
    expect(label(drawn, 'Som do PC').y).toBeGreaterThanOrEqual(26)
  })

  it('cada onda começa depois do seu nome: o nome nunca fica por cima da linha', () => {
    for (const lanes of ['side', 'stacked'] as const) {
      const drawn = paintStrip({ microphone: meter(0.5), computer: meter(0.5) }, lanes, 316, lanes === 'side' ? 30 : 52)
      for (const [text, color] of [
        ['Microfone', BLUE],
        ['Som do PC', GREEN],
      ]) {
        const name = label(drawn, text)
        expect(Math.min(...xs(drawn.waves[color]))).toBeGreaterThan(name.x + text.length * 6)
      }
    }
  })

  // a faixa de 26 px da janelinha cortava os nomes e as ondas: o desenho tinha altura mínima de 44 px e o meio caía fora dela
  it('a área de desenho tem a altura da faixa, sem a altura mínima das ondas de antes', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const stop = mountMiniplayer(container, { preview: null, meters: { microphone: null, computer: null }, computerAudio: '' }, 'side')
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('0px')
    stop()
    const legend = document.createElement('div')
    document.body.appendChild(legend)
    const stopLegend = mountMiniplayer(legend, { preview: null, meters: { microphone: null, computer: null }, computerAudio: '' })
    expect((legend.firstElementChild as HTMLElement).style.minHeight).toBe('44px')
    stopLegend()
  })

  it('sem som do computador: o nome diz isso e a linha fica reta, depois do nome', () => {
    const drawn = paintStrip({ microphone: meter(0.5), computer: null }, 'stacked', 316, 52)
    const name = label(drawn, 'Sem som do computador')
    expect(new Set(ys(drawn.waves[GREEN])).size).toBe(1)
    expect(Math.min(...xs(drawn.waves[GREEN]))).toBeGreaterThan(name.x + 'Sem som do computador'.length * 6)
    expect(drawn.texts.map(item => item.text)).not.toContain('Som do PC')
  })
})
