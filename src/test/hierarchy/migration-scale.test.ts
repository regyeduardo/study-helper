// Spec 005, SC-003: a migração de uma biblioteca com 1.000 itens termina em até 2 minutos, com a contagem igual.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { migrateHierarchy } from '@/lib/storage/hierarchy-migration'
import { LocalRepository } from '@/lib/storage/local-repository'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

let server: FakeAppServer

beforeEach(() => {
  installMemoryStorage()
  new FakeDrive().install()
  const driveFetch = globalThis.fetch
  server = new FakeAppServer()
  server.appEnabled = false
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith(API) ? server.fetch(input, init) : driveFetch(input, init)))
})

afterEach(() => vi.unstubAllGlobals())

it('1.000 itens (100 pastas em 3 níveis e 900 notas no Drive) em até 2 minutos', async () => {
  const account = uniqueAccount()
  const repo = new CombinedRepository(new DriveRepository(account, async () => 'tok', 'drive'), new LocalRepository(`study-helper-local-${account}`, account))
  const folders = Array.from({ length: 100 }, (_, n) => newFolderMeta({ name: `Pasta ${n + 1}` }))
  folders.forEach((folder, n) => (folder.parentId = n >= 10 ? folders[Math.floor(n / 10) - 1].id : null))
  const files = Array.from({ length: 900 }, (_, n) => newFileMeta({ name: `Nota ${n + 1} — reunião semanal com o fornecedor de logística e transporte`, type: 'class', folderId: folders[n % 100].id }))
  const started = performance.now()
  const count = await migrateHierarchy(repo, { folders, files })
  expect(performance.now() - started).toBeLessThan(120_000)
  expect(count).toEqual({ folders: 100, files: 900 })
  expect([...server.rows.values()].filter(row => !row.removedAt)).toHaveLength(1000)
  expect(server.hierarchyAt).toBeTruthy()
}, 130_000)
