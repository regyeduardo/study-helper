import { describe, expect, it } from 'vitest'
import { stripExternalLinks } from '@/lib/generation/links'
import { buildMarkdown, LessonValidationError, readSuggestion, validateLesson } from '@/lib/generation/markdown-builder'
import { tableFallback } from '@/lib/generation/table-fallback'
import { buildContext, diagramPrompt } from '@/lib/generation/diagram-prompt'

function lesson(elements: unknown[], diagrams: unknown[] = []) {
  return { markdown: { elements, diagrams } }
}

describe('validateLesson', () => {
  it('accepts a complete lesson and returns elements and diagram slots', () => {
    const { elements, diagrams } = validateLesson(
      lesson(
        [
          { type: 'heading', level: 1, text: 'Título' },
          { type: 'paragraph', text: 'p' },
          { type: 'diagram', diagramIndex: 0 },
        ],
        [{ type: 'flowchart', hint: 'fluxo' }],
      ),
    )
    expect(elements).toHaveLength(3)
    expect(diagrams).toEqual([{ type: 'flowchart', hint: 'fluxo' }])
  })

  it.each([
    [{}, "resposta sem o objeto 'markdown'"],
    [{ markdown: { elements: [] } }, "'elements' vazio ou ausente"],
    [{ markdown: { elements: [{ type: 'p' }], diagrams: 'x' } }, "'diagrams' precisa ser uma lista"],
    [lesson([{ type: 'video' }]), "tipo desconhecido: 'video'"],
    [lesson([{ type: 'heading', level: 7, text: 't' }]), "'level' entre 1 e 6"],
    [lesson([{ type: 'heading', level: 2, text: ' ' }]), "(heading) sem 'text'"],
    [lesson([{ type: 'bulletedList', items: [] }]), "sem 'items'"],
    [lesson([{ type: 'checklist' }]), "sem 'checkItems'"],
    [lesson([{ type: 'table', headers: ['a'] }]), "sem 'rows'"],
    [lesson([{ type: 'details', summary: 's' }]), "(details) sem 'text'"],
    [lesson([{ type: 'diagram', diagramIndex: 1 }], [{ type: 'pie', hint: 'h' }]), 'diagramIndex fora dos limites: 1'],
    [lesson([{ type: 'paragraph', text: 'p' }], [{ type: 'radar', hint: 'h' }]), "tipo inválido: 'radar'"],
    [lesson([{ type: 'paragraph', text: 'p' }], [{ type: 'pie', hint: '' }]), "está sem 'hint'"],
  ])('rejects %j', (payload, message) => {
    expect(() => validateLesson(payload as Record<string, unknown>)).toThrow(LessonValidationError)
    expect(() => validateLesson(payload as Record<string, unknown>)).toThrow(message)
  })
})

describe('readSuggestion', () => {
  it('reads name and folder', () => {
    expect(readSuggestion({ suggestion: { name: ' Aula X ', folder: 'Bio' } })).toEqual({ name: 'Aula X', folder: 'Bio' })
  })

  it('returns null when empty or missing', () => {
    expect(readSuggestion({ suggestion: { name: '', folder: '' } })).toBeNull()
    expect(readSuggestion({})).toBeNull()
  })
})

describe('buildMarkdown', () => {
  const elements = [
    { type: 'heading', level: 1, text: 'Fotossíntese' },
    { type: 'paragraph', text: 'Veja [a Wikipedia](https://pt.wikipedia.org) e https://x.com/y agora.' },
    { type: 'bulletedList', items: ['luz', 'água'] },
    { type: 'orderedList', items: ['um', 'dois'] },
    { type: 'checklist', checkItems: [{ text: 'feito', checked: true }, { text: 'falta' }] },
    { type: 'blockquote', text: 'linha 1\nlinha 2' },
    { type: 'codeBlock', language: 'python', text: 'print("https://keep.me")' },
    { type: 'table', headers: ['A', 'B'], rows: [['1'], ['2', '3', '4']] },
    { type: 'alert', style: 'warning', text: 'cuidado' },
    { type: 'alert', style: 'bogus', text: 'nota' },
    { type: 'horizontalRule' },
    { type: 'details', summary: 'Resumo', text: 'escondido' },
    { type: 'diagram', diagramIndex: 0 },
    { type: 'diagram', diagramIndex: 1 },
  ]

  it('renders every element type as GitHub markdown and fences resolved mermaid', () => {
    const markdown = buildMarkdown(elements, ['flowchart TD\nA-->B', '| Conceito | Descrição |\n|---|---|\n| a | b |'])
    expect(markdown).toBe(
      [
        '# Fotossíntese',
        'Veja a Wikipedia e agora.',
        '- luz\n- água',
        '1. um\n2. dois',
        '- [x] feito\n- [ ] falta',
        '> linha 1\n> linha 2',
        '```python\nprint("https://keep.me")\n```',
        '| A | B |\n|---|---|\n| 1 | |\n| 2 | 3 |',
        '> [!WARNING]\n> cuidado',
        '> [!NOTE]\n> nota',
        '---',
        '<details><summary>Resumo</summary>\n\nescondido\n\n</details>',
        '```mermaid\nflowchart TD\nA-->B\n```',
        '| Conceito | Descrição |\n|---|---|\n| a | b |',
      ].join('\n\n') + '\n',
    )
  })

  it('renders placeholders during phase one', () => {
    const markdown = buildMarkdown([{ type: 'diagram', diagramIndex: 0 }, { type: 'paragraph', text: 'x' }], null, true)
    expect(markdown).toBe('<!-- diagram:0 -->\n\nx\n')
  })
})

describe('stripExternalLinks', () => {
  it('removes external links but keeps code and internal links', () => {
    expect(stripExternalLinks('Ir [aqui](#sec) ou [fora](http://a.b) <https://c.d> `https://e.f`')).toBe('Ir [aqui](#sec) ou fora `https://e.f`')
  })
})

describe('tableFallback', () => {
  it('turns a hint into a concept table', () => {
    expect(tableFallback('Luz entra na folha. Clorofila absorve')).toBe('| Conceito | Descrição |\n|----------|-----------|\n| Luz | entra na folha |\n| Clorofila | absorve |')
  })
})

describe('diagram prompt', () => {
  it('includes schema, hint, context and previous error', () => {
    const prompt = diagramPrompt('pie', 'proporções', 'contexto X', 'erro Y')
    expect(prompt).toContain('[Auto-Correção]\nErro na tentativa anterior: erro Y')
    expect(prompt).toContain('<Schema JSON para pie>')
    expect(prompt).toContain('O diagrama deve mostrar: proporções')
    expect(prompt).toContain('Contexto do conteúdo:\ncontexto X')
  })

  it('builds context from nearby text elements', () => {
    const context = buildContext(
      [
        { type: 'heading', text: 'H' },
        { type: 'table', headers: [], rows: [] },
        { type: 'paragraph', text: 'antes' },
        { type: 'diagram', diagramIndex: 0 },
        { type: 'bulletedList', items: ['a', 'b'] },
      ],
      3,
    )
    expect(context).toBe('H\n\nantes\n\na\nb')
  })
})
