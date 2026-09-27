import type { TranscriptionEngine, TranscriptionSettings } from '@/types/domain'
import { transcribeWithGroqController } from '@/controllers/transcription.controller'
import { decodeToMono16k, durationOf, encodeWav, splitSamples, withoutSilence } from '@/lib/transcription/audio'
import { speakerTurns } from '@/lib/transcription/diarization'
import { transcribeWithParakeet } from '@/lib/transcription/parakeet'
import { transcribeWithPuter } from '@/lib/transcription/puter'
import { withSpeakers } from '@/lib/transcription/speakers'
import type { Progress, Segment } from '@/lib/transcription/types'
import { transcribeWithWhisper } from '@/lib/transcription/whisper'

const GROQ_CHUNK_SECONDS = 600

export interface EngineInfo {
  id: TranscriptionEngine
  name: string
  where: string
  limits: string
}

export const ENGINES: EngineInfo[] = [
  { id: 'whisper', name: 'Whisper (no navegador)', where: 'roda neste navegador', limits: 'baixa ~250 MB na primeira vez; lento sem placa de vídeo (WebGPU); nada sai do seu computador' },
  { id: 'parakeet', name: 'Parakeet (no navegador)', where: 'roda neste navegador', limits: 'baixa ~650 MB na primeira vez (pt-BR ~700 MB); mais rápido e preciso em português; precisa de memória' },
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
  const parts = splitSamples(samples, GROQ_CHUNK_SECONDS)
  const segments: Segment[] = []
  for (const [index, part] of parts.entries()) {
    progress('Transcrevendo pela Groq', index / parts.length)
    segments.push(...(await transcribeWithGroqController(encodeWav(part), settings.groqApiKey, settings.language, index * GROQ_CHUNK_SECONDS, signal)))
  }
  return segments
}

export async function transcribe(audio: Blob, settings: TranscriptionSettings, progress: Progress = () => {}, signal?: AbortSignal): Promise<TranscriptionOutcome> {
  progress('Lendo o áudio')
  const decoded = await decodeToMono16k(audio)
  const samples = withoutSilence(decoded)
  const durationSeconds = durationOf(decoded)

  let segments: Segment[]
  if (settings.engine === 'parakeet') segments = await transcribeWithParakeet(samples, settings.language, progress)
  else if (settings.engine === 'groq') segments = await groqSegments(samples, settings, progress, signal)
  else if (settings.engine === 'puter') segments = await transcribeWithPuter(encodeWav(samples), settings.language, durationOf(samples), progress)
  else segments = await transcribeWithWhisper(samples, settings.language, progress)

  let turns: Awaited<ReturnType<typeof speakerTurns>> = []
  if (settings.separateSpeakers) {
    try {
      turns = await speakerTurns(samples, progress)
    } catch {
      turns = []
    }
  }
  return {
    text: withSpeakers(segments, turns),
    engine: settings.engine,
    language: settings.language,
    durationSeconds,
    speakers: new Set(turns.map(turn => turn.speaker)).size,
  }
}
