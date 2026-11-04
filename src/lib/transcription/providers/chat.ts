import { chatAudioController, TranscriptionError } from '@/controllers/transcription.controller'
import { base64Of, wavClip } from '@/lib/transcription/audio'
import { instruction, type Speech, speechesIn } from '@/lib/transcription/providers/gemini'
import { partStart, type ProviderJob, type ProviderResult, type SpeakerTurn, type Word } from '@/lib/transcription/types'

const CLIP_SECONDS = 300
const CONTEXT_SPEECHES = 6

/** JSON inside a chat answer (some models wrap it in ```json fences or a sentence). */
function jsonPart(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1]
  const text = fenced ?? raw
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

/** Transcribes with a model that hears through chat/completions, clip by clip, keeping the same label for the same voice. */
export async function transcribeWithChat(job: ProviderJob): Promise<ProviderResult> {
  const { model, baseUrl, apiKey } = job.credential
  if (!model.trim()) throw new TranscriptionError('Escolha um modelo de Transcrição em Configurações › Inteligência artificial › Padrões por uso.')
  const clips = Math.ceil(job.partSeconds / CLIP_SECONDS)
  const words: Word[] = []
  const turns: SpeakerTurn[] = []
  let before: Speech[] = []
  for (const [index, part] of job.parts.entries()) {
    for (let clip = 0; clip < clips; clip++) {
      const audio = await wavClip(part, clip * CLIP_SECONDS, (clip + 1) * CLIP_SECONDS)
      if (audio.size <= 44) break
      job.progress(`Transcrevendo com ${model}`, (index + clip / clips) / job.parts.length)
      const offset = partStart(job, index) + clip * CLIP_SECONDS
      const speeches = speechesIn(jsonPart(await chatAudioController(baseUrl, apiKey, model, await base64Of(audio), instruction(job.language, before), job.signal)), `O modelo ${model}`)
      for (const speech of speeches) {
        const end = Number.isFinite(speech.end) && speech.end > speech.start ? speech.end : speech.start
        words.push({ start: speech.start + offset, end: end + offset, text: speech.text })
        if (speech.speaker) turns.push({ start: speech.start + offset, end: end + offset, speaker: speech.speaker })
      }
      if (speeches.length) before = speeches.slice(-CONTEXT_SPEECHES)
    }
  }
  return { words, turns }
}
