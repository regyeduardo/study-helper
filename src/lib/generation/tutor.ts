import type { Artifact, TutorArtifact } from '@/types/domain'
import { latestOf, newTutorArtifact, questionName } from '@/lib/artifacts'
import { notePart } from '@/lib/generation/map-chat'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

export type TutorMode = 'perguntar' | 'testar'

export interface TutorTurn {
  who: 'você' | 'tutor'
  text: string
}

const HISTORY_TURNS = 12

export function tutorInput(note: string, mode: TutorMode, history: TutorTurn[]): string {
  const talk = history
    .slice(-HISTORY_TURNS)
    .map(turn => `${turn.who === 'você' ? 'Pessoa' : 'Tutor'}: ${turn.text}`)
    .join('\n')
  // A long note goes in the parts about the last thing the person said, so the whole note can be asked about.
  const said = history.filter(turn => turn.who === 'você').at(-1)?.text ?? ''
  return `Modo: ${mode}\n\nNota:\n${notePart(note, said)}\n\nConversa até agora:\n${talk || '(começo da conversa)'}\n\nResponda como Tutor.`
}

export async function askTutor(note: string, mode: TutorMode, history: TutorTurn[], session: GenerationSession): Promise<string> {
  return (await session.chat(tutorInput(note, mode, history), PROMPTS.TUTOR_PROMPT)).trim()
}

/** The conversation used last: opening the Tutor continues it. */
export function lastConversation(list: Artifact[]): TutorArtifact | null {
  return latestOf(list, 'tutor')
}

/** The conversation with these turns; a new one (null) is named by its first question. */
export function withTurns(conversation: TutorArtifact | null, turns: TutorTurn[]): TutorArtifact {
  if (!conversation) return newTutorArtifact({ turns })
  const named = conversation.provisionalName && turns.length ? { name: questionName(turns[0].text), provisionalName: false } : {}
  return { ...conversation, ...named, turns }
}

/** The tutor asks first only in a test. */
export function modeOf(conversation: TutorArtifact): TutorMode {
  return conversation.turns[0]?.who === 'tutor' ? 'testar' : 'perguntar'
}
