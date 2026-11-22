// FR-065 (003): the page "Gerações" in the side bar: what is generating, what failed (kept on this device until "Tentar de novo" or "Dispensar") and what came out.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { JobsPanel } from '@/components/dialogs/JobsPanel'
import { Toasts } from '@/components/ui/Toasts'
import { useViewRoute } from '@/hooks/use-view-route'
import { paths } from '@/lib/paths'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { useAccountStore } from '@/stores/account'
import { useGenerationsStore } from '@/stores/generations'
import { type Job, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'
import { FILES, seedLibrary } from '@/test/library/explorer-fixture'

const REAL = useJobsStore.getState()
const ACCOUNT = useAccountStore.getState().activeId

function job(id: string, patch: Partial<Job> = {}): Job {
  return { id, kind: 'generation', title: 'Aula: Limites laterais e continuidade', fileId: 'limites', status: 'running', message: 'Escrevendo', fraction: 0.62, error: null, startedAt: Date.now(), ...patch }
}

const RETRY: Overlay = { kind: 'generate', fileId: 'derivadas', agent: 'explanation', prefill: { model: 'custom::forte', instruction: 'foque nos exemplos' } }

const RUNNING = job('run-aula')
const TRANSCRIBING = job('run-tr', { kind: 'transcription', title: 'Monitoria de limites', fileId: 'monitoria', message: 'Transcrevendo a gravação', fraction: null })
const FAILED = job('fail-exp', { title: 'Explicação: Derivadas pela definição', fileId: 'derivadas', status: 'error', message: 'A geração falhou.', error: 'O modelo não respondeu', fraction: null, retry: RETRY })
const READY = job('done-ata', { title: 'Ata: Aula gravada: derivadas', fileId: 'derivadas-video', status: 'done', message: 'Pronta e salva na Biblioteca.', fraction: 1 })
// a map of a note: the note is `noteId`, so the note itself does not read as being written
const MAP_RUNNING = job('run-map', { kind: 'artifact', title: 'Mapa: Limites laterais e continuidade', fileId: null, noteId: 'limites', message: 'Desenhando o mapa da nota', fraction: null })
const MAP_READY = job('done-map', { kind: 'artifact', title: 'Mapa: Limites laterais e continuidade', fileId: null, noteId: 'limites', status: 'done', message: 'Pronto: “Mapa dos limites”.', fraction: 1, open: { kind: 'mindmap', fileId: 'limites', artifactId: 'mapa-1' } })

const setJobs = (jobs: Job[]) => act(() => useJobsStore.setState({ jobs }))

function Where() {
  return <output aria-label="Onde estou">{useLocation().pathname}</output>
}

function Workspace() {
  return (
    <>
      <ReaderWorkspace route={useViewRoute()} />
      <Where />
    </>
  )
}

function renderAt(path: string = paths.generations) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/arquivo/:fileId" element={<Workspace />} />
        <Route path="*" element={<Workspace />} />
      </Routes>
    </MemoryRouter>,
  )
}

const sideBar = () => within(screen.getByRole('complementary', { name: 'Navegação' }))
const where = () => screen.getByLabelText('Onde estou').textContent
const tabs = () => screen.getByRole('group', { name: 'Gerações' })
const tab = (name: string) => within(tabs()).getByRole('button', { name: new RegExp(`^${name}`) })
const table = (name: string) => screen.getByRole('table', { name })
const rowOf = (name: string, label: string) => within(table(name)).getByRole('row', { name: label })

beforeEach(() => {
  localStorage.clear()
  seedLibrary()
  useJobsStore.setState({ jobs: [], cancel: REAL.cancel, dismiss: REAL.dismiss })
  useGenerationsStore.setState({ items: [] })
  useUiStore.setState({ overlay: null, toasts: [] })
})

afterEach(() => {
  useAccountStore.setState({ activeId: ACCOUNT })
  vi.useRealTimers()
})

