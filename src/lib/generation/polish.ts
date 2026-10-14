import type { RecordingData } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import { extractJson } from '@/lib/generation/mermaid'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { batches, type Correction, correctionsIn, withCorrections } from '@/lib/generation/reviewer'
import type { GenerationSession } from '@/lib/generation/session'
import { applied, type Suggestion, suggestionsIn } from '@/lib/generation/speaker-names'
import { cleanTitle } from '@/lib/generation/title'
import { clockTime, speakerName, transcriptText } from '@/lib/transcription/export'
import { termsHint } from '@/lib/transcription/types'

const UNNAMED = /^Falante \d+$/

export interface Polished {
  recording: RecordingData
  title: string | null
}

export async function polishTranscript(recording: RecordingData, session: GenerationSession, terms = ''): Promise<Polished> {
  if (!recording.blocks.length) return { recording, title: null }
  const hint = termsHint(terms)
  const context =
    (hint ? `${hint}\n\n` : '') +
    (recording.speakers.length ? `Participantes: ${recording.speakers.map(speaker => speaker.name).join(', ')}\n\n` : '') +
    (recording.frames?.length ? `Escrito na tela durante a reunião: ${recording.frames.map(frame => frame.text).join(' | ')}\n\n` : '')
  const lines = recording.blocks.map((block, index) => `${index + 1} | ${block.speaker ? `${speakerName(recording, block.speaker)} ` : ''}[${clockTime(block.start)}]: ${block.text}`)
  const names: Suggestion[] = []
  const corrections: Correction[] = []
  let title: string | null = null
  try {
    const answers = await Promise.all(
      batches(lines).map((batch, index) => {
        const ask = index === 0 ? 'Primeiro trecho: devolva também o "titulo".' : 'Trecho do meio: não devolva "titulo".'
        return session.chat(`${ask}\n\n${context}${batch.join('\n')}`, PROMPTS.POLISH_PROMPT)
      }),
    )
    for (const [index, answer] of answers.entries()) {
      names.push(...suggestionsIn(answer).filter(item => UNNAMED.test(item.speaker)))
      corrections.push(...correctionsIn(answer))
      if (index === 0) title = cleanTitle(extractJson(answer)?.titulo)
    }
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return { recording, title }
  }
  const speakers = applied(recording.speakers, names, transcriptText(recording))
  const named = speakers.some((speaker, index) => speaker !== recording.speakers[index]) ? { ...recording, speakers } : recording
  return { recording: withCorrections(named, corrections), title }
}
