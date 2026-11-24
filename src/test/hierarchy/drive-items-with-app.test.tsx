// Pedido do dono em 24/11/2026: com a estrutura do app ligada, o que está salvo no Google Drive precisa funcionar normalmente: abrir a
// nota e a mídia, levar para o App e trazer de volta para o Google Drive.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import type { FileMeta } from '@/types/domain'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { MoveJournal } from '@/lib/storage/moves'
import { downloadStoredSource } from '@/lib/storage/source-storage'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { type BlockingOp, useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository

let account: string
let drive: FakeDrive
let server: FakeAppServer

const google = (id: string): Account => ({ id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'tok', expiresAt: Date.now() + 3600_000 } })

const me = (appEnabled: boolean): ServerMe => ({
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true, hierarchyAt: '2026-11-23T12:00:00Z' },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
})

async function turnOn() {
  server.appEnabled = true
  useServerAccount.setState({ me: me(true) })
  await waitFor(() => expect(library().appOn).toBe(true))
  await waitFor(() => expect(useBlockingStore.getState().ops).toHaveLength(0))
}

const VIDEO = new Blob(['bytes do vídeo da aula'], { type: 'video/mp4' })

/** A media note kept in the Google Drive, with its video in the Drive too, made while the structure was off. */
async function driveMedia(): Promise<FileMeta> {
  const note = await library().createFile({ name: 'Aula gravada', type: 'video', folderId: null, kept: 'arquivo' }, 'transcrição da aula')
  expect(repo().sideOf(note.id)).toBe('drive')
  const stored = await repo().putSource(note.id, VIDEO, 'aula.mp4')
  await library().updateFile(note.id, { origin: { input: 'file', name: 'aula.mp4', mime: 'video/mp4', sizeBytes: VIDEO.size, storage: 'drive', storedFileId: stored.ref } })
  return library().files.find(file => file.id === note.id)!
}

const originOf = (id: string) => library().files.find(file => file.id === id)!.origin!
const text = async (source: Blob | string) =>
  typeof source === 'string'
    ? source
    : new Promise<string>(resolve => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(source)
      })

