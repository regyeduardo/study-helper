import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { makeSeekable } = vi.hoisted(() => ({ makeSeekable: vi.fn(async (blob: Blob) => new Blob([blob], { type: blob.type })) }))
vi.mock('@/lib/recording/seekable', () => ({ makeSeekable }))
// T191: the pass of WebCodecs, off by default here (no VideoDecoder in jsdom, as before); the tests of the pass turn it on
const passing = vi.hoisted(() => ({ on: false, failAfter: null as number | null, frame: { width: 1920, height: 1080 }, asked: [] as number[][], draws: [] as unknown[][] }))
vi.mock('@/lib/recording/video-pass', () => ({
  openPass: vi.fn(async () =>
    passing.on
      ? {
          each: async (times: number[], use: (at: number, frame: unknown) => void) => {
            const sorted = [...new Set(times)].sort((a, b) => a - b)
            passing.asked.push(sorted)
            for (const [index, at] of sorted.entries()) {
              if (passing.failAfter !== null && index >= passing.failAfter) throw new Error('o decodificador parou')
              use(at, { ...passing.frame, draw: (...args: unknown[]) => passing.draws.push(args.slice(1)) })
            }
          },
          close: vi.fn(),
        }
      : null,
  ),
}))

// T197: the thumbnails of the index made by the server's ffmpeg, for a media of the App
const server = vi.hoisted(() => ({ frames: null as Uint8Array[] | null, fail: false, asked: [] as unknown[] }))
vi.mock('@/controllers/library-api.controller', async importOriginal => ({
  ...(await importOriginal<typeof import('@/controllers/library-api.controller')>()),
  getMediaThumbs: vi.fn(async (item: string, media: string, ask: unknown) => {
    server.asked.push({ item, media, ask })
    if (server.fail) throw new Error('o servidor não respondeu')
    return server.frames ?? []
  }),
}))

import { openVideoFrames, signatureDifference } from '@/lib/generation/video-source'
import { rememberAppMedia } from '@/lib/storage/media-ref'
import { SEEK_LIMIT_MS } from '@/lib/recording/video-wait'

class FakeVideo extends EventTarget {
  static failOnLoad = false
  static startDuration = 1500
  /** After this many seeks the decoder breaks (25/11: PIPELINE_ERROR_DECODE in the server's Chromium) and nothing answers again. */
  static breakAfter: number | null = null
  /** No seek is ever answered. */
  static silent = false
  /** Seeks to these times are never answered (a frame the decoder takes too long to hand). */
  static lateAt = new Set<number>()
  static instances: FakeVideo[] = []

  muted = false
  preload = ''
  videoWidth = 1920
  videoHeight = 1080
  duration = FakeVideo.startDuration
  seeks: number[] = []
  pending = 0
  maxPending = 0
  error: { code: number } | null = null
  private source = ''
  private time = 0

  constructor() {
    super()
    FakeVideo.instances.push(this)
  }

  get src() {
    return this.source
  }

  set src(value: string) {
    this.source = value
    setTimeout(() => this.dispatchEvent(new Event(FakeVideo.failOnLoad ? 'error' : 'loadeddata')), 0)
  }

  removeAttribute(name: string) {
    if (name === 'src') this.source = ''
  }

  get currentTime() {
    return this.time
  }

  set currentTime(value: number) {
    this.time = value
    this.seeks.push(value)
    if (FakeVideo.silent || this.error || FakeVideo.lateAt.has(value)) return
    this.pending += 1
    this.maxPending = Math.max(this.maxPending, this.pending)
    if (value >= 1e9 && !Number.isFinite(this.duration)) {
      this.duration = 1500
      setTimeout(() => this.dispatchEvent(new Event('durationchange')), 0)
    }
    setTimeout(() => {
      this.pending -= 1
      this.dispatchEvent(new Event('seeked'))
      if (FakeVideo.breakAfter !== null && this.seeks.length >= FakeVideo.breakAfter) {
        this.error = { code: 3 }
        this.dispatchEvent(new Event('error'))
      }
    }, 0)
  }
}

