// The local scene index (visão 4.1): small gray thumbnails of the whole video, the shared area found by the
// blocks that change in steps, and the distinct screens inside it. No AI; calibrated on a real 29 min call.
import type { Box, FrameSource, OcrText } from '@/lib/generation/ata-types'

/** A grayscale picture, one byte (0-255) per pixel. */
export interface Gray {
  width: number
  height: number
  data: Uint8Array
}

/** A rectangle in fractions (0-1) of the frame. */
export interface Area {
  x: number
  y: number
  w: number
  h: number
}

/** One screen that stayed: from `at` until the next one (seconds). */
export interface IndexedScreen {
  at: number
  end: number
  /** What the local OCR read on it, when that was already done (kept by the transcription). */
  texts?: OcrText[]
}

export interface SceneIndex {
  /** The shared area, in source video pixels (the whole frame when nothing better was found). */
  area: Box
  /** True when the area came from the activity mask (no AI). */
  masked: boolean
  screens: IndexedScreen[]
}

export const THUMB_WIDTH = 256
export const THUMB_HEIGHT = 144
const SCENE_STEP = 2
const MAX_THUMBS = 1200
/** A block changed when its mean gray difference passes this (0-255). */
const BLOCK_CHANGE = 8
/** Share of the 16x9 blocks that must change for a new screen: 0.05 still keeps a change only in the formula bar. */
const NEW_SCREEN = 0.05
/** Below this share the next thumbnail shows the same screen: the change stayed still for 2 s. */
const STILL = 0.02
// Activity mask on 32x18 blocks: the call frame never changes, the video tiles change almost all the time,
// the shared content changes now and then (in steps).
const MASK_CHANGE = 4
const MASK_MIN = 0.015
const MASK_MAX = 0.2
/** Smaller than this share of the frame is not a shared screen (an avatar, a clock). */
const MASK_MIN_SIZE = 0.08

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** One thumbnail every 2 s (more apart in very long videos). */
export function sceneTimes(duration: number): number[] {
  const step = Math.max(SCENE_STEP, duration / MAX_THUMBS)
  const out: number[] = []
  for (let t = 1; t < duration; t += step) out.push(Math.round(t * 10) / 10)
  return out
}

function changedBlocks(a: Gray, b: Gray, columns: number, rows: number, threshold: number): Uint8Array {
  const changed = new Uint8Array(columns * rows)
  for (let by = 0; by < rows; by++) {
    const y0 = Math.floor((by * a.height) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((by + 1) * a.height) / rows))
    for (let bx = 0; bx < columns; bx++) {
      const x0 = Math.floor((bx * a.width) / columns)
      const x1 = Math.max(x0 + 1, Math.floor(((bx + 1) * a.width) / columns))
      let total = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) total += Math.abs(a.data[y * a.width + x] - b.data[y * b.width + x])
      if (total / ((y1 - y0) * (x1 - x0)) > threshold) changed[by * columns + bx] = 1
    }
  }
  return changed
}

/** Share of the 16x9 blocks that changed between two pictures of the same size. */
export function changedShare(a: Gray, b: Gray): number {
  const changed = changedBlocks(a, b, 16, 9, BLOCK_CHANGE)
  return changed.reduce((sum, value) => sum + value, 0) / changed.length
}

/** Each screen that changed enough from the last one kept and then stayed still; a screen that comes back counts again. */
export function distinctScreens(frames: Gray[], times: number[], duration: number): IndexedScreen[] {
  if (!frames.length) return []
  const kept = [0]
  let last = frames[0]
  for (let index = 1; index < frames.length; index++) {
    const still = index + 1 >= frames.length || changedShare(frames[index], frames[index + 1]) < STILL
    if (changedShare(frames[index], last) >= NEW_SCREEN && still) {
      kept.push(index)
      last = frames[index]
    }
  }
  return kept.map((index, k) => ({ at: times[index], end: k + 1 < kept.length ? times[kept[k + 1]] : Math.max(duration, times[index]) }))
}

/** The shared area: the largest patch of blocks that change now and then, never all the time; null when there is none. */
export function activityArea(frames: Gray[]): Area | null {
  if (frames.length < 4) return null
  const columns = 32
  const rows = 18
  const active = new Float64Array(columns * rows)
  for (let index = 1; index < frames.length; index++) {
    const changed = changedBlocks(frames[index - 1], frames[index], columns, rows, MASK_CHANGE)
    for (let k = 0; k < changed.length; k++) active[k] += changed[k]
  }
  const on = Array.from(active, value => value / (frames.length - 1) >= MASK_MIN && value / (frames.length - 1) < MASK_MAX)
  const seen = new Array(on.length).fill(false)
  let best: number[] = []
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || seen[start]) continue
    const patch: number[] = []
    const stack = [start]
    seen[start] = true
    while (stack.length) {
      const k = stack.pop()!
      patch.push(k)
      const x = k % columns
      const y = Math.floor(k / columns)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        const next = ny * columns + nx
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows || !on[next] || seen[next]) continue
        seen[next] = true
        stack.push(next)
      }
    }
    if (patch.length > best.length) best = patch
  }
  if (!best.length) return null
  const xs = best.map(k => k % columns)
  const ys = best.map(k => Math.floor(k / columns))
  const area = { x: Math.min(...xs) / columns, y: Math.min(...ys) / rows, w: (Math.max(...xs) - Math.min(...xs) + 1) / columns, h: (Math.max(...ys) - Math.min(...ys) + 1) / rows }
  return area.w * area.h >= MASK_MIN_SIZE ? area : null
}

/** The part of a picture inside the area. */
export function region(frame: Gray, area: Area): Gray {
  const x0 = clamp(Math.round(area.x * frame.width), 0, frame.width - 1)
  const y0 = clamp(Math.round(area.y * frame.height), 0, frame.height - 1)
  const x1 = clamp(Math.round((area.x + area.w) * frame.width), x0 + 1, frame.width)
  const y1 = clamp(Math.round((area.y + area.h) * frame.height), y0 + 1, frame.height)
  const width = x1 - x0
  const data = new Uint8Array(width * (y1 - y0))
  for (let y = y0; y < y1; y++) data.set(frame.data.subarray(y * frame.width + x0, y * frame.width + x1), (y - y0) * width)
  return { width, height: y1 - y0, data }
}

/** Fractions of the frame to a box in video pixels (even numbers, like the rest of the pipeline). */
export function toBox(area: Area, width: number, height: number): Box {
  const even = (value: number) => Math.round(value / 2) * 2
  return { x: even(area.x * width), y: even(area.y * height), w: even(area.w * width), h: even(area.h * height) }
}

/** Thumbnails of the whole video, the shared area (mask first, `fallback` only when it fails) and its distinct screens; null without thumbnails. */
export async function indexScreens(source: FrameSource, fallback?: () => Promise<Box | null>): Promise<SceneIndex | null> {
  if (!source.thumbs || !(source.duration > 0)) return null
  const times = sceneTimes(source.duration)
  if (times.length < 2) return null
  const frames = (await source.thumbs(times, THUMB_WIDTH, THUMB_HEIGHT)).map(data => ({ width: THUMB_WIDTH, height: THUMB_HEIGHT, data }))
  const found = activityArea(frames)
  const area = found ? toBox(found, source.width, source.height) : ((await fallback?.()) ?? { x: 0, y: 0, w: source.width, h: source.height })
  const fractions = found ?? { x: area.x / source.width, y: area.y / source.height, w: area.w / source.width, h: area.h / source.height }
  return { area, masked: Boolean(found), screens: distinctScreens(frames.map(frame => region(frame, fractions)), times, source.duration) }
}
