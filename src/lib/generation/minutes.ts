import { extractJson } from '@/lib/generation/mermaid'
import type { Emit } from '@/lib/generation/pipeline'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

const CHUNK_CHARS = 12000
const CHUNK_OVERLAP = 800

type Item = Record<string, unknown>

function chunks(transcript: string): string[] {
  if (transcript.length <= CHUNK_CHARS) return [transcript]
  const pieces: string[] = []
  let start = 0
  while (start < transcript.length) {
    const end = Math.min(start + CHUNK_CHARS, transcript.length)
    pieces.push(transcript.slice(start, end))
    if (end === transcript.length) break
    start = end - CHUNK_OVERLAP
  }
  return pieces
}

function itemsOf(raw: string): Item[] {
  const payload = extractJson(raw)
  const items = payload?.itens
  return Array.isArray(items) ? items.filter((item): item is Item => typeof item === 'object' && item !== null) : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^"+|"+$/g, '')
}

function quote(item: Item): string {
  const citation = stripQuotes(text(item.citacao))
  return citation ? `\n  > "${citation}"` : ''
}

function kept(items: Item[], kind: string): Item[] {
  return items.filter(item => item.tipo === kind && (item.veredito ?? 'mantem') !== 'descarta')
}

export function renderMinutes(verified: Record<string, unknown>): string {
  const items = (Array.isArray(verified.itens) ? verified.itens : []).filter((item): item is Item => typeof item === 'object' && item !== null)
  const subject = text(verified.assunto).trim() || 'Reunião'
  const parts = [`# ${subject}`, '']
  const summary = text(verified.resumo).trim()
  if (summary) parts.push('## Resumo', summary, '')

  const decisions = kept(items, 'decisao')
  if (decisions.length) parts.push('## Decisões', ...decisions.map(item => `- ${text(item.texto).trim()}${quote(item)}`), '')

  const actions = kept(items, 'encaminhamento')
  if (actions.length) {
    parts.push('## Encaminhamentos', '| O que fazer | Quem | Quando | Frase que sustenta |', '|---|---|---|---|')
    for (const item of actions) {
      const who = text(item.quem).trim() || 'sem dono'
      const when = text(item.quando).trim() || 'sem prazo'
      const citation = stripQuotes(text(item.citacao)).replaceAll('|', '/')
      parts.push(`| ${text(item.texto).trim()} | ${who} | ${when} | ${citation} |`)
    }
    parts.push('')
  }

  const open = kept(items, 'pendencia')
  if (open.length) parts.push('## Em aberto', ...open.map(item => `- ${text(item.texto).trim()}${quote(item)}`), '')

  const confirm = kept(items, 'confirmar')
  if (confirm.length) parts.push('## A confirmar', ...confirm.map(item => `- ${text(item.texto).trim()}${quote(item)}`), '')

  const context = kept(items, 'contexto')
  if (context.length) parts.push('## Contexto', ...context.map(item => `- ${text(item.texto).trim()}`), '')

  return parts.join('\n').trim() + '\n'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function minutesFileName(subject: string, when: Date = new Date()): string {
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}-${pad(when.getMinutes())}`
  return `${stamp} - ${subject.trim() || 'Reunião'}`
}

export async function buildMinutes(transcript: string, session: GenerationSession, emit: Emit = () => {}): Promise<{ markdown: string; subject: string }> {
  const candidates: Item[] = []
  for (const piece of chunks(transcript)) candidates.push(...itemsOf(await session.chat(piece, PROMPTS.MINUTES_EXTRACT_PROMPT)))
  const raw = await session.chat(JSON.stringify({ itens: candidates }), PROMPTS.MINUTES_VERIFY_PROMPT)
  const verified = extractJson(raw) ?? { assunto: '', resumo: '', itens: candidates }
  const markdown = renderMinutes(verified)
  const subject = text(verified.assunto).trim() || 'Reunião'
  emit({ type: 'phase1_complete', markdown })
  emit({ type: 'lesson_complete', markdown })
  return { markdown, subject }
}
