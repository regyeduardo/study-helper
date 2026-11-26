// T184 (dono, 25/11: "Quero uma função que ao enviar vídeo tenha a opção e já converter no formato otimizado"): o vídeo enviado vira o
// formato da gravação otimizada (VP9 até 250 kb/s, quadro-chave a cada 30 s, Opus a 32 kb/s, num WebM) antes de ser guardado ou lido.
// Escolhas do dono: vem marcada acima de 200 MB; a imagem fica do tamanho que é; guarda só o convertido.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({
  init: vi.fn(),
  cancel: vi.fn(async () => undefined),
  execute: vi.fn(async () => undefined),
  conversion: null as null | Record<string, unknown>,
  buffer: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer | null,
}))

vi.mock('mediabunny', () => {
  class Input {
    constructor(public options: unknown) {}
  }
  class Output {
    target: { buffer: ArrayBuffer | null }
    constructor(public options: { target: { buffer: ArrayBuffer | null } }) {
      this.target = options.target
    }
  }
  class BlobSource {
    constructor(public blob: Blob) {}
  }
  class BufferTarget {
    get buffer() {
      return lib.buffer
    }
  }
  class WebMOutputFormat {}
  const Conversion = {
    init: async (options: unknown) => {
      lib.init(options)
      return lib.conversion
    },
  }
  return { ALL_FORMATS: ['todos'], BlobSource, BufferTarget, Conversion, Input, Output, WebMOutputFormat }
})

import { convertVideo, NotConvertible, OPTIMIZE_ABOVE_BYTES, optimizeByDefault, optimizedBitrate, optimizedName } from '@/lib/recording/convert-video'

const MB = 1024 * 1024
const video = (name = 'aula.mp4') => new File([new Uint8Array(10)], name, { type: 'video/mp4' })
const track = (kind: 'video' | 'audio') => ({ isVideoTrack: () => kind === 'video', isAudioTrack: () => kind === 'audio' })

function withCodecs() {
  for (const name of ['VideoEncoder', 'VideoDecoder', 'AudioEncoder', 'AudioDecoder']) vi.stubGlobal(name, class {})
}

beforeEach(() => {
  lib.init.mockClear()
  lib.cancel.mockClear()
  lib.execute.mockReset()
  lib.execute.mockImplementation(async () => undefined)
  lib.buffer = new Uint8Array([1, 2, 3]).buffer
  lib.conversion = { isValid: true, utilizedTracks: [track('video'), track('audio')], discardedTracks: [], execute: lib.execute, cancel: lib.cancel, onProgress: undefined }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a regra da opção', () => {
  it('vem marcada acima de 200 MB', () => {
    expect(OPTIMIZE_ABOVE_BYTES).toBe(200 * MB)
    expect(optimizeByDefault(200 * MB + 1)).toBe(true)
    expect(optimizeByDefault(200 * MB)).toBe(false)
    expect(optimizeByDefault(80 * MB)).toBe(false)
  })

  it('a imagem fica do tamanho que é: até 1080p, os 250 kb/s da gravação; maior, os mesmos bits por ponto', () => {
    expect(optimizedBitrate(1280, 720)).toBe(250_000)
    expect(optimizedBitrate(1920, 1080)).toBe(250_000)
    expect(optimizedBitrate(3840, 2160)).toBe(1_000_000)
  })

  it('o nome: o mesmo, em .webm', () => {
    expect(optimizedName('Reunião de terça.mp4')).toBe('Reunião de terça.webm')
    expect(optimizedName('aula.MOV')).toBe('aula.webm')
    expect(optimizedName('sem-extensao')).toBe('sem-extensao.webm')
  })
})

describe('converter', () => {
  it('neste navegador sem WebCodecs: não converte, dizendo por quê', async () => {
    await expect(convertVideo(video(), () => undefined, new AbortController().signal)).rejects.toThrow(NotConvertible)
    expect(lib.init).not.toHaveBeenCalled()
  })

  it('VP9 com a taxa do tamanho da imagem e quadro-chave a cada 30 s, Opus a 32 kb/s; o andamento passa; sai um .webm', async () => {
    withCodecs()
    lib.execute.mockImplementation(async () => {
      ;(lib.conversion!.onProgress as (progress: number) => void)(0.5)
    })
    const seen: number[] = []
    const out = await convertVideo(video('Reunião.mp4'), fraction => seen.push(fraction), new AbortController().signal)
    const options = lib.init.mock.calls[0][0] as { tracks: string; video: (track: unknown) => Promise<Record<string, unknown>>; audio: Record<string, unknown> }
    expect(options.tracks).toBe('primary')
    const four = { getDisplayWidth: async () => 3840, getDisplayHeight: async () => 2160 }
    expect(await options.video(four)).toMatchObject({ codec: 'vp9', bitrate: 1_000_000, keyFrameInterval: 30, forceTranscode: true })
    expect(options.audio).toMatchObject({ codec: 'opus', bitrate: 32_000, forceTranscode: true })
    expect(seen).toEqual([0.5])
    expect(out.name).toBe('Reunião.webm')
    expect(out.type).toBe('video/webm')
    expect(out.size).toBe(3)
  })

  it('o vídeo do arquivo que este navegador não lê: não converte, dizendo por quê (nunca sai só o som)', async () => {
    withCodecs()
    lib.conversion = { ...lib.conversion, isValid: true, utilizedTracks: [track('audio')], discardedTracks: [{ track: track('video'), reason: 'undecodable_source_codec' }] }
    await expect(convertVideo(video(), () => undefined, new AbortController().signal)).rejects.toThrow('este navegador não lê o vídeo deste arquivo')
    expect(lib.execute).not.toHaveBeenCalled()
  })

  it('cancelar para a conversão', async () => {
    withCodecs()
    const stop = new AbortController()
    lib.execute.mockImplementation(async () => {
      stop.abort()
    })
    await expect(convertVideo(video(), () => undefined, stop.signal)).rejects.toThrow()
    expect(lib.cancel).toHaveBeenCalled()
  })
})
