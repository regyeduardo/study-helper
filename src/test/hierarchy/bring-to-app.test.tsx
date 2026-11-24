// Spec 003, história 5 pelos Locais (escolha A do dono em 24/11): levar a biblioteca para o App grava uma cópia antes e não apaga a
// original (FR-041); ao terminar, diz o que veio (notas, artefatos, mídias) e o que não veio, com o motivo; a mídia vencida num serviço
// temporário chega como "Só o registro", com o aviso (FR-043).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { ServerMe } from '@/controllers/api.controller'
import { PlacesPanel } from '@/components/dialogs/PlacesPanel'
import { newCardsArtifact } from '@/lib/artifacts'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { MoveJournal, OriginalCopies, planMoves, runMoves } from '@/lib/storage/moves'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, FOLDER, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()
const repo = () => library().repo as CombinedRepository

let account: string
let drive: FakeDrive
let server: FakeAppServer

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

/** An account freed by a code whose hierarchy already went to the account (spec 005): the Locais of today. */
const freed: ServerMe = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', photoUrl: null, status: 'enabled', appEnabled: true, admin: false, deleteAt: null, hasPassword: false, hasGoogle: true, hierarchyAt: '2026-11-23T12:00:00Z' },
  requireCode: true,
  device: { id: 'd1', name: 'Chrome no Linux' },
  space: { notes: 0, media: 0, reserved: 0, limit: 10 * 1024 ** 3, warnAt: 0.9 },
}

/** The Drive's own files of notes (not folders): what a move would delete. */
const driveNoteFiles = () => [...drive.files.values()].filter(file => file.mimeType !== FOLDER).map(file => file.id).sort()

beforeEach(async () => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.hierarchyAt = '2026-11-23T12:00:00Z'
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(mockEnv.apiUrl) ? server.fetch(input, init) : driveFetch(input, init)))
  vi.stubGlobal('WebSocket', class { send() {} close() {} })
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  useBlockingStore.setState({ ops: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [], summary: null })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
  useServerAccount.setState({ me: freed, status: 'signed-in' })
  await library().connect(account, token)
  expect(repo().hierarchy).toBeTruthy()
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
  useServerAccount.setState({ me: null, status: 'unknown' })
})

