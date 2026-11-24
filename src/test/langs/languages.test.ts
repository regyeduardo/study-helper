import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test', basePath: '/' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { addLanguage, addText, getLanguage, langsMessage, listLanguages, recordAnswer, retryText, saveProgress } from '@/controllers/langs.controller'
import { ApiError } from '@/controllers/api.controller'
import { useLangsStore } from '@/stores/langs'
import { useLibraryStore } from '@/stores/library'

// T016: the controller and the store of the languages mode (spec 004). Everything goes to the server, with the session and the app's mark.

type Call = { method: string; path: string; body: unknown; headers: Record<string, string>; credentials?: RequestCredentials }
let calls: Call[]
let answer: (call: Call) => Response

const json = (status: number, value: unknown) => new Response(value === undefined ? null : JSON.stringify(value), { status })

beforeEach(() => {
  // these are the App's: the structure is on, the languages live on the server (24/11, FR-040)
  useLibraryStore.setState({ appOn: true })
  calls = []
  answer = () => json(200, {})
  useLangsStore.setState({ languages: null, details: {}, error: null })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { method: init.method ?? 'GET', path: url.replace(mockEnv.apiUrl, ''), body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string>, credentials: init.credentials }
      calls.push(call)
      return answer(call)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('langs.controller', () => {
  it('fala com o servidor com a sessão e a marca do app', async () => {
    answer = () => json(201, { code: 'en', name: 'Inglês', locale: 'en-US' })
    const made = await addLanguage({ code: 'en' })
    expect(made.name).toBe('Inglês')
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/languages', body: { code: 'en' }, credentials: 'include' })
    expect(calls[0].headers['X-Estudo']).toBe('1')

    answer = () => json(202, { id: 't1', status: 'generating' })
    await addText('en', { title: 'Chuva', text: 'I walk' })
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/v1/languages/en/texts', body: { title: 'Chuva', text: 'I walk' } })

    answer = () => json(204, undefined)
    await recordAnswer('en', { textId: 't1', cardId: 'c1', stage: 'practice', promptLang: 'native', answer: 'walk', ok: true, retry: false })
    await saveProgress('en', 't1', { at: 3 })
    await retryText('en', 't1')
    expect(calls.slice(2).map(call => `${call.method} ${call.path}`)).toEqual(['POST /v1/languages/en/answers', 'PUT /v1/languages/en/texts/t1/progress', 'POST /v1/languages/en/texts/t1/retry'])
  })

  it('diz em português cada recusa do servidor', async () => {
    answer = () => json(409, { error: 'language_exists' })
    const refused = await addLanguage({ code: 'en' }).catch(error => error)
    expect(refused).toBeInstanceOf(ApiError)
    expect(langsMessage(refused)).toBe('Você já estuda este idioma.')
    expect(langsMessage(new ApiError(413, 'text_too_large', { maxLength: 100000 }))).toBe('O texto passa de 100.000 caracteres. Mande uma parte de cada vez.')
    expect(langsMessage(new ApiError(403, 'app_disabled'))).toMatch(/estrutura do app/)
    expect(langsMessage(new ApiError(422, 'invalid_language'))).toMatch(/código/)
    expect(langsMessage(new ApiError(0, 'offline'))).toMatch(/internet/)
  })
})

describe('stores/langs', () => {
  it('carrega os idiomas e guarda o detalhe de cada um', async () => {
    answer = call =>
      call.path === '/v1/languages'
        ? json(200, { languages: [{ code: 'en', name: 'Inglês', locale: 'en-US', items: 4, seen: 1, fixed: 0, due: 0, texts: 1 }] })
        : json(200, { code: 'en', name: 'Inglês', locale: 'en-US', items: 4, seen: 1, fixed: 0, due: 0, areas: {}, texts: [{ id: 't1', title: 'Chuva', status: 'ready', progress: 'start', createdAt: '2026-11-23T12:00:00.000Z' }] })
    await useLangsStore.getState().load()
    expect(useLangsStore.getState().languages?.[0].name).toBe('Inglês')
    await useLangsStore.getState().open('en')
    expect(useLangsStore.getState().details.en?.texts[0].title).toBe('Chuva')
  })

  it('sem a estrutura do app, guarda o motivo', async () => {
    answer = () => json(403, { error: 'app_disabled' })
    await useLangsStore.getState().load()
    expect(useLangsStore.getState().error).toBe('app_disabled')
    expect(useLangsStore.getState().languages).toBeNull()
  })

  it('enquanto um texto gera, pergunta de novo sozinho até ficar pronto', async () => {
    vi.useFakeTimers()
    let status = 'generating'
    answer = () => json(200, { code: 'en', name: 'Inglês', locale: 'en-US', items: 0, seen: 0, fixed: 0, due: 0, areas: {}, texts: [{ id: 't1', title: 'Chuva', status, progress: 'start', createdAt: '' }] })
    await useLangsStore.getState().open('en')
    expect(useLangsStore.getState().details.en?.texts[0].status).toBe('generating')
    const stop = useLangsStore.getState().follow('en')
    status = 'ready'
    await vi.advanceTimersByTimeAsync(5_000)
    expect(useLangsStore.getState().details.en?.texts[0].status).toBe('ready')
    const before = calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls.length).toBe(before)
    stop()
  })
})

describe('getLanguage e listLanguages', () => {
  it('leem as rotas do contrato', async () => {
    answer = call => (call.path === '/v1/languages' ? json(200, { languages: [] }) : json(200, { code: 'sv', name: 'Sueco', locale: 'sv-SE', items: 0, seen: 0, fixed: 0, due: 0, areas: {}, texts: [] }))
    expect(await listLanguages()).toEqual([])
    expect((await getLanguage('sv')).name).toBe('Sueco')
    expect(calls.map(call => call.path)).toEqual(['/v1/languages', '/v1/languages/sv'])
  })
})