interface FakeContext {
  drawImage: ReturnType<typeof vi.fn>
  getImageData: () => { data: Uint8ClampedArray }
}

const contexts = new Map<HTMLCanvasElement, FakeContext>()
const originalCreate = document.createElement.bind(document)
const urlApi = URL as unknown as Record<string, unknown>
const savedCreateUrl = urlApi.createObjectURL
const savedRevokeUrl = urlApi.revokeObjectURL
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
let toDataURL: ReturnType<typeof vi.fn>

function lastVideo(): FakeVideo {
  return FakeVideo.instances[FakeVideo.instances.length - 1]
}

function drawsOn(width: number, height: number) {
  return [...contexts.entries()].filter(([canvas]) => canvas.width === width && canvas.height === height).flatMap(([, context]) => context.drawImage.mock.calls)
}

beforeEach(() => {
  Object.assign(passing, { on: false, failAfter: null, frame: { width: 1920, height: 1080 }, asked: [], draws: [] })
  Object.assign(server, { frames: null, fail: false, asked: [] })
  FakeVideo.failOnLoad = false
  FakeVideo.breakAfter = null
  FakeVideo.silent = false
  FakeVideo.lateAt = new Set()
  FakeVideo.startDuration = 1500
  FakeVideo.instances = []
  contexts.clear()
  createObjectURL = vi.fn(() => 'blob:video-1')
  revokeObjectURL = vi.fn()
  urlApi.createObjectURL = createObjectURL
  urlApi.revokeObjectURL = revokeObjectURL
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) =>
    tag === 'video' ? (new FakeVideo() as unknown as HTMLVideoElement) : originalCreate(tag, options)) as typeof document.createElement)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this)
    if (!context) {
      context = { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(48 * 36 * 4).fill(90) }) }
      contexts.set(this, context)
    }
    return context as unknown as CanvasRenderingContext2D
  } as unknown as HTMLCanvasElement['getContext'])
  toDataURL = vi.fn(() => 'data:image/jpeg;base64,AAAA')
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(toDataURL as unknown as HTMLCanvasElement['toDataURL'])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  urlApi.createObjectURL = savedCreateUrl
  urlApi.revokeObjectURL = savedRevokeUrl
})

// T180 (25/11): a Ata da Natália parou 80 minutos em "Vendo quem fala pelos quadros da chamada": o vídeo deu erro de decodificação no
// Chromium do servidor entre dois quadros, o aviso de erro já tinha passado, e o quadro seguinte esperava o "seeked" para sempre.
describe('a leitura dos quadros nunca espera para sempre', () => {
  it('um WebM de antes tem o índice refeito antes de pular', async () => {
    const video = new Blob(['x'], { type: 'video/webm;codecs=vp9' })
    await openVideoFrames(video)
    expect(makeSeekable).toHaveBeenCalledWith(video, { redo: true })
  })

  it('o vídeo que quebrou entre dois quadros: o próximo quadro falha na hora, dizendo por quê', async () => {
    FakeVideo.breakAfter = 1
    const source = await openVideoFrames(new Blob(['x']))
    await source.full(10)
    await expect(source.full(20)).rejects.toThrow('O vídeo da gravação não abriu.')
  })

  it('um quadro que não vem: falha depois do limite, em vez de prender o trabalho', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    FakeVideo.silent = true
    vi.useFakeTimers()
    const shot = source.full(10)
    const failed = expect(shot).rejects.toThrow(/não veio/)
    await vi.advanceTimersByTimeAsync(SEEK_LIMIT_MS + 1)
    await failed
  })
})

