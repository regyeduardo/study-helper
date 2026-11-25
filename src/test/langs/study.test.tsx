import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const { mockEnv, say } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test', basePath: '/' }, say: vi.fn(async () => {}) }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))
vi.mock('@/lib/langs/voice', () => ({ say, sayAll: vi.fn(async () => {}), stop: vi.fn() }))

import StudyPage from '@/pages/idiomas/study'
import type { LanguageText } from '@/controllers/langs.controller'
import { answer as answered, startStudy } from '@/lib/langs/study'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { useLibraryStore } from '@/stores/library'

// Spec 004, o estudo como no protótipo validado (prototipo/web/app.js), em três partes (25/11, FR-041): Vocabulário (cada item do texto;
// errou → o que ele exige, o card de aprender e outro teste) → Prática de ler e ouvir (o errado volta uma vez no fim) → Contexto com o
// texto à vista → fim. As partes são clicáveis e cada uma guarda onde parou (FR-043). Cada resposta e onde a pessoa parou vão para o
// servidor. O sorteio da ordem (FR-042) fica parado aqui (Math.random = 0): a ordem do texto e o primeiro card de cada item.

type Call = { method: string; path: string; body: unknown }
let calls: Call[]
let progress: unknown
let knowledge: Record<string, Record<string, string | boolean>>
const json = (status: number, value: unknown) => new Response(value === undefined ? null : JSON.stringify(value), { status })

const text = {
  id: 't1',
  language: 'en',
  locale: 'en-US',
  title: 'Chuva',
  status: 'ready',
  lines: ['I used to walk to school every day', "But now I won't walk in the rain"],
  equivalences: [["won't", 'will not']],
  items: {
    walk: {
      area: 'lexico',
      kind: 'word',
      label: 'walk',
      meaning: 'andar',
      needs: ['be'],
      expl: 'Andar a pé.',
      ex: ['I walk to school = Eu vou a pé para a escola'],
      test: [
        { id: 'walk_1', type: 'mc', skill: 'read', q: "'walk' quer dizer:", qEn: "'walk' means:", needs: ['be'], covers: ['walk'], opts: ['andar', 'trabalhar', 'falar', 'correr', 'voar'], optsEn: ['to go on foot', 'to work', 'to talk', 'to run', 'to fly'], a: 0 },
        { id: 'walk_2', type: 'same_diff', skill: 'listen', q: 'São iguais?', covers: ['walk'], say: ['walk', 'work'], a: 'diff', expl: 'walk × work' },
      ],
    },
    be: { area: 'gramatica', kind: 'word', label: 'am/is/are', meaning: 'ser, estar', test: [{ id: 'be_1', type: 'tf', skill: 'read', q: "'is' é uma forma de 'be'", covers: ['be'], a: true }] },
  },
  practice: [
    { id: 'dc', type: 'dictation', skill: 'listen', q: 'Ouça e escreva:', say: "I won't walk in the rain" },
    { id: 'ord', type: 'order', skill: 'read', q: 'Monte a frase:', tokens: ['walk', 'I', "won't"], answer: "I won't walk" },
  ],
  context: [{ id: 'ctx', type: 'mc', skill: 'read', q: 'Como a pessoa ia à escola?', dp: 'literal', opts: ['a pé', 'de ônibus', 'de carro', 'de bicicleta', 'de trem'], a: 0 }],
  facets: [],
} as unknown as LanguageText

const road = {
  id: 't3',
  language: 'en',
  locale: 'en-US',
  title: 'Estrada',
  status: 'ready',
  lines: ['Walk in the rain'],
  equivalences: [],
  items: {
    rain: { area: 'lexico', kind: 'word', label: 'rain', meaning: 'chuva', test: [{ id: 'rain_1', type: 'mc', skill: 'read', q: "'rain' quer dizer:", covers: ['rain'], opts: ['chuva', 'sol', 'vento', 'neve', 'nuvem'], a: 0 }] },
  },
  practice: [{ id: 'p_rain', type: 'tf', skill: 'read', q: "'rain' é chuva", covers: ['rain'], a: true }],
  context: [{ id: 'ctx3', type: 'tf', skill: 'read', q: 'A estrada é longa', a: true }],
  facets: [],
} as unknown as LanguageText

