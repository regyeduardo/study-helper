import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import type { CatalogModel } from '@/controllers/models.controller'
import { USES } from '@/lib/ai/config'
import type { DiagnosisCall, DiagnosisDeps } from '@/lib/ai/diagnosis'
import { LIST_TITLE, recommendationOf, situationsOf } from '@/lib/ai/recommendations'
import { USE_REQUIREMENTS } from '@/lib/ai/use-requirements'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { installFetch, jsonResponse } from '@/test/ai/fake-provider'
import type { AiConfig, AiProvider, DiagnosisRecord } from '@/types/domain'

// US5 · FR-047, FR-050, FR-056 · contracts/ui.md "Aba Recomendações": option R-A with the "Geral" overview.
// No test calls a paid AI: the diagnosis runs on a fake.

const NOW = '2026-11-08T12:00:00.000Z'
const hoisted = vi.hoisted(() => ({ deps: null as unknown }))
vi.mock('@/lib/ai/diagnosis', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/ai/diagnosis')>()), liveDiagnosisDeps: () => hoisted.deps }))

const DI: AiProvider = { id: 'di', type: 'deepinfra', name: 'DeepInfra', key: 'k', base: '' }
const OR: AiProvider = { id: 'or', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }
const pairModel = (pid: string, mid: string, name: string) => ({ uid: `${pid}::${mid}`, pid, mid, name })
const DEEPSEEK = pairModel('di', 'deepseek-ai/DeepSeek-V4-Flash-0731', 'DeepSeek V4 Flash 0731')
const GEMINI = pairModel('or', 'google/gemini-3.8-flash', 'Gemini 3.8 Flash')
const CONFIG: AiConfig = { providers: [DI, OR], models: [DEEPSEEK, GEMINI], defaults: { estudo: DEEPSEEK.uid, mapa: GEMINI.uid }, steps: {} }

const TEXT_ONLY = { texto: true, imagem: false, audio: false, video: false, pdf: false }
const cheap: CatalogModel = { id: 'cheap-a', name: 'cheap-a', media: TEXT_ONLY, price: { input: 0.05, output: 0.1 } }

/** A reply that gets every point of the Título e etiquetas test. */
const titleReply = () => {
  const hits = USE_REQUIREMENTS.titulo.test.expected.map(item => item.accept[0])
  return JSON.stringify({ titulo: hits[0], etiquetas: hits.slice(1, 4) })
}

let asked: DiagnosisCall[]
let hold: Promise<void> | null

function fakeDeps(): DiagnosisDeps {
  return {
    now: () => new Date(NOW),
    catalog: async provider => (provider.id === 'di' ? [cheap] : []),
    research: async () => ({ verdicts: [], spent: 0 }),
    call: async request => {
      asked.push(request)
      if (hold)
        await Promise.race([
          hold,
          new Promise<never>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(new DOMException('parado', 'AbortError')))),
        ])
      return { text: request.purpose === 'juiz' ? '{"respostas": []}' : titleReply(), usage: { inputTokens: 500, outputTokens: 100 } }
    },
    sample: async () => null,
    screen: async () => null,
  }
}

function setup(config: AiConfig = CONFIG, diagnosis: DiagnosisRecord[] = []) {
  const index = defaultIndex()
  index.settings = { ...index.settings, aiConfig: config, aiDiagnosis: diagnosis }
  useLibraryStore.setState({ index, repo: { saveIndex: async () => undefined } as never })
}

const saved = () => useLibraryStore.getState().index.settings
const config = () => saved().aiConfig!

/** Opens the tab once the providers' catalogs are read, so nothing updates after the test. */
async function open() {
  render(<SettingsDialog initial="ai" />)
  await waitFor(() => expect(Object.values(useModelsStore.getState().live).every(read => read.state !== 'reading')).toBe(true))
  fireEvent.click(screen.getByRole('tab', { name: 'Recomendações' }))
}

const usesNav = () => screen.getByRole('navigation', { name: 'Usos' })
const overview = () => screen.getByRole('table', { name: 'Todos os usos' })
const rowOf = (label: string) => within(overview()).getByRole('row', { name: new RegExp(`^${label}\\b`) })
const label = (use: string) => USES.find(item => item.id === use)!.label
const uidOf = (providerId: string, model: string) => `${providerId}::${model}`

