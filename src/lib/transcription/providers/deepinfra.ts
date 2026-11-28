import { type AudioRequest, chatAudioController, postAudioController, type ServiceName, TranscriptionError } from '@/controllers/transcription.controller'
import { alignWords } from '@/lib/transcription/align'
import { hourlyPrice } from '@/lib/ai/recommendations'
import { opusOgg } from '@/lib/transcription/opus'
import { timedWords, turnsOf } from '@/lib/transcription/providers/custom'
import { wordsInSpeech } from '@/lib/transcription/turns'
import { listenerInstruction, partName, partStart, type ProviderJob, type ProviderResult, sendParts, type SpeakerTurn, watchProgress, wholeSeconds, withTerms, type Word } from '@/lib/transcription/types'

const TRANSCRIPTION_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions'
const DIARIZATION_URL = 'https://api.deepinfra.com/v1/inference/nvidia/Nemotron-3-Diarization'
/** The speaker split is optional: it waits 60 s plus 10 s per minute of audio, twice, and then the text comes without speakers. */
const DIARIZATION_WAIT_PER_MINUTE = 10
const DIARIZATION_ATTEMPTS = 2
const DEEPINFRA: ServiceName = { the: 'A DeepInfra', of: 'da DeepInfra' }
/**
 * The text of a part (by the model that hears, or Voxtral) only betters the words Whisper gave the part: past this share of the part's seconds after Whisper answered it, Whisper's
 * words stay (T198). Production, 27/11, a 90 min meeting: every part had answered 80 s after the start but one Voxtral part, which
 * never did; the app waited 3 x 210 s for it (nginx: given up at 21:43:55, 21:47:27 and 21:51:15), 650 s for a step of 80 s. Measured
 * the same day with 18 parts at once, as the app sends them: Voxtral came up to ~0.22 s per second of audio after Whisper; this is twice
 * that (135 s for a part of 5 min).
 */
const TEXT_GRACE_PER_SECOND = 0.45
const TEXT_GRACE_MIN_MS = 30_000

/** T199 (research R28): the times of each word, by default (fewer words wrong than the large-v3 on the test meeting and on real talk, 1/2 of the price). */
export const DEEPINFRA_MODEL = 'openai/whisper-large-v3-turbo'
export const DEEPINFRA_TEXT_MODEL = 'mistralai/Voxtral-Small-24B-2507'

function keyOf(job: ProviderJob): string {
  if (!job.credential.apiKey) throw new TranscriptionError('Falta a chave da DeepInfra nas Configurações (deepinfra.com › Dashboard › API Keys).')
  return job.credential.apiKey
}

const inPart = (job: ProviderJob, index: number): AudioRequest => ({ audioSeconds: job.partSeconds, part: { number: index + 1, of: job.parts.length } })

type Spend = (usd: number) => void

/** What a speech model heard cost: its price per hour (the list of models) by the seconds it says it heard, or the part's. */
function spentOn(model: string, seconds: unknown, fallback: number, spend: Spend): void {
  const hour = hourlyPrice(model)
  if (hour !== undefined) spend((hour * (typeof seconds === 'number' && seconds > 0 ? seconds : fallback)) / 3600)
}

async function timed(job: ProviderJob, part: Blob, index: number, signal: AbortSignal | undefined, spend: Spend): Promise<Word[]> {
  const model = job.credential.model || DEEPINFRA_MODEL
  const form = new FormData()
  form.append('file', part, partName(part))
  form.append('model', model)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.append('language', job.language || 'pt')
  const body = await postAudioController(TRANSCRIPTION_URL, keyOf(job), withTerms(form, job), DEEPINFRA, signal ?? job.signal, inPart(job, index))
  spentOn(model, body.duration, job.partSeconds, spend)
  return timedWords(body, partStart(job, index))
}

