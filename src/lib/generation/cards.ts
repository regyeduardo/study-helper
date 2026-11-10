import type { StudyCard } from '@/types/domain'
import { nameArtifact } from '@/lib/generation/artifact-name'
import { withInstruction } from '@/lib/generation/instruction'
import { extractJson } from '@/lib/generation/mermaid'
import { transcriptChunks } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { newId } from '@/lib/ids'

const BOX_DAYS = [1, 2, 4, 8, 16, 32]
const MOST_CARDS = 60

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return today(date)
}

export function dueCount(dates: string[] = [], day = today()): number {
  return dates.filter(due => due <= day).length
}

export function reviewed(card: StudyCard, right: boolean, day = today()): StudyCard {
  if (!right) return { ...card, box: 0, due: day }
  const box = Math.min(card.box + 1, BOX_DAYS.length - 1)
  return { ...card, box, due: addDays(day, BOX_DAYS[card.box] ?? BOX_DAYS[BOX_DAYS.length - 1]) }
}

function cardsOf(list: unknown, day: string): StudyCard[] {
  if (!Array.isArray(list)) return []
  return list.flatMap(item => {
    const front = typeof item?.frente === 'string' ? item.frente.trim() : ''
    const back = typeof item?.verso === 'string' ? item.verso.trim() : ''
    return front && back ? [{ id: newId(), front, back, box: 0, due: day }] : []
  })
}

/** Up to `most` cards taking one from each part in turn, so the end of a long note is not left out; note order kept. */
function spread(parts: StudyCard[][], most: number): StudyCard[] {
  const taken = parts.map(() => 0)
  let left = most
  while (left > 0 && parts.some((part, index) => taken[index] < part.length)) {
    parts.forEach((part, index) => {
      if (left > 0 && taken[index] < part.length) {
        taken[index]++
        left--
      }
    })
  }
  return parts.flatMap((part, index) => part.slice(0, taken[index]))
}

/** The cards of the WHOLE note (read in parts) and the name the AI suggests for the deck. `instruction`: the "Instrução extra para a IA". */
export async function generateCards(content: string, session: GenerationSession, instruction = '', day = today()): Promise<{ cards: StudyCard[]; name: string | null }> {
  const parts: StudyCard[][] = []
  for (const piece of transcriptChunks(content.trim())) parts.push(cardsOf(extractJson(await session.chat(withInstruction(piece, instruction), PROMPTS.CARDS_PROMPT))?.cartoes, day))
  const cards = spread(parts, MOST_CARDS)
  if (!cards.length) return { cards, name: null }
  return { cards, name: await nameArtifact(cards.map(card => card.front).join('\n'), 'cartoes', instruction, session) }
}
