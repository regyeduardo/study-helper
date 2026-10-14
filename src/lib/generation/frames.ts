import type { AiSettings, RecordingData, ScreenFrame, Settings } from '@/types/domain'
import { Cancelled, visionController } from '@/controllers/ai.controller'
import { providerOf } from '@/lib/ai/providers'
import { extractJson } from '@/lib/generation/mermaid'
import { transcriptChunks } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { type GrabbedFrame, grabFrames } from '@/lib/recording/frame-grab'
import { transcriptText } from '@/lib/transcription/export'
import { MICROPHONE } from '@/lib/transcription/turns'

const LOOK_AFTER = [0, 2, 5]
const SAME_SCREEN = 8
const SAMPLE_SECONDS = 60
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
  const apiKey = credential?.apiKey ?? (settings.ai.provider === vision.provider ? settings.ai.apiKey : '')
  if (providerOf(vision.provider).needsKey && !apiKey) return null
  return { provider: vision.provider, model: vision.model, apiKey, baseUrl: credential?.baseUrl ?? '' }
}

function seconds(clock: string): number | null {
  const parts = clock.trim().split(':').map(Number)
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

export function screenMoments(recording: RecordingData, asked: number[]): ScreenMoment[] {
  const end = Math.max(0, ...recording.blocks.map(block => block.end))
  const moments: ScreenMoment[] = asked.flatMap(start => LOOK_AFTER.map(after => ({ at: Math.min(start + after, end), kind: 'tela' as const, from: start })))
  for (let at = 0; at <= end; at += SAMPLE_SECONDS) if (!asked.includes(at)) moments.push({ at, kind: 'tela', from: at })
  const seen = new Set<string>()
  for (const block of recording.blocks) {
    if (!block.speaker || block.speaker === MICROPHONE || seen.has(block.speaker)) continue
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
  for (const piece of transcriptChunks(transcriptText(recording))) {
    const hours = extractJson(await session.chat(piece, PROMPTS.SCREEN_ASKS_PROMPT))?.horas
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
    const frames: ScreenFrame[] = []
    const read: GrabbedFrame[] = []
    for (const start of new Set(moments.filter(moment => moment.kind === 'tela').map(moment => moment.from ?? moment.at))) {
      const shots = distinctFrames(moments.filter(moment => moment.from === start).map(moment => grabbed.get(moment.at)).filter((frame): frame is GrabbedFrame => Boolean(frame))).filter(
        shot => !read.some(other => difference(other.signature, shot.signature) < SAME_SCREEN),
      )
      if (!shots.length) continue
      read.push(...shots)
      const text = field(await tools.see(vision, shots.map(shot => shot.image), PROMPTS.SCREEN_TEXT_PROMPT), 'texto')
      if (text) frames.push({ at: start, image: shots[shots.length - 1].image, text })
    }
    const speakers = [...recording.speakers]
    for (const moment of moments.filter(item => item.kind === 'falante')) {
      const shot = grabbed.get(moment.at)
      const index = speakers.findIndex(speaker => speaker.id === moment.speaker)
      if (!shot || index < 0) continue
      const name = field(await tools.see(vision, [shot.image], PROMPTS.SCREEN_NAME_PROMPT.replace('{nome}', speakers[index].name)), 'nome')
      if (name) speakers[index] = { ...speakers[index], name, suggested: false }
    }
    frames.sort((a, b) => a.at - b.at)
    return { ...recording, speakers, ...(frames.length ? { frames } : {}) }
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return { ...recording, warning: [recording.warning, 'Não deu para ler a tela gravada; a nota foi feita só com o som.'].filter(Boolean).join(' ') }
  }
}
