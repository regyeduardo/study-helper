import type { MindNode } from '@/types/domain'
import { extractJson } from '@/lib/generation/mermaid'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

const DEEPEST = 3
const MOST_BRANCHES = 7
const MOST_CHILDREN = 5

function nodeOf(raw: unknown, depth: number): MindNode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  const title = typeof item.titulo === 'string' ? item.titulo.trim() : ''
  if (!title) return null
  const children = depth < DEEPEST && Array.isArray(item.filhos) ? item.filhos.map(child => nodeOf(child, depth + 1)).filter((child): child is MindNode => Boolean(child)).slice(0, MOST_CHILDREN) : []
  return { title, children }
}

export async function generateMindmap(content: string, session: GenerationSession): Promise<MindNode | null> {
  const text = content.trim().slice(0, CHUNK_CHARS * 2)
  if (!text) return null
  const answer = extractJson(await session.chat(text, PROMPTS.MINDMAP_PROMPT))
  const center = typeof answer?.centro === 'string' ? answer.centro.trim() : ''
  if (!center || !Array.isArray(answer?.ramos)) return null
  const branches = answer.ramos.map((branch: unknown) => nodeOf(branch, 1)).filter((branch: MindNode | null): branch is MindNode => Boolean(branch)).slice(0, MOST_BRANCHES)
  return branches.length ? { title: center, children: branches } : null
}
