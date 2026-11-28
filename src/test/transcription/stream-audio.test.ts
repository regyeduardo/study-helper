import { afterEach, describe, expect, it, vi } from 'vitest'

// T192 (dono, 27/11: "Corrija tudo… quero 0 problemas"): preparar o áudio de uma gravação de 90 min decodificava a mídia inteira de uma vez
// (decodeAudioData): medido no Chromium sem GPU, de 352 MB para 4.460 MB de pico, mais que os 3,8 GB do servidor inteiro. Agora o áudio é
// decodificado aos pedaços (WebCodecs) e reamostrado para 16 kHz em fluxo, com o mesmo resultado; sem WebCodecs, o caminho de antes.

import { downmix, resampler, streamDecode16k } from '@/lib/transcription/stream-audio'

const tone = (hz: number, rate: number, seconds: number, amplitude = 0.5) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / rate))
const rms = (samples: Float32Array, from = 0, to = samples.length) => {
  let total = 0
  for (let index = from; index < to; index++) total += samples[index] * samples[index]
  return Math.sqrt(total / Math.max(1, to - from))
}
const run = (from: number, to: number, input: Float32Array, chunk: number) => {
  const step = resampler(from, to)
  const parts: Float32Array[] = []
  for (let at = 0; at < input.length; at += chunk) parts.push(step.push(input.subarray(at, at + chunk)))
  parts.push(step.end())
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) out.set(part, (at += part.length) - part.length)
  return out
}

afterEach(() => vi.unstubAllGlobals())

describe('o reamostrador para 16 kHz (T192)', () => {
  it('de 48 kHz: sai um terço das amostras, e a voz (1 kHz) passa inteira, no mesmo tempo', () => {
    const out = run(48000, 16000, tone(1000, 48000, 2), 4800)
    expect(out.length).toBe(32000)
    // the middle, away from the edges: same level as a 1 kHz sine at 16 kHz
    expect(rms(out, 1000, 31000)).toBeCloseTo(rms(tone(1000, 16000, 2), 1000, 31000), 2)
    let error = 0
    const expected = tone(1000, 16000, 2)
    for (let index = 1000; index < 31000; index++) error = Math.max(error, Math.abs(out[index] - expected[index]))
    expect(error).toBeLessThan(0.01)
  })

  it('o que passa de 8 kHz cai como no filtro de antes (o do decodeAudioData): 35 dB abaixo a 10 kHz, 79 dB a 12 kHz', () => {
    const level = (hz: number) => rms(run(48000, 16000, tone(hz, 48000, 1), 1000), 500, 15500) / rms(tone(hz, 48000, 1))
    expect(20 * Math.log10(level(10000))).toBeLessThan(-34)
    expect(20 * Math.log10(level(12000))).toBeLessThan(-70)
    // and the voice band stays: 6 kHz loses 1,9 dB, as before
    expect(20 * Math.log10(level(6000))).toBeGreaterThan(-2.5)
  })

  it('o tamanho dos pedaços não muda nada: aos pedaços é igual a de uma vez', () => {
    const input = Float32Array.from({ length: 48000 }, (_, index) => Math.sin(index / 7) * 0.3 + Math.sin(index / 53) * 0.2)
    const whole = run(48000, 16000, input, input.length)
    for (const chunk of [1, 37, 960, 4096]) expect(run(48000, 16000, input, chunk)).toEqual(whole)
  })

  it('de 44,1 kHz e de 22,05 kHz também (proporção que não é inteira), e de 8 kHz para cima', () => {
    for (const rate of [44100, 22050, 8000]) {
      const out = run(rate, 16000, tone(440, rate, 2), 1024)
      expect(Math.abs(out.length - 32000)).toBeLessThanOrEqual(1)
      expect(rms(out, 1000, 31000)).toBeCloseTo(rms(tone(440, 16000, 2), 1000, 31000), 2)
    }
  })

  it('já em 16 kHz: devolve igual', () => {
    const input = tone(300, 16000, 0.5)
    expect(run(16000, 16000, input, 333)).toEqual(input)
  })
})

describe('os canais, como o Web Audio mistura (T192)', () => {
  const L = Float32Array.from([1, 1])
  const R = Float32Array.from([0.5, -0.5])
  const C = Float32Array.from([0.2, 0.2])
  const LFE = Float32Array.from([9, 9])
  const SL = Float32Array.from([0.1, 0])
  const SR = Float32Array.from([0, 0.1])

  it('estéreo fica estéreo (o microfone à esquerda e o som do computador à direita não se misturam)', () => {
    expect(downmix([L, R], 2)).toEqual([L, R])
  })

  it('estéreo para mono: a média dos dois', () => {
    expect(Array.from(downmix([L, R], 1)[0])).toEqual([0.75, 0.25])
  })

  it('5.1 para estéreo e para mono, sem o grave (LFE)', () => {
    const half = Math.SQRT1_2
    const [left, right] = downmix([L, R, C, LFE, SL, SR], 2)
    expect(left[0]).toBeCloseTo(1 + half * (0.2 + 0.1))
    expect(right[1]).toBeCloseTo(-0.5 + half * (0.2 + 0.1))
    expect(downmix([L, R, C, LFE, SL, SR], 1)[0][0]).toBeCloseTo(half * (1 + 0.5) + 0.2 + 0.5 * 0.1)
  })

  it('quadrifônico para estéreo e para mono', () => {
    expect(downmix([L, R, SL, SR], 2)[0][0]).toBeCloseTo(0.5 * (1 + 0.1))
    expect(downmix([L, R, SL, SR], 1)[0][0]).toBeCloseTo(0.25 * (1 + 0.5 + 0.1))
  })

  it('mono fica mono', () => {
    expect(downmix([L], 2)).toEqual([L])
  })
})

describe('sem WebCodecs (os testes, um navegador antigo), o caminho de antes', () => {
  it('não decodifica aos pedaços: devolve nulo e a transcrição usa o decodeAudioData', async () => {
    vi.stubGlobal('AudioDecoder', undefined)
    expect(await streamDecode16k(new Blob(['x'], { type: 'video/webm' }), 2)).toBeNull()
  })
})
