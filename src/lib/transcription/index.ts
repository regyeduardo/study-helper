import type { TranscriptionEngine, TranscriptionSettings } from '@/types/domain'
import { transcribeWithFreeController, transcribeWithGroqController } from '@/controllers/transcription.controller'
import { decodeToMono16k, durationOf, encodeWav, splitSamples, withoutSilence } from '@/lib/transcription/audio'
import { confirmModelDownloads, modelsNeeded } from '@/lib/transcription/consent'
import { freeBalanceSeconds, freeMinutesToken, NotEnoughFreeMinutesError } from '@/lib/transcription/free'
import { runOffThread } from '@/lib/transcription/offload'
import { transcribeWithPuter } from '@/lib/transcription/puter'
import { withSpeakers } from '@/lib/transcription/speakers'
import type { Progress, Segment } from '@/lib/transcription/types'

const REMOTE_CHUNK_SECONDS = 600

export interface EngineInfo {
  id: TranscriptionEngine
  name: string
  where: string
  limits: string
}

export const ENGINES: EngineInfo[] = [
  { id: 'free', name: 'Grátis (30 min/dia)', where: 'serviço grátis do app, com login do Google', limits: '30 min de fala por dia por conta; o silêncio não conta; o áudio vai para a DeepInfra' },
  { id: 'whisper', name: 'Whisper (no navegador)', where: 'roda neste navegador', limits: 'baixa ~510 MB na primeira vez; lento sem placa de vídeo (WebGPU); nada sai do seu computador' },
  { id: 'parakeet', name: 'Parakeet (no navegador)', where: 'roda neste navegador', limits: 'baixa ~670 MB na primeira vez (pt-BR ~930 MB; com placa de vídeo até ~2,5 GB); mais rápido e preciso em português; precisa de memória' },
  { id: 'groq', name: 'Groq Whisper', where: 'serviço grátis com chave', limits: 'chave grátis; 20 pedidos/min, 2.000/dia, 8 h de áudio/dia; o áudio vai para a Groq' },
  { id: 'puter', name: 'Puter', where: 'serviço com conta Puter', limits: 'você entra numa conta Puter, que paga ou limita o uso; o áudio vai para o Puter' },
]

export interface TranscriptionOutcome {
  text: string
  engine: TranscriptionEngine
  language: string
  durationSeconds: number
  speakers: number
}

async function groqSegments(samples: Float32Array, settings: TranscriptionSettings, progress: Progress, signal?: AbortSignal): Promise<Segment[]> {
  const parts = splitSamples(samples, REMOTE_CHUNK_SECONDS)
  const segments: Segment[] = []
  for (const [index, part] of parts.entries()) {
    progress('Transcrevendo pela Groq', index / parts.length)
    segments.push(...(await transcribeWithGroqController(encodeWav(part), settings.groqApiKey, settings.language, index * REMOTE_CHUNK_SECONDS, signal)))
  }
  return segments
}

async function freeSegments(samples: Float32Array, settings: TranscriptionSettings, progress: Progress, signal?: AbortSignal): Promise<Segment[]> {
  const remaining = await freeBalanceSeconds()
  const speech = durationOf(samples)
  if (speech > remaining) throw new NotEnoughFreeMinutesError(remaining, speech)
  const parts = splitSamples(samples, REMOTE_CHUNK_SECONDS)
  const segments: Segment[] = []
  for (const [index, part] of parts.entries()) {
    progress('Transcrevendo com os minutos grátis', index / parts.length)
    segments.push(...(await transcribeWithFreeController(encodeWav(part), await freeMinutesToken(), settings.language, index * REMOTE_CHUNK_SECONDS, signal)))
  }
  return segments
}

export async function transcribe(audio: Blob, settings: TranscriptionSettings, progress: Progress = () => {}, signal?: AbortSignal): Promise<TranscriptionOutcome> {
  progress('Lendo o áudio')
  const decoded = await decodeToMono16k(audio)
  const samples = withoutSilence(decoded)
  const durationSeconds = durationOf(decoded)

  let remote: Segment[] | null = null
  if (settings.engine === 'free') remote = await freeSegments(samples, settings, progress, signal)
  else if (settings.engine === 'groq') remote = await groqSegments(samples, settings, progress, signal)
  else if (settings.engine === 'puter') remote = await transcribeWithPuter(encodeWav(samples), settings.language, durationOf(samples), progress)
  const engine = remote ? null : settings.engine === 'parakeet' ? 'parakeet' : 'whisper'
  if (engine || settings.separateSpeakers) await confirmModelDownloads(modelsNeeded(engine, settings.language, settings.separateSpeakers))
  const local = engine || settings.separateSpeakers ? await runOffThread({ engine, language: settings.language, separateSpeakers: settings.separateSpeakers, samples }, progress) : { segments: null, turns: [] }
  const segments = remote ?? local.segments ?? []
  const turns = local.turns
  return {
    text: withSpeakers(segments, turns),
    engine: settings.engine,
    language: settings.language,
    durationSeconds,
    speakers: new Set(turns.map(turn => turn.speaker)).size,
  }
}
