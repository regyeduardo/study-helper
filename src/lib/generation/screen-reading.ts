// Passes 0a/0b of relatorio.md: find the shared work area, then re-read each distinct crop of it.
import { Cancelled } from '@/controllers/ai.controller'
import type { AtaAi } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import type { Box, FrameSource } from '@/lib/generation/ata-types'
import { jsonIn, pool, type Reading } from '@/lib/generation/meeting-material'

/** Two crops closer than this (mean gray difference, 0-255) are the same screen. */
export const SAME_CROP = 0.6
export const MAX_READS = 160
const SAMPLE_STEP = 5
const MAX_SAMPLES = 400

const quiet = async <T>(work: Promise<T>): Promise<T | null> => {
  try {
    return await work
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return null
  }
}

export function sampleTimes(duration: number, scenes?: number[]): number[] {
  if (scenes?.length) return [...new Set(scenes.filter(t => t >= 1 && (!duration || t <= duration)).map(t => Math.round(t * 1000) / 1000))].sort((a, b) => a - b)
  const step = Math.max(SAMPLE_STEP, duration / MAX_SAMPLES)
  const out: number[] = []
  for (let t = 1; t < duration; t += step) out.push(Math.round(t * 10) / 10)
  return out
}

/** Median of the work-area boxes the vision model sees in 9 whole-screen frames, plus a margin, in video pixels. */
export async function findWorkArea(source: FrameSource, ai: AtaAi, times: number[]): Promise<Box | null> {
  if (!times.length) return null
  const sample = Array.from({ length: 9 }, (_, i) => times[Math.min(times.length - 1, Math.floor(((i + 1) * times.length) / 10))])
  const boxes = (
    await pool([...new Set(sample)], 5, async at => {
      const shot = await quiet(source.full(at))
      if (!shot) return null
      return jsonIn((await quiet(ai.see([shot.image], P.AREA, 2000))) ?? '')?.caixa
    })
  ).filter((b): b is number[] => Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number') && b[2] - b[0] > 150 && b[3] - b[1] > 150 && b[2] - b[0] < 950)
  if (!boxes.length) return null
  const median = (k: number) => boxes.map(b => b[k]).sort((a, b) => a - b)[Math.floor(boxes.length / 2)]
  const [x1, y1, x2, y2] = [median(0) - 4, median(1) - 6, median(2) + 4, median(3) + 6].map(v => Math.min(1000, Math.max(0, v)))
  const even = (v: number) => Math.round(v / 2) * 2
  return { x: even((x1 / 1000) * source.width), y: even((y1 / 1000) * source.height), w: even(((x2 - x1) / 1000) * source.width), h: even(((y2 - y1) / 1000) * source.height) }
}

export interface ScreenReading {
  area: Box | null
  readings: Reading[]
  /** Times whose crop was read (used to look for a nearby frame for prints). */
  times: number[]
}

/** Crops the work area at every sampled time, skips near-identical crops and reads the rest. */
export async function readScreen(source: FrameSource, ai: AtaAi, difference: (a: number[], b: number[]) => number, onProgress: (message: string) => void = () => {}): Promise<ScreenReading> {
  const times = sampleTimes(source.duration, source.scenes)
  onProgress('Achando a área compartilhada da tela')
  const area = await findWorkArea(source, ai, times)
  const box: Box = area ?? { x: 0, y: 0, w: source.width, h: source.height }
  onProgress(`Separando as telas diferentes (${times.length} quadros)`)
  const kept: number[] = []
  let last: number[] | null = null
  for (const at of times) {
    const shot = await quiet(source.crop(at, box))
    if (!shot) continue
    if (!last || difference(shot.signature, last) > SAME_CROP) {
      kept.push(at)
      last = shot.signature
    }
  }
  const chosen = kept.length > MAX_READS ? Array.from({ length: MAX_READS }, (_, i) => kept[Math.floor((i * kept.length) / MAX_READS)]) : kept
  let done = 0
  onProgress(`Lendo a tela (${chosen.length} telas)`)
  const readings = await pool(chosen, 8, async at => {
    const shot = await quiet(source.crop(at, box))
    const leitura = shot ? jsonIn((await quiet(ai.see([shot.image], P.LER_TELA, 6000))) ?? '') : null
    done++
    if (done % 10 === 0) onProgress(`Lendo a tela (${done} de ${chosen.length})`)
    return { at, leitura }
  })
  return { area, readings, times: chosen }
}
