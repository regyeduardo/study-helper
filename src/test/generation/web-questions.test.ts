import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AiSettings, Question } from '@/types/domain'
import { shuffleExam } from '@/lib/exam'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { generateQuestions } from '@/lib/generation/questions'
import { GenerationSession } from '@/lib/generation/session'
import { WEB_QUESTIONS_PROMPT } from '@/lib/generation/web-questions'
import { type CapturedRequest, installFetch, llm7Settings, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'

const openrouter: AiSettings = { provider: 'openrouter', baseUrl: '', apiKey: 'chave-or', model: 'perplexity/sonar' }
const openai: AiSettings = { provider: 'openai', baseUrl: '', apiKey: 'chave-oa', model: 'gpt-4o-search-preview' }

const single = (overrides: Record<string, unknown> = {}) => ({
  tipo: 'unica',
  enunciado: 'Qual pigmento absorve a luz?',
  alternativas: { A: 'Clorofila', B: 'Caroteno', C: 'Xantofila', D: 'Ficocianina', E: 'Antocianina' },
  correta: 'A',
  explicacao: 'A clorofila absorve a luz.',
  ...overrides,
})
const fromWeb = (number: number) => single({ enunciado: `Real ${number}`, fonte: `https://provas.exemplo.org/q${number}` })

const isWeb = (request: CapturedRequest) => !request.url.startsWith('https://api.llm7.io')

function provider(webReply: () => Response) {
  return installFetch(request => {
    if (isWeb(request)) return webReply()
    const system = systemPromptOf(request)
    if (system.startsWith(PROMPTS.QUESTIONS_PREP_PROMPT.slice(0, 40))) return openAiStream('## Resumo\nA clorofila absorve luz.')
    if (system.startsWith(PROMPTS.EXAM_PROMPT)) return openAiStream(JSON.stringify({ questions: [single({ enunciado: 'Criada 1' }), single({ enunciado: 'Criada 2', fonte: 'https://inventada.dev/x' })] }))
    if (system === PROMPTS.EXAM_REVIEW_PROMPT) return openAiStream('{"vereditos":[]}')
    return new Response('inesperado', { status: 500 })
  })
}

const run = (web: AiSettings | null) => generateQuestions('# Aula\n\nconteúdo', 'Fotossíntese', 'class', new GenerationSession(llm7Settings()), undefined, web)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Questões da web na Prova', () => {
  it('OpenRouter: pesquisa com o plugin web, traz as reais com a fonte e a IA cria só o resto', async () => {
    const { calls } = provider(() => openAiStream(JSON.stringify({ questions: [fromWeb(1), fromWeb(2), single({ enunciado: 'Sem fonte' })] })))
    const { questions, web } = await run(openrouter)

    const search = calls.find(isWeb)!
    expect(search.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(search.headers.authorization).toBe('Bearer chave-or')
    expect(search.body?.model).toBe('perplexity/sonar')
    expect(search.body?.plugins).toEqual([{ id: 'web' }])
    expect(search.body).not.toHaveProperty('web_search_options')
    expect(search.body).not.toHaveProperty('temperature')
    expect(systemPromptOf(search)).toBe(WEB_QUESTIONS_PROMPT)
    expect(userContentOf(search)).toContain('# Fotossíntese')
    expect(userContentOf(search)).toContain('A clorofila absorve luz.')

    const exam = calls.find(request => systemPromptOf(request).startsWith(PROMPTS.EXAM_PROMPT))!
    expect(systemPromptOf(exam)).toContain('A prova já tem 2 questões reais tiradas da web')
    expect(systemPromptOf(exam)).toContain('de 10 a 13 questões')
    expect(userContentOf(exam)).toContain('Real 1')

    expect(questions.map(question => question.enunciado).sort()).toEqual(['Criada 1', 'Criada 2', 'Real 1', 'Real 2'])
    expect(questions.find(question => question.enunciado === 'Real 2')?.fonte).toBe('https://provas.exemplo.org/q2')
    expect(questions.find(question => question.enunciado === 'Criada 2')).not.toHaveProperty('fonte')
    expect(web.found).toBe(2)
    expect(web.note).toContain('2 questões vieram da web')
  })

  it('outro provedor no formato OpenAI: liga a pesquisa nativa com web_search_options', async () => {
    const { calls } = provider(() => openAiStream(JSON.stringify({ questions: [fromWeb(1)] })))
    const { web } = await run(openai)
    const search = calls.find(isWeb)!
    expect(search.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(search.body?.web_search_options).toEqual({})
    expect(search.body).not.toHaveProperty('plugins')
    expect(search.body).not.toHaveProperty('temperature')
    expect(web.found).toBe(1)
  })

  it('sem modelo de Questões da web: gera normal e avisa', async () => {
    const { calls } = provider(() => new Response('não devia', { status: 500 }))
    const { questions, web } = await run(null)
    expect(calls.some(isWeb)).toBe(false)
    expect(calls).toHaveLength(3)
    const exam = calls.find(request => systemPromptOf(request).startsWith(PROMPTS.EXAM_PROMPT))!
    expect(systemPromptOf(exam)).not.toContain('QUESTÕES DA WEB')
    expect(questions).toHaveLength(2)
    expect(web.found).toBe(0)
    expect(web.note).toContain('Padrões por uso')
    expect(web.note).toContain('só com questões criadas pela IA')
  })

  it('a pesquisa falha: gera normal e avisa', async () => {
    provider(() => new Response('fora do ar', { status: 500 }))
    const { questions, web } = await run(openrouter)
    expect(questions.map(question => question.enunciado).sort()).toEqual(['Criada 1', 'Criada 2'])
    expect(questions.some(question => 'fonte' in question)).toBe(false)
    expect(web.found).toBe(0)
    expect(web.note).toContain('a pesquisa falhou')
    expect(web.note).toContain('só com questões criadas pela IA')
  })

  it('a pesquisa não acha questão com fonte: gera normal e avisa', async () => {
    provider(() => openAiStream(JSON.stringify({ questions: [single({ enunciado: 'Sem fonte' }), single({ fonte: 'não é endereço' })] })))
    const { questions, web } = await run(openrouter)
    expect(questions).toHaveLength(2)
    expect(web.found).toBe(0)
    expect(web.note).toContain('não achou')
  })

  it('achou a prova inteira: fica com todas as da web, sem teto, e a IA não cria nenhuma', async () => {
    const { calls } = provider(() => openAiStream(JSON.stringify({ questions: Array.from({ length: 17 }, (_, index) => fromWeb(index + 1)) })))
    const { questions, web } = await run(openrouter)
    expect(calls.some(request => systemPromptOf(request).startsWith(PROMPTS.EXAM_PROMPT))).toBe(false)
    expect(questions).toHaveLength(17)
    expect(questions.every(question => typeof question.fonte === 'string')).toBe(true)
    expect(web.found).toBe(17)
  })

  it('questão da web com 4 alternativas fica com 4, como na fonte, e embaralha só entre A e D', async () => {
    const four = { ...fromWeb(1), alternativas: { A: 'Clorofila', B: 'Caroteno', C: 'Xantofila', D: 'Ficocianina' } }
    provider(() => openAiStream(JSON.stringify({ questions: [four] })))
    const { questions } = await run(openrouter)
    const real = questions.find(question => question.enunciado === 'Real 1')
    expect(Object.keys(real?.alternativas as Record<string, string>).sort()).toEqual(['A', 'B', 'C', 'D'])
    const [shown] = shuffleExam([{ ...real, id: 1 } as unknown as Question], () => 0.99)
    expect(Object.keys(shown.alternativas).sort()).toEqual(['A', 'B', 'C', 'D'])
    expect(shown.alternativas[shown.correta as string]).toBe('Clorofila')
  })

  it('cancelar durante a pesquisa cancela a prova, sem cair na geração normal', async () => {
    const controller = new AbortController()
    const { calls } = installFetch(request => {
      if (isWeb(request)) {
        controller.abort()
        return new Response('cancelado', { status: 500 })
      }
      return openAiStream('## Resumo')
    })
    await expect(generateQuestions('# Aula', 'Fotossíntese', 'class', new GenerationSession(llm7Settings(), controller.signal), undefined, openrouter)).rejects.toThrow()
    expect(calls.some(request => systemPromptOf(request).startsWith(PROMPTS.EXAM_PROMPT))).toBe(false)
  })

  it('o pedido à web: sem número fixo, traduz para o português e guarda a fonte', () => {
    expect(WEB_QUESTIONS_PROMPT).toContain('Não há número fixo')
    expect(WEB_QUESTIONS_PROMPT).toContain('traduza')
    expect(WEB_QUESTIONS_PROMPT).toContain('português do Brasil')
    expect(WEB_QUESTIONS_PROMPT).toContain('"fonte"')
    expect(WEB_QUESTIONS_PROMPT).toContain('Nunca invente')
    expect(WEB_QUESTIONS_PROMPT).not.toMatch(/até 15|quinta/)
  })
})
