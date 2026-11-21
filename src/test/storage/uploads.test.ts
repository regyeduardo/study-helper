// Entrega 4 (spec 003, FR-019, FR-044): a mídia vai para o App em partes de 10 MiB; se a conexão cai, continua de onde parou, e um
// arquivo pela metade nunca aparece como guardado. Sem espaço, nada é reservado e o app diz quanto falta.
import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { StorageLimitError } from '@/lib/storage/repository'
import { UploadInterrupted, UploadQueue, uploadMedia, type UploadProgress } from '@/lib/storage/uploads'
import { FakeAppServer } from '@/test/storage/fake-app-server'

const MiB = 1024 * 1024
const noWait = async () => {}
let server: FakeAppServer

function note(id: string) {
  server.rows.set(id, { id, itemKind: 'file', meta: {}, parts: {}, media: null, noteBytes: 0, mediaBytes: 0, trashedAt: null, trashedWith: null, removedAt: null, rev: 1, seq: 1 })
}

const file = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'video/webm' })
const partPuts = () => server.calls.filter(call => call.method === 'PUT' && call.path.includes('/v1/uploads/')).map(call => Number(call.path.split('/').pop()))

beforeEach(() => {
  server = new FakeAppServer()
  vi.stubGlobal('fetch', server.fetch)
  note('n1')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('envio da mídia para o App', () => {
  it('manda em partes de 10 MiB, só a última menor, e conclui com o tamanho real', async () => {
    const progress: UploadProgress[] = []
    const done = await uploadMedia({ item: 'n1', media: 'm1', file: file(21 * MiB), name: 'Reunião.webm' }, { onProgress: p => progress.push(p), wait: noWait })
    expect(partPuts()).toEqual([1, 2, 3])
    expect([...server.uploads.values()][0].parts.get(3)?.bytes).toBe(1 * MiB)
    expect(done).toMatchObject({ bytes: 21 * MiB, mime: 'video/webm' })
    expect(progress.at(-1)).toEqual({ state: 'stored', sentBytes: 21 * MiB, totalBytes: 21 * MiB })
    expect(progress.slice(0, -1).every(p => p.state === 'uploading')).toBe(true)
    expect(server.rows.get('n1')?.media?.status).toBe('stored')
    expect(server.reserved).toBe(0)
  })

  it('a conexão cai no meio: para sem dizer que guardou e, na volta, manda só o que faltou', async () => {
    server.dropParts.add(2)
    await expect(uploadMedia({ item: 'n1', media: 'm1', file: file(21 * MiB), name: 'Reunião.webm' }, { retries: 0, wait: noWait })).rejects.toBeInstanceOf(UploadInterrupted)
    expect(server.rows.get('n1')?.media?.status).toBe('uploading')
    server.calls = []
    await uploadMedia({ item: 'n1', media: 'm1', file: file(21 * MiB), name: 'Reunião.webm' }, { wait: noWait })
    expect(partPuts()).toEqual([2, 3])
    expect(server.rows.get('n1')?.media?.status).toBe('stored')
  })

  it('uma parte que falha uma vez é mandada de novo sozinha', async () => {
    server.dropParts.add(1)
    await uploadMedia({ item: 'n1', media: 'm1', file: file(3 * MiB), name: 'audio.webm' }, { wait: noWait })
    // a tentativa que caiu e a que foi de novo
    expect(partPuts()).toEqual([1, 1])
    expect(server.rows.get('n1')?.media?.status).toBe('stored')
  })

  it('sem espaço nos 10 GB: diz quanto falta e não reserva nada', async () => {
    server.limit = 5 * MiB
    const error = await uploadMedia({ item: 'n1', media: 'm1', file: file(8 * MiB), name: 'grande.webm' }, { wait: noWait }).catch(e => e)
    expect(error).toBeInstanceOf(StorageLimitError)
    expect((error as StorageLimitError).missingBytes).toBe(3 * MiB)
    expect(server.reserved).toBe(0)
    expect(partPuts()).toEqual([])
  })

  it('o envio que caiu fica na fila e continua quando a internet volta', async () => {
    const blobs = new Map([['n1/m1', file(12 * MiB)]])
    const queue = new UploadQueue('acc1', async (item, media) => blobs.get(`${item}/${media}`) ?? null, { retries: 0, wait: noWait })
    server.dropParts.add(2)
    await queue.add({ item: 'n1', media: 'm1', name: 'Reunião.webm', mime: 'video/webm', bytes: 12 * MiB })
    expect(queue.pending().map(job => job.item)).toEqual(['n1'])
    expect(server.rows.get('n1')?.media?.status).toBe('uploading')
    // a fila sobrevive a recarregar a página
    const again = new UploadQueue('acc1', async (item, media) => blobs.get(`${item}/${media}`) ?? null, { wait: noWait })
    expect(again.pending().map(job => job.item)).toEqual(['n1'])
    await again.resumeAll()
    expect(again.pending()).toEqual([])
    expect(server.rows.get('n1')?.media?.status).toBe('stored')
  })
})
