import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import mermaid from 'mermaid'

import { generateContent, extractQuestions, type GenerationEvent, GenerationError } from '@/lib/generation/pipeline'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { GenerationSession } from '@/lib/generation/session'
import { type CapturedRequest, installFetch, llm7Settings, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'

const LESSON = {
  suggestion: { name: 'Fotossíntese', folder: 'Biologia' },
  markdown: {
    elements: [
      { type: 'heading', level: 1, text: 'Fotossíntese' },
      { type: 'paragraph', text: 'A planta transforma luz em energia química.' },
      { type: 'heading', level: 2, text: 'Etapas' },
      { type: 'orderedList', items: ['Fase clara', 'Fase escura'] },
      { type: 'diagram', diagramIndex: 0 },
      { type: 'heading', level: 2, text: 'Proporções' },
      { type: 'diagram', diagramIndex: 1 },
      { type: 'alert', style: 'tip', text: 'Lembre da clorofila.' },
    ],
    diagrams: [
      { type: 'flowchart', hint: 'Luz entra, glicose sai' },
      { type: 'pie', hint: 'Proporção de gases' },
    ],
  },
}

const FLOW = { direction: 'LR', nodes: [{ id: 'L', text: 'Luz (sol)' }, { id: 'G', text: 'Glicose' }], links: [{ from: 'L', to: 'G', text: 'vira' }] }
const PIE = { title: 'Gases', data: [{ label: 'O2', value: 21 }, { label: 'CO2', value: 1 }] }

function isDiagramCall(request: CapturedRequest) {
  return systemPromptOf(request) === PROMPTS.DIAGRAM_PROMPT
}

function diagramType(request: CapturedRequest): string {
  return /<Schema JSON para (\w+)>/.exec(userContentOf(request))?.[1] ?? ''
}

beforeAll(() => {
  mermaid.initialize({ startOnLoad: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('generateContent (lesson pipeline)', () => {
  it('produces a structured lesson with valid mermaid diagrams through the real provider stack', async () => {
    const { calls } = installFetch(request => {
      if (isDiagramCall(request)) return openAiStream(JSON.stringify(diagramType(request) === 'flowchart' ? FLOW : PIE), 4, { prompt_tokens: 10, completion_tokens: 5 })
      return openAiStream('```json\n' + JSON.stringify(LESSON) + '\n```', 6, { prompt_tokens: 100, completion_tokens: 50 })
    })
    const session = new GenerationSession(llm7Settings())
    const events: GenerationEvent[] = []
    const markdown = await generateContent('# Material\n\nfotossíntese', PROMPTS.LESSON_PROMPT, session, event => events.push(event))

    expect(calls).toHaveLength(3)
    expect(systemPromptOf(calls[0])).toBe(PROMPTS.LESSON_PROMPT)
    expect(calls.slice(1).map(diagramType).sort()).toEqual(['flowchart', 'pie'])

    expect(events.map(event => event.type).sort()).toEqual(['diagram_ready', 'diagram_ready', 'lesson_complete', 'phase1_complete', 'suggestion'].sort())
    const phaseOne = events.find(event => event.type === 'phase1_complete') as { markdown: string }
    expect(phaseOne.markdown).toContain('<!-- diagram:0 -->')
    expect(phaseOne.markdown).toContain('<!-- diagram:1 -->')
    expect(events.find(event => event.type === 'suggestion')).toEqual({ type: 'suggestion', suggestion: { name: 'Fotossíntese', folder: 'Biologia' } })

    expect(markdown.startsWith('# Fotossíntese\n')).toBe(true)
    expect(markdown.match(/^## .+$/gm)).toEqual(['## Etapas', '## Proporções'])
    expect(markdown).toContain('1. Fase clara\n2. Fase escura')
    expect(markdown).toContain('> [!TIP]\n> Lembre da clorofila.')
    expect(markdown).not.toContain('<!-- diagram')
    const blocks = [...markdown.matchAll(/```mermaid\n([\s\S]*?)\n```/g)].map(match => match[1])
    expect(blocks).toHaveLength(2)
    expect(blocks[0].startsWith('flowchart LR')).toBe(true)
    expect(blocks[1].startsWith('pie title Gases')).toBe(true)
    for (const block of blocks) await expect(mermaid.parse(block)).resolves.toBeTruthy()

    const usage = session.usage()
    expect(usage).toMatchObject({ provider: 'llm7', model: 'default', inputTokens: 120, outputTokens: 60, estimated: false, calls: 3 })
  })

  it('retries phase one with an auto-correction prompt when the JSON is invalid', async () => {
    let lessonCalls = 0
    const { calls } = installFetch(request => {
      if (isDiagramCall(request)) return openAiStream(JSON.stringify(diagramType(request) === 'flowchart' ? FLOW : PIE))
      lessonCalls++
      if (lessonCalls === 1) return openAiStream('desculpe, não sei')
      if (lessonCalls === 2) return openAiStream(JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 9, text: 'x' }] } }))
      return openAiStream(JSON.stringify(LESSON))
    })
    const markdown = await generateContent('c', PROMPTS.LESSON_PROMPT, new GenerationSession(llm7Settings()))
    expect(lessonCalls).toBe(3)
    const lessonRequests = calls.filter(call => !isDiagramCall(call))
    expect(systemPromptOf(lessonRequests[1])).toContain('[Auto-Correção]\nErro na tentativa anterior: resposta da IA não contém JSON válido')
    expect(systemPromptOf(lessonRequests[2])).toContain("'level' entre 1 e 6")
    expect(systemPromptOf(lessonRequests[2])).toContain(PROMPTS.LESSON_PROMPT)
    expect(markdown).toContain('# Fotossíntese')
  })

  it('gives up after five invalid phase-one replies', async () => {
    const { calls } = installFetch(() => openAiStream('sem json'))
    await expect(generateContent('c', PROMPTS.LESSON_PROMPT, new GenerationSession(llm7Settings()))).rejects.toBeInstanceOf(GenerationError)
    expect(calls).toHaveLength(5)
  })

  it('falls back to a table after three bad diagram replies', async () => {
    const onlyOne = { markdown: { elements: [{ type: 'paragraph', text: 'p' }, { type: 'diagram', diagramIndex: 0 }], diagrams: [{ type: 'sequence', hint: 'Cliente pede. Servidor responde' }] } }
    let diagramCalls = 0
    installFetch(request => {
      if (isDiagramCall(request)) {
        diagramCalls++
        return openAiStream(diagramCalls === 1 ? 'nada' : JSON.stringify({ actors: [] }))
      }
      return openAiStream(JSON.stringify(onlyOne))
    })
    const events: GenerationEvent[] = []
    const markdown = await generateContent('c', PROMPTS.LESSON_PROMPT, new GenerationSession(llm7Settings()), event => events.push(event))
    expect(diagramCalls).toBe(3)
    expect(events.some(event => event.type === 'diagram_fallback')).toBe(true)
    expect(markdown).toContain('| Conceito | Descrição |')
    expect(markdown).toContain('| Cliente | pede |')
    expect(markdown).not.toContain('```mermaid')
  })
})

describe('extractQuestions', () => {
  it('reads questions from plain or fenced JSON', () => {
    expect(extractQuestions('{"questions":[{"a":1}]}')).toEqual([{ a: 1 }])
    expect(extractQuestions('```json\n{"questions":[1,2]}\n```')).toEqual([1, 2])
    expect(extractQuestions('[1]')).toEqual([])
    expect(extractQuestions('lixo')).toEqual([])
  })
})
