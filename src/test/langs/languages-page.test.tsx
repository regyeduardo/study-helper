import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test', basePath: '/' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/components/layout/ReaderShell', () => ({ ReaderShell: ({ children }: { children: unknown }) => children }))

import LanguagesPage from '@/pages/idiomas'
import LanguagePage from '@/pages/idiomas/language'
import { useLangsStore } from '@/stores/langs'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { useLibraryStore } from '@/stores/library'

// T019 and T026: the Idiomas screen (wireframe A + the window F) and the page of a language (wireframe D, with "Novo texto").

type Call = { method: string; path: string; body: unknown }
let calls: Call[]
let routes: Record<string, (call: Call) => Response>
const json = (status: number, value: unknown) => new Response(value === undefined ? null : JSON.stringify(value), { status })

const english = { code: 'en', name: 'Inglês', locale: 'en-US', items: 142, seen: 50, fixed: 38, due: 12, texts: 2 }
const englishDetail = {
  ...english,
  areas: { lexico: { total: 72, seen: 60, fixed: 20 }, gramatica: { total: 35, seen: 30, fixed: 8 } },
  texts: [
    { id: 't1', title: 'Canção da estrada', status: 'ready', progress: 'continue', known: 78, createdAt: '2026-11-20T10:00:00.000Z' },
    { id: 't2', title: 'Artigo: trabalho remoto', status: 'ready', progress: 'start', known: 40, createdAt: '2026-11-21T10:00:00.000Z' },
    { id: 't3', title: 'Entrevista', status: 'generating', progress: 'start', known: 0, createdAt: '2026-11-22T10:00:00.000Z' },
    { id: 't4', title: 'Poema longo', status: 'failed', error: 'provider_down', progress: 'start', known: 0, createdAt: '2026-11-23T10:00:00.000Z' },
  ],
}

function signedIn(appEnabled = true) {
  useServerAccount.setState({
    status: 'signed-in',
    me: { user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true }, requireCode: false, device: { id: 'd', name: 'Chrome' }, space: { notes: 0, media: 0, reserved: 0, limit: 1, warnAt: 0.9 } },
  } as never)
}

