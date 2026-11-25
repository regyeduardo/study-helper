// Spec 007, história 2 (FR-027, FR-031, SC-004): a gravação salva no App com a estrutura ligada pede a transcrição e a Ata à conta, sem o
// arquivo na mão, e só depois que a mídia subiu (a janela diz isso e mostra o envio); lá, a Ata roda depois da transcrição da mesma nota.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { waitFor } from '@testing-library/react'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))
vi.mock('@/routes', () => ({ router: { navigate: vi.fn() } }))

import type { ServerMe } from '@/controllers/api.controller'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { type SaveRecordingRequest, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
let server: FakeAppServer
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository
const originOf = (id: string) => library().files.find(file => file.id === id)?.origin

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

const freed: ServerMe = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: true, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
}

function request(patch: Partial<SaveRecordingRequest>): SaveRecordingRequest {
  return { file: new File(['som da reunião'], 'Reunião.webm', { type: 'audio/webm' }), storedName: null, durationSeconds: 5, folderId: null, storage: 'drive', litterboxTime: '72h', marks: [], transcribe: false, ...patch }
}

beforeEach(async () => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  const account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useBlockingStore.setState({ ops: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: freed, status: 'signed-in' })
  await library().connect(account, token)
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('a gravação no App vai para a conta', () => {
  it('a transcrição e a Ata vão para a conta depois do envio, sem o arquivo', async () => {
    expect(library().appOn).toBe(true)
    const shown: string[] = []
    const unsubscribe = useBlockingStore.subscribe(state => state.ops.forEach(op => shown.push(`${op.title} | ${op.phase ?? ''}`)))
    const id = await useJobsStore.getState().saveRecording(request({ place: 'app', transcribe: true, write: { agent: 'meeting', model: null, ataModel: 'ata-executiva' } }))
    await waitFor(() => expect([...server.jobs.values()].map(job => job.call).sort()).toEqual(['generateAta', 'transcribeNote']))
    unsubscribe()
    for (const job of server.jobs.values()) {
      expect(job.fileId).toBe(id)
      // no file goes in the arguments: the account reads the media it already has
      expect(JSON.stringify(job.args)).not.toContain('som da reunião')
    }
    expect(originOf(id)?.storedFileId).toMatch(/^app:/)
    expect(shown.some(line => line.includes('começa na conta depois do envio'))).toBe(true)
  })

  it('sem a estrutura, a gravação transcreve aqui, como antes', async () => {
    useLibraryStore.setState({ appOn: false })
    await useJobsStore.getState().saveRecording(request({ place: 'drive', transcribe: true }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.jobs.size).toBe(0)
  })
})
