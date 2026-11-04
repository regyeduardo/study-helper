// Passes 0a/0b of relatorio.md: find the shared work area, then re-read each distinct crop of it.
// Visão 4.1 (with `looks`): the distinct screens and the area come from the local index, their text from the
// local OCR, and the vision model only says what a screen means where the speech points at it or a mark was made.
import type { RecordingMark, ScreenIndex } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import type { AtaAi } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import type { Box, FrameSource, OcrText, ScreenOcr } from '@/lib/generation/ata-types'
import { clock, jsonIn, oneLine, pool, type Reading, type ScreenGroup, short } from '@/lib/generation/meeting-material'
import { indexScreens, type IndexedScreen } from '@/lib/generation/scene-index'
import { type ScreenTerms, seenIn, SURE, termsIn, voteTerms } from '@/lib/generation/screen-terms'

/** Two crops closer than this (mean gray difference, 0-255) are the same screen. */
export const SAME_CROP = 0.6
export const MAX_READS = 160
const SAMPLE_STEP = 5
const MAX_SAMPLES = 400
/** Screens the speech points at that the vision model explains; the marks never count against it. */
export const MAX_LOOKS = 40
/** A mark looks at the screen from this many seconds before it (people click after they see). */
export const MARK_BEFORE = 15
const MAX_OCR = 240
const LOOK_TOKENS = 600

const spread = <T>(items: T[], size: number) => (items.length > size ? Array.from({ length: size }, (_, k) => items[Math.floor((k * items.length) / size)]) : items)

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
  /** Visão 4.1: one line per distinct screen (OCR text, plus the meaning where it was asked). */
  screen?: ScreenGroup[]
  terms?: ScreenTerms
  /** What was on the screen at each mark, by mark id. */
  marked?: Map<string, string>
}

/** What visão 4.1 needs besides the video: the OCR, where the speech points at the screen, the marks and the speech. */
export interface ScreenLooks {
  ocr: ScreenOcr | null
  asked: Promise<number[]> | number[]
  marks: RecordingMark[]
  /** The screens the transcription already found and read: used when they are of this video. */
  saved?: ScreenIndex | null
  /** "mm:ss | Nome: texto" lines between two seconds. */
  speech(from: number, to: number): string
}

