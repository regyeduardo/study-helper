import type { AiSettings, RecordingData, ScreenFrame, Settings } from '@/types/domain'
import { Cancelled, visionController } from '@/controllers/ai.controller'
import { providerOf } from '@/lib/ai/providers'
import { pool } from '@/lib/generation/meeting-material'
import { extractJson } from '@/lib/generation/mermaid'
import { transcriptChunks } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { type GrabbedFrame, grabFrames } from '@/lib/recording/frame-grab'
import { transcriptText } from '@/lib/transcription/export'
import { MICROPHONE, RECORDER } from '@/lib/transcription/turns'

const LOOK_AFTER = [0, 2, 5]
const SAME_SCREEN = 8
const SEE_AT_ONCE = 4
const NO_VISION = 'A tela gravada não foi usada: escolha um Modelo de visão em Configurações › IA para o agente ler os nomes e os slides.'

export interface ScreenMoment {
  at: number
  kind: 'tela' | 'falante'
  speaker?: string
  from?: number
}

export interface ScreenTools {
  grab(video: Blob, times: number[]): Promise<GrabbedFrame[]>
  see(settings: AiSettings, images: string[], prompt: string): Promise<string>
}

const REAL_TOOLS: ScreenTools = { grab: grabFrames, see: (settings, images, prompt) => visionController(settings, images, prompt) }

export function visionSettingsOf(settings: Settings): AiSettings | null {
  const vision = settings.vision
  if (!vision?.provider || !vision.model) return null
  const credential = settings.aiCredentials[vision.provider]
  const same = settings.ai.provider === vision.provider
  const apiKey = credential?.apiKey || (same ? settings.ai.apiKey : '')
  if (providerOf(vision.provider).needsKey && !apiKey) return null
  return { provider: vision.provider, model: vision.model, apiKey, baseUrl: credential?.baseUrl || (same ? settings.ai.baseUrl : '') }
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

async function askedMoments(recording: RecordingData, session: GenerationSession): Promise<number[]> {
  const starts = recording.blocks.map(block => block.start)
  const found = new Set<number>()
  const answers = await Promise.all(transcriptChunks(transcriptText(recording)).map(piece => session.chat(piece, PROMPTS.SCREEN_ASKS_PROMPT)))
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
  if (!vision) return { ...recording, warning: [recording.warning, NO_VISION].filter(Boolean).join(' ') }
  try {
    const asked = await askedMoments(recording, session)
    const moments = screenMoments(recording, asked)
    const times = [...new Set(moments.map(moment => moment.at))].sort((a, b) => a - b)
    const grabbed = new Map((await tools.grab(video, times)).map(frame => [frame.at, frame]))
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
    return { ...recording, speakers, ...(frames.length ? { frames } : {}) }
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return { ...recording, warning: [recording.warning, 'Não deu para ler a tela gravada; a nota foi feita só com o som.'].filter(Boolean).join(' ') }
  }
}
