import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openVideoFrames, signatureDifference } from '@/lib/generation/video-source'

class FakeVideo extends EventTarget {
  static failOnLoad = false
  static startDuration = 1500
  static instances: FakeVideo[] = []

  muted = false
  preload = ''
  videoWidth = 1920
  videoHeight = 1080
  duration = FakeVideo.startDuration
  seeks: number[] = []
  pending = 0
  maxPending = 0
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
    this.pending += 1
    this.maxPending = Math.max(this.maxPending, this.pending)
    if (value >= 1e9 && !Number.isFinite(this.duration)) {
      this.duration = 1500
      setTimeout(() => this.dispatchEvent(new Event('durationchange')), 0)
    }
    setTimeout(() => {
      this.pending -= 1
      this.dispatchEvent(new Event('seeked'))
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
  FakeVideo.failOnLoad = false
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
  vi.restoreAllMocks()
  urlApi.createObjectURL = savedCreateUrl
  urlApi.revokeObjectURL = savedRevokeUrl
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
