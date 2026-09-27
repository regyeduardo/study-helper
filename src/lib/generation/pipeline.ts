import { Cancelled } from '@/controllers/ai.controller'
import { buildContext, diagramPrompt } from '@/lib/generation/diagram-prompt'
import {
  buildMarkdown,
  type DiagramSlot,
  type LessonElement,
  LessonValidationError,
  readSuggestion,
  type Suggestion,
  validateLesson,
} from '@/lib/generation/markdown-builder'
import { DiagramError, extractJson, generateDiagram } from '@/lib/generation/mermaid'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { tableFallback } from '@/lib/generation/table-fallback'

const PHASE1_MAX_RETRIES = 5
const PHASE2_MAX_RETRIES = 3

export type GenerationEvent =
  | { type: 'phase1_complete'; markdown: string }
  | { type: 'suggestion'; suggestion: Suggestion }
  | { type: 'diagram_ready'; index: number; mermaid: string }
  | { type: 'diagram_fallback'; index: number; table: string }
  | { type: 'lesson_complete'; markdown: string }

export type Emit = (event: GenerationEvent) => void

export class GenerationError extends Error {}

export async function generateContent(content: string, systemPrompt: string, session: GenerationSession, emit: Emit = () => {}): Promise<string> {
  const { elements, diagrams, suggestion } = await phaseOne(content, systemPrompt, session)
  emit({ type: 'phase1_complete', markdown: buildMarkdown(elements, null, true) })
  if (suggestion) emit({ type: 'suggestion', suggestion })
  const resolved = await phaseTwo(elements, diagrams, session, emit)
  const markdown = buildMarkdown(elements, resolved)
  emit({ type: 'lesson_complete', markdown })
  return markdown
}

async function phaseOne(content: string, systemPrompt: string, session: GenerationSession) {
  let lastError = ''
  for (let attempt = 0; attempt < PHASE1_MAX_RETRIES; attempt++) {
    const prompt = lastError
      ? `[Auto-Correção]\nErro na tentativa anterior: ${lastError}\n--- PROMPT ORIGINAL (não modificar) ---\n${systemPrompt}`
      : systemPrompt
    const raw = await session.chat(content, prompt)
    const payload = extractJson(raw)
    if (payload === null) {
      lastError = 'resposta da IA não contém JSON válido'
      continue
    }
    try {
      const { elements, diagrams } = validateLesson(payload)
      return { elements, diagrams, suggestion: readSuggestion(payload) }
    } catch (error) {
      if (!(error instanceof LessonValidationError)) throw error
      lastError = error.message
    }
  }
  throw new GenerationError(`Geração falhou após ${PHASE1_MAX_RETRIES} tentativas: ${lastError}`)
}

async function phaseTwo(elements: LessonElement[], diagrams: DiagramSlot[], session: GenerationSession, emit: Emit): Promise<string[]> {
  if (!diagrams.length) return []
  const resolved: string[] = diagrams.map(() => '')
  await Promise.all(
    diagrams.map(async (_, slotIndex) => {
      const { content, fellBack } = await resolveDiagram(elements, diagrams, slotIndex, session)
      resolved[slotIndex] = content
      emit(fellBack ? { type: 'diagram_fallback', index: slotIndex, table: content } : { type: 'diagram_ready', index: slotIndex, mermaid: content })
    }),
  )
  return resolved
}

function elementIndexForSlot(elements: LessonElement[], slotIndex: number): number {
  return elements.findIndex(element => element.type === 'diagram' && element.diagramIndex === slotIndex)
}

async function resolveDiagram(elements: LessonElement[], diagrams: DiagramSlot[], slotIndex: number, session: GenerationSession) {
  const slot = diagrams[slotIndex]
  const context = buildContext(elements, elementIndexForSlot(elements, slotIndex))
  let previousError = ''
  for (let attempt = 0; attempt < PHASE2_MAX_RETRIES; attempt++) {
    const prompt = diagramPrompt(slot.type, slot.hint, context, previousError)
    let raw: string
    try {
      raw = await session.chat(prompt, PROMPTS.DIAGRAM_PROMPT)
    } catch (error) {
      if (error instanceof Cancelled) throw error
      previousError = error instanceof Error ? error.message : String(error)
      continue
    }
    const data = extractJson(raw)
    if (data === null) {
      previousError = `resposta sem JSON válido para o diagrama ${slot.type}`
      continue
    }
    try {
      return { content: generateDiagram(slot.type, data), fellBack: false }
    } catch (error) {
      previousError = error instanceof DiagramError ? error.message : `payload inesperado para o diagrama ${slot.type}: ${String(error)}`
    }
  }
  return { content: tableFallback(slot.hint), fellBack: true }
}

export function extractQuestions(raw: string): unknown[] {
  const trimmed = raw.trim()
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    payload = extractJson(trimmed)
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const questions = (payload as Record<string, unknown>).questions
  return Array.isArray(questions) ? questions : []
}