beforeEach(() => {
  asked = []
  hold = null
  hoisted.deps = fakeDeps()
  installFetch(() => jsonResponse({ error: 'sem rede nos testes' }, 404))
  useModelsStore.setState({ live: {}, probes: {}, adding: false, ui: { tab: 'provedores', filter: 'all', shut: {} }, diagnosis: { state: 'idle' } })
})

afterEach(() => vi.unstubAllGlobals())

describe('a aba e a visão Geral (FR-056)', () => {
  it('é a quarta aba, depois de "Padrões por uso", abre em "Geral" e mostra a data da lista', async () => {
    setup()
    await open()
    expect(screen.getAllByRole('tab').map(item => item.textContent)).toEqual(['Provedores', 'Modelos', 'Padrões por uso', 'Recomendações'])
    expect(screen.getByRole('tab', { name: 'Recomendações' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(LIST_TITLE)).toBeInTheDocument()
    expect(screen.getByText(LIST_TITLE)).toHaveTextContent('07/11/2026')
    expect(within(usesNav()).getByRole('button', { name: /^Geral · todos os usos/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByRole('region', { name: /^Escada de/ })).toBeNull()
  })

  it('uma linha por uso: o indicado com provedor, nota e custo; o padrão atual com provedor, "herda" quando vem de Estudo', async () => {
    setup()
    await open()
    const rows = within(overview()).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(USES.length)

    const estudo = recommendationOf('estudo').indicated!
    const row = rowOf('Estudo')
    expect(row).toHaveTextContent(estudo.pair.name)
    expect(row).toHaveTextContent(`nota ${estudo.score}`)
    expect(row).toHaveTextContent(/US\$ 0,00\d/)
    expect(within(row).getAllByText('DeepInfra').length).toBeGreaterThanOrEqual(2)
    expect(within(row).getByText('✓ é o indicado')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /^Usar o indicado/ })).toBeNull()

    // Aula has no default of its own: it uses Estudo's
    expect(rowOf('Aula')).toHaveTextContent('herda')
    expect(rowOf('Estudo')).not.toHaveTextContent('herda')
  })

  it('diz quantos usos são iguais ao indicado e quantos diferem; o que não tem padrão ou tem outro par difere', async () => {
    setup()
    await open()
    const sits = situationsOf(CONFIG)
    const differ = sits.filter(item => !item.same).length
    expect(differ).toBeGreaterThan(0)
    expect(screen.getByText(`${sits.length - differ} iguais · ${differ} diferem`)).toBeInTheDocument()
    expect(within(rowOf('Mapa mental')).getByRole('button', { name: 'Usar o indicado em Mapa mental' })).toBeInTheDocument()
    expect(within(rowOf('Vídeo e áudio')).getByText('sem padrão')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Usar o indicado nos ${differ}` })).toBeInTheDocument()
  })

  it('"Usar o indicado" grava o padrão do uso com o par indicado, acrescentando o modelo aos seus, e a linha passa a ✓', async () => {
    setup()
    await open()
    const indicated = recommendationOf('mapa').indicated!.pair
    const provider = indicated.provider === 'deepinfra' ? DI : OR
    expect(config().defaults.mapa).toBe(GEMINI.uid)
    fireEvent.click(within(rowOf('Mapa mental')).getByRole('button', { name: 'Usar o indicado em Mapa mental' }))
    expect(config().defaults.mapa).toBe(uidOf(provider.id, indicated.model))
    expect(config().models.some(item => item.uid === uidOf(provider.id, indicated.model) && item.mid === indicated.model)).toBe(true)
    expect(within(rowOf('Mapa mental')).getByText('✓ é o indicado')).toBeInTheDocument()
    // the other defaults stay
    expect(config().defaults.estudo).toBe(DEEPSEEK.uid)
  })

  it('"Usar o indicado nos N" aplica a todas as linhas que diferem', async () => {
    setup()
    await open()
    const before = situationsOf(CONFIG).filter(item => !item.same).length
    fireEvent.click(screen.getByRole('button', { name: `Usar o indicado nos ${before}` }))
    const now = situationsOf(config())
    expect(now.filter(item => !item.same).length).toBe(0)
    expect(screen.getByText(`${now.length} iguais · 0 diferem`)).toBeInTheDocument()
  })

  it('sem o provedor do par cadastrado, "Usar o indicado" fica desligado e diz qual provedor falta', async () => {
    setup({ ...CONFIG, providers: [OR], models: [GEMINI], defaults: { mapa: GEMINI.uid } })
    await open()
    const button = within(rowOf('Estudo')).getByRole('button', { name: 'Usar o indicado em Estudo' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Cadastre o provedor DeepInfra em Provedores')
  })
})

describe('a escada de cada uso (R-A)', () => {
  const openLadder = (use: string) => fireEvent.click(within(rowOf(label(use))).getByRole('button', { name: label(use) }))
  const ladder = (use: string) => screen.getByRole('region', { name: `Escada de ${label(use)}` })

  it('clicar no uso abre a escada: o que exige, a nota mínima, o indicado com o motivo e os pares do mais barato para cima', async () => {
    setup()
    await open()
    openLadder('ata')
    const recommendation = recommendationOf('ata')
    const region = ladder('ata')
    expect(within(region).getByText(USE_REQUIREMENTS.ata.asks)).toBeInTheDocument()
    expect(region).toHaveTextContent(`mínima ${USE_REQUIREMENTS.ata.minScore}`)
    expect(region).toHaveTextContent(`Indicado: ${recommendation.indicated!.pair.name}`)
    expect(region).toHaveTextContent(recommendation.why)
    const rows = within(within(region).getByRole('table', { name: `Pares de ${label('ata')}` })).getAllByRole('row').slice(1)
    const names = rows.map(row => row.textContent ?? '')
    recommendation.ladder.forEach((rung, index) => expect(names[index]).toContain(rung.pair.name))
    expect(within(usesNav()).getByRole('button', { name: /^Geral · todos os usos/ })).not.toHaveAttribute('aria-current', 'true')
    expect(within(usesNav()).getByRole('button', { name: /^Ata/ })).toHaveAttribute('aria-current', 'true')
  })

  it('o mesmo modelo em dois provedores são duas linhas, cada uma com o seu provedor, nota e custo', async () => {
    setup()
    await open()
    openLadder('ata')
    const rows = within(within(ladder('ata')).getByRole('table', { name: `Pares de ${label('ata')}` })).getAllByRole('row').slice(1)
    const deepseek = rows.filter(row => row.textContent?.includes('DeepSeek V4 Flash 0731'))
    expect(deepseek.map(row => (row.textContent?.includes('DeepInfra') ? 'DeepInfra' : row.textContent?.includes('OpenRouter') ? 'OpenRouter' : '')).sort()).toEqual(['DeepInfra', 'OpenRouter'])
  })

  it('"Usar como padrão" em cada linha grava o par como padrão do uso; o que está em uso diz "padrão atual"', async () => {
    setup()
    await open()
    openLadder('ata')
    const table = () => within(ladder('ata')).getByRole('table', { name: `Pares de ${label('ata')}` })
    const current = within(table()).getAllByRole('row').find(row => row.textContent?.includes('padrão atual'))!
    expect(current).toHaveTextContent('DeepSeek V4 Flash 0731')
    expect(within(current).queryByRole('button', { name: /como padrão$/ })).toBeNull()

    const other = within(table()).getByRole('button', { name: 'Usar DeepSeek V4 Flash 0731 · OpenRouter como padrão' })
    fireEvent.click(other)
    expect(config().defaults.ata).toBe(uidOf('or', 'deepseek/deepseek-v4-flash-0731'))
    expect(config().models.some(item => item.uid === uidOf('or', 'deepseek/deepseek-v4-flash-0731'))).toBe(true)
    expect(config().defaults.estudo).toBe(DEEPSEEK.uid)
    const now = within(table()).getAllByRole('row').find(row => row.textContent?.includes('padrão atual'))!
    expect(now).toHaveTextContent('OpenRouter')
  })

  it('a nota do seu teste, com a data, entra na linha do par; e "Geral" volta à visão geral', async () => {
    const pair = recommendationOf('titulo').ladder[0].pair
    setup(CONFIG, [{ use: 'titulo', provider: pair.provider, model: pair.model, score: 7, costPerNote: 0.0003, at: NOW }])
    await open()
    openLadder('titulo')
    const row = within(ladder('titulo')).getAllByRole('row').find(item => item.textContent?.includes(pair.name))!
    expect(row).toHaveTextContent('7 · 08/11')
    fireEvent.click(within(ladder('titulo')).getByRole('button', { name: 'Geral · todos os usos' }))
    expect(overview()).toBeInTheDocument()
  })
})

describe('Rodar meu diagnóstico (FR-050)', () => {
  const openTitle = () => fireEvent.click(within(rowOf(label('titulo'))).getByRole('button', { name: label('titulo') }))

  it('mostra o custo estimado antes de rodar, sem gastar nada; "Cancelar" volta atrás', async () => {
    setup()
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Rodar meu diagnóstico' }))
    const plan = await screen.findByRole('group', { name: 'Diagnóstico antes de rodar' })
    expect(plan).toHaveTextContent(/Custo estimado: US\$ \d/)
    expect(within(plan).getByText(/catálogo grátis/)).toBeInTheDocument()
    expect(within(plan).getByRole('button', { name: /^Rodar · ~US\$/ })).toBeInTheDocument()
    expect(asked).toHaveLength(0)
    fireEvent.click(within(plan).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('group', { name: 'Diagnóstico antes de rodar' })).toBeNull()
    expect(asked).toHaveLength(0)
  })

  it('dentro de um uso, roda só aquele: rodando mostra o andamento e "Parar"; no fim, o resultado com a data, guardado por provedor + modelo', async () => {
    setup()
    await open()
    openTitle()
    let release!: () => void
    hold = new Promise<void>(resolve => (release = resolve))
    fireEvent.click(screen.getByRole('button', { name: 'Rodar meu diagnóstico' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Rodar · ~US\$/ }))

    const running = await screen.findByRole('status', { name: 'Diagnóstico rodando' })
    expect(running).toHaveTextContent(/Rodando/)
    expect(running).toHaveTextContent(/US\$ [\d,]+ até agora/)
    expect(within(running).getByRole('button', { name: 'Parar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rodar meu diagnóstico' })).toBeNull()

    await act(async () => release())
    const done = await screen.findByRole('group', { name: 'Resultado do diagnóstico' })
    expect(done).toHaveTextContent('08/11/2026')
    expect(done).toHaveTextContent(/guardado por modelo e provedor/)
    expect(asked.every(call => call.use === 'titulo')).toBe(true)

    const records = saved().aiDiagnosis!
    expect(records).toContainEqual(expect.objectContaining({ use: 'titulo', provider: 'deepinfra', model: 'cheap-a', score: 10, at: NOW }))
    // the new result is on the ladder of the use, with its date
    const row = within(screen.getByRole('region', { name: `Escada de ${label('titulo')}` }))
      .getAllByRole('row')
      .find(item => item.textContent?.includes('cheap-a'))!
    expect(row).toHaveTextContent('10 · 08/11')
  })

  it('"Parar" para no meio, guarda o que já rodou e não gasta mais', async () => {
    setup(CONFIG, [{ use: 'estudo', provider: 'deepinfra', model: 'antigo', score: 9, costPerNote: 0.002, at: '2026-11-01T12:00:00.000Z' }])
    await open()
    openTitle()
    hold = new Promise<void>(() => undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Rodar meu diagnóstico' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Rodar · ~US\$/ }))
    const running = await screen.findByRole('status', { name: 'Diagnóstico rodando' })
    await waitFor(() => expect(asked.length).toBeGreaterThan(0))
    fireEvent.click(within(running).getByRole('button', { name: 'Parar' }))
    const done = await screen.findByRole('group', { name: 'Resultado do diagnóstico' })
    expect(done).toHaveTextContent(/Parado/)
    const calls = asked.length
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(asked).toHaveLength(calls)
    // what was saved before stays
    expect(saved().aiDiagnosis).toContainEqual(expect.objectContaining({ use: 'estudo', model: 'antigo' }))
  })

  it('o custo "?" aparece quando o provedor não informa preço', async () => {
    hoisted.deps = { ...fakeDeps(), catalog: async (provider: AiProvider) => (provider.id === 'di' ? [{ ...cheap, price: null }] : []) }
    setup()
    await open()
    openTitle()
    fireEvent.click(screen.getByRole('button', { name: 'Rodar meu diagnóstico' }))
    expect(await screen.findByRole('group', { name: 'Diagnóstico antes de rodar' })).toHaveTextContent(/\?/)
  })
})

describe('o que não muda', () => {
  it('"Padrões por uso" continua com os seus seletores, sem a lista, a escada nem o diagnóstico', async () => {
    setup()
    render(<SettingsDialog initial="ai" />)
    await waitFor(() => expect(Object.values(useModelsStore.getState().live).every(read => read.state !== 'reading')).toBe(true))
    fireEvent.click(screen.getByRole('tab', { name: 'Padrões por uso' }))
    expect(screen.getByLabelText('Estudo')).toBeInTheDocument()
    expect(screen.queryByText(LIST_TITLE)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rodar meu diagnóstico' })).toBeNull()
  })
})
