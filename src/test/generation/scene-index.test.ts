import { describe, expect, it } from 'vitest'

import type { Box, FrameSource, Shot } from '@/lib/generation/ata-types'
import { activityArea, changedShare, distinctScreens, type Gray, indexScreens, sceneTimes } from '@/lib/generation/scene-index'

const W = 160
const H = 90

function gray(paint: (x: number, y: number) => number, width = W, height = H): Gray {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = paint(x, y)
  return { width, height, data }
}

const blank = gray(() => 230)
// a sheet: dark text lines over the whole crop
const sheet = gray((x, y) => (y % 10 < 3 && x % 7 < 5 ? 40 : 230))
// the same sheet with one more line typed in the formula bar (8 of the 144 blocks)
const formula = gray((x, y) => (y < 10 && x < 80 ? (x % 4 < 2 ? 20 : 230) : sheet.data[y * W + x]))
// the cursor over the sheet: one block
const cursor = gray((x, y) => (x >= 50 && x < 56 && y >= 30 && y < 36 ? 0 : sheet.data[y * W + x]))
// a menu that opened for a moment
const menu = gray((x, y) => (x < 80 ? 90 : 230))

describe('the local scene index', () => {
  it('samples every 2 s, never more than the cap', () => {
    expect(sceneTimes(9)).toEqual([1, 3, 5, 7])
    expect(sceneTimes(10_000).length).toBeLessThanOrEqual(1200)
  })

  it('counts the share of the 16x9 blocks that changed', () => {
    expect(changedShare(sheet, sheet)).toBe(0)
    expect(changedShare(sheet, cursor)).toBeCloseTo(1 / 144)
    expect(changedShare(sheet, formula)).toBeGreaterThanOrEqual(0.05)
    expect(changedShare(blank, sheet)).toBeGreaterThan(0.5)
  })

  it('a screen counts once while it stays; the cursor never makes a new one; a change counts only when it stays still for 2 s', () => {
    const frames = [blank, blank, sheet, cursor, sheet, menu, sheet, formula, formula, blank, blank]
    const times = frames.map((_, index) => 1 + index * 2)
    expect(distinctScreens(frames, times, 23)).toEqual([
      { at: 1, end: 5 },
      { at: 5, end: 15 },
      { at: 15, end: 19 },
      { at: 19, end: 23 },
    ])
  })

  it('a screen that comes back after another one counts again', () => {
    const frames = [sheet, sheet, blank, blank, sheet, sheet]
    expect(distinctScreens(frames, [1, 3, 5, 7, 9, 11], 12).map(screen => screen.at)).toEqual([1, 5, 9])
  })
})

describe('the shared area from the activity mask', () => {
  // 60 frames: the call frame never changes, the video tiles flicker all the time, the shared content changes in steps
  const frames = Array.from({ length: 60 }, (_, index) =>
    gray((x, y) => {
      if (x >= 130) return (index * 37 + x * 11 + y * 7) % 251
      if (x >= 30 && x < 110 && y >= 20 && y < 70) return Math.floor(index / 10) % 2 ? (x % 6 < 3 ? 40 : 220) : 220
      return 120
    }),
  )

  it('the blocks that change in steps are the shared screen; the tiles that always change and the frame that never changes are out', () => {
    const area = activityArea(frames)!
    expect(area.x).toBeCloseTo(30 / W, 1)
    expect(area.y).toBeCloseTo(20 / H, 1)
    expect(area.x + area.w).toBeCloseTo(110 / W, 1)
    expect(area.y + area.h).toBeCloseTo(70 / H, 1)
  })

  it('without content changing in steps there is no mask (the old way finds the area)', () => {
    expect(activityArea(Array.from({ length: 30 }, () => blank))).toBeNull()
    expect(activityArea(frames.slice(0, 2))).toBeNull()
  })
})

describe('indexing a video', () => {
  // A recording that opens at 1280x720: the box comes in the opening size, like every other box of the pipeline.
  function source(screenAt: (at: number) => Gray): FrameSource & { crops: Box[] } {
    const crops: Box[] = []
    const shot = (at: number): Shot => ({ at, image: `data:image/jpeg;base64,crop-${at}`, width: 1280, height: 720, signature: [] })
    return {
      crops,
      width: 1280,
      height: 720,
      duration: 61,
      full: async at => shot(at),
      crop: async (at, box) => (crops.push(box), shot(at)),
      thumbs: async (times, width, height) =>
        times.map(at => {
          const content = screenAt(at)
          const index = Math.round(at)
          return gray(
            (x, y) => {
              if (x >= width * 0.8) return (index * 37 + x * 11 + y * 7) % 251
              const cx = Math.floor(((x - width * 0.25) / (width * 0.5)) * W)
              const cy = Math.floor(((y - height * 0.25) / (height * 0.5)) * H)
              return cx >= 0 && cx < W && cy >= 0 && cy < H ? content.data[cy * W + cx] : 120
            },
            width,
            height,
          ).data
        }),
    }
  }

  it('finds the area locally (no AI) and the distinct screens inside it', async () => {
    const screens = (at: number) => (at < 20 ? sheet : at < 40 ? blank : menu)
    const made = await indexScreens(source(screens))
    expect(made).not.toBeNull()
    const { area, screens: found } = made!
    expect(area.x / 1280).toBeCloseTo(0.25, 1)
    expect(area.y / 720).toBeCloseTo(0.25, 1)
    expect(area.w / 1280).toBeCloseTo(0.5, 1)
    expect(found.map(screen => screen.at)).toEqual([1, 21, 41])
    expect(found[2].end).toBe(61)
  })

  it('a source without thumbnails (Node, ffmpeg) has no local index', async () => {
    const { thumbs: _none, ...plain } = source(() => sheet)
    expect(await indexScreens(plain)).toBeNull()
  })
})