describe('levar a biblioteca para o App', () => {
  it('a original continua no Google Drive: nada do Drive é apagado, e a nota abre do App', async () => {
    const folder = await library().createFolder({ name: 'Faculdade' })
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: folder.id, place: 'drive' }, 'texto da aula 1')
    expect(repo().sideOf(aula.id)).toBe('drive')
    const before = driveNoteFiles()
    expect(before.length).toBeGreaterThan(0)

    await usePlacesStore.getState().choosePlace([aula.id], 'app')

    expect(usePlacesStore.getState().failed).toEqual([])
    expect(repo().sideOf(aula.id)).toBe('app')
    expect(await repo().readContent(aula.id)).toBe('texto da aula 1')
    // FR-041: the original is not deleted
    expect(driveNoteFiles()).toEqual(before)
    // and the note shows once, in the App
    expect(library().files.filter(file => file.id === aula.id)).toHaveLength(1)
    expect((await repo().load()).files.filter(file => file.id === aula.id)).toHaveLength(1)
  })

  it('de Local para o App, a original fica guardada numa cópia neste navegador e não volta como nota Local', async () => {
    const nota = await library().createFile({ name: 'Rascunho', type: 'class', folderId: null, place: 'local' }, 'só aqui')
    expect(repo().sideOf(nota.id)).toBe('local')

    await usePlacesStore.getState().choosePlace([nota.id], 'app')

    expect(repo().sideOf(nota.id)).toBe('app')
    const copies = await new OriginalCopies(account).all()
    expect(copies.map(copy => ({ id: copy.id, from: copy.from, content: copy.content }))).toEqual([{ id: nota.id, from: 'local', content: 'só aqui' }])
    const loaded = await repo().load()
    expect(loaded.files.filter(file => file.id === nota.id)).toHaveLength(1)
    expect(repo().sideOf(nota.id)).toBe('app')
  })

  it('ao terminar, diz quantas notas, artefatos e mídias vieram, e avisa a mídia vencida que chegou como "Só o registro"', async () => {
    const aula = await library().createFile({ name: 'Aula 1', type: 'class', folderId: null, place: 'drive' }, 'texto')
    await library().updateSidecar(aula.id, sidecar => ({ ...sidecar, artifacts: [newCardsArtifact({ name: 'Cartões', cards: [] }), newCardsArtifact({ name: 'Revisão', cards: [] })] }))
    const video = await library().createFile(
      {
        name: 'Gravação antiga',
        type: 'class',
        folderId: null,
        place: 'drive',
        kept: 'arquivo',
        origin: { input: 'file', name: 'aula.mp4', storage: 'litterbox', storedUrl: 'https://litter.example/aula.mp4', expiresAt: '2026-10-01T00:00:00.000Z' },
      },
      'transcrição',
    )

    await usePlacesStore.getState().choosePlace([aula.id, video.id], 'app')

    const summary = usePlacesStore.getState().summary
    expect(summary).toEqual({ to: 'app', notes: 2, artifacts: 2, media: 0, expired: 1, kept: 'drive' })
    render(<MemoryRouter><PlacesPanel /></MemoryRouter>)
    const done = await screen.findByRole('status', { name: 'O que veio para o App' })
    expect(done).toHaveTextContent('2 notas e 2 artefatos vieram para o App.')
    expect(done).toHaveTextContent('A original continua no Google Drive.')
    expect(done).toHaveTextContent('1 mídia tinha vencido no serviço temporário e chegou como “Só o registro”.')
    // and it is "Só o registro" in the App too, not "Registro e arquivo" pointing at a file that is gone
    expect((await repo().readSidecar(video.id)).meta.kept).toBe('registro')
  })

  it('fechada a aba no meio, abrir de novo continua de onde parou sem duplicar nada', async () => {
    const a = await library().createFile({ name: 'A', type: 'class', folderId: null, place: 'drive' }, 'texto a')
    const b = await library().createFile({ name: 'B', type: 'class', folderId: null, place: 'drive' }, 'texto b')
    const before = driveNoteFiles()
    const journal = new MoveJournal(account)
    for (const record of planMoves(repo(), library(), [a.id, b.id], 'app', 'lote', () => 0)) await journal.put(record)
    // the tab closes right after A arrived and was checked, before it was taken as done
    await runMoves(repo(), journal, library(), { copies: new OriginalCopies(account), stopAfter: record => record.id === a.id && record.state === 'conferido' })

    await usePlacesStore.getState().resume()

    expect(await journal.all()).toEqual([])
    expect([repo().sideOf(a.id), repo().sideOf(b.id)]).toEqual(['app', 'app'])
    expect(library().files.filter(file => file.id === a.id || file.id === b.id)).toHaveLength(2)
    expect(await repo().readContent(a.id)).toBe('texto a')
    expect(driveNoteFiles()).toEqual(before)
  })

  it('o que não veio aparece com o motivo, e o resumo conta só o que veio', async () => {
    const boa = await library().createFile({ name: 'Boa', type: 'class', folderId: null, place: 'drive' }, 'ok')
    const ruim = await library().createFile({ name: 'Ruim', type: 'class', folderId: null, place: 'drive' }, 'falha')
    server.failPutFor = ruim.id

    await usePlacesStore.getState().choosePlace([boa.id, ruim.id], 'app')

    expect(usePlacesStore.getState().failed.map(record => record.name)).toEqual(['Ruim'])
    expect(usePlacesStore.getState().summary).toMatchObject({ notes: 1 })
    await waitFor(() => expect(repo().sideOf(boa.id)).toBe('app'))
    expect(repo().sideOf(ruim.id)).toBe('drive')
  })
})
