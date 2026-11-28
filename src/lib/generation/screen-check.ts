import type { AiSettings } from '@/types/domain'
import { Cancelled, visionController } from '@/controllers/ai.controller'
import { withRetry } from '@/lib/generation/ata-ai'
import type { FrameSource } from '@/lib/generation/ata-types'
import { browserOcr } from '@/lib/generation/screen-ocr'
import { openVideoFrames } from '@/lib/generation/video-source'

/** Where the video is tried: near the start, the middle and near the end. */
const POINTS = [0.1, 0.5, 0.9]
/** A frame this dark and this flat (gray 0 to 255) shows no screen: the black recording of T170 and T171 measured 15 to 16. */
const DARK = 24
const FLAT = 4
const TRY_TOKENS = 16
const TRY_PROMPT = 'Responda só: ok'
const TRY_TIMEOUT_MS = 30_000

export const NO_READER = 'Ninguém lê a tela: escolha um modelo de visão no passo Vídeo (ou em Configurações › Inteligência artificial › Leitura de tela).'
export const DARK_VIDEO = 'O vídeo está todo escuro no começo, no meio e no fim: a gravação não pegou a imagem da tela, então não há o que ler.'

export interface ProbedFrame {
  at: number
  image: string
  /** Mean and spread (standard deviation) of its gray, 0 to 255: flat and dark is a screen that was not recorded. */
  mean: number
  spread: number
}

export interface CheckTools {
  /** Frames of the video at these fractions of its length; throws with the reason. */
  probe(video: Blob | FrameSource, fractions: number[]): Promise<ProbedFrame[]>
  see(settings: AiSettings, images: string[], prompt: string, signal?: AbortSignal, maxTokens?: number): Promise<string>
}

function grayOf(signature: number[]): { mean: number; spread: number } {
  const count = Math.max(1, signature.length)
  const mean = signature.reduce((total, value) => total + value, 0) / count
  const variance = signature.reduce((total, value) => total + (value - mean) ** 2, 0) / count
  return { mean, spread: Math.sqrt(variance) }
}

const isSource = (video: Blob | FrameSource): video is FrameSource => typeof (video as FrameSource).full === 'function'

/**
 * The frames of the check, read the way the screen is read (openVideoFrames: the same hidden video, the same limits): a source already
 * open (the Ata, the Aula) is used and left open; a video is opened here and closed. A video that does not say its length is tried once.
 */
export async function probeVideo(video: Blob | FrameSource, fractions: number[]): Promise<ProbedFrame[]> {
  const source = isSource(video) ? video : await openVideoFrames(video)
  try {
    const times = source.duration > 0 ? fractions.map(fraction => Math.round(source.duration * fraction * 10) / 10) : [1]
    const frames: ProbedFrame[] = []
    for (const at of times) {
      const shot = await source.full(at)
      frames.push({ at, image: shot.image, ...grayOf(shot.signature) })
    }
    return frames
  } finally {
    if (!isSource(video)) source.close?.()
  }
}

const REAL: CheckTools = {
  probe: probeVideo,
  see: (settings, images, prompt, signal, maxTokens) => withRetry(own => visionController(settings, images, prompt, own, maxTokens), { signal, timeoutMs: TRY_TIMEOUT_MS, attempts: 2 }),
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * T188 (dono, 27/11: "se marcar pra ver a tela é pra ver a tela, e quando houver problemas semelhantes já avisar antes de iniciar qualquer
 * gasto"): before anything is spent on the screen of a video (the transcription, the questions to the AI, the frames), whether it can be
 * read where the work runs. Someone reads it (a vision model, or the local OCR for the text alone: `ocr`, by default whether it runs
 * here; it starts no worker until it reads); the video opens and jumps to its
 * start, middle and end within seconds, with a picture there; the vision model answers about one frame of it (a few tokens).
 * Null: it can be read. Otherwise, why not, in words for the person.
 */
export async function checkScreen(video: Blob | FrameSource, vision: AiSettings | null, { ocr = browserOcr() !== null, signal }: { ocr?: boolean; signal?: AbortSignal } = {}, tools: CheckTools = REAL): Promise<string | null> {
  if (signal?.aborted) throw new Cancelled()
  if (!vision && !ocr) return NO_READER
  let frames: ProbedFrame[]
  try {
    frames = await tools.probe(video, POINTS)
  } catch (error) {
    if (signal?.aborted) throw new Cancelled()
    return `O vídeo não deixa ler os quadros: ${messageOf(error)}`
  }
  if (signal?.aborted) throw new Cancelled()
  if (frames.length && frames.every(frame => frame.mean < DARK && frame.spread < FLAT)) return DARK_VIDEO
  if (!vision) return null
  const sample = [...frames].sort((a, b) => b.spread - a.spread)[0]
  if (!sample) return null
  try {
    await tools.see(vision, [sample.image], TRY_PROMPT, signal, TRY_TOKENS)
  } catch (error) {
    if (signal?.aborted || error instanceof Cancelled) throw new Cancelled()
    return `O modelo de visão falhou no teste com um quadro do vídeo: ${messageOf(error)}`
  }
  return null
}
