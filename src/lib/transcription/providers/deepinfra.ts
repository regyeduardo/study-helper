import { type AudioRequest, postAudioController, type ServiceName, TranscriptionError } from '@/controllers/transcription.controller'
import { alignWords } from '@/lib/transcription/align'
import { opusOgg } from '@/lib/transcription/opus'
import { timedWords, turnsOf } from '@/lib/transcription/providers/custom'
import { wordsInSpeech } from '@/lib/transcription/turns'
import { partName, partStart, type ProviderJob, type ProviderResult, sendParts, type SpeakerTurn, watchProgress, wholeSeconds, withTerms, type Word } from '@/lib/transcription/types'

const TRANSCRIPTION_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions'
const DIARIZATION_URL = 'https://api.deepinfra.com/v1/inference/nvidia/Nemotron-3-Diarization'
/** The speaker split is optional: it waits 60 s plus 10 s per minute of audio, twice, and then the text comes without speakers. */
const DIARIZATION_WAIT_PER_MINUTE = 10
const DIARIZATION_ATTEMPTS = 2
const DEEPINFRA: ServiceName = { the: 'A DeepInfra', of: 'da DeepInfra' }

export const DEEPINFRA_MODEL = 'openai/whisper-large-v3'
export const DEEPINFRA_TEXT_MODEL = 'mistralai/Voxtral-Small-24B-2507'

function keyOf(job: ProviderJob): string {
  if (!job.credential.apiKey) throw new TranscriptionError('Falta a chave da DeepInfra nas Configurações (deepinfra.com › Dashboard › API Keys).')
  return job.credential.apiKey
}

const inPart = (job: ProviderJob, index: number): AudioRequest => ({ audioSeconds: job.partSeconds, part: { number: index + 1, of: job.parts.length } })

async function timed(job: ProviderJob, part: Blob, index: number): Promise<Word[]> {
  const form = new FormData()
  form.append('file', part, partName(part))
  form.append('model', job.credential.model || DEEPINFRA_MODEL)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.append('language', job.language || 'pt')
  return timedWords(await postAudioController(TRANSCRIPTION_URL, keyOf(job), withTerms(form, job), DEEPINFRA, job.signal, inPart(job, index)), partStart(job, index))
}

async function said(job: ProviderJob, part: Blob, index: number): Promise<string> {
  const form = new FormData()
  form.append('file', part, partName(part))
  form.append('model', DEEPINFRA_TEXT_MODEL)
  form.append('response_format', 'json')
  form.append('language', job.language || 'pt')
  try {
    const { text } = await postAudioController(TRANSCRIPTION_URL, keyOf(job), form, DEEPINFRA, job.signal, inPart(job, index))
    return typeof text === 'string' ? text : ''
  } catch (error) {
    if (job.signal?.aborted) throw error
    return ''
  }
}

export async function deepInfraTurns(job: ProviderJob): Promise<SpeakerTurn[]> {
  const form = new FormData()
  // A recording with video can pass a gigabyte for a few MB of sound: the split gets only its audio track (the same Opus, not re-encoded).
  form.append('audio', (await opusOgg(job.audio)) ?? job.audio, 'gravacao')
  return turnsOf((await postAudioController(DIARIZATION_URL, keyOf(job), form, DEEPINFRA, job.signal, { audioSeconds: wholeSeconds(job), waitPerMinute: DIARIZATION_WAIT_PER_MINUTE, timeoutAttempts: DIARIZATION_ATTEMPTS })).speaker_segments)
}

export async function transcribeWithDeepInfra(job: ProviderJob): Promise<ProviderResult> {
  keyOf(job)
  const watched = watchProgress(job.progress, 'a DeepInfra')
  const watching = { ...job, progress: watched.progress }
  let speakersError = ''
  let separated = false
  const pending = deepInfraTurns(job)
    .catch(error => {
      speakersError = error instanceof Error ? error.message : String(error)
      return [] as SpeakerTurn[]
    })
    .finally(() => {
      separated = true
    })
  try {
    const heard = await sendParts(watching, 'Transcrevendo pela DeepInfra', (part, index) => Promise.all([timed(job, part, index), said(job, part, index)]))
    if (!separated) watching.progress('Separando quem fala')
    const turns = await pending
    const words = heard.flatMap(([times, text], index) => {
      const spoken = wordsInSpeech(times, turns)
      return alignWords(spoken.length * 2 >= times.length ? spoken : times, text, partStart(job, index), partStart(job, index) + job.partSeconds)
    })
    return { words, turns, inSpeech: true, ...(!turns.length && speakersError ? { speakersError } : {}) }
  } finally {
    watched.stop()
  }
}
