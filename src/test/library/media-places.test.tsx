import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The folder of the browser (Mídias) only exists in a real browser: here it is a list and the files in memory.
const browser = vi.hoisted(() => ({ items: [] as import('@/lib/recording/media-library').LocalMedia[], files: new Map<string, Blob>(), counter: 0 }))

vi.mock('@/lib/recording/media-library', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/recording/media-library')>()
  // what the real one does when the index changes: the library store reads it again
  const publish = async () => (await import('@/stores/library')).useLibraryStore.setState({ localMedia: [...browser.items] })
  return {
    ...real,
    listLocalMedia: vi.fn(async () => [...browser.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    readLocalMedia: vi.fn(async (item: { storedName: string; name: string; mime: string }) => {
      const stored = browser.files.get(item.storedName)
      if (!stored) throw new DOMException('A requested file or directory could not be found', 'NotFoundError')
      return new File([stored], item.name, { type: item.mime })
    }),
    linkLocalMedia: vi.fn(async (storedName: string, fileId: string) => {
      browser.items = browser.items.map(item => (item.storedName === storedName && !item.fileIds.includes(fileId) ? { ...item, fileIds: [...item.fileIds, fileId] } : item))
      await publish()
    }),
    keepLocalMedia: vi.fn(async (file: File, fileId: string, durationSeconds: number) => {
      const storedName = `envio-${++browser.counter}`
      browser.files.set(storedName, file)
      browser.items = [...browser.items, { storedName, name: file.name, mime: file.type, durationSeconds, size: file.size, createdAt: '2026-11-12T12:00:00.000Z', fileIds: [fileId] }]
      await publish()
    }),
    removeLocalMedia: vi.fn(async (storedName: string) => {
      browser.files.delete(storedName)
      browser.items = browser.items.filter(item => item.storedName !== storedName)
      await publish()
    }),
  }
})
vi.mock('@/utils/download', async importOriginal => ({ ...(await importOriginal<typeof import('@/utils/download')>()), downloadBlob: vi.fn() }))

import { Overlays } from '@/components/dialogs/Overlays'
import { InfoPanel } from '@/components/reader/Inspector'
import { Toasts } from '@/components/ui/Toasts'
import { defaultIndex, newFileMeta } from '@/lib/defaults'
import { keepLocalMedia, type LocalMedia, removeLocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { FakeDrive, installMemoryStorage, readBlob, uniqueAccount } from '@/test/storage/fake-drive'
import { downloadBlob } from '@/utils/download'
import type { FileMeta, SourceMeta } from '@/types/domain'
import { isSourceNote } from '@/lib/file-types'

// T136 and T138: "Mídias neste computador" says where each media is, offers what is missing, and downloads a transcription only when there is one.

const token = vi.fn(async () => 'tok')
const GOOGLE: Account = { id: 'g-1', kind: 'google', name: 'Marina Silva', email: 'marina@exemplo.com', picture: '' }
const stamp = { at: '2026-11-07T10:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }

const HERE = 'Só neste computador'
const DRIVE = 'No Google Drive'
const BOTH = 'Nos dois'
const SAVE = /Salvar no meu Drive/
const KEEP = /Guardar neste computador/

const RECORDED: SourceMeta = { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 2910, sizeBytes: 11, storage: 'none' }
const KICKOFF: SourceMeta = { input: 'file', name: 'kickoff.mp4', mime: 'video/mp4', durationSeconds: 1800, sizeBytes: 14, storage: 'none', expiresAt: null }
const PDF: SourceMeta = { input: 'file', name: 'contrato.pdf', mime: 'application/pdf', sizeBytes: 9, storage: 'none', expiresAt: null }

let drive: FakeDrive
let account: string

const library = () => useLibraryStore.getState()
const toasts = () => useUiStore.getState().toasts.map(toast => toast.text)
const entradas = () => library().files.filter(file => isSourceNote(file))

/** What the browser keeps: the file in the folder, and its line in the index. */
function keptHere(name: string, text: string, fileIds: string[] = [], fields: Partial<LocalMedia> = {}): LocalMedia {
  const item: LocalMedia = { storedName: `grav-${++browser.counter}`, name, mime: name.endsWith('.mp4') ? 'video/mp4' : 'audio/webm', durationSeconds: 2910, size: text.length, createdAt: stamp.at, fileIds, ...fields }
  browser.files.set(item.storedName, new Blob([text], { type: item.mime }))
  browser.items = [...browser.items, item]
  useLibraryStore.setState({ localMedia: [...browser.items] })
  return item
}

function entrada(name: string, origin: SourceMeta, fields: Partial<FileMeta> = {}): Promise<FileMeta> {
  return library().createFile({ name, role: 'entrada', kept: 'arquivo', type: 'reading', description: '', folderId: null, status: 'ready', pendingExcerpt: null, origin, ...fields }, '')
}

/** In the Drive of the account: what "Salvar no meu Drive" leaves behind. */
async function inDrive(name: string, origin: SourceMeta, text: string, fields: Partial<FileMeta> = {}): Promise<FileMeta> {
  const meta = await entrada(name, origin, fields)
  const stored = await library().repo!.putSource(meta.id, new Blob([text], { type: origin.mime }), origin.name)
  await library().updateFile(meta.id, { origin: { ...origin, storage: 'drive', storedFileId: stored.ref, expiresAt: null } })
  return library().files.find(file => file.id === meta.id)!
}

const driveCopy = (name: string) => [...drive.files.values()].find(file => file.name.endsWith(`-${name}`))

function renderMidias() {
  useUiStore.getState().open({ kind: 'media' })
  return render(
    <MemoryRouter>
      <Overlays />
      <Toasts />
    </MemoryRouter>,
  )
}

const itemOf = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement
/** The row, once it says `place`: a row that changes list is a new row. */
const movedTo = (place: string, name: string) =>
  waitFor(async () => {
    const row = await itemOf(name)
    expect(row).toHaveTextContent(place)
    return row
  })
const dialogToConfirm = () => screen.findByRole('dialog', { name: /^Salvar no meu Drive/ })

async function confirmSave(item: HTMLElement) {
  fireEvent.click(within(item).getByRole('button', { name: SAVE }))
  fireEvent.click(within(await dialogToConfirm()).getByRole('button', { name: 'Salvar no meu Drive' }))
}

beforeEach(async () => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  account = uniqueAccount()
  browser.items = []
  browser.files.clear()
  browser.counter = 0
  vi.mocked(downloadBlob).mockClear()
  vi.mocked(keepLocalMedia).mockClear()
  vi.mocked(removeLocalMedia).mockClear()
  await library().connect(account, token)
  expect(library().loadError).toBeNull()
  useUiStore.setState({ menu: null, overlay: null, selection: new Set(), toasts: [] })
})

afterEach(() => {
  useSyncStore.getState().stop()
  vi.unstubAllGlobals()
  useLibraryStore.setState({ repo: null })
})

describe('Mídias: onde cada mídia está', () => {
  it('só neste computador: diz isso e oferece salvar no Drive; salvar leva para o Drive e passa a dizer "Nos dois"', async () => {
    const meta = await entrada('Gravação da aula 3', RECORDED)
    keptHere('aula3.webm', 'som da aula 3', [meta.id])
    renderMidias()
    const item = await itemOf('aula3.webm')
    expect(item).toHaveTextContent(HERE)
    expect(item).not.toHaveTextContent(DRIVE)
    expect(within(item).queryByRole('button', { name: KEEP })).not.toBeInTheDocument()
    await confirmSave(item)
    await waitFor(() => expect(item).toHaveTextContent(BOTH))
    expect(item).not.toHaveTextContent(HERE)
    expect(within(item).queryByRole('button', { name: SAVE })).not.toBeInTheDocument()
    expect(library().files.find(file => file.id === meta.id)?.origin).toMatchObject({ storage: 'drive', storedFileId: expect.any(String) })
    expect(driveCopy('aula3.webm')?.content).toBe('som da aula 3')
    // the copy of this computer stays
    expect(browser.items).toHaveLength(1)
    expect(removeLocalMedia).not.toHaveBeenCalled()
  })

  it('no Drive e neste computador: diz "Nos dois" e não oferece nada', async () => {
    const meta = await inDrive('Reunião de kickoff', KICKOFF, 'video do kickoff')
    keptHere('kickoff.mp4', 'video do kickoff', [meta.id])
    renderMidias()
    const item = await itemOf('kickoff.mp4')
    expect(item).toHaveTextContent(BOTH)
    expect(within(item).queryByRole('button', { name: SAVE })).not.toBeInTheDocument()
    expect(within(item).queryByRole('button', { name: KEEP })).not.toBeInTheDocument()
  })

  describe('a mídia que ainda não virou nota', () => {
    beforeEach(() => {
      keptHere('monitoria.webm', 'som da monitoria')
    })

    it('também vai para o Drive: ganha uma entrada, sem nota, e a janela avisa isso antes', async () => {
      renderMidias()
      const item = await itemOf('monitoria.webm')
      expect(item).toHaveTextContent('Ainda não virou nota.')
      expect(item).toHaveTextContent(HERE)
      fireEvent.click(within(item).getByRole('button', { name: SAVE }))
      const asking = await dialogToConfirm()
      expect(asking).toHaveTextContent(/vira uma nota de mídia na biblioteca/)
      expect(entradas()).toHaveLength(0)
      fireEvent.click(within(asking).getByRole('button', { name: 'Salvar no meu Drive' }))
      await waitFor(() => expect(item).toHaveTextContent(BOTH))
      // the same as "Só guardar para ler" does for a media: an entrada that keeps the file, and nothing else
      expect(library().files).toHaveLength(1)
      const made = entradas()[0]
      expect(made).toMatchObject({ name: 'monitoria', kept: 'arquivo', type: 'audio', status: 'ready', folderId: null })
      expect(made.origin).toMatchObject({ input: 'recording', name: 'monitoria.webm', mime: 'audio/webm', storage: 'drive', storedFileId: expect.any(String) })
      expect(browser.items[0].fileIds).toEqual([made.id])
      expect(item).toHaveTextContent('Virou: monitoria')
      expect(item).not.toHaveTextContent('Ainda não virou nota.')
      expect(driveCopy('monitoria.webm')?.content).toBe('som da monitoria')
      expect(removeLocalMedia).not.toHaveBeenCalled()
    })

    it('um envio de arquivo vira entrada de arquivo, não de gravação', async () => {
      browser.items = []
      keptHere('envio.mp4', 'video enviado', [], { storedName: 'envio-9' })
      renderMidias()
      await confirmSave(await itemOf('envio.mp4'))
      await waitFor(() => expect(entradas()[0]?.origin?.storage).toBe('drive'))
      expect(entradas()[0].origin).toMatchObject({ input: 'file', mime: 'video/mp4' })
    })

    it('se o envio falhar, diz o motivo e a entrada fica ligada à mídia; tentar de novo não cria outra', async () => {
      vi.spyOn(library().repo!, 'putSource').mockRejectedValueOnce(new Error('Sem espaço no Drive.'))
      renderMidias()
      const item = await itemOf('monitoria.webm')
      await confirmSave(item)
      await waitFor(() => expect(toasts()).toContain('Sem espaço no Drive.'))
      expect(item).toHaveTextContent(HERE)
      expect(entradas()).toHaveLength(1)
      expect(entradas()[0].origin?.storedFileId).toBeUndefined()
      await confirmSave(item)
      await waitFor(() => expect(item).toHaveTextContent(BOTH))
      expect(entradas()).toHaveLength(1)
      expect(driveCopy('monitoria.webm')?.content).toBe('som da monitoria')
    })

    it('se o arquivo sumiu do navegador, diz isso e não cria entrada', async () => {
      browser.files.clear()
      renderMidias()
      await confirmSave(await itemOf('monitoria.webm'))
      await waitFor(() => expect(toasts()).toContain('O arquivo não está mais neste navegador.'))
      expect(library().files).toHaveLength(0)
    })
  })

  describe('o que está só no Drive', () => {
    it('aparece em Mídias com "No Google Drive" e "Guardar neste computador"; apagado, não-mídia e da Lixeira, não', async () => {
      await inDrive('Reunião de kickoff', KICKOFF, 'video do kickoff')
      await inDrive('Antigo', { ...KICKOFF, name: 'antigo.mp4' }, 'antigo', { deletedAt: '2026-11-01T00:00:00.000Z' })
      await entrada('Apagado', { ...KICKOFF, name: 'apagado.mp4', removedAt: '2026-11-01T00:00:00.000Z' })
      await inDrive('Contrato', PDF, 'pdf')
      renderMidias()
      const item = await itemOf('kickoff.mp4')
      expect(item).toHaveTextContent(DRIVE)
      expect(item).toHaveTextContent('Reunião de kickoff')
      expect(within(item).getByRole('button', { name: KEEP })).toBeInTheDocument()
      expect(within(item).queryByRole('button', { name: SAVE })).not.toBeInTheDocument()
      for (const name of ['antigo.mp4', 'apagado.mp4', 'contrato.pdf']) expect(screen.queryByText(name)).not.toBeInTheDocument()
      expect(screen.queryByText('Nenhuma gravação guardada ainda.')).not.toBeInTheDocument()
    })

    it('"Guardar neste computador" baixa do Drive, guarda em Mídias ligada à entrada e passa a dizer "Nos dois"', async () => {
      const meta = await inDrive('Reunião de kickoff', KICKOFF, 'video do kickoff')
      renderMidias()
      const item = await itemOf('kickoff.mp4')
      fireEvent.click(within(item).getByRole('button', { name: KEEP }))
      // it leaves the list of the Drive and is now a media of this computer
      const kept = await movedTo(BOTH, 'kickoff.mp4')
      expect(browser.items).toHaveLength(1)
      expect(browser.items[0]).toMatchObject({ name: 'kickoff.mp4', mime: 'video/mp4', durationSeconds: 1800, fileIds: [meta.id] })
      expect(await readBlob(browser.files.get(browser.items[0].storedName)!)).toBe('video do kickoff')
      expect(toasts()).toContain('Guardado neste computador.')
      // the Drive keeps its copy, and the entrada is the same one
      expect(driveCopy('kickoff.mp4')).toBeDefined()
      expect(library().files.find(file => file.id === meta.id)?.origin?.storedFileId).toBeDefined()
      expect(within(kept).queryByRole('button', { name: KEEP })).not.toBeInTheDocument()
    })

    it('enquanto baixa, o botão diz "Guardando…" e não aceita outro clique', async () => {
      await inDrive('Reunião de kickoff', KICKOFF, 'video do kickoff')
      let release: (blob: Blob) => void = () => undefined
      vi.spyOn(library().repo!, 'getSource').mockReturnValueOnce(new Promise(resolve => (release = resolve)))
      renderMidias()
      const item = await itemOf('kickoff.mp4')
      fireEvent.click(within(item).getByRole('button', { name: KEEP }))
      const busy = within(item).getByRole('button', { name: 'Guardando…' })
      expect(busy).toBeDisabled()
      release(new Blob(['video do kickoff'], { type: 'video/mp4' }))
      await movedTo(BOTH, 'kickoff.mp4')
      expect(keepLocalMedia).toHaveBeenCalledTimes(1)
    })

    it('se o Drive não entregar o arquivo, diz o motivo e nada é guardado', async () => {
      await inDrive('Reunião de kickoff', KICKOFF, 'video do kickoff')
      vi.spyOn(library().repo!, 'getSource').mockRejectedValueOnce(new Error('O Drive não respondeu.'))
      renderMidias()
      const item = await itemOf('kickoff.mp4')
      fireEvent.click(within(item).getByRole('button', { name: KEEP }))
      await waitFor(() => expect(toasts()).toContain('O Drive não respondeu.'))
      expect(keepLocalMedia).not.toHaveBeenCalled()
      expect(browser.items).toHaveLength(0)
      expect(within(item).getByRole('button', { name: KEEP })).toBeEnabled()
      expect(item).toHaveTextContent(DRIVE)
    })
  })

  describe('sem conta do Google', () => {
    const signIn = vi.fn(async () => GOOGLE)

    beforeEach(() => {
      const local = {
        kind: 'local',
        accountId: LOCAL_ACCOUNT.id,
        readContent: async () => '',
        readSidecar: async (id: string) => ({ meta: library().files.find(file => file.id === id)! }),
        saveFile: async (sidecar: unknown) => sidecar,
        saveIndex: async () => undefined,
        fileSizes: async () => ({}),
      } as unknown as Repository
      const listed = newFileMeta({ id: 'antes', name: 'Reunião de kickoff', type: 'reading', role: 'entrada', kept: 'arquivo', origin: { ...KICKOFF, storage: 'drive', storedFileId: 'drv-antes' }, created: stamp, updated: stamp })
      const index = defaultIndex()
      index.settings.storageLimitBytes = 10 * 1024 * 1024 * 1024
      signIn.mockClear()
      useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id, reconnectId: null, addGoogleAccount: signIn })
      useLibraryStore.setState({ repo: local, accountId: LOCAL_ACCOUNT.id, files: [listed], folders: [], index })
      keptHere('monitoria.webm', 'som da monitoria')
    })

    it('a mídia só aqui oferece entrar com o Google, sem criar entrada; o que está no Drive não aparece', async () => {
      renderMidias()
      const item = await itemOf('monitoria.webm')
      expect(item).toHaveTextContent(HERE)
      fireEvent.click(within(item).getByRole('button', { name: SAVE }))
      await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1))
      expect(library().files).toHaveLength(1)
      expect(screen.queryByText('kickoff.mp4')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: KEEP })).not.toBeInTheDocument()
    })
  })
})

