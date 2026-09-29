import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { FreeAi } from '@/components/dialogs/FreeAi'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { chatController, FreeAiExhaustedError } from '@/controllers/ai.controller'
import { lessonsLeft } from '@/lib/ai/free'
import { defaultIndex, newAccountIndex } from '@/lib/defaults'
import { env } from '@/lib/env'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { openAiStream } from './fake-provider'

const WORKER = 'https://free-ai.test'
const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana Souza', email: 'ana@example.com', picture: '', token: { accessToken: 'google-token', expiresAt: Date.now() + 3600_000 } }
const FREE = { provider: 'free' as const, baseUrl: '', apiKey: '', model: '' }
let calls: { url: string; init: RequestInit }[]
let balance = { input_tokens_remaining: 214983, output_tokens_remaining: 48159 }

beforeEach(() => {
  env.transcriptionWorkerUrl = WORKER
  calls = []
  balance = { input_tokens_remaining: 214983, output_tokens_remaining: 48159 }
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
  const index = defaultIndex()
  index.settings.ai = FREE
  useLibraryStore.setState({ index, updateSettings: async settings => void useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, ...settings } } })) })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init })
      if (url.endsWith('/balance')) return new Response(JSON.stringify(balance))
      return openAiStream('# Aula', 1, { prompt_tokens: 10, completion_tokens: 5 })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('free AI (Ling-3.0-flash through the worker)', () => {
  it('sends the Google token to the worker and asks for Ling', async () => {
    expect((await chatController(FREE, 'material', 'sistema')).text).toBe('# Aula')
    expect(calls[0].url).toBe(`${WORKER}/chat/completions`)
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer google-token')
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('inclusionAI/Ling-3.0-flash')
  })

  it('stops at once with the exhausted message when the worker says the day is over', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => (calls.push({ url, init }), new Response('{"error":"no_tokens"}', { status: 429 }))))
    await expect(chatController(FREE, 'material', 'sistema')).rejects.toBeInstanceOf(FreeAiExhaustedError)
    expect(calls).toHaveLength(1)
  })

  it('asks for the Google login in the Local profile without calling anyone', async () => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    await expect(chatController(FREE, 'material', 'sistema')).rejects.toThrow('login com o Google')
    expect(calls).toHaveLength(0)
  })

  it('counts lessons by the scarcer of input and output', () => {
    expect(lessonsLeft({ inputTokens: 214983, outputTokens: 48159 })).toBe(9)
    expect(lessonsLeft({ inputTokens: 214983, outputTokens: 10000 })).toBe(1)
    expect(lessonsLeft({ inputTokens: 0, outputTokens: 48159 })).toBe(0)
  })

  it('a new Google library starts on the free AI and the default stays on OVH', () => {
    expect(newAccountIndex().settings.ai.provider).toBe('free')
    expect(defaultIndex().settings.ai.provider).toBe('ovh')
  })

  it('shows the lessons left for today', async () => {
    render(<FreeAi />)
    expect(await screen.findByText('≈ 9 aulas restantes hoje')).toBeInTheDocument()
  })

  it('when the day is over offers OVH and the free Gemini, and OVH switches the AI', async () => {
    balance = { input_tokens_remaining: 0, output_tokens_remaining: 3000 }
    render(<FreeAi />)
    expect(await screen.findByRole('alert', { name: 'IA grátis' })).toHaveTextContent('A IA grátis de hoje acabou.')
    expect(screen.getByRole('button', { name: /Configurar o Gemini grátis/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Usar a OVH/ }))
    expect(useLibraryStore.getState().index.settings.ai.provider).toBe('ovh')
  })

  it('offers "Grátis (Ling)" in the AI settings only to a Google account', () => {
    const { unmount } = render(<SettingsDialog initial="ai" />)
    expect(screen.getByRole('button', { name: /^Grátis\s*com login Google$/ })).toBeInTheDocument()
    unmount()
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    render(<SettingsDialog initial="ai" />)
    expect(screen.queryByRole('button', { name: /^Grátis\s*com login Google$/ })).not.toBeInTheDocument()
  })

  it('the free AI shows no key, model or free-model warning, and the test checks the login and today\'s balance', async () => {
    render(<SettingsDialog initial="ai" />)
    expect(screen.getByRole('note', { name: 'IA em uso' })).toHaveTextContent(/^Em uso: Grátis$/)
    expect(screen.queryByLabelText(/Chave da API/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Modelo')).not.toBeInTheDocument()
    expect(screen.queryByText('Modelos grátis podem comprometer o resultado da geração.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Testar sem gastar token/ }))
    await waitFor(() => expect(screen.getByText('Conectado · ≈ 9 aulas restantes hoje')).toBeInTheDocument())
    expect(calls[0].url).toBe(`${WORKER}/balance`)
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer google-token')
  })
})
