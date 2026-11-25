import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CodecRecorder } from '@/lib/recording/codec-recorder'
import { installBlobShim } from '@/test/imports/blob-shim'
import { codecContext, FakeAudioEncoder, FakeAudioWorkletNode, FakeVideoEncoder, FakeVideoFrame, installCodecEnvironment } from '@/test/recording/codec-fakes'

// T174 (dono, 25/11: "Sim, implemente", research R18): a gravação otimizada codificada pelo WebCodecs (VP9 e Opus) no lugar do
// MediaRecorder; no Firefox, metade do tamanho e o texto nítido

const OPTIONS = { videoBitsPerSecond: 250_000, audioBitsPerSecond: 32_000, keyFrameIntervalMs: 30_000 }

function screenSource() {
  let sink: ((canvas: HTMLCanvasElement) => void) | null = null
  const canvas = document.createElement('canvas')
  canvas.width = 1920
  canvas.height = 1080
  return {
    canvas,
    handTo: vi.fn((next: ((canvas: HTMLCanvasElement) => void) | null) => {
      sink = next
    }),
    /** The screen hands a frame, as ScreenCanvas does when it decides one goes out. */
    hand: () => sink?.(canvas),
  }
}

async function open(context = codecContext()) {
  const screen = screenSource()
  const mix = { connect: vi.fn(), disconnect: vi.fn() }
  const recorder = await CodecRecorder.open(screen, context as unknown as AudioContext, mix as unknown as AudioNode, OPTIONS)
  return { recorder: recorder!, screen, mix, context, tap: () => FakeAudioWorkletNode.instances.at(-1)! }
}

const video = () => FakeVideoEncoder.instances.at(-1)!
const audio = () => FakeAudioEncoder.instances.at(-1)!

async function stopped(recorder: CodecRecorder): Promise<Uint8Array> {
  const blobs: Blob[] = []
  recorder.ondataavailable = event => void blobs.push(event.data)
  await new Promise<void>(resolve => {
    recorder.onstop = resolve
    recorder.stop()
  })
  return new Uint8Array(await new Blob(blobs).arrayBuffer())
}

let removeCodecs: () => void

beforeEach(() => {
  installBlobShim()
  removeCodecs = installCodecEnvironment()
})