const detail = {
  code: 'en',
  name: 'Inglês',
  locale: 'en-US',
  areas: { lexico: { total: 2, seen: 0, fixed: 0 } },
  texts: [
    { id: 't1', title: 'Chuva', status: 'ready', progress: 'start', known: 0, createdAt: '' },
    { id: 't2', title: 'Gerando', status: 'generating', progress: 'start', known: 0, createdAt: '' },
    { id: 't3', title: 'Estrada', status: 'ready', progress: 'start', known: 0, createdAt: '' },
  ],
}

let random: { mockRestore(): void }

beforeEach(() => {
  random = vi.spyOn(Math, 'random').mockReturnValue(0)
  // these are the App's: the structure is on, the languages live on the server (24/11, FR-040)
  useLibraryStore.setState({ appOn: true })
  calls = []
  progress = null
  knowledge = {}
  say.mockClear()
  useServerAccount.setState({ status: 'signed-in' } as never)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { method: init.method ?? 'GET', path: url.replace(mockEnv.apiUrl, ''), body: init.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      if (call.path === '/v1/languages/en') return json(200, detail)
      if (call.path === '/v1/languages/en/texts/t1') return json(200, text)
      if (call.path === '/v1/languages/en/texts/t3') return json(200, road)
      if (call.path === '/v1/languages/en/texts/t1/progress' && call.method === 'GET') return progress ? json(200, { state: progress, updatedAt: '' }) : json(404, { error: 'not_found' })
      if (call.path === '/v1/languages/en/texts/t1/progress') return json(204, undefined)
      if (call.path === '/v1/languages/en/answers') return json(204, undefined)
      if (call.path === '/v1/languages/en/knowledge') return json(200, knowledge)
      if (call.path === '/v1/languages/en/texts/t2') return json(409, { error: 'not_ready', status: 'generating' })
      if (call.path.endsWith('/report')) return json(202, { status: 'remaking' })
      return json(404, { error: 'not_found' })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  random.mockRestore()
})

function open(id = 't1') {
  return render(
    <MemoryRouter initialEntries={[`/idiomas/en/${id}`]}>
      <Routes>
        <Route path="/idiomas/:code/area/:area" element={<StudyPage />} />
        <Route path="/idiomas/:code/:textId" element={<StudyPage />} />
        <Route path="/idiomas/:code" element={<p>página do idioma</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

const answers = () => calls.filter(call => call.path === '/v1/languages/en/answers').map(call => call.body as Record<string, unknown>)
const saved = () => calls.filter(call => call.method === 'PUT').map(call => (call.body as { state: Record<string, unknown> }).state)

const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }))
const conferir = () => fireEvent.click(screen.getByRole('button', { name: 'Conferir' }))
const continuar = async () => fireEvent.click(await screen.findByRole('button', { name: 'Continuar' }))
const parts = () => screen.getByRole('list', { name: 'Partes do estudo' })
const part = (name: string | RegExp) => within(parts()).getByRole('button', { name })

describe('Estudo de um texto', () => {
  it('começa pelo Vocabulário, sem a aba "Frases": o primeiro card já testa um item do texto', async () => {
    open()
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    expect(parts()).toHaveTextContent('VocabulárioPráticaContexto')
    expect(part('Vocabulário')).toHaveAttribute('aria-current', 'step')
    expect(screen.queryByRole('button', { name: /Ouvir tudo/ })).toBeNull()
    expect(screen.getByRole('main', { name: 'Estudo: Chuva' })).toBeInTheDocument()
  })

  it('o teste mostra o item escrito; errou: testa o que ele exige, ensina e testa de novo de outro jeito', async () => {
    open()
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    expect(screen.getByText('Teste · Ler · Léxico')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Conferir' })).toBeDisabled()
    pick('trabalhar')
    conferir()
    expect(await screen.findByText('Não foi')).toBeInTheDocument()
    await continuar()

    // what "walk" needs comes first
    expect(await screen.findByRole('heading', { name: "'is' é uma forma de 'be'" })).toBeInTheDocument()
    pick('Verdadeiro')
    conferir()
    expect(await screen.findByText('Certo')).toBeInTheDocument()
    await continuar()

    // the learn card
    expect(await screen.findByRole('heading', { name: 'walk' })).toBeInTheDocument()
    expect(screen.getByText('andar')).toBeInTheDocument()
    expect(screen.getByText('Usa: am/is/are')).toBeInTheDocument()
    expect(screen.getByText('I walk to school = Eu vou a pé para a escola')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Testar de outro jeito' }))

    // tested again, another way
    expect(await screen.findByRole('heading', { name: 'São iguais?' })).toBeInTheDocument()
    expect(screen.getByText('Teste · de novo, de outro jeito · Ouvir · Léxico')).toBeInTheDocument()
    pick('Diferentes')
    conferir()
    await continuar()
    expect(await screen.findByRole('heading', { name: 'Ouça e escreva:' })).toBeInTheDocument()

    await waitFor(() => expect(answers()).toHaveLength(3))
    // 24/11 ("é por card"): each answer goes with the card's own repetition (FSRS); a card answered the first time is in the short steps
    const firstTime = expect.objectContaining({ state: 'learning', reps: 1, lapses: 0 })
    expect(answers()).toEqual([
      { textId: 't1', cardId: 'walk_1', stage: 'test', promptLang: 'native', answer: 'trabalhar', ok: false, retry: false, schedule: firstTime },
      { textId: 't1', cardId: 'be_1', stage: 'test', promptLang: 'native', answer: 'Verdadeiro', ok: true, retry: false, schedule: firstTime },
      { textId: 't1', cardId: 'walk_2', stage: 'test', promptLang: 'native', answer: 'Diferentes', ok: true, retry: true, schedule: firstTime },
    ])
  })

  it('o que a base já provou é pulado; a prática traz ler e ouvir, o errado volta uma vez; o contexto mostra o texto; o fim resume', async () => {
    knowledge = { walk: { recognize: 'fixed', due: false }, be: { recognize: 'learning', due: false } }
    open()
    expect(await screen.findByText('1 de 2')).toBeInTheDocument()
    // nothing left in the Vocabulário: it is marked and does not open
    expect(part('Vocabulário (terminada)')).toBeDisabled()
    expect(part('Prática')).toHaveAttribute('aria-current', 'step')
    fireEvent.change(screen.getByLabelText('O que você ouviu'), { target: { value: 'I walk in the rain' } })
    conferir()
    expect(await screen.findByText('Não foi')).toBeInTheDocument()
    await continuar()

    expect(await screen.findByRole('heading', { name: 'Monte a frase:' })).toBeInTheDocument()
    const pool = screen.getByRole('group', { name: 'Peças' })
    for (const token of ['I', "won't", 'walk']) fireEvent.click(within(pool).getByRole('button', { name: token }))
    conferir()
    expect(await screen.findByText('Certo')).toBeInTheDocument()
    await continuar()

    // the wrong one, once more
    expect(await screen.findByText('Prática · de novo · Ouvir')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('O que você ouviu'), { target: { value: 'I will not walk in the rain' } })
    conferir()
    await continuar()

    // the context, with the text in sight
    expect(await screen.findByRole('heading', { name: 'Como a pessoa ia à escola?' })).toBeInTheDocument()
    expect(screen.getByLabelText('O texto')).toHaveTextContent('I used to walk to school every day')
    pick('a pé')
    conferir()
    await continuar()

    expect(await screen.findByRole('heading', { name: 'Texto terminado' })).toBeInTheDocument()
    expect(screen.getByText('prática certa de primeira').previousSibling).toHaveTextContent('1 de 2')
    expect(screen.getByText('contexto').previousSibling).toHaveTextContent('1 de 1')
    expect(saved().at(-1)).toMatchObject({ v: 2, step: 'done', done: true })
  })

  it('em inglês quando tudo o que a pergunta usa já foi provado', async () => {
    knowledge = { be: { recognize: 'fixed', due: false } }
    open()
    expect(await screen.findByRole('heading', { name: "'walk' means:" })).toBeInTheDocument()
    expect(screen.getByText('Teste · Ler · Léxico · EN')).toBeInTheDocument()
    pick('to go on foot')
    conferir()
    await waitFor(() => expect(answers()[0]).toMatchObject({ cardId: 'walk_1', promptLang: 'target', ok: true, answer: 'to go on foot' }))
  })

  it('volta de onde parou', async () => {
    progress = answered(startStudy(text, {}, new Date(), () => 0), text, {}, false, 'native')
    open()
    expect(await screen.findByRole('heading', { name: "'is' é uma forma de 'be'" })).toBeInTheDocument()
  })

  it('o progresso guardado de antes (só ouvir) e o texto terminado recomeçam do começo', async () => {
    progress = { step: 'cards', at: 1, order: ['walk_2', 'dc'], wrong: [], again: [], slots: {}, right: 1, answered: 1 }
    const first = open()
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    first.unmount()
    progress = { ...startStudy(text, {}, new Date(), () => 0), step: 'done' }
    open()
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
  })

  it('o progresso guardado na parte "Frases" (antes de 25/11) segue no Vocabulário', async () => {
    progress = { ...startStudy(text, {}, new Date(), () => 0), step: 'lines' }
    open()
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    expect(part('Vocabulário')).toHaveAttribute('aria-current', 'step')
  })

  it('as partes são clicáveis e cada uma continua de onde parou', async () => {
    open()
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    pick('andar')
    conferir()
    await continuar()
    expect(await screen.findByRole('heading', { name: "'is' é uma forma de 'be'" })).toBeInTheDocument()

    fireEvent.click(part('Prática'))
    expect(await screen.findByRole('heading', { name: 'Ouça e escreva:' })).toBeInTheDocument()
    expect(part('Prática')).toHaveAttribute('aria-current', 'step')
    fireEvent.click(part('Contexto'))
    expect(await screen.findByRole('heading', { name: 'Como a pessoa ia à escola?' })).toBeInTheDocument()
    fireEvent.click(part('Vocabulário'))
    expect(await screen.findByRole('heading', { name: "'is' é uma forma de 'be'" })).toBeInTheDocument()
    await waitFor(() => expect(saved().at(-1)).toMatchObject({ step: 'test', pp: 1 }))
  })

  it('trocar de parte com a resposta já conferida segue adiante: o mesmo card não volta para ser respondido de novo', async () => {
    open()
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    pick('andar')
    conferir()
    expect(await screen.findByText('Certo')).toBeInTheDocument()
    fireEvent.click(part('Prática'))
    expect(await screen.findByRole('heading', { name: 'Ouça e escreva:' })).toBeInTheDocument()
    fireEvent.click(part('Vocabulário'))
    expect(await screen.findByRole('heading', { name: "'is' é uma forma de 'be'" })).toBeInTheDocument()
    await waitFor(() => expect(answers()).toHaveLength(1))
  })

  it('Enter numa parte é da parte: não confere o card que está aberto', async () => {
    open()
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    pick('andar')
    part('Prática').focus()
    fireEvent.keyDown(part('Prática'), { key: 'Enter' })
    expect(screen.queryByText('Certo')).toBeNull()
    expect(answers()).toHaveLength(0)
  })

  it('sair guarda e volta à página do idioma', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Sair (guarda onde parou)' }))
    expect(await screen.findByText('página do idioma')).toBeInTheDocument()
    expect(saved()[0]).toMatchObject({ v: 2, step: 'test', pp: 0 })
  })

  it('a bandeira discreta reporta o card: motivo, nota e "Refazer o card"', async () => {
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Reportar este card' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reportar este card' })
    const send = within(dialog).getByRole('button', { name: 'Refazer o card' })
    expect(send).toBeDisabled()
    // Enter with the window open does not check the card behind it
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.queryByText('Não foi')).toBeNull()
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Duas opções estão certas' }))
    fireEvent.change(within(dialog).getByLabelText('Conte o que foi (opcional)'), { target: { value: 'andar e caminhar servem' } })
    fireEvent.click(send)
    await waitFor(() => expect(calls.some(call => call.path === '/v1/languages/en/texts/t1/cards/walk_1/report')).toBe(true))
    expect(calls.find(call => call.path.endsWith('/report'))?.body).toEqual({ reason: 'two_right', note: 'andar e caminhar servem' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(useUiStore.getState().toasts.at(-1)?.text).toMatch(/Vou refazer este card/)
  })

  it('texto ainda gerando diz para voltar depois', async () => {
    open('t2')
    expect(await screen.findByRole('alert')).toHaveTextContent('ainda está sendo preparado')
  })
})

// T135 (spec 004, FR-044; dono, 25/11): clicar numa área da base estuda aquela área com tudo o que foi gerado em todos os textos.
describe('Estudo de uma área, com todos os textos', () => {
  it('junta os textos prontos: Vocabulário e Prática da área, sem Contexto; cada resposta vai para o texto do card; nada de progresso', async () => {
    open('area/lexico')
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    expect(screen.getByRole('main', { name: 'Estudo: Léxico' })).toBeInTheDocument()
    expect(parts()).toHaveTextContent('VocabulárioPrática')
    expect(within(parts()).queryByRole('button', { name: /Contexto/ })).toBeNull()
    expect(screen.getByText('1 de 2')).toBeInTheDocument()
    pick('andar')
    conferir()
    await continuar()

    // the item of the other text
    expect(await screen.findByRole('heading', { name: "'rain' quer dizer:" })).toBeInTheDocument()
    pick('chuva')
    conferir()
    await continuar()

    // the practice of the area: only the card whose first item is of the area
    expect(await screen.findByRole('heading', { name: "'rain' é chuva" })).toBeInTheDocument()
    pick('Verdadeiro')
    conferir()
    await continuar()

    expect(await screen.findByRole('heading', { name: 'Estudo de Léxico terminado' })).toBeInTheDocument()
    expect(screen.queryByText('contexto')).toBeNull()
    await waitFor(() => expect(answers()).toHaveLength(3))
    expect(answers().map(body => `${body.textId}:${body.cardId}`)).toEqual(['t1:walk_1', 't3:rain_1', 't3:p_rain'])
    expect(saved()).toEqual([])
    expect(calls.some(call => call.path.endsWith('/progress'))).toBe(false)
  })

  it('"Reportar" vai para o texto de onde veio o card', async () => {
    open('area/lexico')
    expect(await screen.findByRole('heading', { name: "'walk' quer dizer:" })).toBeInTheDocument()
    pick('andar')
    conferir()
    await continuar()
    expect(await screen.findByRole('heading', { name: "'rain' quer dizer:" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reportar este card' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reportar este card' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Duas opções estão certas' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refazer o card' }))
    await waitFor(() => expect(calls.some(call => call.path === '/v1/languages/en/texts/t3/cards/rain_1/report')).toBe(true))
  })

  it('área sem nada vencido nem novo diz que está em dia', async () => {
    knowledge = { be: { recognize: 'fixed', due: false } }
    open('area/gramatica')
    expect(await screen.findByRole('heading', { name: 'Gramática está em dia' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeInTheDocument()
  })

  it('área que não existe', async () => {
    open('area/nada')
    expect(await screen.findByRole('alert')).toHaveTextContent('Esta área não existe')
  })
})
