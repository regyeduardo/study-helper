import type { Artifact, FileMeta, FileSidecar, TutorArtifact, TutorScope } from '@/types/domain'
import { latestOf, newTutorArtifact, questionName } from '@/lib/artifacts'
import { motherOf } from '@/lib/family'
import { notePart } from '@/lib/generation/map-chat'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { transcriptText } from '@/lib/transcription/export'

export type TutorMode = 'perguntar' | 'testar'

export interface TutorTurn {
  who: 'você' | 'tutor'
  text: string
}

const HISTORY_TURNS = 12

/** The speeches about the question when the transcript is long: each speech is one line, so it is cut speech by speech. */
export function transcriptPart(transcript: string, question: string): string {
  return notePart(transcript.trim().split('\n').join('\n\n'), question)
}

/** `transcript`: the recording the note was born from, sent as context (its speeches about the question when long). */
export function tutorInput(note: string, mode: TutorMode, history: TutorTurn[], transcript = ''): string {
  const talk = history
    .slice(-HISTORY_TURNS)
    .map(turn => `${turn.who === 'você' ? 'Pessoa' : 'Tutor'}: ${turn.text}`)
    .join('\n')
  // A long note goes in the parts about the last thing the person said, so the whole note can be asked about.
  const said = history.filter(turn => turn.who === 'você').at(-1)?.text ?? ''
  const heard = transcript.trim() ? `\n\nTranscrição da gravação de onde a nota saiu:\n${transcriptPart(transcript, said)}` : ''
  return `Modo: ${mode}\n\nNota:\n${notePart(note, said)}${heard}\n\nConversa até agora:\n${talk || '(começo da conversa)'}\n\nResponda como Tutor.`
}

export async function askTutor(note: string, mode: TutorMode, history: TutorTurn[], session: GenerationSession, transcript = ''): Promise<string> {
  return (await session.chat(tutorInput(note, mode, history, transcript), PROMPTS.TUTOR_PROMPT)).trim()
}

const heardIn = (sidecar: FileSidecar): string => (sidecar.recording?.blocks.length ? transcriptText(sidecar.recording) : (sidecar.transcript ?? '')).trim()

/** The recording the tutor hears: the note itself when it is one, or the nearest one above it with a transcript. */
export async function recordingAbove(files: FileMeta[], fileId: string, open: (id: string) => Promise<{ sidecar: FileSidecar }>): Promise<{ id: string; transcript: string } | null> {
  const own = heardIn((await open(fileId)).sidecar)
  if (own) return { id: fileId, transcript: own }
  const seen = new Set([fileId])
  let mother = motherOf(files, files.find(file => file.id === fileId) ?? { parentFileId: null })
  while (mother && !seen.has(mother.id)) {
    seen.add(mother.id)
    const heard = heardIn((await open(mother.id)).sidecar)
    if (heard) return { id: mother.id, transcript: heard }
    mother = motherOf(files, mother)
  }
  return null
}

/** The transcript of the recording above the note (its entrada, or further up); '' when the note is that recording, whose text is the note already. */
export async function transcriptAbove(files: FileMeta[], fileId: string, open: (id: string) => Promise<{ sidecar: FileSidecar }>): Promise<string> {
  const found = await recordingAbove(files, fileId, open)
  return found && found.id !== fileId ? found.transcript : ''
}

/**
 * Whose conversation it is. The one made after the Chat existed carries its mark; the old ones do not: on an entrada they were
 * the Chat's (the Chat was what saved there), on a note they are the Tutor's.
 */
export function scopeOf(conversation: { scope?: TutorScope }, onEntry: boolean): TutorScope {
  return conversation.scope ?? (onEntry ? 'chat' : 'tutor')
}

/** The conversations of one side, the one changed last first (on a tie, the later in the list). */
export function conversationsOf(list: Artifact[], scope: TutorScope, onEntry: boolean): TutorArtifact[] {
  return list
    .map((item, index) => ({ item, index }))
    .filter((entry): entry is { item: TutorArtifact; index: number } => entry.item.kind === 'tutor' && scopeOf(entry.item, onEntry) === scope)
    .sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt) || b.index - a.index)
    .map(({ item }) => item)
}

/** The conversation used last: opening the Tutor (or the Chat) continues it. Without a side, the last of any. */
export function lastConversation(list: Artifact[], scope?: TutorScope, onEntry = false): TutorArtifact | null {
  return scope ? (conversationsOf(list, scope, onEntry)[0] ?? null) : latestOf(list, 'tutor')
}

/** The conversation with these turns; a new one (null) is named by its first question and marked as the `scope`'s. */
export function withTurns(conversation: TutorArtifact | null, turns: TutorTurn[], scope?: TutorScope): TutorArtifact {
  if (!conversation) return newTutorArtifact({ turns, scope })
  const named = conversation.provisionalName && turns.length ? { name: questionName(turns[0].text), provisionalName: false } : {}
  return { ...conversation, ...named, turns }
}

/** The tutor asks first only in a test. */
export function modeOf(conversation: TutorArtifact): TutorMode {
  return conversation.turns[0]?.who === 'tutor' ? 'testar' : 'perguntar'
}
