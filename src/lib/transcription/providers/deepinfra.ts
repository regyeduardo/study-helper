import { postAudioController, type ServiceName, TranscriptionError } from '@/controllers/transcription.controller'
import { alignWords } from '@/lib/transcription/align'
import { timedWords, turnsOf } from '@/lib/transcription/providers/custom'
import { wordsInSpeech } from '@/lib/transcription/turns'
import { partName, partStart, type ProviderJob, type ProviderResult, sendParts, type SpeakerTurn, withTerms, type Word } from '@/lib/transcription/types'

const TRANSCRIPTION_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions'
const DIARIZATION_URL = 'https://api.deepinfra.com/v1/inference/nvidia/Nemotron-3-Diarization'
const DEEPINFRA: ServiceName = { the: 'A DeepInfra', of: 'da DeepInfra' }

export const DEEPINFRA_MODEL = 'openai/whisper-large-v3'
export const DEEPINFRA_TEXT_MODEL = 'mistralai/Voxtral-Small-24B-2507'

function keyOf(job: ProviderJob): string {
  if (!job.credential.apiKey) throw new TranscriptionError('Falta a chave da DeepInfra nas Configurações (deepinfra.com › Dashboard › API Keys).')
  return job.credential.apiKey
}

async function timed(job: ProviderJob, part: Blob, index: number): Promise<Word[]> {
  const form = new FormData()
  form.append('file', part, partName(part))
  form.append('model', job.credential.model || DEEPINFRA_MODEL)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.append('language', job.language || 'pt')
  return timedWords(await postAudioController(TRANSCRIPTION_URL, keyOf(job), withTerms(form, job), DEEPINFRA, job.signal), partStart(job, index))
}

async function said(job: ProviderJob, part: Blob): Promise<string> {
  const form = new FormData()
  form.append('file', part, partName(part))
  form.append('model', DEEPINFRA_TEXT_MODEL)
  form.append('response_format', 'json')
  form.append('language', job.language || 'pt')
  try {
    const { text } = await postAudioController(TRANSCRIPTION_URL, keyOf(job), form, DEEPINFRA, job.signal)
    return typeof text === 'string' ? text : ''
  } catch (error) {
    if (job.signal?.aborted) throw error
    return ''
  }
}

export async function deepInfraTurns(job: ProviderJob): Promise<SpeakerTurn[]> {
  const form = new FormData()
  form.append('audio', job.audio, 'gravacao')
  return turnsOf((await postAudioController(DIARIZATION_URL, keyOf(job), form, DEEPINFRA, job.signal)).speaker_segments)
}

export async function transcribeWithDeepInfra(job: ProviderJob): Promise<ProviderResult> {
  keyOf(job)
  const pending = deepInfraTurns(job).catch(() => [] as SpeakerTurn[])
  const heard = await sendParts(job, 'Transcrevendo pela DeepInfra', (part, index) => Promise.all([timed(job, part, index), said(job, part)]))
  const turns = await pending
  const words = heard.flatMap(([times, text], index) => {
    const spoken = wordsInSpeech(times, turns)
    return alignWords(spoken.length * 2 >= times.length ? spoken : times, text, partStart(job, index), partStart(job, index) + job.partSeconds)
  })
  return { words, turns, inSpeech: true }
}
