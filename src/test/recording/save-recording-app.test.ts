// 23/11/2026: a gravação salva com "App" vai para o App, a nota e a mídia, mesmo numa pasta de outro lugar; "Google Drive" vai para o Drive
// mesmo numa pasta do App. "Só neste computador" deixa a nota no lugar da pasta.
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
  const server = new FakeAppServer()
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

describe('Salvar a gravação no App', () => {
  // T203 (research R30): what the recording marked goes with it: the index of the screens in the note, the photos and the volume apart
  it('a gravação com telas marcadas guarda o índice na nota e as fotos e o volume à parte (T203)', async () => {
    const screens = {
      index: { width: 1920, height: 1080, area: { x: 0, y: 0, w: 1920, h: 1080 }, madeBy: 'gravacao' as const, screens: [{ at: 1, end: 10, texts: [{ text: 'Pauta', confidence: 0.9 }] }, { at: 10, end: 20 }] },
      images: [
        { at: 1, image: 'data:image/jpeg;base64,VU0=' },
        { at: 10, image: 'data:image/jpeg;base64,RE9JUw==' },
      ],
    }
    const volume = { step: 0.05, microphone: 'AAE=', computer: 'AQA=' }
    const id = await useJobsStore.getState().saveRecording(request({ place: 'app', screens, volume }))
    expect(repo().sideOf(id)).toBe('app')
    await waitFor(async () => expect((await library().openFile(id)).sidecar.recording?.screenIndex).toEqual(screens.index))
    await waitFor(async () => expect(await repo().aside(id, 'telas/001')).toBe(JSON.stringify(screens.images[1])))
    expect(await repo().aside(id, 'telas/000')).toBe(JSON.stringify(screens.images[0]))
    expect(JSON.parse((await repo().aside(id, 'volume'))!)).toEqual(volume)
  })

  it('"App" numa pasta do Google Drive: a nota e a mídia vão para o App', async () => {
    const folder = await library().createFolder({ name: 'Trabalho' })
    const id = await useJobsStore.getState().saveRecording(request({ folderId: folder.id, place: 'app' }))
    expect(repo().sideOf(id)).toBe('app')
    await waitFor(() => expect(originOf(id)?.storedFileId).toMatch(/^app:/))
  })

  it('"Google Drive" numa pasta do App: a nota e a mídia vão para o Drive', async () => {
    const folder = await library().createFolder({ name: 'Faculdade' })
    await usePlacesStore.getState().choosePlace([folder.id], 'app')
    const id = await useJobsStore.getState().saveRecording(request({ folderId: folder.id, place: 'drive' }))
    expect(repo().sideOf(id)).toBe('drive')
    await waitFor(() => expect(originOf(id)?.storedFileId).toBeTruthy())
    expect(originOf(id)?.storedFileId).not.toMatch(/^app:/)
  })

  it('sem lugar escolhido, a nota fica onde a pasta está', async () => {
    const folder = await library().createFolder({ name: 'Faculdade' })
    await usePlacesStore.getState().choosePlace([folder.id], 'app')
    const id = await useJobsStore.getState().saveRecording(request({ folderId: folder.id, storage: 'none' }))
    expect(repo().sideOf(id)).toBe('app')
    expect(library().files.find(file => file.id === id)?.place).toBeUndefined()
  })
})