afterEach(() => {
  removeCodecs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('o gravador da gravação otimizada pelo WebCodecs', () => {
  it('onde falta WebCodecs, VP9 ou Opus, não abre: quem grava usa o MediaRecorder', async () => {
    FakeVideoEncoder.supported = false
    expect((await open()).recorder).toBeNull()
    FakeVideoEncoder.supported = true
    FakeAudioEncoder.supported = false
    expect((await open()).recorder).toBeNull()
    FakeAudioEncoder.supported = true
    vi.stubGlobal('VideoEncoder', undefined)
    expect((await open()).recorder).toBeNull()
  })

  it('grava cada quadro que a tela entrega, no tempo do relógio do som; o primeiro é quadro-chave; VP9 a 250 kb/s com a dica de texto', async () => {
    const { recorder, screen, context } = await open()
    context.currentTime = 2
    recorder.start(1000)
    expect(screen.handTo).toHaveBeenCalledWith(expect.any(Function))
    context.currentTime = 2.5
    screen.hand()
    expect(video().configs[0]).toEqual(expect.objectContaining({ codec: expect.stringMatching(/^vp09\./), width: 1920, height: 1080, bitrate: 250_000, bitrateMode: 'variable', latencyMode: 'realtime', contentHint: 'text' }))
    expect(video().encoded).toEqual([{ timestamp: 500_000, keyFrame: true, width: 1920, height: 1080 }])
    expect(FakeVideoFrame.made.every(frame => frame.closed)).toBe(true)
  })

  it('um quadro-chave a cada 30 s', async () => {
    const { recorder, screen, context } = await open()
    recorder.start(1000)
    for (const at of [0, 10, 29.9, 30, 45, 59.9, 60.2]) {
      context.currentTime = at
      screen.hand()
    }
    expect(video().encoded.filter(frame => frame.keyFrame).map(frame => frame.timestamp)).toEqual([0, 30_000_000, 60_200_000])
  })

  it('o som: cada bloco do AudioWorklet vira AudioData de dois canais, com o tempo contado em amostras; Opus 32 kb/s constante', async () => {
    const { recorder, mix, tap } = await open()
    recorder.start(1000)
    expect(mix.connect).toHaveBeenCalledWith(tap())
    tap().hand(960)
    tap().hand(960)
    tap().hand(960)
    expect(audio().configs[0]).toEqual(expect.objectContaining({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 32_000, bitrateMode: 'constant' }))
    expect(audio().encoded).toEqual([0, 20_000, 40_000].map(timestamp => ({ timestamp, frames: 960, channels: 2, rate: 48000 })))
  })

  it('pausado não grava imagem nem som; ao voltar, o tempo continua de onde parou', async () => {
    const { recorder, screen, context, tap } = await open()
    recorder.start(1000)
    context.currentTime = 1
    screen.hand()
    tap().hand(960)
    context.currentTime = 2
    recorder.pause()
    context.currentTime = 3
    screen.hand()
    tap().hand(960)
    context.currentTime = 5
    recorder.resume()
    context.currentTime = 6
    screen.hand()
    tap().hand(960)
    expect(video().encoded.map(frame => frame.timestamp)).toEqual([1_000_000, 3_000_000])
    expect(audio().encoded.map(data => data.timestamp)).toEqual([0, 20_000])
  })

  it('fila cheia no codificador: o quadro é pulado, e o quadro-chave da vez sai no próximo', async () => {
    const { recorder, screen, context } = await open()
    recorder.start(1000)
    screen.hand()
    video().holding = true
    for (let index = 0; index < 5; index++) screen.hand()
    context.currentTime = 31
    screen.hand()
    expect(video().encoded).toHaveLength(6)
    video().release()
    video().holding = false
    screen.hand()
    expect(video().encoded.at(-1)).toEqual(expect.objectContaining({ timestamp: 31_000_000, keyFrame: true }))
  })

  it('a tela que muda de tamanho reconfigura o codificador e manda quadro-chave', async () => {
    const { recorder, screen, context } = await open()
    recorder.start(1000)
    screen.hand()
    context.currentTime = 1
    screen.canvas.width = 1280
    screen.canvas.height = 720
    screen.hand()
    expect(video().configs.map(config => [config.width, config.height])).toEqual([
      [1920, 1080],
      [1280, 720],
    ])
    expect(video().encoded.map(frame => frame.keyFrame)).toEqual([true, true])
  })

  it('parar: deixa de receber imagem e som, esvazia os codificadores, entrega o WebM inteiro e então avisa que parou', async () => {
    const { recorder, screen, mix, context, tap } = await open()
    recorder.start(1000)
    for (let index = 0; index < 50; index++) {
      context.currentTime = index * 0.02
      if (index % 10 === 0) screen.hand()
      tap().hand(960)
    }
    const file = await stopped(recorder)
    expect(recorder.state).toBe('inactive')
    expect(screen.handTo).toHaveBeenLastCalledWith(null)
    expect(mix.disconnect).toHaveBeenCalledWith(tap())
    expect(video().flush).toHaveBeenCalled()
    expect(audio().flush).toHaveBeenCalled()
    expect([...file.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    const ascii = new TextDecoder('latin1').decode(file)
    expect(ascii).toContain('V_VP9')
    expect(ascii).toContain('A_OPUS')
    expect(ascii).toContain('OpusHead')
  })

  it('entrega o que já escreveu a cada segundo, como o MediaRecorder com fatia de tempo', async () => {
    vi.useFakeTimers()
    const { recorder, screen, tap } = await open()
    const blobs: Blob[] = []
    recorder.ondataavailable = event => void blobs.push(event.data)
    recorder.start(1000)
    screen.hand()
    tap().hand(960)
    screen.hand()
    await vi.advanceTimersByTimeAsync(1000)
    expect(blobs.length).toBe(1)
    expect(blobs[0].size).toBeGreaterThan(0)
  })

  it('erro do codificador termina a gravação com o que já tem', async () => {
    const { recorder, screen, tap } = await open()
    const blobs: Blob[] = []
    recorder.ondataavailable = event => void blobs.push(event.data)
    const ended = new Promise<void>(resolve => (recorder.onstop = resolve))
    recorder.start(1000)
    screen.hand()
    tap().hand(960)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    video().fail('the GPU went away')
    await ended
    expect(recorder.state).toBe('inactive')
    expect(blobs.length).toBeGreaterThan(0)
  })
})