describe('openVideoFrames', () => {
  it('reads the video size and duration', async () => {
    const source = await openVideoFrames(new Blob(['x'], { type: 'video/webm' }))
    expect(source.width).toBe(1920)
    expect(source.height).toBe(1080)
    expect(source.duration).toBe(1500)
    expect(lastVideo().muted).toBe(true)
    expect(lastVideo().preload).toBe('auto')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('finds the duration of a recording that reports Infinity', async () => {
    FakeVideo.startDuration = Infinity
    const source = await openVideoFrames(new Blob(['x']))
    expect(source.duration).toBe(1500)
    expect(lastVideo().seeks).toEqual([1e9, 0])
  })

  it('full() scales 1920x1080 down to 1280x720', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    const shot = await source.full(10)
    expect(shot).toMatchObject({ at: 10, width: 1280, height: 720, image: 'data:image/jpeg;base64,AAAA' })
    expect(drawsOn(1280, 720)).toEqual([[lastVideo(), 0, 0, 1280, 720]])
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85)
    expect(lastVideo().seeks).toEqual([10])
  })

  it('full() clamps the time to the video length', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    await source.full(9999)
    await source.full(-5)
    expect(lastVideo().seeks).toEqual([1500, 0])
  })

  it('crop() cuts the box from the full frame and scales it to 1280 wide', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    const shot = await source.crop(20, { x: 100, y: 200, w: 640, h: 400 })
    expect(shot.width).toBe(1280)
    expect(shot.height).toBe(800)
    expect(drawsOn(1280, 800)).toEqual([[lastVideo(), 100, 200, 640, 400, 0, 0, 1280, 800]])
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.9)
  })

  it('crop() follows a recording that opens at 1280x720 and grows to 1920x1080 after the first frame', async () => {
    const opening = openVideoFrames(new Blob(['x']))
    lastVideo().videoWidth = 1280
    lastVideo().videoHeight = 720
    const opened = await opening
    expect(opened.width).toBe(1280)
    lastVideo().videoWidth = 1920
    lastVideo().videoHeight = 1080
    const shot = await opened.crop(20, { x: 240, y: 200, w: 720, h: 400 })
    expect(drawsOn(1280, shot.height)).toEqual([[lastVideo(), 360, 300, 1080, 600, 0, 0, 1280, shot.height]])
  })

  it('crop() keeps the box inside the frame', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    const shot = await source.crop(20, { x: 1600, y: -50, w: 600, h: 350 })
    expect(shot.width).toBe(1280)
    expect(shot.height).toBe(Math.round((1280 * 300) / 320))
    expect(drawsOn(1280, shot.height)).toEqual([[lastVideo(), 1600, 0, 320, 300, 0, 0, 1280, shot.height]])
  })

  it('signature is 48x36 grayscale values', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    const shot = await source.full(10)
    expect(shot.signature).toHaveLength(1728)
    expect(shot.signature.every((value) => value === 90)).toBe(true)
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true })
    expect(drawsOn(48, 36)[0].slice(1)).toEqual([0, 0, 48, 36])
  })

  it('serializes concurrent seeks', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    const [full, crop] = await Promise.all([source.full(10), source.crop(20, { x: 0, y: 0, w: 960, h: 540 })])
    expect(full.at).toBe(10)
    expect(crop.at).toBe(20)
    expect(lastVideo().seeks).toEqual([10, 20])
    expect(lastVideo().maxPending).toBe(1)
  })

  it('does not seek twice for the same second', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    await source.full(10)
    await source.crop(10, { x: 0, y: 0, w: 100, h: 100 })
    expect(lastVideo().seeks).toEqual([10])
  })

  it('rejects with a Portuguese message when the video does not open', async () => {
    FakeVideo.failOnLoad = true
    await expect(openVideoFrames(new Blob(['x']))).rejects.toThrow('O vídeo da gravação não abriu.')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:video-1')
  })

  it('close() removes the source and revokes the URL', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    expect(lastVideo().src).toBe('blob:video-1')
    source.close?.()
    expect(lastVideo().src).toBe('')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:video-1')
  })
})

