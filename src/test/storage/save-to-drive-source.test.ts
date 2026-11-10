import { createElement as h } from 'react'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// jsdom has no browser folder: the copy in Mídias is a tiny file.
vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  listLocalMedia: vi.fn(),
  readLocalMedia: vi.fn(),
  removeLocalMedia: vi.fn(),
}))

import { MediaDialog } from '@/components/dialogs/MediaDialog'
import { SaveToDrive } from '@/components/library/SaveToDrive'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { listLocalMedia, type LocalMedia, readLocalMedia, removeLocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import { saveToDrive } from '@/lib/storage/source-storage'
import { type Account, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileMeta, FileSidecar, SourceMeta } from '@/types/domain'

// FR-043: the real "Salvar no meu Drive": from Mídias to the Drive, and the item keeps the address.

const stamp = { at: '2026-11-07T10:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }

const RECORDED: SourceMeta = { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 2910, sizeBytes: 4, storage: 'none' }
const MEDIA: LocalMedia = { storedName: 'grav-1', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 2910, size: 4, createdAt: stamp.at, fileIds: ['aula3'] }
const BLOB = new File(['oi!!'], 'aula3.webm', { type: 'audio/webm' })

const stored = (fields: Partial<SourceMeta> = {}): FileMeta => newFileMeta({ id: 'aula3', name: 'Gravação da aula 3.webm', type: 'reading', folderId: null, role: 'entrada', kept: 'arquivo', origin: { ...RECORDED, ...fields }, created: stamp, updated: stamp })

let repo: Repository & { putSource: Mock<Repository['putSource']>; removeSource: Mock<Repository['removeSource']>; saveFile: Mock<Repository['saveFile']> }

function open(file: FileMeta, kind: Repository['kind'] = 'drive', localMedia: LocalMedia[] = [MEDIA]) {
  const sidecars = new Map([[file.id, newSidecar(file)]])
  repo = {
    kind,
    accountId: 'g-1',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: vi.fn(async (sidecar: FileSidecar) => {
      sidecars.set(sidecar.meta.id, sidecar)
      return sidecar
    }),
    fileSizes: async () => ({}),
    putSource: vi.fn(async (fileId: string) => ({ ref: `drv-${fileId}` })),
    removeSource: vi.fn(async () => undefined),
  } as unknown as typeof repo
  useLibraryStore.setState({ repo, accountId: 'g-1', ready: true, files: [file], opened: {}, localMedia, sharedView: null, sizes: {} })
  vi.mocked(readLocalMedia).mockReset().mockResolvedValue(BLOB)
  vi.mocked(removeLocalMedia).mockReset()
}

const saved = () => useLibraryStore.getState().files[0]

describe('saveToDrive', () => {
  beforeEach(() => open(stored()))

  it('sobe a mídia deste navegador e guarda o endereço, sem mexer no resto da origem', async () => {
    await saveToDrive('aula3')
    expect(readLocalMedia).toHaveBeenCalledWith(MEDIA)
    expect(repo.putSource).toHaveBeenCalledWith('aula3', BLOB, 'aula3.webm')
    expect(saved().origin).toEqual({ ...RECORDED, storage: 'drive', storedFileId: 'drv-aula3', expiresAt: null })
  })

  it('a cópia em Mídias fica', async () => {
    await saveToDrive('aula3')
    expect(removeLocalMedia).not.toHaveBeenCalled()
    expect(useLibraryStore.getState().localMedia).toEqual([MEDIA])
  })

  it('volta a contar como guardada quando a mídia tinha sido apagada do Drive', async () => {
    open(stored({ removedAt: '2026-11-01T00:00:00.000Z' }))
    await saveToDrive('aula3')
    expect(saved().origin?.removedAt).toBeUndefined()
  })

  it('sem a mídia neste navegador não há o que subir', async () => {
    open(stored(), 'drive', [])
    await expect(saveToDrive('aula3')).rejects.toThrow('O arquivo não está mais neste navegador.')
    expect(repo.putSource).not.toHaveBeenCalled()
  })

  it('se o arquivo sumiu do navegador, diz isso em português', async () => {
    vi.mocked(readLocalMedia).mockRejectedValueOnce(new DOMException('A requested file or directory could not be found', 'NotFoundError'))
    await expect(saveToDrive('aula3')).rejects.toThrow('O arquivo não está mais neste navegador.')
    expect(repo.putSource).not.toHaveBeenCalled()
  })

  it('no perfil Local não finge que foi para o Drive', async () => {
    open(stored(), 'local')
    await expect(saveToDrive('aula3')).rejects.toThrow('Entre com o Google para guardar no Drive.')
    expect(repo.putSource).not.toHaveBeenCalled()
    expect(saved().origin).toEqual(RECORDED)
  })

  it('se o envio falhar, o item continua como estava', async () => {
    repo.putSource.mockRejectedValueOnce(new Error('Sem espaço no Drive.'))
    await expect(saveToDrive('aula3')).rejects.toThrow('Sem espaço no Drive.')
    expect(saved().origin).toEqual(RECORDED)
  })

  it('se não der para guardar o endereço, tira do Drive o que subiu: não sobra arquivo perdido', async () => {
    repo.saveFile.mockRejectedValueOnce(new Error('Sem rede.'))
    await expect(saveToDrive('aula3')).rejects.toThrow('Sem rede.')
    expect(repo.removeSource).toHaveBeenCalledWith('drv-aula3')
    expect(saved().origin).toEqual(RECORDED)
  })
})

// What the screens do around the action, beyond the texts pinned in src/test/library/save-to-drive.test.tsx.
describe('SaveToDrive', () => {
  const NOTICE = 'Só neste navegador'
  const GOOGLE: Account = { id: 'g-1', kind: 'google', name: 'Marina', email: 'm@exemplo.com', picture: '' }
  const action = () => screen.getByRole('button', { name: /Salvar no meu Drive/ })
  const asked = () => screen.getByRole('dialog', { name: /^Salvar no meu Drive/ })
  const show = (compact = false) => render(h(SaveToDrive, { fileId: 'aula3', compact }))
  const toasts = () => useUiStore.getState().toasts.map(toast => toast.text)

  beforeEach(() => {
    open(stored())
    useUiStore.setState({ overlay: null, toasts: [] })
  })

  it('no perfil Local a linha fica limpa, e a nota avisa', () => {
    open(stored(), 'local')
    expect(show(true).container).toBeEmptyDOMElement()
    show()
    expect(screen.getByText(NOTICE)).toBeInTheDocument()
    expect(action()).toBeInTheDocument()
  })

  it.each([false, true])('guardado em outro navegador, sem nada para subir: só avisa (compacto: %s)', compact => {
    open(stored(), 'drive', [])
    show(compact)
    expect(screen.getByText(NOTICE)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('no que foi compartilhado comigo não aparece', () => {
    useLibraryStore.setState({ sharedView: { item: {}, rootId: null } as never })
    expect(show().container).toBeEmptyDOMElement()
  })

  it('clicar na ação, teclar nela e clicar na janela não abre a linha de trás', () => {
    const row = vi.fn()
    render(h('div', { onClick: row, onKeyDown: row }, h(SaveToDrive, { fileId: 'aula3', compact: true })))
    fireEvent.keyDown(action(), { key: 'Enter' })
    fireEvent.click(action())
    fireEvent.click(within(asked()).getByRole('button', { name: 'Agora não' }))
    expect(row).not.toHaveBeenCalled()
  })

  it('Esc fecha só esta janela, não Mídias embaixo', () => {
    const below = vi.fn()
    window.addEventListener('keydown', below)
    show()
    fireEvent.click(action())
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', below)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(below).not.toHaveBeenCalled()
  })

  it('o mesmo arquivo na lista e na nota sobe uma vez só', async () => {
    let finish: (stored: { ref: string }) => void = () => undefined
    repo.putSource.mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
    render(h('div', null, h(SaveToDrive, { fileId: 'aula3' }), h(SaveToDrive, { fileId: 'aula3', compact: true })))
    fireEvent.click(screen.getAllByRole('button', { name: /Salvar no meu Drive/ })[0])
    fireEvent.click(within(asked()).getByRole('button', { name: 'Salvar no meu Drive' }))
    await waitFor(() => expect(repo.putSource).toHaveBeenCalledTimes(1))
    const busy = screen.getAllByRole('button', { name: /Salvando no Drive/ })
    expect(busy).toHaveLength(2)
    for (const control of busy) expect(control).toBeDisabled()
    finish({ ref: 'drv-aula3' })
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument())
    expect(toasts()).toEqual(['Salvo no seu Drive. Agora ele está disponível em qualquer aparelho.'])
  })

  it('sem conta, entra com o Google e oferece enviar o que estava aqui, como o menu da conta', async () => {
    open(stored(), 'local')
    useAccountStore.setState({ addGoogleAccount: vi.fn(async () => GOOGLE) })
    show()
    fireEvent.click(action())
    await waitFor(() => expect(useUiStore.getState().overlay).toEqual({ kind: 'send-local' }))
    expect(repo.putSource).not.toHaveBeenCalled()
  })

  it('se o login falhar, diz o motivo e o botão volta', async () => {
    open(stored(), 'local')
    useAccountStore.setState({
      addGoogleAccount: vi.fn(async () => {
        throw new Error('A janela do Google foi fechada.')
      }),
    })
    show()
    fireEvent.click(action())
    await waitFor(() => expect(toasts()).toEqual(['A janela do Google foi fechada.']))
    expect(action()).toBeEnabled()
    expect(useUiStore.getState().overlay).toBeNull()
  })

  const mediaItem = async (media: LocalMedia) => {
    vi.mocked(listLocalMedia).mockResolvedValue([media])
    render(h(MemoryRouter, null, h(MediaDialog)))
    return (await screen.findByText(media.name)).closest('li') as HTMLElement
  }

  it('em Mídias, o que ainda não virou nota continua como era', async () => {
    const item = await mediaItem({ ...MEDIA, fileIds: [] })
    expect(item).toHaveTextContent('Ainda não virou nota.')
    expect(item).not.toHaveTextContent(NOTICE)
    expect(within(item).queryByRole('button', { name: /Salvar no meu Drive/ })).not.toBeInTheDocument()
  })

  it('em Mídias, a gravação de vários itens oferece salvar o que ainda falta', async () => {
    const inDrive = newFileMeta({ id: 'antes', name: 'Primeira', type: 'reading', folderId: null, role: 'entrada', kept: 'arquivo', origin: { ...RECORDED, storage: 'drive', storedFileId: 'drv-antes' }, created: stamp, updated: stamp })
    const shared = { ...MEDIA, fileIds: ['antes', 'aula3'] }
    open(stored(), 'drive', [shared])
    useLibraryStore.setState(state => ({ files: [inDrive, ...state.files] }))
    const item = await mediaItem(shared)
    fireEvent.click(within(item).getByRole('button', { name: /Salvar no meu Drive/ }))
    fireEvent.click(within(asked()).getByRole('button', { name: 'Salvar no meu Drive' }))
    await waitFor(() => expect(repo.putSource).toHaveBeenCalledWith('aula3', BLOB, 'aula3.webm'))
  })
})
