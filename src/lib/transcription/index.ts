import type { ProviderEngine, RecordingData, SpeakersEngine, TranscriptionCredential, TranscriptionEngine, TranscriptionSettings } from '@/types/domain'
import { decodeChannels16k, durationOf, encodeWav, mixedDown, splitSamples } from '@/lib/transcription/audio'
import { transcriptText } from '@/lib/transcription/export'
import { transcribeWithCustom } from '@/lib/transcription/providers/custom'
import { deepInfraTurns, transcribeWithDeepInfra } from '@/lib/transcription/providers/deepinfra'
import { transcribeWithGemini } from '@/lib/transcription/providers/gemini'
import { transcribeWithOpenAi } from '@/lib/transcription/providers/openai'
import { blocksFromWords, microphoneWords, speakersOf } from '@/lib/transcription/turns'
import type { Progress, ProviderJob, ProviderResult, SpeakerTurn } from '@/lib/transcription/types'

const PROVIDER_PART_SECONDS = 300
const CHOOSE_ENGINE = 'Escolha um provedor de transcrição em Configurações › Transcrição.'

export interface EngineInfo {
  id: TranscriptionEngine
  name: string
  where: string
  limits: string
}

export const ENGINES: EngineInfo[] = [
  { id: 'openai', name: 'OpenAI', where: 'serviço pago, com a sua chave', limits: 'separa quem fala (gpt-4o-transcribe-diarize); o áudio vai para a OpenAI' },
  { id: 'deepinfra', name: 'DeepInfra', where: 'serviço pago, com a sua chave', limits: 'separa quem fala (Nemotron) e transcreve com tempo por palavra (Whisper); o áudio vai para a DeepInfra' },
  { id: 'gemini', name: 'Google Gemini', where: 'serviço do Google, com a sua chave', limits: 'separa quem fala; os tempos são aproximados; o áudio vai para o Google' },
  { id: 'custom', name: 'Personalizado', where: 'qualquer serviço no formato da OpenAI', limits: 'você informa endereço, chave e modelo; os falantes aparecem se o serviço devolver' },
]

export interface TranscriptionOutcome {
  text: string
  engine: TranscriptionEngine
  language: string
  durationSeconds: number
  speakers: number
  recording?: RecordingData
}

export interface TranscribeOptions {
  microphoneOnLeft?: boolean
}

const PROVIDERS: Record<ProviderEngine, (job: ProviderJob) => Promise<ProviderResult>> = {
  openai: transcribeWithOpenAi,
  deepinfra: transcribeWithDeepInfra,
  gemini: transcribeWithGemini,
  custom: transcribeWithCustom,
}

const NO_SPEAKERS = 'Este provedor não separa quem fala. Para ver os falantes, escolha em Configurações › Transcrição um segundo provedor só para isso.'
const EMPTY_CREDENTIAL: TranscriptionCredential = { apiKey: '', baseUrl: '', model: '', extra: '' }

function isProvider(engine: TranscriptionEngine): engine is ProviderEngine {
  return engine in PROVIDERS
}

async function otherSpeakers(engine: Exclude<SpeakersEngine, ''>, job: ProviderJob): Promise<SpeakerTurn[]> {
  job.progress('Separando quem fala')
  return engine === 'deepinfra' ? deepInfraTurns(job) : (await PROVIDERS[engine](job)).turns
}

async function transcribeWithProvider(engine: ProviderEngine, audio: Blob, settings: TranscriptionSettings, progress: Progress, signal: AbortSignal | undefined, options: TranscribeOptions): Promise<TranscriptionOutcome> {
  const channels = await decodeChannels16k(audio)
  const samples = mixedDown(channels)
  const credentials = settings.credentials ?? {}
  const job: ProviderJob = { audio, parts: splitSamples(samples, PROVIDER_PART_SECONDS).map(part => encodeWav(part)), partSeconds: PROVIDER_PART_SECONDS, language: settings.language, credential: credentials[engine] ?? EMPTY_CREDENTIAL, progress, signal }
  const heard = await PROVIDERS[engine](job)
  let turns = heard.turns
  let warning = ''
  const second = settings.speakersEngine
  if (!turns.length && second && second !== engine) {
    try {
      turns = await otherSpeakers(second, { ...job, credential: credentials[second] ?? EMPTY_CREDENTIAL })
    } catch (error) {
      if (signal?.aborted) throw error
      warning = `Os falantes não foram separados: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!turns.length && !warning) warning = NO_SPEAKERS
  const blocks = blocksFromWords(heard.words, turns, options.microphoneOnLeft && channels.length === 2 ? microphoneWords({ microphone: channels[0], computer: channels[1] }) : undefined)
  const speakers = speakersOf(blocks)
  const recording: RecordingData = { blocks, speakers, marks: [], ...(warning ? { warning } : {}) }
  return { text: transcriptText(recording).trim(), engine, language: settings.language, durationSeconds: durationOf(samples), speakers: speakers.length, recording }
}

export async function transcribe(audio: Blob, settings: TranscriptionSettings, progress: Progress = () => {}, signal?: AbortSignal, options: TranscribeOptions = {}): Promise<TranscriptionOutcome> {
  if (!isProvider(settings.engine)) throw new Error(CHOOSE_ENGINE)
  progress('Lendo o áudio')
  return transcribeWithProvider(settings.engine, audio, settings, progress, signal, options)
}