describe('a lateral', () => {
  it('tem "Gerações" com o número do que está gerando, e o ponto vermelho só quando algo falhou', () => {
    setJobs([RUNNING, TRANSCRIBING])
    renderAt('/biblioteca')
    const item = sideBar().getByRole('button', { name: /^Gerações/ })
    expect(item).toHaveTextContent('2')
    expect(within(item).queryByTitle('Uma geração falhou')).toBeNull()
    setJobs([RUNNING, TRANSCRIBING, FAILED])
    expect(within(item).getByTitle('Uma geração falhou')).toBeInTheDocument()
    fireEvent.click(item)
    expect(where()).toBe(paths.generations)
    expect(sideBar().getByRole('button', { name: /^Gerações/ })).toHaveAttribute('aria-current', 'true')
  })

  it('no celular, o botão do menu mostra o que está gerando e o ponto vermelho da falha', () => {
    setJobs([RUNNING])
    renderAt('/biblioteca')
    expect(screen.getByRole('button', { name: 'Menu, 1 gerando' })).toBeInTheDocument()
    setJobs([RUNNING, FAILED])
    const menu = screen.getByRole('button', { name: 'Menu, 1 gerando, 1 falhou' })
    expect(within(menu).getByTitle('Uma geração falhou')).toBeInTheDocument()
    // the generation ended (its line leaves Gerando); the failure stays
    setJobs([FAILED])
    expect(screen.getByRole('button', { name: 'Menu, 1 falhou' })).toBeInTheDocument()
  })
})

