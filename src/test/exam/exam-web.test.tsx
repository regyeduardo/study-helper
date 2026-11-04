import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { AiConfig } from '@/types/domain'
import { ExamDialog } from '@/components/dialogs/ExamDialog'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const question = (enunciado: string, extra: Record<string, unknown> = {}) => ({
  tipo: 'unica',
  enunciado,
  alternativas: { A: 'Existe', B: 'Não existe', C: 'Vale 0', D: 'Vale 1', E: 'Infinito' },
  correta: 'B',
  explicacao: 'Os laterais diferem.',
  ...extra,
})

function useConfig(defaults: AiConfig['defaults']) {
  const aiConfig: AiConfig = {
    providers: [
      { id: 'custom', type: 'custom', name: 'Personalizado', key: 'test-key', base: 'https://api.exemplo.dev/v1' },
      { id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'chave-or', base: '' },
    ],
    models: [
      { uid: 'custom::default', pid: 'custom', mid: 'default', name: 'Padrão' },
      { uid: 'openrouter::perplexity/sonar', pid: 'openrouter', mid: 'perplexity/sonar', name: 'Sonar' },
    ],
    defaults,
    steps: {},
  }
  useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, aiConfig } } }))
}

function provider() {
  return installFetch(request => {
    if (request.url.startsWith('https://openrouter.ai')) return openAiStream(JSON.stringify({ questions: [question('Real da web', { fonte: 'https://www.provas.exemplo.org/limites/7' })] }))
    const system = systemPromptOf(request)
    if (system.startsWith(PROMPTS.EXAM_PROMPT)) return openAiStream(JSON.stringify({ questions: [question('Criada pela IA')] }))
    if (system === PROMPTS.EXAM_REVIEW_PROMPT) return openAiStream('{"vereditos":[]}')
    return openAiStream('## Resumo\nLimites laterais.')
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  useModelsStore.setState({ live: {}, probes: {} })
})

describe('Prova com Questões da web', () => {
  it('usa o modelo de Padrões por uso › Questões da web e mostra a fonte de cada questão achada', async () => {
    const { calls } = provider()
    studyLibrary()
    useConfig({ estudo: 'custom::default', web: 'openrouter::perplexity/sonar' })
    const id = await studyNote()
    render(<ExamDialog fileId={id} />)
    fireEvent.click(await screen.findByRole('button', { name: /Gerar a prova/ }))

    const link = await screen.findByRole('link', { name: 'provas.exemplo.org' })
    expect(link).toHaveAttribute('href', 'https://www.provas.exemplo.org/limites/7')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByText('Criada pela IA')).toBeInTheDocument()
    expect(screen.queryByText(/Sem questões da web/)).not.toBeInTheDocument()
    const search = calls.find(request => request.url.startsWith('https://openrouter.ai'))!
    expect(search.body?.plugins).toEqual([{ id: 'web' }])
    expect(useJobsStore.getState().jobs[0].message).toContain('1 questão veio da web')
  })

  it('o Estudo herdado só pesquisa quando o app sabe que ele pesquisa na web', async () => {
    const { calls } = provider()
    studyLibrary()
    useConfig({ estudo: 'openrouter::perplexity/sonar' })
    const id = await studyNote()
    useModelsStore.setState({ probes: { 'openrouter::perplexity/sonar': { web: { state: 'yes' } } } })
    const result = await useJobsStore.getState().createQuestions(id)
    expect(result.web.found).toBe(1)
    expect(calls.filter(request => request.body && 'plugins' in request.body)).toHaveLength(1)
  })

  it('sem modelo que pesquise na web: a prova sai e avisa', async () => {
    const { calls } = provider()
    studyLibrary()
    useConfig({ estudo: 'custom::default' })
    const id = await studyNote()
    render(<ExamDialog fileId={id} />)
    fireEvent.click(await screen.findByRole('button', { name: /Gerar a prova/ }))

    expect(await screen.findByText(/Sem questões da web/)).toHaveTextContent('Padrões por uso')
    await waitFor(() => expect(screen.getByText('Criada pela IA')).toBeInTheDocument())
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(calls.some(request => request.url.startsWith('https://openrouter.ai'))).toBe(false)
  })
})
