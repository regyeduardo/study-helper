import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toBox } from '@/lib/generation/scene-index'
import { openVideoFrames } from '@/lib/generation/video-source'

// A hidden <video> that seeks asynchronously; each instance counts its own seeks.
class FakeVideo extends EventTarget {
  static instances: FakeVideo[] = []
  static inFlight = 0
  static maxInFlight = 0
  muted = false
  preload = ''
  videoWidth = 1920
  videoHeight = 1080
  duration = 120
  seeks: number[] = []
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
    if (value) setTimeout(() => this.dispatchEvent(new Event('loadeddata')), 0)
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
    FakeVideo.inFlight += 1
    FakeVideo.maxInFlight = Math.max(FakeVideo.maxInFlight, FakeVideo.inFlight)
    setTimeout(() => {
      FakeVideo.inFlight -= 1
      this.dispatchEvent(new Event('seeked'))
    }, 1)
  }
}

const draws: { canvas: HTMLCanvasElement; args: unknown[] }[] = []
const originalCreate = document.createElement.bind(document)
const urlApi = URL as unknown as Record<string, unknown>
const saved = { create: urlApi.createObjectURL, revoke: urlApi.revokeObjectURL }

beforeEach(() => {
  FakeVideo.instances = []
  FakeVideo.inFlight = 0
  FakeVideo.maxInFlight = 0
  draws.length = 0
  urlApi.createObjectURL = vi.fn(() => 'blob:video-1')
  urlApi.revokeObjectURL = vi.fn()
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) =>
    tag === 'video' ? (new FakeVideo() as unknown as HTMLVideoElement) : originalCreate(tag, options)) as typeof document.createElement)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const canvas = this
    return {
      drawImage: (...args: unknown[]) => draws.push({ canvas, args }),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(60) }),
    } as unknown as CanvasRenderingContext2D
  } as unknown as HTMLCanvasElement['getContext'])
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/jpeg;base64,AAAA')
})

afterEach(() => {
  vi.restoreAllMocks()
  urlApi.createObjectURL = saved.create
  urlApi.revokeObjectURL = saved.revoke
})

describe('thumbnails for the local scene index', () => {
  it('one small gray picture of the whole frame per time, taken by several videos at once, all closed at the end', async () => {
    const source = await openVideoFrames(new Blob(['x'], { type: 'video/webm' }))
    const main = FakeVideo.instances[0]
    const times = Array.from({ length: 40 }, (_, index) => 1 + index * 2)
    const thumbs = await source.thumbs!(times, 32, 18)
    expect(thumbs).toHaveLength(40)
    expect(thumbs.every(thumb => thumb.length === 32 * 18 && thumb.every(value => value === 60))).toBe(true)
    const helpers = FakeVideo.instances.slice(1)
    expect(helpers.length).toBeGreaterThan(1)
    expect(FakeVideo.maxInFlight).toBeGreaterThan(1)
    expect(helpers.flatMap(video => video.seeks).sort((a, b) => a - b)).toEqual(times)
    expect(helpers.every(video => video.src === '')).toBe(true)
    // the main video, used for crops, did not move
    expect(main.seeks).toEqual([])
    expect(draws.filter(draw => draw.canvas.width === 32).every(draw => draw.args.slice(1).join() === '0,0,32,18')).toBe(true)
  })

  it('a recording that opens at 1280x720 and grows to 1920x1080: the area found on the thumbnails is cropped in the right place', async () => {
    const opening = openVideoFrames(new Blob(['x']))
    const main = FakeVideo.instances[0]
    main.videoWidth = 1280
    main.videoHeight = 720
    const source = await opening
    main.videoWidth = 1920
    main.videoHeight = 1080
    // the mask gives fractions of the frame; the box is in the opening size, like the rest of the pipeline
    const box = toBox({ x: 0.1875, y: 0.2778, w: 0.5625, h: 0.5556 }, source.width, source.height)
    expect(box).toEqual({ x: 240, y: 200, w: 720, h: 400 })
    const shot = await source.crop(20, box)
    const crop = draws.find(draw => draw.canvas.width === 1280 && draw.canvas.height === shot.height)!
    expect(crop.args.slice(1, 5)).toEqual([360, 300, 1080, 600])
  })
})