describe('Mídias: "Baixar a transcrição" só quando há transcrição', () => {
  const TRANSCRIPT = 'Marina: bom dia a todos.'
  const transcriptButton = (item: HTMLElement) => within(item).queryByRole('button', { name: 'Baixar a transcrição' })

  it('a mídia de uma nota com transcrição tem o botão, e ele baixa o texto', async () => {
    const meta = await entrada('Gravação da aula 3', RECORDED)
    await library().updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript: TRANSCRIPT }))
    keptHere('aula3.webm', 'som da aula 3', [meta.id])
    renderMidias()
    const item = await itemOf('aula3.webm')
    fireEvent.click(await within(item).findByRole('button', { name: 'Baixar a transcrição' }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    const [blob, name] = vi.mocked(downloadBlob).mock.calls[0]
    expect(name).toBe('Gravação da aula 3 - transcrição.txt')
    expect(await readBlob(blob)).toBe(TRANSCRIPT)
  })

  it('a mídia de uma nota sem transcrição não tem o botão, mesmo ligada a uma nota', async () => {
    const meta = await entrada('Gravação sem texto', RECORDED)
    keptHere('aula3.webm', 'som da aula 3', [meta.id])
    renderMidias()
    const item = await itemOf('aula3.webm')
    expect(item).toHaveTextContent('Virou: Gravação sem texto')
    // the transcription is read from the library after the dialog opens: give it the time it takes
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(transcriptButton(item)).not.toBeInTheDocument()
  })

  it('a mídia que ainda não virou nota não tem o botão', async () => {
    keptHere('monitoria.webm', 'som da monitoria')
    renderMidias()
    const item = await itemOf('monitoria.webm')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(transcriptButton(item)).not.toBeInTheDocument()
  })

  it('com duas notas, basta uma ter a transcrição', async () => {
    const empty = await entrada('Sem texto', RECORDED)
    const written = await entrada('Com texto', RECORDED)
    await library().updateSidecar(written.id, sidecar => ({ ...sidecar, transcript: TRANSCRIPT }))
    keptHere('aula3.webm', 'som da aula 3', [empty.id, written.id])
    renderMidias()
    const item = await itemOf('aula3.webm')
    expect(await within(item).findByRole('button', { name: 'Baixar a transcrição' })).toBeInTheDocument()
  })
})

