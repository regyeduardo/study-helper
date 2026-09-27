import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishQuestions, type RawQuestion, reviewQuestions, validateQuestions } from '@/lib/generation/exam-questions'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { examPrompt, generateQuestions, generateReadingExam } from '@/lib/generation/questions'
import { GenerationSession } from '@/lib/generation/session'
import { installFetch, llm7Settings, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'

const ALTERNATIVES = { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' }

function single(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { tipo: 'unica', nivel: 'aplicar', enunciado: 'Qual?', alternativas: ALTERNATIVES, correta: 'A', explicacao: 'porque', explicacao_das_erradas: { A: 'x', B: 'erro b', C: ' ' }, resposta_certa: 'a', id: 9, ...overrides }
}

function sequenceRandom(): () => number {
  let seed = 7
  return () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('validateQuestions', () => {
  it('keeps valid questions of every kind and strips internal fields', () => {
    const accepted = validateQuestions([
      single(),
      { tipo: 'multipla', enunciado: 'Quais?', alternativas: ALTERNATIVES, corretas: ['A', 'C'], explicacao: 'e' },
      { tipo: 'certo_errado', enunciado: 'É?', certo: false, explicacao: 'e' },
      { tipo: 'ordenar', enunciado: 'Ordene', passos: ['1', '2', '3'], explicacao: 'e' },
      { tipo: 'associar', enunciado: 'Ligue', pares: [{ esquerda: 'a', direita: '1' }, { esquerda: 'b', direita: '2' }, { esquerda: 'c', direita: '3' }], explicacao: 'e' },
      { tipo: 'lacuna', enunciado: 'O [[1]] é', lacunas: [{ opcoes: ['sol', 'mar'], correta: 'sol' }], explicacao: 'e' },
    ])
    expect(accepted.map(question => question.tipo)).toEqual(['unica', 'multipla', 'certo_errado', 'ordenar', 'associar', 'lacuna'])
    expect(accepted[0]).not.toHaveProperty('resposta_certa')
    expect(accepted[0]).not.toHaveProperty('id')
    expect(accepted[0].explicacao_das_erradas).toEqual({ B: 'erro b' })
    expect(accepted[2].nivel).toBeNull()
  })

  it.each([
    ['missing alternative', single({ alternativas: { A: 'a', B: 'b', C: 'c', D: 'd' } })],
    ['bad correct letter', single({ correta: 'F' })],
    ['no statement', single({ enunciado: '' })],
    ['no explanation', single({ explicacao: '' })],
    ['unknown kind', single({ tipo: 'dissertativa' })],
    ['multiple with one letter', { tipo: 'multipla', enunciado: 'q', alternativas: ALTERNATIVES, corretas: ['A'], explicacao: 'e' }],
    ['true/false without answer', { tipo: 'certo_errado', enunciado: 'q', explicacao: 'e' }],
    ['ordering with two steps', { tipo: 'ordenar', enunciado: 'q', passos: ['1', '2'], explicacao: 'e' }],
    ['ordering with repeated step', { tipo: 'ordenar', enunciado: 'q', passos: ['1', '1', '2'], explicacao: 'e' }],
    ['matching with repeated right side', { tipo: 'associar', enunciado: 'q', pares: [{ esquerda: 'a', direita: '1' }, { esquerda: 'b', direita: '1' }, { esquerda: 'c', direita: '3' }], explicacao: 'e' }],
    ['gap not in statement', { tipo: 'lacuna', enunciado: 'sem marca', lacunas: [{ opcoes: ['a', 'b'], correta: 'a' }], explicacao: 'e' }],
    ['gap answer not among options', { tipo: 'lacuna', enunciado: '[[1]]', lacunas: [{ opcoes: ['a', 'b'], correta: 'c' }], explicacao: 'e' }],
  ])('drops %s', (_, question) => {
    expect(validateQuestions([question])).toEqual([])
  })

  it('treats a question without kind as single choice', () => {
    const { tipo, ...rest } = single()
    expect(tipo).toBe('unica')
    expect(validateQuestions([rest])[0].tipo).toBe('unica')
  })
})

describe('finishQuestions', () => {
  it('spreads the right letter evenly across A-E for single-choice questions while keeping the answer', () => {
    const questions = Array.from({ length: 10 }, (_, index) => validateQuestions([single({ enunciado: `q${index}`, alternativas: { A: 'certa', B: 'b', C: 'c', D: 'd', E: 'e' } })])[0])
    const finished = finishQuestions(questions, sequenceRandom())
    const letters = finished.map(question => question.correta as string)
    for (const letter of ['A', 'B', 'C', 'D', 'E']) expect(letters.filter(item => item === letter)).toHaveLength(2)
    for (const question of finished) expect((question.alternativas as Record<string, string>)[question.correta as string]).toBe('certa')
  })

  it('turns a question diagram spec into mermaid and drops data questions with broken diagrams', () => {
    const withDiagram = { tipo: 'certo_errado', enunciado: 'q', certo: true, explicacao: 'e', diagrama: { tipo: 'pie', dados: { data: [{ label: 'a', value: 1 }] } } } as RawQuestion
    const broken = { tipo: 'certo_errado', enunciado: 'q', certo: true, explicacao: 'e', formato: 'interpretar_dado', diagrama: { tipo: 'pie', dados: {} } } as RawQuestion
    const finished = finishQuestions([withDiagram, broken])
    expect(finished).toHaveLength(1)
    expect(finished[0].diagrama).toBe('pie\n    "a" : 1')
  })
})

describe('reviewQuestions', () => {
  it('applies discard and fix verdicts', async () => {
    installFetch(() =>
      openAiStream(
        JSON.stringify({
          vereditos: [
            { id: 1, veredito: 'descarta' },
            { id: 2, veredito: 'corrige', questao: { enunciado: 'Corrigida', certo: true, explicacao: 'e' } },
            { id: 3, veredito: 'mantem' },
          ],
        }),
      ),
    )
    const questions = validateQuestions([single(), { tipo: 'certo_errado', enunciado: 'Errada', certo: false, explicacao: 'e' }, { tipo: 'certo_errado', enunciado: 'Ok', certo: true, explicacao: 'e' }])
    const reviewed = await reviewQuestions(questions, new GenerationSession(llm7Settings()))
    expect(reviewed.map(question => question.enunciado)).toEqual(['Corrigida', 'Ok'])
    expect(reviewed[0].tipo).toBe('certo_errado')
  })

  it('keeps the questions when the review call fails', async () => {
    installFetch(() => new Response('down', { status: 500 }))
    const questions = validateQuestions([single()])
    expect(await reviewQuestions(questions, new GenerationSession(llm7Settings()))).toEqual(questions)
  })
})

describe('generateQuestions', () => {
  it('runs prep, exam and review calls and returns finished questions', async () => {
    const exam = { questions: [single(), { tipo: 'certo_errado', enunciado: 'É verde?', certo: true, explicacao: 'sim' }, { tipo: 'ordenar', enunciado: 'Ordene', passos: ['a', 'b', 'c'], explicacao: 'e' }, { tipo: 'nada' }] }
    const { calls } = installFetch(request => {
      const system = systemPromptOf(request)
      if (system.startsWith(PROMPTS.QUESTIONS_PREP_PROMPT.slice(0, 40))) return openAiStream('## Resumo\n**Clorofila** absorve luz.')
      if (system.startsWith(PROMPTS.EXAM_PROMPT)) return openAiStream(JSON.stringify(exam))
      if (system === PROMPTS.EXAM_REVIEW_PROMPT) return openAiStream(JSON.stringify({ vereditos: [] }))
      return new Response('unexpected', { status: 500 })
    })
    const { questions } = await generateQuestions('# Aula\n\nconteúdo', 'Fotossíntese', 'class', new GenerationSession(llm7Settings()), [{ enunciado: 'errei', explicacao: 'x' }])
    expect(calls).toHaveLength(3)
    expect(systemPromptOf(calls[0])).toContain('No máximo 4000 caracteres')
    expect(userContentOf(calls[1])).toContain('## Questões que a pessoa errou')
    expect(systemPromptOf(calls[1])).toContain(PROMPTS.ADAPTIVE_FOCUS)
    expect(calls[1].body?.max_tokens).toBe(32768)
    expect(questions.map(question => question.tipo)).toEqual(['unica', 'certo_errado', 'ordenar'])
  })

  it('exam prompt includes the focus for the file type', () => {
    expect(examPrompt('meeting')).toContain(PROMPTS.FILE_TYPE_FOCUS.meeting)
    expect(examPrompt('class')).not.toContain(PROMPTS.ADAPTIVE_FOCUS)
  })

  it('reading exam uses the reading prompt', async () => {
    const { calls } = installFetch(() => openAiStream(JSON.stringify({ questions: [single()] })))
    const { questions } = await generateReadingExam('texto', 'Conto', new GenerationSession(llm7Settings()))
    expect(systemPromptOf(calls[0])).toBe(PROMPTS.READING_EXAM_PROMPT)
    expect(questions).toHaveLength(1)
  })
})
