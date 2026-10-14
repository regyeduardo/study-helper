import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

export type TutorMode = 'perguntar' | 'testar'

export interface TutorTurn {
  who: 'você' | 'tutor'
  text: string
}

const NOTE_CHARS = CHUNK_CHARS * 2
const HISTORY_TURNS = 12

export function tutorInput(note: string, mode: TutorMode, history: TutorTurn[]): string {
  const talk = history
    .slice(-HISTORY_TURNS)
    .map(turn => `${turn.who === 'você' ? 'Pessoa' : 'Tutor'}: ${turn.text}`)
    .join('\n')
  return `Modo: ${mode}\n\nNota:\n${note.trim().slice(0, NOTE_CHARS)}\n\nConversa até agora:\n${talk || '(começo da conversa)'}\n\nResponda como Tutor.`
}

export async function askTutor(note: string, mode: TutorMode, history: TutorTurn[], session: GenerationSession): Promise<string> {
  return (await session.chat(tutorInput(note, mode, history), PROMPTS.TUTOR_PROMPT)).trim()
}
