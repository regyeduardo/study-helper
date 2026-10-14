import { postAudioController, type ServiceName, TranscriptionError } from '@/controllers/transcription.controller'
import { timedWords, turnsOf } from '@/lib/transcription/providers/custom'
import { partName, partStart, type ProviderJob, type ProviderResult, sendParts, type SpeakerTurn, withTerms, type Word } from '@/lib/transcription/types'

const TRANSCRIPTION_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions'
const DIARIZATION_URL = 'https://api.deepinfra.com/v1/inference/nvidia/Nemotron-3-Diarization'
const DEEPINFRA: ServiceName = { the: 'A DeepInfra', of: 'da DeepInfra' }

export const DEEPINFRA_MODEL = 'openai/whisper-large-v3'

function keyOf(job: ProviderJob): string {
  if (!job.credential.apiKey) throw new TranscriptionError('Falta a chave da DeepInfra nas Configurações (deepinfra.com › Dashboard › API Keys).')
  return job.credential.apiKey
}

async function words(job: ProviderJob): Promise<Word[]> {
  const heard = await sendParts(job, 'Transcrevendo pela DeepInfra', async (part, index) => {
    const form = new FormData()
    form.append('file', part, partName(part))
    form.append('model', job.credential.model || DEEPINFRA_MODEL)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    if (job.language) form.append('language', job.language)
    return timedWords(await postAudioController(TRANSCRIPTION_URL, keyOf(job), withTerms(form, job), DEEPINFRA, job.signal), partStart(job, index))
  })
  return heard.flat()
}

export async function deepInfraTurns(job: ProviderJob): Promise<SpeakerTurn[]> {
  const form = new FormData()
  form.append('audio', job.audio, 'gravacao')
  return turnsOf((await postAudioController(DIARIZATION_URL, keyOf(job), form, DEEPINFRA, job.signal)).speaker_segments)
}

export async function transcribeWithDeepInfra(job: ProviderJob): Promise<ProviderResult> {
  keyOf(job)
  const turns = deepInfraTurns(job).catch(() => [] as SpeakerTurn[])
  return { words: await words(job), turns: await turns }
}
