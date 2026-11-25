// Spec 007, T029 e T031 (research R4): abrir uma nota do App pede de uma vez, num pedido só, as partes que o aparelho ainda não tem
// (antes era uma ida e volta por parte, uma depois da outra); guardar manda em paralelo as partes que mudaram. O conteúdo é o mesmo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import type { FileSidecar } from '@/types/domain'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { AppRepository } from '@/lib/storage/app-repository'
import { API, FakeAppServer } from '@/test/storage/fake-app-server'
import { installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

let server: FakeAppServer
let account: string

function bigNote(): FileSidecar {
  const meta = newFileMeta({ name: 'Reunião com tudo', type: 'audio', folderId: null })
  const sidecar = newSidecar(meta)
  return {
    ...sidecar,
    recording: { blocks: [{ speaker: 'Ana', start: 0, end: 6, text: 'a reunião começou' }], speakers: [{ id: 's1', name: 'Ana', suggested: false }], marks: [] },
    transcript: 'Ana: a reunião começou',
    highlights: [{ id: 'h1', quote: 'reunião', color: 'amarelo', createdAt: '2026-11-24T00:00:00Z' } as never],
    artifacts: [
      { id: 'a1', kind: 'mapa', name: 'Mapa', createdAt: '2026-11-24T00:00:00Z' } as never,
      { id: 'a2', kind: 'cartoes', name: 'Cartões', createdAt: '2026-11-24T00:00:00Z' } as never,
    ],
  }
}

beforeEach(() => {
  installMemoryStorage()
  server = new FakeAppServer()
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => server.fetch(input, init))
  account = uniqueAccount()
})
afterEach(() => vi.unstubAllGlobals())

const partCalls = () => server.calls.filter(call => /\/parts(\/|$)|\/parts\/batch/.test(call.path))

describe('abrir uma nota', () => {
  it('as partes que faltam vêm num pedido só, com o mesmo conteúdo', async () => {
    const writer = new AppRepository(account)
    await writer.load()
    const sidecar = bigNote()
    await writer.saveFile(sidecar, '# Texto da nota')
    // outro aparelho, sem nada guardado
    const reader = new AppRepository(uniqueAccount())
    await reader.load()
    server.calls.length = 0
    const read = await reader.readSidecar(sidecar.meta.id)
    const gets = partCalls()
    expect(gets.filter(call => call.method === 'GET')).toHaveLength(0)
    expect(gets.filter(call => call.method === 'POST' && call.path.endsWith('/parts/batch'))).toHaveLength(1)
    expect(read.transcript).toBe(sidecar.transcript)
    expect(read.recording?.blocks).toEqual(sidecar.recording?.blocks)
    expect(read.artifacts?.map(item => item.id)).toEqual(['a1', 'a2'])
    expect(await reader.readContent(sidecar.meta.id)).toBe('# Texto da nota')
  })

  it('com tudo no aparelho, nenhum pedido de parte', async () => {
    const repo = new AppRepository(account)
    await repo.load()
    const sidecar = bigNote()
    await repo.saveFile(sidecar, '# Texto')
    server.calls.length = 0
    await repo.readSidecar(sidecar.meta.id)
    expect(partCalls()).toHaveLength(0)
  })
})

describe('guardar uma nota', () => {
  it('as partes que mudaram vão ao mesmo tempo, e o servidor fica igual', async () => {
    const repo = new AppRepository(account)
    await repo.load()
    const sidecar = bigNote()
    let inFlight = 0
    let most = 0
    const fetchOne = server.fetch.bind(server)
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const put = init?.method === 'PUT' && /\/parts\//.test(String(input))
      if (put) {
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      try {
        return await fetchOne(input, init)
      } finally {
        if (put) inFlight--
      }
    })
    await repo.saveFile(sidecar, '# Texto')
    expect(most).toBeGreaterThan(1)
    const row = server.rows.get(sidecar.meta.id)!
    expect(Object.keys(row.parts).sort()).toEqual(['artifacts/a1', 'artifacts/a2', 'highlights', 'text', 'transcript'])
    expect(server.currentPart(sidecar.meta.id, 'text')?.content).toBe('# Texto')
  })
})

void API
