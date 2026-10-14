import { Cancelled } from '@/controllers/ai.controller'
import { transcriptChunks } from '@/lib/generation/minutes'
import { extractJson } from '@/lib/generation/mermaid'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

const TITLE_MAX = 80
const TITLE_TOKENS = 200

export async function titleFromTranscript(transcript: string, session: GenerationSession): Promise<string | null> {
  const opening = transcriptChunks(transcript.trim())[0]
  if (!opening) return null
  let answer: string
  try {
    answer = await session.chat(opening, PROMPTS.TITLE_PROMPT, TITLE_TOKENS)
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return null
  }
  return cleanTitle(extractJson(answer)?.titulo)
}

export function cleanTitle(raw: unknown): string | null {
  const title = typeof raw === 'string' ? raw.replace(/^["“”'\s]+|["“”'.\s]+$/g, '') : ''
  if (!title) return null
  return title.length > TITLE_MAX ? title.slice(0, TITLE_MAX).replace(/\s+\S*$/, '') : title
}