describe('a página', () => {
  it('tem as abas Gerando, Falharam e Prontas, com a contagem', () => {
    setJobs([RUNNING, TRANSCRIBING, FAILED, READY])
    renderAt()
    expect(screen.getByRole('heading', { name: 'Gerações' })).toBeInTheDocument()
    expect(tab('Gerando')).toHaveTextContent('Gerando2')
    expect(tab('Falharam')).toHaveTextContent('Falharam1')
    expect(tab('Prontas')).toHaveTextContent('Prontas1')
    expect(tab('Gerando')).toHaveAttribute('aria-pressed', 'true')
  })

  it('Gerando: a nota (abre a nota), o que está sendo feito e o andamento; "Cancelar" para a geração', () => {
    const cancel = vi.fn()
    useJobsStore.setState({ cancel })
    setJobs([RUNNING, TRANSCRIBING])
    renderAt()
    const row = rowOf('Gerando', 'Limites laterais e continuidade')
    expect(row).toHaveTextContent('Aula')
    expect(row).toHaveTextContent('62%')
    expect(row).toHaveTextContent('Escrevendo')
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62')
    expect(rowOf('Gerando', 'Monitoria de limites')).toHaveTextContent('Transcrição')
    expect(rowOf('Gerando', 'Monitoria de limites')).toHaveTextContent('Transcrevendo a gravação')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancelar' }))
    expect(cancel).toHaveBeenCalledWith('run-aula')
    fireEvent.click(within(row).getByRole('link', { name: /Limites laterais e continuidade/ }))
    expect(where()).toBe(paths.file('limites'))
  })

  it('uma geração cancelada sai da lista sem virar falha', () => {
    setJobs([RUNNING])
    renderAt()
    setJobs([{ ...RUNNING, status: 'cancelled', message: 'Cancelado por você.', fraction: null }])
    expect(screen.queryByRole('table', { name: 'Gerando' })).toBeNull()
    expect(screen.getByText('Nada gerando agora')).toBeInTheDocument()
    expect(tab('Falharam')).toHaveTextContent('Falharam0')
  })

  it('Falharam: o motivo, "Tentar de novo" abre a janela com o que foi pedido e tira da lista', () => {
    setJobs([FAILED])
    renderAt()
    fireEvent.click(tab('Falharam'))
    const row = rowOf('Falharam', 'Derivadas pela definição')
    expect(row).toHaveTextContent('Explicação')
    expect(row).toHaveTextContent('O modelo não respondeu')
    fireEvent.click(within(row).getByRole('button', { name: 'Tentar de novo' }))
    expect(useUiStore.getState().overlay).toEqual(RETRY)
    expect(useGenerationsStore.getState().items).toEqual([])
    expect(useJobsStore.getState().jobs).toEqual([])
    expect(tab('Falharam')).toHaveTextContent('Falharam0')
  })

  it('a aba fica no endereço: um link para ?aba=falharam abre em Falharam', () => {
    setJobs([RUNNING, FAILED])
    renderAt(`${paths.generations}?aba=falharam`)
    expect(tab('Falharam')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('table', { name: 'Gerando' })).toBeNull()
    expect(rowOf('Falharam', 'Derivadas pela definição')).toBeInTheDocument()
  })

  it('a falha também aparece embaixo de "Gerando", como no desenho escolhido', () => {
    setJobs([RUNNING, FAILED])
    renderAt()
    expect(tab('Gerando')).toHaveAttribute('aria-pressed', 'true')
    expect(rowOf('Falharam', 'Derivadas pela definição')).toHaveTextContent('O modelo não respondeu')
  })

  it('Falharam: "Dispensar" tira da lista', () => {
    setJobs([FAILED])
    renderAt()
    fireEvent.click(tab('Falharam'))
    fireEvent.click(within(rowOf('Falharam', 'Derivadas pela definição')).getByRole('button', { name: 'Dispensar' }))
    expect(screen.queryByRole('table', { name: 'Falharam' })).toBeNull()
    expect(useGenerationsStore.getState().items).toEqual([])
    expect(useJobsStore.getState().jobs).toEqual([])
  })

  it('uma nota que falhou ao escrever, sem janela guardada: "Tentar de novo" abre a escolha de modelo dela', () => {
    useLibraryStore.setState({ files: FILES.map(file => (file.id === 'derivadas' ? { ...file, status: 'pending' as const } : file)) })
    setJobs([{ ...FAILED, retry: undefined }])
    renderAt()
    fireEvent.click(within(rowOf('Falharam', 'Derivadas pela definição')).getByRole('button', { name: 'Tentar de novo' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'pending', fileId: 'derivadas' })
  })

  it('Prontas: a nota que saiu, com "Abrir"', () => {
    setJobs([READY])
    renderAt()
    fireEvent.click(tab('Prontas'))
    const row = rowOf('Prontas', 'Aula gravada: derivadas')
    expect(row).toHaveTextContent('Ata')
    fireEvent.click(within(row).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.file('derivadas-video'))
  })

  it('um mapa sendo feito: a nota, "Mapa", o andamento e "Cancelar"', () => {
    const cancel = vi.fn()
    useJobsStore.setState({ cancel })
    setJobs([MAP_RUNNING])
    renderAt()
    const row = rowOf('Gerando', 'Limites laterais e continuidade')
    expect(row).toHaveTextContent('Mapa')
    expect(row).toHaveTextContent('Desenhando o mapa da nota')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancelar' }))
    expect(cancel).toHaveBeenCalledWith('run-map')
  })

  it('Prontas: um mapa que saiu, "Abrir" abre a nota no mapa', () => {
    setJobs([MAP_READY])
    renderAt(`${paths.generations}?aba=prontas`)
    const row = rowOf('Prontas', 'Limites laterais e continuidade')
    expect(row).toHaveTextContent('Mapa')
    fireEvent.click(within(row).getByRole('button', { name: 'Abrir' }))
    expect(where()).toBe(paths.file('limites'))
    expect(useUiStore.getState().overlay).toEqual(MAP_READY.open)
  })

  it('a pronta continua em Prontas depois que sai de Tarefas', () => {
    setJobs([READY])
    setJobs([])
    renderAt()
    expect(tab('Prontas')).toHaveTextContent('Prontas1')
  })

  it('um passo do meio ("Material lido.") não conta como pronta', () => {
    setJobs([job('read', { status: 'done', message: 'Material lido.', fraction: 1 })])
    renderAt()
    expect(tab('Prontas')).toHaveTextContent('Prontas0')
  })
})

describe('guardada na conta, neste aparelho', () => {
  /** The page reloaded: every module again, reading what was kept. */
  async function reload() {
    vi.resetModules()
    const generations = await import('@/stores/generations')
    const ui = await import('@/stores/ui')
    return { store: generations.useGenerationsStore, ui: ui.useUiStore }
  }

  it('a falha sobrevive a recarregar, com o que foi pedido para "Tentar de novo"', async () => {
    setJobs([FAILED])
    const { store, ui } = await reload()
    const [kept] = store.getState().items
    expect(kept).toMatchObject({ id: 'fail-exp', state: 'failed', error: 'O modelo não respondeu', title: FAILED.title, fileId: 'derivadas', retry: RETRY })
    store.getState().retry('fail-exp')
    expect(ui.getState().overlay).toEqual(RETRY)
    expect(store.getState().items).toEqual([])
  })

  it('o que estava gerando quando a aba fechou vira falha: "A aba fechou antes de terminar"', async () => {
    setJobs([RUNNING])
    const { store } = await reload()
    expect(store.getState().items).toEqual([expect.objectContaining({ id: 'run-aula', state: 'failed', error: expect.stringMatching(/^A aba fechou antes de terminar/) })])
  })

  it('um mapa pronto guarda o que "Abrir" abre', async () => {
    setJobs([MAP_READY])
    const { store } = await reload()
    expect(store.getState().items).toEqual([expect.objectContaining({ id: 'done-map', state: 'ready', fileId: 'limites', open: MAP_READY.open })])
  })

  it('"Dispensar" não volta ao recarregar', async () => {
    setJobs([FAILED])
    act(() => useGenerationsStore.getState().dismiss('fail-exp'))
    const { store } = await reload()
    expect(store.getState().items).toEqual([])
  })

  it('uma janela que não cabe no aparelho (um arquivo escolhido) não é guardada; a falha fica, sem ela', async () => {
    const withFile: Overlay = { kind: 'new', prefill: { file: new File(['x'], 'aula.mp4') } as never }
    setJobs([{ ...FAILED, retry: withFile }])
    expect(useGenerationsStore.getState().items[0].retry).toBe(withFile)
    const { store } = await reload()
    expect(store.getState().items[0]).toMatchObject({ id: 'fail-exp', state: 'failed' })
    expect(store.getState().items[0].retry).toBeUndefined()
  })

  it('as prontas: só as dos últimos 7 dias, até 50', async () => {
    const day = 24 * 60 * 60 * 1000
    const old = job('velha', { status: 'done', message: 'Pronta e salva na Biblioteca.' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() - 8 * day)
    setJobs([old])
    vi.useRealTimers()
    setJobs(Array.from({ length: 55 }, (_, at) => job(`p${at}`, { status: 'done', message: 'Pronta e salva na Biblioteca.' })))
    const { store } = await reload()
    const ready = store.getState().items.filter(item => item.state === 'ready')
    expect(ready).toHaveLength(50)
    expect(ready.some(item => item.id === 'velha')).toBe(false)
  })

  it('cada conta tem as suas falhas', () => {
    setJobs([FAILED])
    act(() => useAccountStore.setState({ activeId: 'google-outra' }))
    expect(useGenerationsStore.getState().items).toEqual([])
    act(() => useAccountStore.setState({ activeId: ACCOUNT }))
    expect(useGenerationsStore.getState().items).toEqual([expect.objectContaining({ id: 'fail-exp', state: 'failed' })])
  })
})

describe('os cartões de Tarefas do canto saem', () => {
  function renderCorner() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <JobsPanel />
        <Toasts />
      </MemoryRouter>,
    )
  }

  it('nada de cartões no canto, gerando ou com falha', () => {
    setJobs([RUNNING, FAILED])
    renderCorner()
    expect(document.querySelector('.jobs')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull()
  })

  it('o aviso "ficou pronta · Abrir" continua', () => {
    setJobs([RUNNING])
    renderCorner()
    setJobs([{ ...RUNNING, status: 'done', message: 'Pronta e salva na Biblioteca.', fraction: 1 }])
    const toasts = document.querySelector<HTMLElement>('.toasts')!
    expect(within(toasts).getByText(/“Aula: Limites laterais e continuidade” ficou pronta/)).toBeInTheDocument()
    expect(within(toasts).getByRole('button', { name: 'Abrir' })).toBeInTheDocument()
  })
})
