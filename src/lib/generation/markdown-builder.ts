import { stripExternalLinks } from '@/lib/generation/links'
import { DIAGRAM_TYPES } from '@/lib/generation/mermaid'

export type LessonElement = Record<string, unknown> & { type: string }

export interface DiagramSlot {
  type: string
  hint: string
}

export interface Suggestion {
  name: string
  folder: string
}

const ELEMENT_TYPES = new Set([
  'heading',
  'paragraph',
  'bulletedList',
  'orderedList',
  'checklist',
  'blockquote',
  'codeBlock',
  'table',
  'alert',
  'horizontalRule',
  'details',
  'diagram',
])

const ALERT_STYLES: Record<string, string> = { note: 'NOTE', tip: 'TIP', important: 'IMPORTANT', warning: 'WARNING', caution: 'CAUTION' }

export class LessonValidationError extends Error {}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function filled(value: unknown): boolean {
  return text(value).trim() !== ''
}

function nonEmpty(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value)
}

export function readSuggestion(payload: Record<string, unknown>): Suggestion | null {
  const suggestion = payload.suggestion
  if (typeof suggestion !== 'object' || suggestion === null) return null
  const record = suggestion as Record<string, unknown>
  const name = text(record.name).trim()
  const folder = text(record.folder).trim()
  return name || folder ? { name, folder } : null
}

export function validateLesson(payload: Record<string, unknown>): { elements: LessonElement[]; diagrams: DiagramSlot[] } {
  const markdown = payload.markdown
  if (typeof markdown !== 'object' || markdown === null || Array.isArray(markdown)) throw new LessonValidationError("resposta sem o objeto 'markdown'")
  const record = markdown as Record<string, unknown>
  const elements = record.elements
  if (!Array.isArray(elements) || !elements.length) throw new LessonValidationError("'elements' vazio ou ausente")
  const diagrams = record.diagrams ?? []
  if (!Array.isArray(diagrams)) throw new LessonValidationError("'diagrams' precisa ser uma lista")

  elements.forEach((element, index) => {
    if (typeof element !== 'object' || element === null || Array.isArray(element)) throw new LessonValidationError(`elemento[${index}] não é um objeto`)
    const type = (element as LessonElement).type
    if (!ELEMENT_TYPES.has(type)) throw new LessonValidationError(`elemento[${index}] tem tipo desconhecido: '${type}'`)
    validateElement(index, element as LessonElement, diagrams)
  })

  diagrams.forEach((diagram, index) => {
    if (typeof diagram !== 'object' || diagram === null) throw new LessonValidationError(`diagrama[${index}] não é um objeto`)
    const slot = diagram as Record<string, unknown>
    if (!(DIAGRAM_TYPES as readonly string[]).includes(text(slot.type))) throw new LessonValidationError(`diagrama[${index}] tem tipo inválido: '${text(slot.type)}'`)
    if (!filled(slot.hint)) throw new LessonValidationError(`diagrama[${index}] está sem 'hint'`)
  })

  return { elements: elements as LessonElement[], diagrams: diagrams as DiagramSlot[] }
}

function validateElement(index: number, element: LessonElement, diagrams: unknown[]): void {
  const type = element.type
  if (type === 'heading') {
    if (!filled(element.text)) throw new LessonValidationError(`elemento[${index}] (heading) sem 'text'`)
    const level = element.level
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) throw new LessonValidationError(`elemento[${index}] (heading) precisa de 'level' entre 1 e 6`)
  } else if (type === 'paragraph' || type === 'blockquote' || type === 'codeBlock') {
    if (!filled(element.text)) throw new LessonValidationError(`elemento[${index}] (${type}) sem 'text'`)
  } else if (type === 'bulletedList' || type === 'orderedList') {
    if (!nonEmpty(element.items)) throw new LessonValidationError(`elemento[${index}] (${type}) sem 'items'`)
  } else if (type === 'checklist') {
    if (!nonEmpty(element.checkItems)) throw new LessonValidationError(`elemento[${index}] (checklist) sem 'checkItems'`)
  } else if (type === 'table') {
    if (!nonEmpty(element.headers)) throw new LessonValidationError(`elemento[${index}] (table) sem 'headers'`)
    if (!nonEmpty(element.rows)) throw new LessonValidationError(`elemento[${index}] (table) sem 'rows'`)
  } else if (type === 'alert') {
    if (!filled(element.text)) throw new LessonValidationError(`elemento[${index}] (alert) sem 'text'`)
  } else if (type === 'details') {
    if (!filled(element.summary)) throw new LessonValidationError(`elemento[${index}] (details) sem 'summary'`)
    if (!filled(element.text)) throw new LessonValidationError(`elemento[${index}] (details) sem 'text'`)
  } else if (type === 'diagram') {
    const diagramIndex = element.diagramIndex
    if (typeof diagramIndex !== 'number' || !Number.isInteger(diagramIndex) || diagramIndex < 0 || diagramIndex >= diagrams.length) {
      throw new LessonValidationError(`elemento[${index}] (diagram) tem diagramIndex fora dos limites: ${JSON.stringify(diagramIndex ?? null)}`)
    }
  }
}

function renderDiagram(element: LessonElement, resolved: string[] | null, placeholders: boolean): string {
  const index = (element.diagramIndex as number) ?? 0
  if (placeholders || resolved === null) return `<!-- diagram:${index} -->`
  if (index >= resolved.length) return ''
  const content = resolved[index]
  if (content.trimStart().startsWith('|')) return content
  return '```mermaid\n' + content + '\n```'
}

function quoted(value: unknown): string {
  return text(value)
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
}

function renderTable(element: LessonElement): string {
  const headers = (element.headers as unknown[]).map(text)
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`]
  for (const row of element.rows as unknown[][]) {
    const cells = row.map(text)
    while (cells.length < headers.length) cells.push('')
    lines.push(`| ${cells.slice(0, headers.length).join(' | ')} |`)
  }
  return lines.join('\n')
}

function renderElement(element: LessonElement): string {
  switch (element.type) {
    case 'heading':
      return `${'#'.repeat(element.level as number)} ${text(element.text)}`
    case 'paragraph':
      return text(element.text)
    case 'bulletedList':
      return (element.items as unknown[]).map(item => `- ${text(item)}`).join('\n')
    case 'orderedList':
      return (element.items as unknown[]).map((item, position) => `${position + 1}. ${text(item)}`).join('\n')
    case 'checklist':
      return (element.checkItems as Record<string, unknown>[]).map(item => `- [${item.checked ? 'x' : ' '}] ${text(item.text)}`).join('\n')
    case 'blockquote':
      return quoted(element.text)
    case 'codeBlock':
      return '```' + text(element.language) + '\n' + text(element.text) + '\n```'
    case 'table':
      return renderTable(element)
    case 'alert': {
      const style = ALERT_STYLES[text(element.style || 'note').toLowerCase()] ?? 'NOTE'
      return `> [!${style}]\n${quoted(element.text)}`
    }
    case 'horizontalRule':
      return '---'
    case 'details':
      return `<details><summary>${text(element.summary)}</summary>\n\n${text(element.text)}\n\n</details>`
    default:
      return ''
  }
}

export function buildMarkdown(elements: LessonElement[], resolved: string[] | null = null, placeholders = false): string {
  const blocks = elements.map(element => (element.type === 'diagram' ? renderDiagram(element, resolved, placeholders) : renderElement(element)))
  return stripExternalLinks(blocks.filter(Boolean).join('\n\n').trim() + '\n')
}
