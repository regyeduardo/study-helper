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
