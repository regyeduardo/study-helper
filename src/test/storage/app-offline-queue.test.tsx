// Spec 003, história 6 (T144, US6/AC3, AC5): sem internet, escrever, marcar trechos, mexer nos cartões ou na Prova de uma nota do App
// continua funcionando: a mudança fica guardada neste navegador, a linha do pé da lateral diz que espera (escolha C de 23/11), e quando a
// internet volta tudo sobe sozinho e aparece nos outros aparelhos. Recarregar sem internet não perde nada.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen, waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { Highlight } from '@/types/domain'
import type { ServerMe } from '@/controllers/api.controller'
import { SyncPill } from '@/components/layout/Chrome'
import { PartCache } from '@/lib/storage/part-cache'
import { useUiStore } from '@/stores/ui'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useSyncStore } from '@/stores/sync'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()

let account: string
let server: FakeAppServer

const google = (id: string): Account => ({ id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } })

const freed: ServerMe = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: true, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true, hierarchyAt: '2026-11-23T12:00:00Z' },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
}

const highlight: Highlight = { id: 'h1', kind: 'highlight', quote: 'texto', text: '', color: 'yellow', startOffset: 0, endOffset: 5, createdAt: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:00:00.000Z' }

/** The text the server keeps of a note, at its current version. */
const serverText = (id: string) => {
  const row = server.rows.get(id)
  const version = row?.parts.text
  return version ? server.partStore.get(`${id}/text`)?.find(entry => entry.version === version)?.content : undefined
}

function goOffline(off: boolean) {
  server.offline = off
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(!off)
  if (!off) window.dispatchEvent(new Event('online'))
}

beforeEach(async () => {
  installMemoryStorage()
  const drive = new FakeDrive().install()
  void drive
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useSyncStore.setState({ busy: false, conflicts: [], error: null, lastSyncAt: Date.now() })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: freed, status: 'signed-in' })
  await library().connect(account, token)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('fila sem internet do conteúdo do App', () => {
  it('sem internet, escrever e marcar um trecho funciona; a linha diz que espera; recarregar sem internet não perde nada', async () => {
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: null }, 'antes')
    render(<SyncPill />)
    goOffline(true)

    await library().saveContent(aula.id, 'texto escrito sem internet')
    await library().updateSidecar(aula.id, sidecar => ({ ...sidecar, highlights: [highlight] }))

    expect(await screen.findByText('1 mudança esperando conexão')).toBeInTheDocument()
    expect(serverText(aula.id)).toBe('antes')

    // the tab reloads, still without internet
    await library().connect(account, token)
    expect(library().files.map(file => file.name)).toContain('Aula 1')
    expect(await library().repo!.readContent(aula.id)).toBe('texto escrito sem internet')
    expect((await library().repo!.readSidecar(aula.id)).highlights).toEqual([highlight])
  })

  it('quando a internet volta, sobe sozinho e aparece no outro aparelho', async () => {
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: null }, 'antes')
    render(<SyncPill />)
    goOffline(true)
    await library().saveContent(aula.id, 'texto escrito sem internet')
    await library().updateSidecar(aula.id, sidecar => ({ ...sidecar, highlights: [highlight] }))

    goOffline(false)

    await waitFor(() => expect(serverText(aula.id)).toBe('texto escrito sem internet'))
    await waitFor(() => expect(screen.getByText(/^Tudo na conta/)).toBeInTheDocument())
    // another device: nothing of this note in its cache
    await new PartCache(account).forget()
    await library().connect(account, token)
    expect(await library().repo!.readContent(aula.id)).toBe('texto escrito sem internet')
    expect((await library().repo!.readSidecar(aula.id)).highlights).toEqual([highlight])
  })

  it('uma nota nova no App, criada sem internet, aparece na biblioteca e sobe quando a internet volta', async () => {
    goOffline(true)
    const nova = await library().createFile({ name: 'Ideias do ônibus', type: 'class', folderId: null }, 'escrito no caminho')
    expect(library().files.map(file => file.name)).toContain('Ideias do ônibus')
    expect(server.rows.has(nova.id)).toBe(false)

    goOffline(false)

    await waitFor(() => expect(serverText(nova.id)).toBe('escrito no caminho'))
    expect(server.rows.get(nova.id)).toMatchObject({ name: 'Ideias do ônibus', place: 'app' })
  })

  it('recusada de vez pelo servidor (a nota foi apagada em outro aparelho), sai da fila, fica numa cópia neste navegador e avisa', async () => {
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: null }, 'antes')
    goOffline(true)
    await library().saveContent(aula.id, 'texto escrito sem internet')
    useUiStore.setState({ toasts: [] })
    server.failPutFor = aula.id
    server.failWith = { status: 404, error: 'not_found' }

    goOffline(false)

    await waitFor(() => expect(useUiStore.getState().toasts.map(toast => toast.text)).toContain('“Aula 1” não subiu: a nota foi apagada em outro aparelho. O que você escreveu sem internet ficou guardado numa cópia neste navegador.'))
    expect((await new PartCache(account).refused()).map(note => ({ id: note.id, content: note.content }))).toEqual([{ id: aula.id, content: 'texto escrito sem internet' }])
    expect(await new PartCache(account).held()).toEqual([])
    // it is not tried again
    const writes = () => server.calls.filter(call => call.method === 'PUT' && call.path.includes(`${aula.id}/parts/`)).length
    const before = writes()
    await useSyncStore.getState().syncNow()
    expect(writes()).toBe(before)
  })

  it('um erro passageiro do servidor (5xx) mantém a mudança na fila para a próxima vez', async () => {
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: null }, 'antes')
    goOffline(true)
    await library().saveContent(aula.id, 'texto escrito sem internet')
    server.failPutFor = aula.id

    goOffline(false)
    await useSyncStore.getState().syncNow()
    expect((await new PartCache(account).held()).map(note => note.id)).toEqual([aula.id])

    server.failPutFor = null
    await useSyncStore.getState().syncNow()
    await waitFor(() => expect(serverText(aula.id)).toBe('texto escrito sem internet'))
  })
})
