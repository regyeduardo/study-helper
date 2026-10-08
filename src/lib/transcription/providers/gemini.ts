import { geminiAudioController, TranscriptionError } from '@/controllers/transcription.controller'
import { base64Of, wavClip } from '@/lib/transcription/audio'
import type { ProviderJob, ProviderResult, SpeakerTurn, Word } from '@/lib/transcription/types'

const CLIP_SECONDS = 300
const CONTEXT_SPEECHES = 6

export const GEMINI_MODEL = 'gemini-flash-latest'

interface Speech {
  speaker: string
  start: number
  end: number
  text: string
}

function instruction(language: string, before: Speech[]): string {
  const known = before.length ? `\n\nEste áudio continua uma gravação. Os falantes já têm rótulo; as últimas falas antes deste trecho foram:\n${before.map(speech => `${speech.speaker}: ${speech.text}`).join('\n')}\nUse o MESMO rótulo para a mesma voz e crie um rótulo novo só para voz nova.` : ''
  return `Transcreva este áudio por inteiro, palavra por palavra, no idioma falado${language ? ` (${language})` : ''}, sem resumir e sem corrigir.
Separe por fala: cada vez que muda quem fala, começa uma fala nova. Fala longa da mesma pessoa pode ser dividida a cada frase ou duas.
Devolva SOMENTE um JSON assim:
{"falas": [{"falante": "F1", "inicio": 0.0, "fim": 3.2, "texto": "..."}]}
"falante" é um rótulo estável por voz (F1, F2, ...). "inicio" e "fim" são segundos contados do começo DESTE áudio.${known}`
}

function speechesIn(raw: string): Speech[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new TranscriptionError('O Gemini devolveu uma transcrição que não deu para ler. Tente de novo.')
  }
  const list = (parsed as { falas?: unknown })?.falas
  if (!Array.isArray(list)) return []
  return list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({ speaker: String(item.falante ?? ''), start: Number(item.inicio), end: Number(item.fim), text: typeof item.texto === 'string' ? item.texto.trim() : '' }))
    .filter(speech => speech.text && Number.isFinite(speech.start))
}

export async function transcribeWithGemini(job: ProviderJob): Promise<ProviderResult> {
  if (!job.credential.apiKey) throw new TranscriptionError('Falta a chave do Gemini nas Configurações (aistudio.google.com › Get API key).')
  const clips = Math.ceil(job.partSeconds / CLIP_SECONDS)
  const words: Word[] = []
  const turns: SpeakerTurn[] = []
  let before: Speech[] = []
  for (const [index, part] of job.parts.entries()) {
    for (let clip = 0; clip < clips; clip++) {
      const audio = await wavClip(part, clip * CLIP_SECONDS, (clip + 1) * CLIP_SECONDS)
      if (audio.size <= 44) break
      job.progress('Transcrevendo pelo Gemini', (index + clip / clips) / job.parts.length)
      const offset = index * job.partSeconds + clip * CLIP_SECONDS
      const speeches = speechesIn(await geminiAudioController(job.credential.model || GEMINI_MODEL, job.credential.apiKey, await base64Of(audio), 'audio/wav', instruction(job.language, before), job.signal))
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
