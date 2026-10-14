import { Cancelled } from '@/controllers/ai.controller'
import { extractJson } from '@/lib/generation/mermaid'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

const MOST_TAGS = 4
const TAGS_TOKENS = 200

function cleaned(tag: string): string {
  return tag.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-')
}

export async function suggestTags(content: string, known: string[], session: GenerationSession): Promise<string[]> {
  const text = content.trim().slice(0, CHUNK_CHARS)
  if (!text) return []
  let answer: string
  try {
    answer = await session.chat(`Etiquetas que a pessoa já usa: ${known.length ? known.join(', ') : 'nenhuma'}\n\n${text}`, PROMPTS.TAGS_PROMPT, TAGS_TOKENS)
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return []
  }
  const list = extractJson(answer)?.etiquetas
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter((item): item is string => typeof item === 'string').map(cleaned).filter(Boolean))].slice(0, MOST_TAGS)
}