/** Crops the work area at every sampled time, skips near-identical crops and reads the rest; with `looks`, visão 4.1. */
export async function readScreen(source: FrameSource, ai: AtaAi, difference: (a: number[], b: number[]) => number, onProgress: (message: string) => void = () => {}, looks?: ScreenLooks): Promise<ScreenReading> {
  if (looks) {
    const saved = looks.saved?.screens.length && looks.saved.width === source.width && looks.saved.height === source.height ? looks.saved : null
    if (saved) {
      onProgress('Usando as telas que a transcrição já separou')
      return readIndexed(source, ai, saved.area, saved.screens, looks, onProgress)
    }
    onProgress('Separando as telas diferentes (sem IA)')
    const index = await quiet(indexScreens(source, () => (ai.hasVision ? findWorkArea(source, ai, sampleTimes(source.duration)) : Promise.resolve(null))))
    if (index?.screens.length) return readIndexed(source, ai, index.area, index.screens, looks, onProgress)
    if (!ai.hasVision) return { area: null, readings: [], times: [] }
  }
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

/** What the transcription keeps for the Ata: the index of the video with the text of its screens. Null without the mask area (the Ata asks the vision model for it) or without thumbnails. */
export async function indexAndRead(source: FrameSource, ocr: ScreenOcr | null, signal?: AbortSignal): Promise<ScreenIndex | null> {
  const index = await quiet(indexScreens(source))
  if (!index?.masked || !index.screens.length || signal?.aborted) return null
  const read = new Set(spread(index.screens.map((_, k) => k), MAX_OCR))
  const screens = await Promise.all(
    index.screens.map(async (screen, k) => {
      if (!ocr || !read.has(k) || signal?.aborted) return screen
      const shot = await quiet(source.crop(screen.at, index.area))
      const texts = shot ? await ocr.read(shot.image).catch(() => undefined) : undefined
      return texts ? { ...screen, texts } : screen
    }),
  )
  return { width: source.width, height: source.height, area: index.area, screens }
}

const textOf = (texts: OcrText[], sure: boolean) => texts.filter(item => (item.confidence >= SURE) === sure).map(item => oneLine(item.text)).filter(Boolean)

interface Look {
  /** Indexes of the screens it covers. */
  screens: number[]
  images: Promise<string | null>[]
  at: number
  falas: string
  mark?: RecordingMark
}

async function readIndexed(source: FrameSource, ai: AtaAi, box: Box, screens: IndexedScreen[], looks: ScreenLooks, onProgress: (message: string) => void): Promise<ScreenReading> {
  const showing = (at: number) => Math.max(0, screens.findIndex((screen, index) => at < screen.end || index === screens.length - 1))
  const crop = (at: number) => quiet(source.crop(at, box)).then(shot => shot?.image ?? null)
  const texts = new Map<number, Promise<OcrText[]>>()
  const ocr = looks.ocr
  const readText = (index: number) => {
    const kept = screens[index].texts
    if (!texts.has(index)) texts.set(index, kept ? Promise.resolve(kept) : ocr ? crop(screens[index].at).then(image => (image ? ocr.read(image).catch(() => []) : [])) : Promise.resolve([]))
    return texts.get(index)!
  }

  // the marked screens first, then where the speech points, then the rest: the questions start before the OCR ends
  const marked = [...looks.marks]
    .sort((a, b) => a.at - b.at)
    .map(mark => {
      const window = screens.map((screen, index) => ({ screen, index })).filter(({ screen }) => screen.at <= mark.at && screen.end > mark.at - MARK_BEFORE)
      return { mark, screens: window.length ? window.map(item => item.index) : [showing(mark.at)] }
    })
  marked.forEach(item => item.screens.forEach(readText))
  const asked = ai.hasVision ? ((await quiet(Promise.resolve(looks.asked))) ?? []) : []
  const pointed = new Map<number, number[]>()
  for (const at of asked) {
    const index = showing(at)
    if (marked.some(item => item.screens.includes(index))) continue
    pointed.set(index, [...(pointed.get(index) ?? []), at])
  }
  const chosen = spread([...pointed], MAX_LOOKS)
  const first = [...new Set([...marked.flatMap(item => item.screens), ...chosen.map(([index]) => index)])]
  const later = spread(
    screens.map((_, index) => index).filter(index => !first.includes(index)),
    Math.max(0, MAX_OCR - first.length),
  )
  const order = [...first, ...later]
  if (order.some(index => !screens[index].texts)) onProgress(`Lendo o texto da tela no computador (${order.length} telas)`)
  first.forEach(readText)
  const questions: Look[] = ai.hasVision
    ? [
        ...marked.map(({ mark, screens: covered }) => ({ screens: covered, images: [crop(mark.at)], at: mark.at, falas: looks.speech(mark.at - MARK_BEFORE - 5, mark.at + 5), mark })),
        ...chosen.map(([index, ats]) => ({ screens: [index], images: [crop(ats[0])], at: ats[0], falas: [...new Set(ats.flatMap(at => looks.speech(at - 5, at + 20).split('\n')))].filter(Boolean).join('\n') })),
      ]
    : []
  later.forEach(readText)

  const meaning = new Map<number, Record<string, unknown>>()
  const seenAtMark = new Map<string, string>()
  const confirmed: string[] = []
  if (questions.length) onProgress(`Perguntando à IA o sentido da tela (${questions.length} momentos)`)
  await pool(questions, 8, async look => {
    const read = (await Promise.all(look.screens.map(readText))).flat()
    const images = (await Promise.all(look.images)).filter((image): image is string => Boolean(image))
    if (!images.length) return
    const nota = look.mark ? `Quem gravou marcou este momento${look.mark.text.trim() ? ` e anotou: «${oneLine(look.mark.text)}»` : ''}. Diga o que, na tela, corresponde a isso.` : ''
    // replacer functions: the read text may carry "$" (spreadsheet formulas)
    const prompt = P.SENTIDO_TELA.replace('{{minuto}}', () => clock(look.at))
      .replace('{{exato}}', () => short(textOf(read, true).join(' · '), 900) || '(nada)')
      .replace('{{duvida}}', () => short(textOf(read, false).join(' · '), 300) || '(nada)')
      .replace('{{falas}}', () => look.falas.slice(0, 1200) || '(ninguém falando)')
      .replace('{{nota}}', () => nota)
    const got = jsonIn((await quiet(ai.see(images, prompt, LOOK_TOKENS))) ?? '')
    if (!got) return
    const said = [got.tela, got.o_que_mostra].map(oneLine).filter(Boolean).join(' — ')
    if (look.mark && said) seenAtMark.set(look.mark.id, said)
    meaning.set(look.screens[look.screens.length - 1], got)
    // a term the vision model names counts only when the OCR read it too, sure or not ("FGT5" seen as "FGTS"): never an invented one
    const readTerms = read.flatMap(item => termsIn(item.text))
    for (const term of Array.isArray(got.termos) ? got.termos : []) if (typeof term === 'string' && term.trim() && seenIn(term.trim(), readTerms)) confirmed.push(term.trim())
  })

  const byScreen = new Map(await Promise.all(order.map(index => readText(index).then(found => [index, found] as const))))
  const terms = voteTerms(screens.map((_, index) => byScreen.get(index) ?? []))
  const groups: ScreenGroup[] = []
  let before = new Set<string>()
  screens.forEach((screen, index) => {
    const sure = textOf(byScreen.get(index) ?? [], true)
    const fresh = sure.filter(text => !before.has(text))
    before = new Set(sure)
    const got = meaning.get(index)
    const parts = got ? [oneLine(got.tela), oneLine(got.o_que_mostra), got.a_fala_se_refere_a ? `a fala aponta: ${oneLine(got.a_fala_se_refere_a)}` : ''] : []
    const text = [...parts, fresh.length ? `texto: ${short(fresh.join(' · '), 400)}` : ''].filter(Boolean).join(' · ')
    if (text) groups.push({ at: screen.at, end: screen.end, ats: [screen.at], tela: short(oneLine(got?.tela) || sure[0] || '', 60), resumo: short(oneLine(got?.o_que_mostra), 140), text })
  })
  for (const { mark, screens: covered } of marked) {
    if (seenAtMark.has(mark.id)) continue
    const sure = covered.flatMap(index => textOf(byScreen.get(index) ?? [], true))
    if (sure.length) seenAtMark.set(mark.id, short([...new Set(sure)].join(' · '), 200))
  }
  return { area: box, readings: [], times: screens.map(screen => screen.at), screen: groups, terms: { exact: [...new Set([...terms.exact, ...confirmed])], doubtful: terms.doubtful.filter(term => !confirmed.some(sure => seenIn(sure, [term]))) }, marked: seenAtMark }
}
