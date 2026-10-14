import type { StudyCard } from '@/types/domain'
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

export async function generateCards(content: string, session: GenerationSession, day = today()): Promise<StudyCard[]> {
  const cards: StudyCard[] = []
  for (const piece of transcriptChunks(content.trim())) {
    const list = extractJson(await session.chat(piece, PROMPTS.CARDS_PROMPT))?.cartoes
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const front = typeof item?.frente === 'string' ? item.frente.trim() : ''
      const back = typeof item?.verso === 'string' ? item.verso.trim() : ''
      if (front && back) cards.push({ id: newId(), front, back, box: 0, due: day })
    }
  }
  return cards.slice(0, MOST_CARDS)
}