beforeEach(() => {
  // these are the App's: the structure is on, the languages live on the server (24/11, FR-040)
  useLibraryStore.setState({ appOn: true })
  calls = []
  routes = {}
  useLangsStore.setState({ languages: null, details: {}, error: null })
  useUiStore.setState({ overlay: null, toasts: [] })
  signedIn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { method: init.method ?? 'GET', path: url.replace(mockEnv.apiUrl, ''), body: init.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      const route = routes[`${call.method} ${call.path}`]
      return route ? route(call) : json(404, { error: 'not_found' })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/idiomas" element={<LanguagesPage />} />
        <Route path="/idiomas/:code" element={<LanguagePage />} />
        <Route path="/idiomas/:code/:textId" element={<p>estudo aberto</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Idiomas', () => {
  it('cada idioma com o resumo e o texto para continuar, a um toque', async () => {
    routes['GET /v1/languages'] = () => json(200, { languages: [english, { code: 'sv', name: 'Sueco', locale: 'sv-SE', items: 0, seen: 0, fixed: 0, due: 0, texts: 0 }] })
    routes['GET /v1/languages/en'] = () => json(200, englishDetail)
    routes['GET /v1/languages/sv'] = () => json(200, { code: 'sv', name: 'Sueco', locale: 'sv-SE', items: 0, seen: 0, fixed: 0, due: 0, areas: {}, texts: [] })
    at('/idiomas')
    expect(await screen.findByText('50 vistos · 38 fixados · 12 para revisar')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Continuar: Canção da estrada/ }))
    expect(await screen.findByText('estudo aberto')).toBeInTheDocument()
  })

  it('o idioma sem texto pede o primeiro', async () => {
    routes['GET /v1/languages'] = () => json(200, { languages: [{ code: 'sv', name: 'Sueco', locale: 'sv-SE', items: 0, seen: 0, fixed: 0, due: 0, texts: 0 }] })
    routes['GET /v1/languages/sv'] = () => json(200, { code: 'sv', name: 'Sueco', locale: 'sv-SE', items: 0, seen: 0, fixed: 0, due: 0, areas: {}, texts: [] })
    at('/idiomas')
    expect(await screen.findByRole('button', { name: 'Mande o primeiro texto' })).toBeInTheDocument()
  })

  it('novo idioma da lista, com busca; o que já estuda vem marcado', async () => {
    routes['GET /v1/languages'] = () => json(200, { languages: [english] })
    routes['GET /v1/languages/en'] = () => json(200, englishDetail)
    routes['POST /v1/languages'] = call => json(201, { code: (call.body as { code: string }).code, name: 'Espanhol', locale: 'es-ES' })
    routes['GET /v1/languages/es'] = () => json(200, { code: 'es', name: 'Espanhol', locale: 'es-ES', items: 0, seen: 0, fixed: 0, due: 0, areas: {}, texts: [] })
    at('/idiomas')
    fireEvent.click(await screen.findByRole('button', { name: /Novo idioma/ }))
    const dialog = screen.getByRole('dialog', { name: 'Novo idioma' })
    expect(within(dialog).getByRole('radio', { name: /Inglês/ })).toBeDisabled()
    expect(within(dialog).getByText('já estuda')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Buscar idioma'), { target: { value: 'esp' } })
    expect(within(dialog).getAllByRole('radio')).toHaveLength(1)
    fireEvent.click(within(dialog).getByRole('radio', { name: /Espanhol/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar' }))
    await waitFor(() => expect(calls.some(call => call.method === 'POST' && call.path === '/v1/languages')).toBe(true))
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ code: 'es' })
    expect(await screen.findByRole('heading', { name: 'Espanhol' })).toBeInTheDocument()
  })

  it('"Outro idioma" com nome e código', async () => {
    routes['GET /v1/languages'] = () => json(200, { languages: [] })
    routes['POST /v1/languages'] = () => json(422, { error: 'invalid_language' })
    at('/idiomas')
    fireEvent.click((await screen.findAllByRole('button', { name: /Novo idioma/ }))[0])
    const dialog = screen.getByRole('dialog', { name: 'Novo idioma' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Outro idioma/ }))
    fireEvent.change(within(dialog).getByLabelText('Nome'), { target: { value: 'Tupi antigo' } })
    fireEvent.change(within(dialog).getByLabelText('Código'), { target: { value: 'tupi antigo!' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Criar' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/código/)
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ code: 'tupi antigo!', name: 'Tupi antigo' })
  })

  it('sem a estrutura do app, explica e leva a Configurações › Outros', async () => {
    routes['GET /v1/languages'] = () => json(403, { error: 'app_disabled' })
    at('/idiomas')
    expect(await screen.findByText('Os idiomas usam a estrutura do app')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir Configurações › Outros' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'settings', tab: 'others' })
  })
})

describe('Página do idioma', () => {
  it('a base por área em cores de estado e cada texto com quanto já sabe', async () => {
    routes['GET /v1/languages/en'] = () => json(200, englishDetail)
    at('/idiomas/en')
    expect(await screen.findByRole('heading', { name: 'Inglês' })).toBeInTheDocument()
    const lexico = screen.getByRole('rowheader', { name: 'Léxico' }).closest('tr')!
    expect(within(lexico).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['20', '40', '12'])
    expect(screen.getByText('você já sabe 78%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Continuar/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Começar/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Na fila: começa quando o texto anterior terminar.')
    expect(screen.getByText(/Não deu para gerar: A IA não respondeu agora/)).toBeInTheDocument()
  })

  it('"Tentar de novo" no texto que falhou', async () => {
    routes['GET /v1/languages/en'] = () => json(200, englishDetail)
    routes['POST /v1/languages/en/texts/t4/retry'] = () => json(202, { status: 'generating' })
    at('/idiomas/en')
    fireEvent.click(await screen.findByRole('button', { name: /Tentar de novo/ }))
    await waitFor(() => expect(calls.some(call => call.path === '/v1/languages/en/texts/t4/retry')).toBe(true))
  })

  it('novo texto: título e texto inteiro, com o limite', async () => {
    routes['GET /v1/languages/en'] = () => json(200, { ...englishDetail, texts: [] })
    routes['POST /v1/languages/en/texts'] = () => json(202, { id: 't9', status: 'generating' })
    at('/idiomas/en')
    fireEvent.click((await screen.findAllByRole('button', { name: /Novo texto/ }))[0])
    const dialog = screen.getByRole('dialog', { name: 'Novo texto em Inglês' })
    const send = within(dialog).getByRole('button', { name: 'Mandar' })
    expect(send).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Letra de 60 linhas' } })
    const lyric = Array.from({ length: 60 }, (_, n) => `Line ${n} of the song`).join('\n')
    fireEvent.change(within(dialog).getByLabelText('Texto'), { target: { value: lyric } })
    fireEvent.click(send)
    await waitFor(() => expect(calls.some(call => call.method === 'POST' && call.path === '/v1/languages/en/texts')).toBe(true))
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ title: 'Letra de 60 linhas', text: lyric })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('fechar a janela sem querer não perde o texto colado', async () => {
    routes['GET /v1/languages/en'] = () => json(200, { ...englishDetail, texts: [] })
    at('/idiomas/en')
    fireEvent.click((await screen.findAllByRole('button', { name: /Novo texto/ }))[0])
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Rascunho' } })
    fireEvent.change(screen.getByLabelText('Texto'), { target: { value: 'I walk to school' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    fireEvent.click((await screen.findAllByRole('button', { name: /Novo texto/ }))[0])
    expect(screen.getByLabelText('Título')).toHaveValue('Rascunho')
    expect(screen.getByLabelText('Texto')).toHaveValue('I walk to school')
  })

  it('texto grande demais não sai', async () => {
    routes['GET /v1/languages/en'] = () => json(200, { ...englishDetail, texts: [] })
    at('/idiomas/en')
    fireEvent.click((await screen.findAllByRole('button', { name: /Novo texto/ }))[0])
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Grande' } })
    fireEvent.change(within(dialog).getByLabelText('Texto'), { target: { value: 'a'.repeat(100_001) } })
    expect(within(dialog).getByRole('button', { name: 'Mandar' })).toBeDisabled()
    expect(within(dialog).getByText(/mande uma parte de cada vez/i)).toBeInTheDocument()
  })
})

// Constituição IV (24/11): o texto gerando diz o que está acontecendo, quanto já foi, quando termina e que não travou.
import { generationLines } from '@/pages/idiomas/language'

describe('texto gerando: o andamento', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 24, 4, minutes)).toISOString()
  const hhmm = (minutes: number) => new Date(Date.UTC(2026, 10, 24, 4, minutes)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  it('na fila, antes de começar', () => {
    expect(generationLines(undefined, Date.parse(at(0)))).toEqual(['Na fila: começa quando o texto anterior terminar.'])
  })
  it('a primeira parte em andamento: quando começou e há quanto tempo', () => {
    expect(generationLines({ done: 0, total: 6, startedAt: at(28) }, Date.parse(at(30)))).toEqual([`Gerando os cards: 0 de 6 partes prontas · começou às ${hhmm(28)}`, 'Andando: a primeira parte está sendo feita há 2 min.'])
  })
  it('partes prontas: quantas, por volta de quando termina e quando saiu a última', () => {
    expect(generationLines({ done: 5, total: 6, startedAt: at(28), lastAt: at(41), endsAt: at(45) }, Date.parse(at(41)) + 40_000)).toEqual([
      `Gerando os cards: 5 de 6 partes prontas · termina por volta de ${hhmm(45)}`,
      'Andando: a última parte saiu há 40 s.',
    ])
  })
  it('parte demorando mais de 8 minutos: diz que está demorando e que continua tentando', () => {
    expect(generationLines({ done: 2, total: 6, startedAt: at(0), lastAt: at(10), endsAt: at(30) }, Date.parse(at(20)))[1]).toBe('A IA está demorando nesta parte (há 10 min); o app continua tentando.')
  })
})
