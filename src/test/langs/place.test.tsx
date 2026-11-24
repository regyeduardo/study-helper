// T120/T122 (spec 004, FR-040; dono, 24/11: "Tudo no lugar padrão"): sem a estrutura do app, os idiomas ficam no lugar padrão da conta
// e funcionam sem servidor: criar o idioma, mandar o texto, gerar com a IA de Cartões e abrir o texto, tudo neste navegador.
import '@/test/account/storage-shim'
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const { mockEnv, ai } = vi.hoisted(() => ({
  mockEnv: { apiUrl: 'https://api.example.test', basePath: '/' },
  ai: { answer: (): Promise<string> => Promise.reject(new Error('sem resposta')), configured: true, prompts: [] as string[] },
}))
vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/components/layout/ReaderShell', () => ({ ReaderShell: ({ children }: { children: unknown }) => children }))
vi.mock('@/lib/ai/config', async original => ({ ...(await original<object>()), targetFor: () => ({ provider: 'deepinfra', baseUrl: '', apiKey: 'chave', model: 'deepseek-cartoes' }) }))
vi.mock('@/lib/ai/providers', async original => ({ ...(await original<object>()), missingSetup: () => (ai.configured ? null : 'Escolha um modelo.') }))
vi.mock('@/controllers/ai.controller', async original => ({
  ...(await original<object>()),
  chatController: async (_settings: unknown, prompt: string) => {
    ai.prompts.push(prompt)
    return { text: await ai.answer(), usage: { inputTokens: 0, outputTokens: 0, estimated: true } }
  },
}))

import { addLanguage, addText, failedReason, getText, listLanguages } from '@/controllers/langs.controller'
import { browserLangs, langPlace } from '@/lib/langs/browser'
import LanguagesPage from '@/pages/idiomas'
import LanguagePage from '@/pages/idiomas/language'
import { useLangsStore } from '@/stores/langs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const okJson = () => readFileSync(resolve(process.cwd(), 'api/internal/langs/testdata/ok.json'), 'utf8')
const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))

beforeEach(() => {
  // a library without Google and without the structure: everything in this browser
  useLibraryStore.setState({ appOn: false, repo: null, ready: true, accountId: `local-${Math.random()}` })
  useLangsStore.setState({ languages: null, details: {}, error: null } as never)
  ai.answer = async () => okJson()
  ai.configured = true
  ai.prompts = []
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchSpy.mockClear()
})

describe('idiomas no lugar padrão, sem a estrutura do app', () => {
  it('o lugar: App com a estrutura; Local sem Google', () => {
    expect(langPlace()).toBe('local')
    useLibraryStore.setState({ appOn: true })
    expect(langPlace()).toBe('app')
    expect(browserLangs()).toBeNull()
  })

  it('cria o idioma, manda o texto e ele é gerado neste navegador, com a IA de Cartões, sem falar com o servidor', async () => {
    await addLanguage({ code: 'en' })
    const { id, status } = await addText('en', { title: 'Chuva', text: "I used to walk to school every day\nBut now I won't walk in the rain" })
    expect(status).toBe('generating')
    await browserLangs()!.generator.idle()
    const text = await getText('en', id)
    expect(Object.keys(text.items)).toEqual(['walk', 'used_to', 'walk_way', 'neg_will'])
    expect(ai.prompts[0]).toContain('I used to walk to school every day')
    expect((await listLanguages())[0]).toMatchObject({ code: 'en', items: 4, texts: 1 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sem modelo em Cartões, o texto falha dizendo onde escolher', async () => {
    ai.configured = false
    await addLanguage({ code: 'en' })
    const { id } = await addText('en', { title: 'Sem IA', text: 'I walk' })
    await browserLangs()!.generator.idle()
    await expect(getText('en', id)).rejects.toMatchObject({ code: 'not_ready', data: { status: 'failed', error: 'ai_not_configured' } })
    expect(failedReason('ai_not_configured')).toBe('falta escolher o modelo de Cartões.')
  })

  it('o texto que falhou sem modelo leva direto à escolha do modelo (revisão de design, 24/11)', async () => {
    ai.configured = false
    await addLanguage({ code: 'en' })
    await addText('en', { title: 'Sem IA', text: 'I walk' })
    await browserLangs()!.generator.idle()
    render(
      <MemoryRouter initialEntries={['/idiomas/en']}>
        <Routes>
          <Route path="/idiomas/:code" element={<LanguagePage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Não deu para gerar: falta escolher o modelo de Cartões.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Escolher o modelo' }))
    expect(useUiStore.getState().overlay).toMatchObject({ kind: 'settings', tab: 'ai' })
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
  })

  it('a tela Idiomas abre sem conta no servidor e cria o idioma aqui', async () => {
    render(
      <MemoryRouter initialEntries={['/idiomas']}>
        <Routes>
          <Route path="/idiomas" element={<LanguagesPage />} />
          <Route path="/idiomas/:code" element={<p>idioma aberto</p>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: 'Escolha o primeiro idioma' })).toBeInTheDocument()
    expect(screen.queryByText('Os idiomas usam a estrutura do app')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Novo idioma' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo idioma' })
    fireEvent.click(within(dialog).getByRole('radio', { name: /Inglês/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar' }))
    expect(await screen.findByText('idioma aberto')).toBeInTheDocument()
    await waitFor(async () => expect((await listLanguages()).map(l => l.code)).toEqual(['en']))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
