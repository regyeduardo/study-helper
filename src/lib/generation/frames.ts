import type { AiSettings, RecordingData, ScreenFrame, ScreenIndex, Settings } from '@/types/domain'
import { Cancelled, visionController } from '@/controllers/ai.controller'
import { visionOf } from '@/lib/ai/config'
import type { ScreenOcr } from '@/lib/generation/ata-types'
import { pool } from '@/lib/generation/meeting-material'
import { extractJson } from '@/lib/generation/mermaid'
import { transcriptChunks } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { browserOcr } from '@/lib/generation/screen-ocr'
import { indexAndRead } from '@/lib/generation/screen-reading'
import { voteTerms } from '@/lib/generation/screen-terms'
import type { GenerationSession } from '@/lib/generation/session'
import { openVideoFrames } from '@/lib/generation/video-source'
import { type GrabbedFrame, grabFrames } from '@/lib/recording/frame-grab'
import { transcriptText } from '@/lib/transcription/export'
import { MICROPHONE, RECORDER } from '@/lib/transcription/turns'

const LOOK_AFTER = [0, 2, 5]
const SAME_SCREEN = 8
const SEE_AT_ONCE = 4
const NO_VISION = 'A tela gravada não foi usada: escolha um modelo de Leitura de tela (ou de Vídeo e áudio) em Configurações › Inteligência artificial › Padrões por uso para o agente ler os nomes e os slides.'
const OCR_ONLY = 'A tela gravada foi lida só pelo texto (OCR local): escolha um modelo de Leitura de tela (ou de Vídeo e áudio) em Configurações › Inteligência artificial › Padrões por uso para o agente entender os slides.'

export interface ScreenMoment {
  at: number
  kind: 'tela' | 'falante'
  speaker?: string
  from?: number
}

export interface ScreenTools {
  grab(video: Blob, times: number[]): Promise<GrabbedFrame[]>
  see(settings: AiSettings, images: string[], prompt: string): Promise<string>
  /** The local OCR (null where it cannot run). */
  ocr?(): ScreenOcr | null
  /** The distinct screens of the whole video with their text, to keep for the Ata (null when there are none to keep). */
  index?(video: Blob, ocr: ScreenOcr | null, signal?: AbortSignal): Promise<ScreenIndex | null>
}

async function keptIndex(video: Blob, ocr: ScreenOcr | null, signal?: AbortSignal): Promise<ScreenIndex | null> {
  const source = await openVideoFrames(video)
  try {
    return await indexAndRead(source, ocr, signal)
  } finally {
    source.close?.()
  }
}

const REAL_TOOLS: ScreenTools = { grab: grabFrames, see: (settings, images, prompt) => visionController(settings, images, prompt), ocr: browserOcr, index: keptIndex }

/** Leitura de tela (own, or the Vídeo e áudio model), or the one picked at generation time; null without a usable one. */
export function visionSettingsOf(settings: Settings, pick?: string | null): AiSettings | null {
  return visionOf(settings, pick)
}

