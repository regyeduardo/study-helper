import type { RecordingData } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import { extractJson } from '@/lib/generation/mermaid'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { batches, type Correction, correctionsIn, withCorrections } from '@/lib/generation/reviewer'
import type { GenerationSession } from '@/lib/generation/session'
import { applied, type Suggestion, suggestionsIn } from '@/lib/generation/speaker-names'
import { cleanTitle } from '@/lib/generation/title'
import { clockTime, speakerName, transcriptText } from '@/lib/transcription/export'
import { RECORDER } from '@/lib/transcription/turns'
import { termsHint } from '@/lib/transcription/types'

const UNNAMED = /^Falante \d+$/
const PIECE_CHARS = 4000

export interface Polished {
  recording: RecordingData
  title: string | null
}

/** Smaller than the reviewer's batches: more pieces asked side by side, each answering faster. */
function pieces(lines: string[]): string[][] {
  const out: string[][] = [[]]
  let size = 0
  for (const line of lines) {
    if (size + line.length > PIECE_CHARS && out[out.length - 1].length) {
      out.push([])
      size = 0
    }
    out[out.length - 1].push(line)
    size += line.length
  }
  return out
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
    const parts = pieces(lines)
    const long = parts.length > 1
    // A long transcript gets its title from its own call over the same opening the first batch used to have.
    const [opening, answers] = await Promise.all([
      long ? session.chat(`${context}${batches(lines)[0].join('\n')}`, PROMPTS.TITLE_PROMPT) : Promise.resolve(''),
      Promise.all(
        parts.map(part => {
          const ask = long ? 'Trecho da gravação: não devolva "titulo".' : 'Primeiro trecho: devolva também o "titulo".'
          return session.chat(`${ask}\n\n${context}${part.join('\n')}`, PROMPTS.POLISH_PROMPT)
        }),
      ),
    ])
    for (const answer of answers) {
      names.push(...suggestionsIn(answer).filter(item => UNNAMED.test(item.speaker) || item.speaker === RECORDER))
      corrections.push(...correctionsIn(answer))
    }
    title = cleanTitle(extractJson(long ? opening : answers[0])?.titulo)
  } catch (error) {
    if (error instanceof Cancelled) throw error
    const reason = `A revisão por IA não rodou (nomes e palavras ficaram como o áudio saiu): ${error instanceof Error ? error.message : String(error)}`
    return { recording: { ...recording, warning: recording.warning ? `${recording.warning} ${reason}` : reason }, title }
  }
  const speakers = applied(recording.speakers, names, transcriptText(recording))
  const named = speakers.some((speaker, index) => speaker !== recording.speakers[index]) ? { ...recording, speakers } : recording
  return { recording: withCorrections(named, corrections), title }
}