// FR-076 / T137: "Detalhes" of a media that is only in this computer also has its "Baixar".
describe('Detalhes: baixar a mídia que só está neste computador', () => {
  const renderDetails = (fileId: string) =>
    render(
      <MemoryRouter>
        <InfoPanel fileId={fileId} />
      </MemoryRouter>,
    )

  it('só neste computador: "Baixar a mídia" entrega o arquivo com o nome do original', async () => {
    const meta = await entrada('Gravação da aula 3', RECORDED)
    keptHere('aula3.webm', 'som da aula 3', [meta.id])
    renderDetails(meta.id)
    fireEvent.click(await screen.findByRole('button', { name: 'Baixar a mídia' }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    const [file, name] = vi.mocked(downloadBlob).mock.calls[0]
    expect(name).toBe('aula3.webm')
    expect(await readBlob(file)).toBe('som da aula 3')
  })

  it('sem o arquivo no navegador, não há o que baixar', async () => {
    const meta = await entrada('Gravação da aula 3', RECORDED)
    renderDetails(meta.id)
    await screen.findByRole('heading', { name: 'Origem' })
    expect(screen.queryByRole('button', { name: /^Baixar/ })).not.toBeInTheDocument()
  })

  it('no Drive, continua "Baixar a fonte", sem repetir o botão', async () => {
    const meta = await inDrive('Reunião de kickoff', KICKOFF, 'video do kickoff')
    keptHere('kickoff.mp4', 'video do kickoff', [meta.id])
    renderDetails(meta.id)
    expect(await screen.findByRole('button', { name: 'Baixar a fonte' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Baixar a mídia' })).not.toBeInTheDocument()
  })
})