beforeEach(async () => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  useBlockingStore.setState({ ops: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [], summary: null })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: me(false), status: 'signed-in' })
  await library().connect(account, token)
  expect(repo().hierarchy).toBeTruthy()
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('itens do Google Drive com a estrutura do app ligada', () => {
  it('a nota de mídia do Drive abre, com o texto e a mídia', async () => {
    const note = await driveMedia()
    await turnOn()

    expect(repo().sideOf(note.id)).toBe('drive')
    const opened = await library().openFile(note.id)
    expect(opened.content).toBe('transcrição da aula')
    expect(opened.sidecar.meta.origin).toMatchObject({ storage: 'drive', name: 'aula.mp4' })
    expect(await text(await downloadStoredSource(originOf(note.id), repo()))).toBe('bytes do vídeo da aula')
  })

  it('leva a nota de mídia do Drive para o App, com a mídia, e ela abre do App', async () => {
    const note = await driveMedia()
    await turnOn()
    // the person opens the note first, then moves it
    await library().openFile(note.id)

    await usePlacesStore.getState().choosePlace([note.id], 'app')

    expect(usePlacesStore.getState().failed).toEqual([])
    expect(repo().sideOf(note.id)).toBe('app')
    expect(originOf(note.id).storedFileId).toMatch(/^app:/)
    const opened = await library().openFile(note.id)
    expect(opened.content).toBe('transcrição da aula')
    expect(await text(await downloadStoredSource(originOf(note.id), repo()))).toBe('bytes do vídeo da aula')
  })

  it('traz de volta do App para o Google Drive, com a mídia, e ela abre do Drive', async () => {
    const note = await driveMedia()
    await turnOn()
    await library().openFile(note.id)
    await usePlacesStore.getState().choosePlace([note.id], 'app')
    expect(repo().sideOf(note.id)).toBe('app')
    await library().openFile(note.id)

    await usePlacesStore.getState().choosePlace([note.id], 'drive')

    expect(usePlacesStore.getState().failed).toEqual([])
    expect(repo().sideOf(note.id)).toBe('drive')
    expect(originOf(note.id).storedFileId).not.toMatch(/^app:/)
    const opened = await library().openFile(note.id)
    expect(opened.content).toBe('transcrição da aula')
    expect(await text(await downloadStoredSource(originOf(note.id), repo()))).toBe('bytes do vídeo da aula')
    // and after opening the app again
    const loaded = await repo().load()
    expect(loaded.files.filter(file => file.id === note.id)).toHaveLength(1)
    expect(repo().sideOf(note.id)).toBe('drive')
    expect(await repo().readContent(note.id)).toBe('transcrição da aula')
  })

  it('uma nota de texto do Drive vai para o App e volta, e abre nas duas pontas', async () => {
    const folder = await library().createFolder({ name: 'Faculdade' })
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: folder.id }, 'texto da aula 1')
    await turnOn()

    await usePlacesStore.getState().choosePlace([aula.id], 'app')
    expect(usePlacesStore.getState().failed).toEqual([])
    expect((await library().openFile(aula.id)).content).toBe('texto da aula 1')

    await usePlacesStore.getState().choosePlace([aula.id], 'drive')
    expect(usePlacesStore.getState().failed).toEqual([])
    expect(repo().sideOf(aula.id)).toBe('drive')
    expect((await library().openFile(aula.id)).content).toBe('texto da aula 1')
    expect(library().files.find(file => file.id === aula.id)).toMatchObject({ folderId: folder.id, name: 'Aula 1' })
  })

  it('ao levar a mídia, a janela mostra quanto já baixou e quanto já subiu, sem ficar parada em 0%', async () => {
    const note = await driveMedia()
    await turnOn()
    server.partSize = 8
    const seen: BlockingOp[] = []
    const stop = useBlockingStore.subscribe(state => seen.push(...state.ops))

    await usePlacesStore.getState().choosePlace([note.id], 'app')
    stop()

    expect(usePlacesStore.getState().failed).toEqual([])
    const down = seen.filter(op => op.phase === 'Baixando a mídia do Google Drive')
    const up = seen.filter(op => op.phase === 'Enviando a mídia para o App')
    expect(down.at(-1)).toMatchObject({ doneBytes: VIDEO.size, totalBytes: VIDEO.size, current: 'Aula gravada' })
    // the bar moves part by part, not only at the end
    expect(up.some(op => op.doneBytes! > 0 && op.doneBytes! < VIDEO.size)).toBe(true)
    expect(up.at(-1)).toMatchObject({ doneBytes: VIDEO.size, totalBytes: VIDEO.size })
    // the bar and the line speak of the media only: no count of notes beside its bytes
    expect([...down, ...up].every(op => op.total === undefined && op.done === undefined)).toBe(true)
  })

  it('Cancelar no meio da mídia para na hora: nada mais sobe, e a nota fica inteira no Google Drive, sem erro', async () => {
    const note = await driveMedia()
    await turnOn()
    server.partSize = 8
    const stop = useBlockingStore.subscribe(state => {
      const op = state.ops.find(item => item.phase === 'Enviando a mídia para o App' && item.doneBytes! > 0)
      if (op && !op.cancelling) state.cancel(op.id)
    })

    await usePlacesStore.getState().choosePlace([note.id], 'app')
    stop()

    const upload = [...server.uploads.values()][0]
    expect(upload.parts.size).toBeLessThan(Math.ceil(VIDEO.size / 8))
    expect(usePlacesStore.getState().failed).toEqual([])
    expect(await new MoveJournal(account).all()).toEqual([])
    expect(repo().sideOf(note.id)).toBe('drive')
    expect(originOf(note.id).storedFileId).not.toMatch(/^app:/)
    expect((await library().openFile(note.id)).content).toBe('transcrição da aula')
    expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('Parou: nada mudou de lugar.')
  })

  it('com a hierarquia na conta, mudanças antigas de pasta não aparecem como erro: pasta não tem lugar', async () => {
    const folder = await library().createFolder({ name: 'VP6' })
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: folder.id }, 'texto')
    await turnOn()
    // what a move of before the hierarchy left in this browser's journal
    const journal = new MoveJournal(account)
    await journal.put({ id: folder.id, kind: 'folder', name: 'VP6', from: 'drive', to: 'app', state: 'falhou', reason: 'A pasta ainda tem itens no Google Drive; nada foi apagado.', batch: 'antes', order: 0, bytes: 0 })
    await journal.put({ id: 'pasta-antiga', kind: 'folder', name: '2026-23-11', from: 'drive', to: 'app', state: 'conferido', batch: 'antes', order: 1, bytes: 0 })

    await usePlacesStore.getState().choosePlace([aula.id], 'app')

    expect(usePlacesStore.getState().failed).toEqual([])
    expect(await journal.all()).toEqual([])
    expect(repo().sideOf(aula.id)).toBe('app')
  })
})
