import type { LessonElement } from '@/lib/generation/markdown-builder'
import { PROMPTS } from '@/lib/generation/prompts.data'

const SCHEMAS = PROMPTS.DIAGRAM_SCHEMAS as Record<string, string>

export function diagramSchema(type: string): string {
  return SCHEMAS[type] ?? ''
}

export function diagramPrompt(type: string, hint: string, context: string, previousError = ''): string {
  const parts: string[] = []
  if (previousError) parts.push(`[Auto-Correção]\nErro na tentativa anterior: ${previousError}\n`)
  parts.push(diagramSchema(type))
  parts.push(`\nO diagrama deve mostrar: ${hint}\n`)
  parts.push(`Contexto do conteúdo:\n${context}\n`)
  parts.push('Retorne apenas o objeto JSON de dados, sem cercas de markdown e sem campos extras.')
  return parts.join('\n')
}

const TEXT_TYPES = new Set(['paragraph', 'heading', 'bulletedList', 'orderedList'])

function elementText(element: LessonElement): string | null {
  if (!TEXT_TYPES.has(element.type)) return null
  if (element.type === 'bulletedList' || element.type === 'orderedList') {
    return ((element.items as unknown[]) ?? []).map(String).join('\n')
  }
  return (element.text as string) || null
}

export function buildContext(elements: LessonElement[], diagramElementIndex: number, window = 3): string {
  const before: string[] = []
  const after: string[] = []
  for (let index = diagramElementIndex - 1; index >= 0 && before.length < window; index--) {
    const value = elementText(elements[index])
    if (value) before.unshift(value)
  }
  for (let index = diagramElementIndex + 1; index < elements.length && after.length < window; index++) {
    const value = elementText(elements[index])
    if (value) after.push(value)
  }
  return [...before, ...after].join('\n\n')
}
