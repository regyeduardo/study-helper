// Spec 003, história 8 (T147, T148; US8/AC1–AC3, FR-039, FR-040): a busca acha no que está no App, inclusive na transcrição e na Ata de
// uma nota nunca aberta neste aparelho, dizendo onde achou ("na transcrição · mm:ss"). Sem internet, procura no que este aparelho já
// tem e avisa que pode faltar algo; quando a internet volta, lê o que faltou.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, renderHook, screen, waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { RecordingData } from '@/types/domain'
import type { ServerMe } from '@/controllers/api.controller'
import { useSearchHits, useSearchMissed } from '@/hooks/use-library-view'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { PartCache } from '@/lib/storage/part-cache'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { renderAt } from '@/test/library/explorer-fixture'
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

const meeting = (said: string): RecordingData => ({
  blocks: [
    { speaker: 'mic', start: 5, end: 9, text: 'Bom dia a todos.' },
    { speaker: 'mic', start: 754, end: 760, text: said },
  ],
  speakers: [],
  marks: [],
})

/** Notes in the App written on another device: this one has never opened them, nor keeps anything of them. */
async function otherDeviceWrites() {
  const ata = await library().createFile({ name: 'Reunião de terça', type: 'meeting', folderId: null }, 'Ata: decidimos o fornecedor.')
  await library().updateSidecar(ata.id, sidecar => ({ ...sidecar, recording: meeting('O maracatu da festa fica para sexta.') }))
  const aula = await library().createFile({ name: 'Aula 3', type: 'class', folderId: null }, 'Ritmos: o maracatu de baque virado.')
  expect(library().repo instanceof CombinedRepository && (library().repo as CombinedRepository).sideOf(ata.id)).toBe('app')
  await new PartCache(account).forget()
  await library().connect(account, token)
  expect(library().opened).toEqual({})
  return { ata, aula }
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
  useUiStore.setState({ overlay: null, toasts: [], query: '' })
  useUiStore.getState().clearFilters()
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

describe('busca no App', () => {
  it('acha na transcrição de uma nota do App nunca aberta neste aparelho, com o minuto da fala', async () => {
    const { ata, aula } = await otherDeviceWrites()

    const { result } = renderHook(() => useSearchHits('maracatu'))

    await waitFor(() => expect(result.current.size).toBe(2))
    expect(result.current.get(ata.id)).toMatchObject({ where: 'transcricao', at: 754 })
    expect(result.current.get(aula.id)).toMatchObject({ where: 'nota' })
  })

  it('acha no texto da Ata de uma nota do App nunca aberta', async () => {
    const { ata } = await otherDeviceWrites()
    const { result } = renderHook(() => useSearchHits('fornecedor'))
    await waitFor(() => expect(result.current.get(ata.id)).toMatchObject({ where: 'nota' }))
  })

  it('sem internet, acha no que este aparelho já tem e avisa que pode faltar algo; com a internet de volta, acha o resto', async () => {
    const { ata, aula } = await otherDeviceWrites()
    // only the class was opened here before the internet went: its content is in this browser
    await library().openFile(aula.id)
    useLibraryStore.setState({ opened: {} })
    server.offline = true
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    const hits = renderHook(() => ({ hits: useSearchHits('maracatu'), missed: useSearchMissed() }))
    await waitFor(() => expect(hits.result.current.missed).toBe(1))
    expect([...hits.result.current.hits.keys()]).toEqual([aula.id])

    server.offline = false
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(hits.result.current.hits.has(ata.id)).toBe(true))
    expect(hits.result.current.missed).toBe(0)
  })

  it('a linha da busca diz que, sem internet, pode faltar algo', async () => {
    await otherDeviceWrites()
    server.offline = true
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    renderAt('/biblioteca')
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Buscar' }), { target: { value: 'maracatu' } })
    const warning = await screen.findByText('Sem internet: a busca olhou só o que já está neste aparelho, e pode faltar algo.')
    // in the line the screen reader hears
    expect(warning.closest('[role="status"]')).not.toBeNull()
  })
})
