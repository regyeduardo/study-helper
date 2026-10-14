import { postAudioController, type ServiceName, TranscriptionError } from '@/controllers/transcription.controller'
import { base64Of, wavClip } from '@/lib/transcription/audio'
import { timedWords, turnsOf } from '@/lib/transcription/providers/custom'
import { type ProviderJob, type ProviderResult, type SpeakerTurn, withTerms, type Word } from '@/lib/transcription/types'

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
const OPENAI: ServiceName = { the: 'A OpenAI', of: 'da OpenAI' }
const KNOWN_SPEAKERS_LIMIT = 4
const SAMPLE_MIN_SECONDS = 2
const SAMPLE_MAX_SECONDS = 10

export const OPENAI_MODEL = 'gpt-4o-transcribe-diarize'

async function voiceSamples(known: Map<string, string>, turns: SpeakerTurn[], part: Blob): Promise<void> {
  for (const speaker of new Set(turns.map(turn => turn.speaker))) {
    if (known.has(speaker) || known.size >= KNOWN_SPEAKERS_LIMIT) continue
    const longest = turns.filter(turn => turn.speaker === speaker).reduce((best, turn) => (turn.end - turn.start > best.end - best.start ? turn : best))
    if (longest.end - longest.start < SAMPLE_MIN_SECONDS) continue
    known.set(speaker, `data:audio/wav;base64,${await base64Of(await wavClip(part, longest.start, Math.min(longest.end, longest.start + SAMPLE_MAX_SECONDS)))}`)
  }
}

export async function transcribeWithOpenAi(job: ProviderJob): Promise<ProviderResult> {
  if (!job.credential.apiKey) throw new TranscriptionError('Falta a chave da OpenAI nas Configurações (platform.openai.com › API keys).')
  const model = job.credential.model || OPENAI_MODEL
  const withSpeakers = model.includes('diarize')
  const words: Word[] = []
  const turns: SpeakerTurn[] = []
  const known = new Map<string, string>()
  for (const [index, part] of job.parts.entries()) {
    job.progress('Transcrevendo pela OpenAI', index / job.parts.length)
    const form = new FormData()
    form.append('file', part, 'trecho.wav')
    form.append('model', model)
    if (job.language) form.append('language', job.language)
    if (withSpeakers) {
      form.append('response_format', 'diarized_json')
      form.append('chunking_strategy', 'auto')
      for (const [name, sample] of known) {
        form.append('known_speaker_names[]', name)
        form.append('known_speaker_references[]', sample)
      }
    } else {
      withTerms(form, job)
      if (model.includes('whisper')) {
        form.append('response_format', 'verbose_json')
        form.append('timestamp_granularities[]', 'word')
      }
    }
    const body = await postAudioController(TRANSCRIPTION_URL, job.credential.apiKey, form, OPENAI, job.signal)
    words.push(...timedWords(body, index * job.partSeconds))
    if (!withSpeakers) continue
    const heard = turnsOf(body.segments)
    turns.push(...heard.map(turn => ({ ...turn, start: turn.start + index * job.partSeconds, end: turn.end + index * job.partSeconds })))
    if (index < job.parts.length - 1) await voiceSamples(known, heard, part)
  }
  return { words, turns }
}