describe('signatureDifference', () => {
  it('is the mean absolute difference', () => {
    expect(signatureDifference([10, 20, 30], [10, 20, 30])).toBe(0)
    expect(signatureDifference([0, 10], [10, 30])).toBe(15)
  })

  it('is Infinity for empty signatures', () => {
    expect(signatureDifference([], [])).toBe(Infinity)
    expect(signatureDifference([1], [])).toBe(Infinity)
  })
})

// T188 (dono, 27/11): no servidor (2 vCPU), o índice do vídeo inteiro levou 20 min e saiu nulo porque UMA miniatura passou dos 20 s
// (medido no vídeo real de 90 min: 4 vídeos ocultos decodificando juntos, cada pulo de 2,6 a 7 s, o pior 20,07 s).
describe('as miniaturas do índice não são tudo ou nada (T188)', () => {
  it('uma miniatura que não vem repete a anterior, e as outras saem', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    FakeVideo.lateAt = new Set([30])
    vi.useFakeTimers()
    const thumbs = source.thumbs!([10, 20, 30, 40, 50, 60, 70, 80], 4, 2)
    await vi.advanceTimersByTimeAsync(SEEK_LIMIT_MS + 50)
    const out = await thumbs
    expect(out).toHaveLength(8)
    expect(out.every(gray => gray instanceof Uint8Array && gray.length === 8)).toBe(true)
    expect(out[2]).toBe(out[1])
  })

  it('três seguidas que não vêm: o vídeo parou de entregar, e o índice falha dizendo por quê', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    FakeVideo.lateAt = new Set([10, 20, 30])
    vi.stubGlobal('navigator', { ...navigator, hardwareConcurrency: 1 })
    vi.useFakeTimers()
    const thumbs = source.thumbs!([10, 20, 30, 40], 4, 2)
    const failed = expect(thumbs).rejects.toThrow(/não veio/)
    await vi.advanceTimersByTimeAsync(3 * SEEK_LIMIT_MS + 50)
    await failed
    vi.unstubAllGlobals()
  })

  it('num computador de 2 núcleos (o servidor), 2 vídeos ocultos decodificam as miniaturas, não 4', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    vi.stubGlobal('navigator', { ...navigator, hardwareConcurrency: 2 })
    const before = FakeVideo.instances.length
    await source.thumbs!([10, 20, 30, 40, 50, 60, 70, 80], 4, 2)
    expect(FakeVideo.instances.length - before).toBe(2)
    vi.unstubAllGlobals()
  })
})

