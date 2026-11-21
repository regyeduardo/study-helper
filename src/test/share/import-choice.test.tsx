// Quem recebe o link sempre escolhe o que fazer com a mídia, e sempre sabe por que ela não veio.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { FileSidecar, SharedFile, SharedItem } from '@/types/domain'
import { SharedBadge } from '@/components/library/SharedBadge'
import { defaultIndex } from '@/lib/defaults'
import { importSharedEntry, prefetchEntryMedia } from '@/lib/share'
import type { Repository } from '@/lib/storage/repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const SHARE_ID = 'EscolhaMidiaEscolha01'
const MEDIA_URL = `https://share.test/media/${SHARE_ID}/f1`
const SIZE = 1000
const DAY = 24 * 3600_000

let status: number | 'network'
let sidecars: Map<string, FileSidecar>
let putSource: ReturnType<typeof vi.fn>

function memoryRepository() {
  const contents = new Map<string, string>()
  putSource = vi.fn(async () => ({ ref: 'drive-nova' }))
  sidecars = new Map()
  return {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => sidecars.get(id)!,
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
    putSource,
  } as unknown as Repository
}

function installBrowserFolder() {
  const files = new Map<string, BlobPart[]>()
  const handle = (name: string) => ({
    getFile: async () => ({ text: async () => (files.get(name) ?? []).map(String).join('') }),
    createWritable: async () => {
      const parts: BlobPart[] = []
      return { write: async (data: BlobPart) => void parts.push(data), close: async () => void files.set(name, parts) }
    },
  })
  const folder = { getFileHandle: async (name: string) => handle(name), removeEntry: async (name: string) => void files.delete(name) }
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => folder } })
}

function noteFile(fields: Partial<SharedFile> = {}): SharedFile {
  return {
    id: 'f1',
    name: 'Reunião',
    folderId: null,
    type: 'meeting',
    position: 0,
    description: '',
    tags: [],
    content: '# Ata',
    questions: [],
    highlights: [],
    media: { url: MEDIA_URL, mime: 'video/mp4', size: SIZE },
    meta: { role: 'entrada', kept: 'arquivo', origin: { input: 'file', name: 'Reunião.mp4', mime: 'video/mp4', sizeBytes: SIZE, storage: 'none' } },
    ...fields,
  }
}

function linkOf(file: SharedFile, fields: Partial<SharedItem> = {}): SharedItem {
  return { version: 2, id: SHARE_ID, kind: 'file', title: file.name, createdAt: new Date(Date.now() - 3600_000).toISOString(), expiresAt: new Date(Date.now() + 2 * DAY).toISOString(), mediaExpiresAt: new Date(Date.now() + 2 * DAY).toISOString(), folders: [], files: [file], ...fields }
}

const pending = { mime: 'video/mp4', size: SIZE }
const withoutMedia = (): Partial<SharedFile> => ({ media: undefined })

function renderBadge(item: SharedItem) {
  useLibraryStore.getState().enterShared(item, {})
  render(
    <MemoryRouter initialEntries={[`/shared/${item.id}`]}>
      <Routes>
        <Route path="/shared/:shareId" element={<SharedBadge />} />
        <Route path="*" element={<div>biblioteca</div>} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Importar para a minha biblioteca' }))
}

const toasts = () => useUiStore.getState().toasts.map(toast => toast.text)
const downloaded = () => vi.mocked(fetch).mock.calls.some(([url]) => String(url) === MEDIA_URL)

beforeEach(() => {
  status = 200
  installBrowserFolder()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (String(input) !== MEDIA_URL) return new Response('not found', { status: 404 })
      if (status === 'network') throw new TypeError('Failed to fetch')
      if (status !== 200) return new Response(JSON.stringify({ error: 'x' }), { status })
      return new Response(new Uint8Array(SIZE), { headers: { 'Content-Length': String(SIZE), 'Content-Type': 'video/mp4' } })
    }),
  )
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id, reconnectId: null })
  useLibraryStore.setState({ repo: memoryRepository(), accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ overlay: null, toasts: [] })
})

afterEach(() => {
  useLibraryStore.getState().leaveShared()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  vi.unstubAllGlobals()
})

