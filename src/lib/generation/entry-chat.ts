// Chat da mídia: conversa sobre a entrada inteira, a transcrição (ou o conteúdo) e as notas que nasceram dela.
import type { FileMeta, FileSidecar } from '@/types/domain'
import { descendantsOf, isNote } from '@/lib/family'
import { notePart } from '@/lib/generation/map-chat'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { transcriptPart, type TutorTurn } from '@/lib/generation/tutor'
import { transcriptText } from '@/lib/transcription/export'

const HISTORY_TURNS = 12
const HEARD = 'Transcrição da mídia' as const

export interface ChatSource {
  name: string
  text: string
}

export interface EntryChatContext {
  original: { label: typeof HEARD | 'Conteúdo da entrada'; text: string } | null
  notes: ChatSource[]
}

type Open = (id: string) => Promise<{ content: string; sidecar: FileSidecar }>

const heardIn = (sidecar: FileSidecar): string => (sidecar.recording?.blocks.length ? transcriptText(sidecar.recording) : (sidecar.transcript ?? '')).trim()

/** The entrada's transcript (its content when it has none) and every note born of it, granddaughters too; the Lixeira stays out. */
export async function entryChatContext(files: FileMeta[], entryId: string, open: Open): Promise<EntryChatContext> {
  const { content, sidecar } = await open(entryId)
  const heard = heardIn(sidecar)
  const original = heard ? { label: HEARD, text: heard } : content.trim() ? { label: 'Conteúdo da entrada' as const, text: content.trim() } : null
  const notes: ChatSource[] = []
  for (const note of descendantsOf(files, entryId).filter(isNote)) {
    const opened = await open(note.id).catch(() => null)
    const text = opened ? heardIn(opened.sidecar) || opened.content.trim() : ''
    if (text) notes.push({ name: note.name, text })
  }
  return { original, notes }
}

/** Each part with its name; a long one goes in the parts about the last thing the person said. */
export function chatInput(context: EntryChatContext, history: TutorTurn[]): string {
  const said = history.filter(turn => turn.who === 'você').at(-1)?.text ?? ''
  const talk = history
    .slice(-HISTORY_TURNS)
    .map(turn => `${turn.who === 'você' ? 'Pessoa' : 'Chat'}: ${turn.text}`)
    .join('\n')
  const { original, notes } = context
  const parts = [
    ...(original ? [`${original.label}:\n${original.label === HEARD ? transcriptPart(original.text, said) : notePart(original.text, said)}`] : []),
    ...notes.map(note => `Nota "${note.name}":\n${notePart(note.text, said)}`),
  ]
  return `${parts.join('\n\n') || '(a entrada ainda não tem transcrição nem notas)'}\n\nConversa até agora:\n${talk || '(começo da conversa)'}\n\nResponda como Chat.`
}

export async function askChat(context: EntryChatContext, history: TutorTurn[], session: GenerationSession): Promise<string> {
  return (await session.chat(chatInput(context, history), PROMPTS.CHAT_PROMPT)).trim()
}
