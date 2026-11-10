import type { ComponentType, ReactNode } from 'react'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))
// The action of T059: these tests drive the screens, the upload itself never runs.
vi.mock('@/lib/storage/source-storage', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/storage/source-storage')>()), saveToDrive: vi.fn() }))
// Mídias lists the browser's own folder, which jsdom does not have: here it is what the library knows.
vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  listLocalMedia: vi.fn(async () => (await import('@/stores/library')).useLibraryStore.getState().localMedia),
}))

import { Overlays } from '@/components/dialogs/Overlays'
import { EntryList } from '@/components/library/EntryList'
import { ColumnsCard, CommandsRow, FocusRow, ReaderRow } from '@/components/library/FileRows'
import { Toasts } from '@/components/ui/Toasts'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import type { LocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import * as sourceStorage from '@/lib/storage/source-storage'
import WorkspacePage from '@/pages/workspace'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileMeta, FileSidecar, SourceMeta } from '@/types/domain'

// FR-043: what is kept only in this browser says so and offers "Salvar no meu Drive", wherever it appears.

// Read through the module so this file compiles before the function exists.
const saveToDrive = (sourceStorage as unknown as { saveToDrive: Mock<(fileId: string) => Promise<void>> }).saveToDrive

const NOTICE = /Só neste navegador/
const ACTION = 'Salvar no meu Drive'
const SAVED = 'Salvo no seu Drive. Agora ele está disponível em qualquer aparelho.'
// The list of Entradas has the short form of the prototype: "Só no navegador · Salvar no Drive".
const ANY_NOTICE = /Só n(este|o) navegador/
const ANY_ACTION = /Salvar no (meu )?Drive/

