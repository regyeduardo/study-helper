// Spec 007, história 1 (T044, H10, research R8): o Google Drive pede só os campos que o app usa, um aparelho que já abriu abre a
// biblioteca com um pedido só, e um aparelho novo baixa as notas no máximo 6 de cada vez (sem estourar o limite de pedidos do Google),
// com o mesmo resultado.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { newFileMeta, newSidecar } from '@/lib/defaults'
import { DriveRepository } from '@/lib/storage/drive-repository'

import { FakeDrive, installMemoryStorage, uniqueAccount } from './fake-drive'

vi.mock('@/lib/storage/media-stream', () => ({ driveStreamUrl: vi.fn(async (ref: string) => `/media-stream/${ref}`) }))

const token = vi.fn(async (_options?: { force?: boolean }) => 'tok')
let drive: FakeDrive
let inFlight = 0
let mostAtOnce = 0

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  // the downloads take a moment, as on the network, and the test counts how many go at once
  const answer = drive.fetch.getMockImplementation()!
  drive.fetch.mockImplementation(async (input, init) => {
    const media = new URL(String(input)).searchParams.get('alt') === 'media'
    if (!media) return answer(input, init)
    inFlight++
    mostAtOnce = Math.max(mostAtOnce, inFlight)
    await new Promise(resolve => setTimeout(resolve, 2))
    try {
      return await answer(input, init)
    } finally {
      inFlight--
    }
  })
  inFlight = 0
  mostAtOnce = 0
})

afterEach(() => vi.unstubAllGlobals())

async function libraryOf(notes: number): Promise<string> {
  const account = uniqueAccount()
  const repo = new DriveRepository(account, token)
  await repo.load()
  for (let n = 0; n < notes; n++) await repo.saveFile(newSidecar(newFileMeta({ name: `Nota ${n}`, type: 'reading' })), `texto ${n}`)
  return account
}

describe('as chamadas ao Google Drive', () => {
  it('um aparelho novo baixa as notas no máximo 6 de cada vez, e a biblioteca sai igual', async () => {
    const account = await libraryOf(30)
    const first = await new DriveRepository(account, token).load()
    await new DriveRepository(account, token).forget()
    drive.requests = []
    mostAtOnce = 0
    const fresh = await new DriveRepository(account, token).load()
    expect(drive.mediaDownloads().length).toBeGreaterThanOrEqual(30)
    expect(mostAtOnce).toBeLessThanOrEqual(6)
    expect(mostAtOnce).toBeGreaterThan(1)
    expect(fresh.files.map(file => file.name).sort()).toEqual(first.files.map(file => file.name).sort())
  })

  it('um aparelho que já abriu abre a biblioteca com um pedido só, que pede só os campos usados', async () => {
    const account = await libraryOf(10)
    await new DriveRepository(account, token).load()
    drive.requests = []
    await new DriveRepository(account, token).load()
    expect(drive.requests).toHaveLength(1)
    expect(drive.requests[0].search.get('fields')).toMatch(/^nextPageToken,files\(/)
    expect(drive.requests[0].search.get('pageSize')).toBe('1000')
  })

  it('abrir de novo uma nota já lida não baixa nada', async () => {
    const account = await libraryOf(3)
    const repo = new DriveRepository(account, token)
    const { files } = await repo.load()
    await repo.readContent(files[0].id)
    drive.requests = []
    expect(await repo.readContent(files[0].id)).toMatch(/^texto \d$/)
    expect(drive.requests).toHaveLength(0)
  })
})