describe('com a mídia no link, quem recebe sempre escolhe', () => {
  it('sem conta Google também pergunta: "Neste navegador" baixa e guarda, "Só o texto" importa sem baixar nada', async () => {
    renderBadge(linkOf(noteFile()))
    expect(await screen.findByText('Baixar a mídia?')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'No Google Drive' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Neste navegador' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Só o texto' })).toBeInTheDocument()
    expect(downloaded()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Só o texto' }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(downloaded()).toBe(false)
    expect(useLibraryStore.getState().localMedia).toEqual([])
    expect(useLibraryStore.getState().files).toHaveLength(1)
    expect(toasts()).toContain('Importado para a sua biblioteca')
  })

  it('"Neste navegador" sem conta Google guarda a mídia nas mídias do navegador', async () => {
    renderBadge(linkOf(noteFile()))
    fireEvent.click(await screen.findByRole('button', { name: 'Neste navegador' }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    await waitFor(() => expect(useLibraryStore.getState().localMedia).toHaveLength(1))
    expect(putSource).not.toHaveBeenCalled()
  })

  it('com conta Google são três escolhas: No Google Drive, Neste navegador e Só o texto; "Cancelar" não importa nada', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    renderBadge(linkOf(noteFile()))
    expect(await screen.findByText('Onde guardar a mídia?')).toBeInTheDocument()
    for (const name of ['No Google Drive', 'Neste navegador', 'Só o texto', 'Cancelar']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByText('Onde guardar a mídia?')).not.toBeInTheDocument()
    expect(useLibraryStore.getState().sharedView).not.toBeNull()
    expect(sidecars.size).toBe(0)
  })

  it('"Só o texto" de uma entrada fica como "Só o registro": não aponta para um arquivo que não veio', async () => {
    const file = noteFile()
    const item = linkOf(file, { kind: 'entrada' })
    await importSharedEntry(item, {}, { createFolder: useLibraryStore.getState().createFolder, createFile: useLibraryStore.getState().createFile, updateSidecar: useLibraryStore.getState().updateSidecar }, { folderId: null, existing: [] })
    expect(useLibraryStore.getState().files[0]).toMatchObject({ kept: 'registro' })
  })
})

describe('quando a mídia não está no link, o motivo aparece', () => {
  it('ainda subindo: pergunta antes, e "Importar só o texto" importa agora sem a mídia', async () => {
    renderBadge(linkOf(noteFile({ ...withoutMedia(), mediaPending: pending })))
    expect(await screen.findByText('A mídia ainda está subindo')).toBeInTheDocument()
    expect(screen.getByText(/Quem compartilhou ainda está enviando a mídia/)).toBeInTheDocument()
    expect(sidecars.size).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Importar só o texto' }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(downloaded()).toBe(false)
    expect(useLibraryStore.getState().files).toHaveLength(1)
  })

  it('ainda subindo: "Cancelar" deixa o link aberto para esperar', async () => {
    renderBadge(linkOf(noteFile({ ...withoutMedia(), mediaPending: pending })))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }))
    expect(useLibraryStore.getState().sharedView).not.toBeNull()
    expect(sidecars.size).toBe(0)
  })

  it('vencida: importa o texto e diz por que a mídia não veio', async () => {
    renderBadge(linkOf(noteFile(), { mediaExpiresAt: new Date(Date.now() - 1000).toISOString() }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(downloaded()).toBe(false)
    expect(toasts()).toContain('Importado, mas a mídia não veio: A mídia deste compartilhamento expirou (fica 3 dias).')
  })

  it('o link não trouxe mídia nenhuma: importa como antes, sem aviso de mídia', async () => {
    renderBadge(linkOf(noteFile({ ...withoutMedia(), meta: undefined })))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(toasts()).toEqual(['Importado para a sua biblioteca'])
  })
})

describe('a mídia não baixou: o motivo é o que o Worker respondeu', () => {
  const item = () => linkOf(noteFile(), { kind: 'entrada' })

  it('410: expirou; 404: não terminou de subir; sem resposta: a conexão', async () => {
    const reasons: [number | 'network', string][] = [
      [410, 'A mídia deste compartilhamento expirou (fica 3 dias).'],
      [404, 'A mídia ainda não terminou de subir, ou quem compartilhou a apagou.'],
      ['network', 'Sem conexão com o serviço de compartilhamento. Confira a internet e tente de novo.'],
    ]
    for (const [answer, reason] of reasons) {
      status = answer
      const result = await prefetchEntryMedia(item(), () => undefined)
      expect(result.failed?.get('f1')).toBe(reason)
    }
  })

  it('pelo botão: o aviso da importação diz o motivo e a nota vem sem a mídia', async () => {
    status = 410
    renderBadge(linkOf(noteFile()))
    fireEvent.click(await screen.findByRole('button', { name: 'Neste navegador' }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(toasts().some(text => text.includes('A mídia deste compartilhamento expirou (fica 3 dias).'))).toBe(true)
  })
})

describe('a mídia que veio guarda o que ela é', () => {
  it('uma entrada marcada "só registro" por quem compartilhou, mas com a mídia no link, importa como arquivo guardado', async () => {
    const file = noteFile({ meta: { role: 'entrada', kept: 'registro', origin: { input: 'file', name: 'Reunião.mp4', mime: 'video/mp4', sizeBytes: SIZE, storage: 'none' } } })
    const item = linkOf(file, { kind: 'entrada' })
    const media = { place: 'browser' as const, repo: useLibraryStore.getState().repo, track: useJobsStore.getState().trackTask, ...(await prefetchEntryMedia(item, () => undefined)) }
    const result = await importSharedEntry(item, {}, { createFolder: useLibraryStore.getState().createFolder, createFile: useLibraryStore.getState().createFile, updateSidecar: useLibraryStore.getState().updateSidecar }, { folderId: null, existing: [], media })
    expect(result.mediaFailed).toBeUndefined()
    expect(useLibraryStore.getState().files.find(entry => entry.id === result.fileId)).toMatchObject({ kept: 'arquivo' })
    await waitFor(() => expect(useLibraryStore.getState().localMedia).toHaveLength(1))
  })
})