const stamp = { at: '2026-11-07T10:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }
const SIZE = 42 * 1024 * 1024

const GOOGLE: Account = { id: 'g-1', kind: 'google', name: 'Marina Silva', email: 'marina@exemplo.com', picture: '' }

/** In Mídias and nowhere else. */
const RECORDED: SourceMeta = { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 2910, sizeBytes: SIZE, storage: 'none' }
const IN_DRIVE: SourceMeta = { input: 'file', name: 'kickoff.mp4', mime: 'video/mp4', durationSeconds: 1800, sizeBytes: SIZE, storage: 'drive', storedFileId: 'drv-kickoff', expiresAt: null }
const LINK: SourceMeta = { input: 'url', name: 'Guia de juros', url: 'https://exemplo.com/juros', storage: 'none' }

function item(id: string, name: string, fields: Partial<FileMeta>): FileMeta {
  return newFileMeta({ id, name, type: 'reading', folderId: 'aurora', created: stamp, updated: stamp, ...fields })
}

function inMedia(name: string, fileId: string): LocalMedia {
  return { storedName: name, name, mime: 'audio/webm', durationSeconds: 2910, size: SIZE, createdAt: stamp.at, fileIds: [fileId] }
}

function fakeRepository(kind: 'local' | 'drive', accountId: string, files: FileMeta[]): Repository {
  const sidecars = new Map(files.map(meta => [meta.id, newSidecar(meta)]))
  return {
    kind,
    accountId,
    readContent: async () => 'Texto da nota.',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: async (sidecar: FileSidecar) => {
      sidecars.set(sidecar.meta.id, sidecar)
      return sidecar
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
}

let signIn: Mock<() => Promise<Account>>

function seed(google: boolean) {
  const entry = { role: 'entrada', kept: 'arquivo' } as const
  const files = [
    item('aula3', 'Gravação da aula 3.webm', { ...entry, origin: RECORDED }),
    item('kickoff', 'Reunião de kickoff.mp4', { ...entry, origin: IN_DRIVE }),
    // in the Drive and still in Mídias: a copy here does not make it "only here"
    item('reuniao', 'Reunião de planejamento.mp4', { ...entry, origin: { ...IN_DRIVE, name: 'planejamento.mp4', storedFileId: 'drv-reuniao' } }),
    item('guia', 'Guia de juros compostos', { ...entry, kept: 'registro', origin: LINK }),
    // a note whose own recording is only here
    item('gravada', 'Monitoria gravada', { origin: { ...RECORDED, name: 'monitoria.webm' } }),
    item('ata', 'Ata da reunião', { type: 'meeting' }),
  ]
  const index = defaultIndex()
  // Without a limit, the first connection of a Google account opens its own window over everything.
  index.settings.storageLimitBytes = 10 * 1024 * 1024 * 1024
  signIn = vi.fn(async () => GOOGLE)
  useAccountStore.setState({ accounts: google ? [LOCAL_ACCOUNT, GOOGLE] : [LOCAL_ACCOUNT], activeId: google ? GOOGLE.id : LOCAL_ACCOUNT.id, reconnectId: null, addGoogleAccount: signIn })
  useLibraryStore.setState({
    repo: google ? fakeRepository('drive', GOOGLE.id, files) : fakeRepository('local', LOCAL_ACCOUNT.id, files),
    accountId: google ? GOOGLE.id : LOCAL_ACCOUNT.id,
    ready: true,
    loadError: null,
    folders: [newFolderMeta({ id: 'aurora', name: 'Projeto Aurora' })],
    files,
    index,
    opened: {},
    openedAt: {},
    localMedia: [inMedia('aula3.webm', 'aula3'), inMedia('monitoria.webm', 'gravada'), inMedia('planejamento.webm', 'reuniao')],
    sharedView: null,
    sizes: {},
  })
  useUiStore.setState({ menu: null, overlay: null, selection: new Set(), toasts: [] })
  useUiStore.getState().clearFilters()
  // What the real one leaves behind: the item has a Drive address. The copy in Mídias stays.
  saveToDrive.mockReset()
  saveToDrive.mockImplementation(async fileId => {
    const library = useLibraryStore.getState()
    const origin = library.files.find(file => file.id === fileId)!.origin!
    await library.updateFile(fileId, { origin: { ...origin, storage: 'drive', storedFileId: `drv-${fileId}`, expiresAt: null } })
  })
}

function renderApp(children: ReactNode) {
  return render(
    <MemoryRouter>
      {children}
      <Overlays />
      <Toasts />
    </MemoryRouter>,
  )
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/biblioteca/:folderId" element={<WorkspacePage />} />
        <Route path="/arquivo/:fileId" element={<WorkspacePage />} />
        <Route path="/entrada/:fileId" element={<WorkspacePage />} />
        <Route path="*" element={<WorkspacePage />} />
      </Routes>
      <Overlays />
      <Toasts />
    </MemoryRouter>,
  )
}

type RowComponent = ComponentType<{ file: FileMeta; showWhere: boolean; currentId: string | null; excerpt: string }>
const FILE_ROWS: [string, RowComponent][] = [
  ['ReaderRow', ReaderRow],
  ['ColumnsCard', ColumnsCard],
  ['CommandsRow', CommandsRow],
  ['FocusRow', FocusRow],
]

/** A row that follows the library, as the lists do. */
function LiveRow({ Row, id }: { Row: RowComponent; id: string }) {
  const file = useLibraryStore(state => state.files.find(entry => entry.id === id)!)
  return <Row file={file} showWhere={false} currentId={null} excerpt="" />
}

function rowOf(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-file-id="${id}"]`)
  expect(row).not.toBeNull()
  return row!
}

const actionIn = (scope: HTMLElement) => within(scope).getByRole('button', { name: /Salvar no meu Drive/ })
const expectNoOffer = (scope: HTMLElement) => {
  expect(scope).not.toHaveTextContent(ANY_NOTICE)
  expect(within(scope).queryByRole('button', { name: ANY_ACTION })).not.toBeInTheDocument()
}
const saveDialog = () => screen.findByRole('dialog', { name: /^Salvar no meu Drive/ })
const titleOf = (name: string) => screen.findByRole('heading', { name, level: 1 })

/** The action, the window that asks, and the confirmation. */
async function saveWith(action: HTMLElement) {
  fireEvent.click(action)
  fireEvent.click(within(await saveDialog()).getByRole('button', { name: ACTION }))
  await waitFor(() => expect(saveToDrive).toHaveBeenCalledTimes(1))
}

describe('com conta do Google, o que está só neste navegador', () => {
  beforeEach(() => seed(true))

  describe('nas listas', () => {
    it.each(FILE_ROWS)('%s: avisa e oferece salvar; o que está no Drive, não', (_name, Row) => {
      renderApp(
        <>
          <LiveRow Row={Row} id="aula3" />
          <LiveRow Row={Row} id="kickoff" />
        </>,
      )
      expect(rowOf('aula3')).toHaveTextContent(NOTICE)
      expect(actionIn(rowOf('aula3'))).toBeInTheDocument()
      expectNoOffer(rowOf('kickoff'))
    })

    it('a linha salva e o aviso some dela', async () => {
      renderApp(<LiveRow Row={ReaderRow} id="aula3" />)
      await saveWith(actionIn(rowOf('aula3')))
      expect(saveToDrive).toHaveBeenCalledWith('aula3')
      await waitFor(() => expect(rowOf('aula3')).not.toHaveTextContent(NOTICE))
    })

    it('a pasta do explorador avisa na linha, só no que está só aqui', async () => {
      renderAt('/biblioteca/aurora')
      await screen.findByRole('table', { name: 'Notas e pastas' })
      for (const id of ['aula3', 'gravada']) {
        expect(rowOf(id)).toHaveTextContent(NOTICE)
        expect(actionIn(rowOf(id))).toBeInTheDocument()
      }
      for (const id of ['kickoff', 'reuniao', 'guia', 'ata']) expectNoOffer(rowOf(id))
    })

    it('a linha do explorador salva e o aviso some', async () => {
      renderAt('/biblioteca/aurora')
      await screen.findByRole('table', { name: 'Notas e pastas' })
      await saveWith(actionIn(rowOf('aula3')))
      expect(saveToDrive).toHaveBeenCalledWith('aula3')
      await waitFor(() => expect(rowOf('aula3')).not.toHaveTextContent(NOTICE))
    })

    it('a lista de Entradas avisa só em quem está só aqui', () => {
      renderApp(<EntryList />)
      expect(rowOf('aula3')).toHaveTextContent(ANY_NOTICE)
      expect(within(rowOf('aula3')).getByRole('button', { name: ANY_ACTION })).toBeInTheDocument()
      for (const id of ['kickoff', 'reuniao', 'guia']) expectNoOffer(rowOf(id))
    })
  })

  describe('na página da entrada', () => {
    it.each(['/entrada/aula3', '/arquivo/aula3'])('%s diz onde está e oferece salvar', async path => {
      renderAt(path)
      await titleOf('Gravação da aula 3.webm')
      expect(await screen.findByText(NOTICE)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: ACTION })).toBeInTheDocument()
    })

    it('antes de salvar, pergunta, com o risco e o tamanho; "Agora não" deixa tudo como está', async () => {
      renderAt('/entrada/aula3')
      await titleOf('Gravação da aula 3.webm')
      fireEvent.click(await screen.findByRole('button', { name: ACTION }))
      const dialog = await saveDialog()
      expect(within(dialog).getByRole('heading', { name: 'Salvar no meu Drive?' })).toBeInTheDocument()
      expect(dialog).toHaveTextContent('Hoje este arquivo está só neste navegador: se os dados do navegador forem limpos, ele se perde. No Drive, ele fica na sua conta, disponível em qualquer aparelho.')
      expect(dialog).toHaveTextContent('Tamanho: 42 MB')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Agora não' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Salvar no meu Drive/ })).not.toBeInTheDocument())
      expect(saveToDrive).not.toHaveBeenCalled()
      expect(screen.getByText(NOTICE)).toBeInTheDocument()
    })

    it('salvar grava no Drive, o aviso some, o lugar muda e a confirmação aparece', async () => {
      renderAt('/entrada/aula3')
      await titleOf('Gravação da aula 3.webm')
      await saveWith(await screen.findByRole('button', { name: ACTION }))
      expect(saveToDrive).toHaveBeenCalledWith('aula3')
      expect(signIn).not.toHaveBeenCalled()
      await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeInTheDocument())
      expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument()
      expect(await screen.findByText('Google Drive')).toBeInTheDocument()
      expect(await screen.findByText(SAVED)).toBeInTheDocument()
    })

    it('se não der para salvar, diz o motivo e o aviso continua', async () => {
      saveToDrive.mockRejectedValueOnce(new Error('Sem espaço no Drive.'))
      renderAt('/entrada/aula3')
      await titleOf('Gravação da aula 3.webm')
      await saveWith(await screen.findByRole('button', { name: ACTION }))
      expect(await screen.findByText('Sem espaço no Drive.')).toBeInTheDocument()
      expect(screen.getByText(NOTICE)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: ACTION })).toBeInTheDocument()
    })

    it.each([
      ['guardada no Drive', '/entrada/kickoff', 'Reunião de kickoff.mp4'],
      ['no Drive e com cópia em Mídias', '/entrada/reuniao', 'Reunião de planejamento.mp4'],
    ])('%s: diz que está no Drive e não oferece nada', async (_case, path, name) => {
      renderAt(path)
      await titleOf(name)
      expect(await screen.findByText('Google Drive')).toBeInTheDocument()
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument()
    })

    it('"Só o registro" não tem arquivo, então não há o que salvar', async () => {
      renderAt('/entrada/guia')
      await titleOf('Guia de juros compostos')
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument()
    })
  })

  describe('na nota', () => {
    it('com a gravação só aqui, avisa e oferece salvar', async () => {
      renderAt('/arquivo/gravada')
      await titleOf('Monitoria gravada')
      expect(await screen.findByText(NOTICE)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: ACTION })).toBeInTheDocument()
    })

    it('salvar grava no Drive e o aviso some', async () => {
      renderAt('/arquivo/gravada')
      await titleOf('Monitoria gravada')
      await saveWith(await screen.findByRole('button', { name: ACTION }))
      expect(saveToDrive).toHaveBeenCalledWith('gravada')
      await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeInTheDocument())
      expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument()
    })

    it('a nota guardada na biblioteca do Drive não avisa nada', async () => {
      renderAt('/arquivo/ata')
      await titleOf('Ata da reunião')
      await screen.findByTestId('markdown')
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: ACTION })).not.toBeInTheDocument()
    })
  })

  describe('em Mídias', () => {
    const itemOf = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement

    beforeEach(() => useUiStore.getState().open({ kind: 'media' }))

    it('a mídia só aqui avisa e oferece salvar; a que já está no Drive, não', async () => {
      renderApp(null)
      const here = await itemOf('aula3.webm')
      expect(here).toHaveTextContent(NOTICE)
      expect(actionIn(here)).toBeInTheDocument()
      expectNoOffer(await itemOf('planejamento.webm'))
    })

    it('salvar grava no Drive e o aviso some daquela mídia', async () => {
      renderApp(null)
      await saveWith(actionIn(await itemOf('aula3.webm')))
      expect(saveToDrive).toHaveBeenCalledWith('aula3')
      await waitFor(() => {
        const row = screen.queryByText('aula3.webm')?.closest('li')
        expect(row ? within(row as HTMLElement).queryByText(NOTICE) : null).toBeNull()
      })
    })
  })
})

// In the Local profile the whole library is in this browser: a notice on every row is the owner's call, so only the page and the note are pinned here.
describe('sem conta do Google, a mesma ação leva a entrar', () => {
  beforeEach(() => seed(false))

  it.each([
    ['página da entrada', '/entrada/aula3', 'Gravação da aula 3.webm'],
    ['nota', '/arquivo/ata', 'Ata da reunião'],
  ])('%s: avisa e o botão pede para entrar com o Google, sem gravar nada', async (_place, path, name) => {
    renderAt(path)
    await titleOf(name)
    expect(await screen.findByText(NOTICE)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: ACTION }))
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
    expect(saveToDrive).not.toHaveBeenCalled()
  })
})