// T191 (dono, 27/11: "Corrija tudo… quero 0 problemas"): medido em 2 núcleos sem GPU, 150 miniaturas levavam 125 s pulando o <video> e 15 s
// numa passada só; os recortes do OCR e os quadros da conversa também saem numa passada, com a mesma conta de recorte de antes.
describe('os quadros numa passada só (T191)', () => {
  it('as miniaturas do índice vêm da passada, sem nenhum vídeo escondido pulando', async () => {
    passing.on = true
    const source = await openVideoFrames(new Blob(['x']))
    const before = FakeVideo.instances.length
    const out = await source.thumbs!([10, 20, 30], 4, 2)
    expect(out).toHaveLength(3)
    expect(FakeVideo.instances.length).toBe(before)
    expect(passing.asked).toEqual([[10, 20, 30]])
    expect(passing.draws.every(args => JSON.stringify(args) === JSON.stringify([0, 0, 1920, 1080, 0, 0, 4, 2]))).toBe(true)
  })

  it('o recorte da passada usa a mesma conta do pulo: a gravação que abre em 1280x720 e cresce para 1920x1080', async () => {
    passing.on = true
    const opening = openVideoFrames(new Blob(['x']))
    lastVideo().videoWidth = 1280
    lastVideo().videoHeight = 720
    const source = await opening
    const [shot] = await source.shots!([20], { x: 240, y: 200, w: 720, h: 400 })
    expect(passing.draws[0]).toEqual([360, 300, 1080, 600, 0, 0, 1280, shot!.height])
    expect(shot).toMatchObject({ at: 20, width: 1280 })
    expect(lastVideo().seeks).toEqual([])
  })

  it('a tela inteira vem como a do full(): no máximo 1280 de largura', async () => {
    passing.on = true
    const source = await openVideoFrames(new Blob(['x']))
    const [shot] = await source.shots!([5])
    expect(shot).toMatchObject({ at: 5, width: 1280, height: 720 })
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85)
  })

  it('a passada que para no meio: o resto sai pelos pulos de antes, na ordem pedida', async () => {
    passing.on = true
    passing.failAfter = 1
    const source = await openVideoFrames(new Blob(['x']))
    const shots = await source.shots!([30, 10, 20], { x: 0, y: 0, w: 960, h: 540 })
    expect(shots.map(shot => shot?.at)).toEqual([30, 10, 20])
    expect(lastVideo().seeks).toEqual([30, 20])
  })

  it('sem a passada (sem WebCodecs), os recortes saem pelos pulos, como antes', async () => {
    const source = await openVideoFrames(new Blob(['x']))
    const shots = await source.shots!([5, 15], { x: 0, y: 0, w: 960, h: 540 })
    expect(shots.map(shot => shot?.at)).toEqual([5, 15])
    expect(lastVideo().seeks).toEqual([5, 15])
  })
})

// T197 (dono, 27/11: "Por que está passando ffmpeg no navegador ao invés do servidor?"): a media kept in the App has the thumbnails of
// the index made by the server's ffmpeg (45 s against 66 s for 20 min of 1080p on 2 cores, outside the Chromium's memory)
describe('as miniaturas do índice pelo ffmpeg do servidor (T197)', () => {
  const gray = (value: number) => new Uint8Array(8).fill(value)

  it('uma mídia do App: as miniaturas vêm do servidor, de uma vez, sem passada nem pulo', async () => {
    passing.on = true
    server.frames = [gray(10), gray(20), gray(30)]
    const video = new Blob(['x'], { type: 'video/webm' })
    rememberAppMedia(video, 'app:n1/m1')
    const source = await openVideoFrames(video)
    const before = FakeVideo.instances.length
    const out = await source.thumbs!([1, 5.5, 10], 4, 2)
    expect(out.map(thumb => thumb[0])).toEqual([10, 20, 30])
    expect(server.asked).toEqual([{ item: 'n1', media: 'm1', ask: { from: 1, step: 4.5, count: 3, width: 4, height: 2 } }])
    expect(passing.asked).toEqual([])
    expect(FakeVideo.instances.length).toBe(before)
  })

  it('o vídeo acabou antes da última miniatura: a última que veio fica no lugar das que faltam', async () => {
    server.frames = [gray(10), gray(20)]
    const video = new Blob(['x'])
    rememberAppMedia(video, 'app:n1/m1')
    const out = await (await openVideoFrames(video)).thumbs!([1, 3, 5, 7], 4, 2)
    expect(out.map(thumb => thumb[0])).toEqual([10, 20, 20, 20])
  })

  it('o servidor não pôde: a passada faz, como antes', async () => {
    passing.on = true
    server.fail = true
    const video = new Blob(['x'])
    rememberAppMedia(video, 'app:n1/m1')
    const out = await (await openVideoFrames(video)).thumbs!([10, 20, 30], 4, 2)
    expect(out).toHaveLength(3)
    expect(passing.asked).toEqual([[10, 20, 30]])
  })

  it('uma mídia que não é do App (do aparelho, do Drive) nem pergunta ao servidor', async () => {
    passing.on = true
    const video = new Blob(['x'])
    rememberAppMedia(video, 'drv-123')
    await (await openVideoFrames(video)).thumbs!([10, 20, 30], 4, 2)
    expect(server.asked).toEqual([])
  })
})