function seconds(clock: string): number | null {
  const parts = clock.trim().split(':').map(Number)
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

export function screenMoments(recording: RecordingData, asked: number[]): ScreenMoment[] {
  const end = Math.max(0, ...recording.blocks.map(block => block.end))
  const moments: ScreenMoment[] = asked.flatMap(start => LOOK_AFTER.map(after => ({ at: Math.min(start + after, end), kind: 'tela' as const, from: start })))
  const seen = new Set<string>()
  // The microphone is looked at only while nobody knows who recorded.
  const recorderKnown = recording.speakers.some(speaker => speaker.id === MICROPHONE && speaker.name !== RECORDER)
  for (const block of recording.blocks) {
    if (!block.speaker || (block.speaker === MICROPHONE && recorderKnown) || seen.has(block.speaker)) continue
    seen.add(block.speaker)
    moments.push({ at: block.start + Math.min(1, (block.end - block.start) / 2), kind: 'falante', speaker: block.speaker })
  }
  return moments
}

function difference(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (!length) return Infinity
  let total = 0
  for (let index = 0; index < length; index++) total += Math.abs(a[index] - b[index])
  return total / length
}

export function distinctFrames(frames: GrabbedFrame[]): GrabbedFrame[] {
  const kept: GrabbedFrame[] = []
  for (const frame of frames) if (!kept.some(other => difference(other.signature, frame.signature) < SAME_SCREEN)) kept.push(frame)
  return kept
}

/** Starts of the speech blocks where the speech needs the screen (names, acronyms, "olha essa tela"). */
export async function askedMoments(recording: RecordingData, chat: (user: string, system: string) => Promise<string>): Promise<number[]> {
  const starts = recording.blocks.map(block => block.start)
  const found = new Set<number>()
  const answers = await Promise.all(transcriptChunks(transcriptText(recording)).map(piece => chat(piece, PROMPTS.SCREEN_ASKS_PROMPT)))
  for (const answer of answers) {
    const hours = extractJson(answer)?.horas
    if (!Array.isArray(hours)) continue
    for (const hour of hours) {
      const at = typeof hour === 'string' ? seconds(hour) : null
      if (at === null) continue
      found.add(starts.reduce((best, start) => (Math.abs(start - at) < Math.abs(best - at) ? start : best), at))
    }
  }
  return [...found].sort((a, b) => a - b)
}

function field(raw: string, name: string): string {
  const value = extractJson(raw)?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

export async function lookAtScreen(recording: RecordingData, video: Blob | null, vision: AiSettings | null, session: GenerationSession, tools: ScreenTools = REAL_TOOLS): Promise<RecordingData> {
  if (!video) return recording
  const ocr = tools.ocr?.() ?? null
  if (!vision && !ocr) return { ...recording, warning: [recording.warning, NO_VISION].filter(Boolean).join(' ') }
  // the screens of the whole video are found next to the rest and kept with the recording; failing never fails the look
  const indexing = tools.index?.(video, ocr, session.signal).catch(() => null)
  const kept = async () => {
    const screenIndex = await indexing
    return screenIndex ? { screenIndex } : {}
  }
  try {
    const asked = await askedMoments(recording, (user, system) => session.chat(user, system))
    const moments = screenMoments(recording, asked)
    const times = [...new Set(moments.map(moment => moment.at))].sort((a, b) => a - b)
    const grabbed = new Map((await tools.grab(video, times)).map(frame => [frame.at, frame]))
    // The local OCR reads each distinct frame (exact text, free) while the vision model looks; unsure readings never become terms.
    const reading = Promise.all(distinctFrames([...grabbed.values()]).map(frame => (ocr ? ocr.read(frame.image).catch(() => []) : [])))
    if (!vision) {
      const screenTerms = voteTerms(await reading).exact
      return { ...recording, warning: [recording.warning, screenTerms.length ? OCR_ONLY : NO_VISION].filter(Boolean).join(' '), ...(screenTerms.length ? { screenTerms } : {}), ...(await kept()) }
    }
    const looks: { at: number; shots: GrabbedFrame[] }[] = []
    const read: GrabbedFrame[] = []
    for (const start of new Set(moments.filter(moment => moment.kind === 'tela').map(moment => moment.from ?? moment.at))) {
      const shots = distinctFrames(moments.filter(moment => moment.from === start).map(moment => grabbed.get(moment.at)).filter((frame): frame is GrabbedFrame => Boolean(frame))).filter(
        shot => !read.some(other => difference(other.signature, shot.signature) < SAME_SCREEN),
      )
      if (!shots.length) continue
      read.push(...shots)
      looks.push({ at: start, shots })
    }
    const speakers = [...recording.speakers]
    const faces = moments.flatMap(moment => {
      const shot = moment.kind === 'falante' ? grabbed.get(moment.at) : undefined
      const index = speakers.findIndex(speaker => speaker.id === moment.speaker)
      return shot && index >= 0 ? [{ shot, index }] : []
    })
    // Which screens to read is settled above; the vision calls themselves run side by side.
    const asks = [
      ...looks.map(look => () => tools.see(vision, look.shots.map(shot => shot.image), PROMPTS.SCREEN_TEXT_PROMPT)),
      ...faces.map(face => () => tools.see(vision, [face.shot.image], PROMPTS.SCREEN_NAME_PROMPT.replace('{nome}', speakers[face.index].name))),
    ]
    const answers = await pool(asks, SEE_AT_ONCE, ask => ask())
    const frames: ScreenFrame[] = []
    looks.forEach((look, index) => {
      const text = field(answers[index], 'texto')
      if (text) frames.push({ at: look.at, image: look.shots[look.shots.length - 1].image, text })
    })
    faces.forEach((face, index) => {
      const name = field(answers[looks.length + index], 'nome')
      if (name) speakers[face.index] = { ...speakers[face.index], name, suggested: false }
    })
    frames.sort((a, b) => a.at - b.at)
    const screenTerms = voteTerms(await reading).exact
    return { ...recording, speakers, ...(frames.length ? { frames } : {}), ...(screenTerms.length ? { screenTerms } : {}), ...(await kept()) }
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return { ...recording, warning: [recording.warning, 'Não deu para ler a tela gravada; a nota foi feita só com o som.'].filter(Boolean).join(' '), ...(await kept()) }
  } finally {
    ocr?.close?.()
  }
}
