import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T191 (dono, 27/11: "Corrija tudo… quero 0 problemas"): os quadros de um vídeo em muitos tempos numa passada só (WebCodecs pela
// Mediabunny), em vez de um pulo do <video> escondido para cada tempo (medido: 150 miniaturas em 125 s pulando, 15 s numa passada).

const bunny = vi.hoisted(() => ({
  rotation: 0,
  decodes: true,
  hangAfter: null as number | null,
  ended: 0,
  asked: [] as number[][],
  closed: 0,
  disposed: 0,
}))

vi.mock('mediabunny', () => {
  class Input {
    async getPrimaryVideoTrack() {
      return { rotation: bunny.rotation, canDecode: async () => bunny.decodes }
    }
    dispose() {
      bunny.disposed++
    }
  }
  class VideoSampleSink {
    async *samplesAtTimestamps(times: number[]) {
      bunny.asked.push([...times])
      try {
        for (const [index, at] of times.entries()) {
          if (bunny.hangAfter !== null && index >= bunny.hangAfter) await new Promise(() => undefined)
          yield at < 1 ? null : { displayWidth: 1920, displayHeight: 1080, at, draw: vi.fn(), close: () => bunny.closed++ }
        }
      } finally {
        bunny.ended++
      }
    }
  }
  return { ALL_FORMATS: [], BlobSource: class {}, Input, VideoSampleSink }
})

import { openPass, PASS_STALLED } from '@/lib/recording/video-pass'

beforeEach(() => {
  Object.assign(bunny, { rotation: 0, decodes: true, hangAfter: null, ended: 0, asked: [], closed: 0, disposed: 0 })
  vi.stubGlobal('VideoDecoder', class {})
})

afterEach(() => vi.unstubAllGlobals())

describe('a passada única pelos quadros (T191)', () => {
  it('pede os tempos em ordem, uma vez cada, e entrega cada quadro com o seu tempo; antes do primeiro quadro, nada', async () => {
    const pass = (await openPass(new Blob(['v'], { type: 'video/webm' })))!
    const seen: [number, number | null][] = []
    await pass.each([30, 5, 0.5, 30, 12], (at, frame) => void seen.push([at, frame ? frame.width : null]))
    expect(bunny.asked).toEqual([[0.5, 5, 12, 30]])
    expect(seen).toEqual([
      [0.5, null],
      [5, 1920],
      [12, 1920],
      [30, 1920],
    ])
    expect(bunny.closed).toBe(3)
    pass.close()
    expect(bunny.disposed).toBe(1)
  })

  it('cada quadro é fechado mesmo quando quem usa falha', async () => {
    const pass = (await openPass(new Blob(['v'])))!
    await expect(pass.each([5, 10], () => Promise.reject(new Error('desenho')))).rejects.toThrow('desenho')
    expect(bunny.closed).toBe(1)
  })

  it('a passada que para de entregar quadros falha no limite, em vez de prender o trabalho (T180: nenhuma espera é para sempre)', async () => {
    bunny.hangAfter = 1
    const pass = (await openPass(new Blob(['v']), { stallMs: 30 }))!
    const seen: number[] = []
    await expect(pass.each([5, 10, 15], at => void seen.push(at))).rejects.toThrow(PASS_STALLED)
    expect(seen).toEqual([5])
  })

  it('sem WebCodecs, com um codec que o navegador não decodifica ou com rotação no arquivo: nulo, e quem chamou pula como antes', async () => {
    vi.stubGlobal('VideoDecoder', undefined)
    expect(await openPass(new Blob(['v']))).toBeNull()
    vi.stubGlobal('VideoDecoder', class {})
    bunny.decodes = false
    expect(await openPass(new Blob(['v']))).toBeNull()
    bunny.decodes = true
    bunny.rotation = 90
    expect(await openPass(new Blob(['v']))).toBeNull()
    expect(bunny.disposed).toBe(2)
  })
})