/** The part as base64, for `input_audio`. */
async function base64Of(part: Blob): Promise<string> {
  const bytes = new Uint8Array(await part.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** The text of a part: by the model that hears (T199) when there is one, else by Voxtral, as before. */
async function hear(job: ProviderJob, part: Blob, index: number, signal: AbortSignal, spend: Spend): Promise<string> {
  const listener = job.listener
  if (listener) {
    const format = /ogg|opus|webm/.test(part.type) ? 'ogg' : 'wav'
    return chatAudioController(listener.baseUrl, listener.apiKey, listener.model, await base64Of(part), listenerInstruction(job.language, job.terms), signal, { format, onCost: spend })
  }
  const form = new FormData()
  form.append('file', part, partName(part))
  form.append('model', DEEPINFRA_TEXT_MODEL)
  form.append('response_format', 'json')
  form.append('language', job.language || 'pt')
  const body = await postAudioController(TRANSCRIPTION_URL, keyOf(job), form, DEEPINFRA, signal, inPart(job, index))
  spentOn(DEEPINFRA_TEXT_MODEL, body.duration, job.partSeconds, spend)
  return typeof body.text === 'string' ? body.text : ''
}

async function said(job: ProviderJob, part: Blob, index: number, heard: Promise<unknown>, signal: AbortSignal | undefined, spend: Spend): Promise<string> {
  const limit = new AbortController()
  const stop = () => limit.abort()
  const cancel = signal ?? job.signal
  if (cancel?.aborted) limit.abort()
  else cancel?.addEventListener('abort', stop, { once: true })
  let finished = false
  let grace: ReturnType<typeof setTimeout> | undefined
  // Whisper answered: Voxtral has the grace left; Whisper failed: the part fails anyway, nothing waits for Voxtral
  heard.then(
    () => {
      if (!finished) grace = setTimeout(stop, Math.max(TEXT_GRACE_MIN_MS, job.partSeconds * TEXT_GRACE_PER_SECOND * 1000))
    },
    stop,
  )
  try {
    return await hear(job, part, index, limit.signal, spend)
  } catch (error) {
    if (job.signal?.aborted) throw error
    return ''
  } finally {
    finished = true
    clearTimeout(grace)
    cancel?.removeEventListener('abort', stop)
  }
}

export async function deepInfraTurns(job: ProviderJob, spend: Spend = () => {}): Promise<SpeakerTurn[]> {
  const form = new FormData()
  // A recording with video can pass a gigabyte for a few MB of sound: the split gets only its audio track (the same Opus, not re-encoded).
  form.append('audio', (await opusOgg(job.audio)) ?? job.audio, 'gravacao')
  const body = await postAudioController(DIARIZATION_URL, keyOf(job), form, DEEPINFRA, job.signal, { audioSeconds: wholeSeconds(job), waitPerMinute: DIARIZATION_WAIT_PER_MINUTE, timeoutAttempts: DIARIZATION_ATTEMPTS })
  const said = (body.inference_status as { cost?: unknown } | undefined)?.cost
  if (typeof said === 'number') spend(said)
  return turnsOf(body.speaker_segments)
}

export async function transcribeWithDeepInfra(job: ProviderJob): Promise<ProviderResult> {
  keyOf(job)
  const watched = watchProgress(job.progress, 'a DeepInfra')
  const watching = { ...job, progress: watched.progress }
  let speakersError = ''
  let separated = false
  let cost = 0
  const spend: Spend = usd => {
    cost += usd
  }
  const pending = deepInfraTurns(job, spend)
    .catch(error => {
      speakersError = error instanceof Error ? error.message : String(error)
      return [] as SpeakerTurn[]
    })
    .finally(() => {
      separated = true
    })
  try {
    const heard = await sendParts(watching, 'Transcrevendo pela DeepInfra', (part, index, signal) => {
      const times = timed(job, part, index, signal, spend)
      return Promise.all([times, said(job, part, index, times, signal, spend)])
    })
    if (!separated) watching.progress('Separando quem fala')
    const turns = await pending
    const words = heard.flatMap(([times, text], index) => {
      const spoken = wordsInSpeech(times, turns)
      return alignWords(spoken.length * 2 >= times.length ? spoken : times, text, partStart(job, index), partStart(job, index) + job.partSeconds)
    })
    return { words, turns, inSpeech: true, cost, ...(!turns.length && speakersError ? { speakersError } : {}) }
  } finally {
    watched.stop()
  }
}
