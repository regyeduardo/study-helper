// T203 (research R30): as fotos das telas marcadas na gravação (`telas/<n>`) e o volume de cada canal (`volume`) ficam em partes à
// parte da nota: gravadas uma vez, lidas só quando a leitura da tela ou a transcrição pedem (abrir a nota não traz ~12 MB de fotos de 1h30),
// e nunca apagadas por uma gravação da nota, que só conhece as suas partes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', async importOriginal => ({ env: { ...((await importOriginal()) as { env: object }).env, apiUrl: mockEnv.apiUrl } }))

import { newFileMeta, newSidecar } from '@/lib/defaults'
import { AppRepository } from '@/lib/storage/app-repository'
import { FakeAppServer } from '@/test/storage/fake-app-server'
import { installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

let server: FakeAppServer
let account: string
let bodies: string[] = []

beforeEach(() => {
  installMemoryStorage()
  server = new FakeAppServer()
  bodies = []
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(init.body)
    return server.fetch(input, init)
  })
  account = uniqueAccount()
})
afterEach(() => vi.unstubAllGlobals())

const screen = (n: number) => JSON.stringify({ at: n * 10, image: `data:image/jpeg;base64,TELA${n}` })

async function recordingWithAside() {
  const writer = new AppRepository(account)
  await writer.load()
  const sidecar = { ...newSidecar(newFileMeta({ name: 'Reunião', type: 'video', folderId: null })), recording: { blocks: [], speakers: [], marks: [] } }
  await writer.saveFile(sidecar, '')
  await writer.putAside(sidecar.meta.id, { 'telas/000': screen(0), 'telas/001': screen(1), volume: JSON.stringify({ step: 0.05, microphone: 'AAE=', computer: 'AQA=' }) })
  return { writer, sidecar }
}

describe('partes à parte: as fotos das telas e o volume (T203)', () => {
  it('são gravadas e lidas uma a uma, quando pedidas', async () => {
    const { sidecar } = await recordingWithAside()
    const reader = new AppRepository(uniqueAccount())
    await reader.load()
    expect(await reader.aside(sidecar.meta.id, 'telas/001')).toBe(screen(1))
    expect(JSON.parse((await reader.aside(sidecar.meta.id, 'volume'))!).step).toBe(0.05)
    expect(await reader.aside(sidecar.meta.id, 'telas/009')).toBeUndefined()
  })

  it('abrir a nota não as traz', async () => {
    const { sidecar } = await recordingWithAside()
    const reader = new AppRepository(uniqueAccount())
    await reader.load()
    server.calls.length = 0
    bodies = []
    await reader.readSidecar(sidecar.meta.id)
    const asked = [...server.calls.map(call => decodeURIComponent(call.path)), ...bodies].join(' ')
    expect(asked).not.toContain('telas/')
    expect(asked).not.toContain('volume')
  })

  it('gravar a nota de novo não as apaga', async () => {
    const { writer, sidecar } = await recordingWithAside()
    await writer.saveFile({ ...sidecar, transcript: 'Ana: começou' }, 'texto novo')
    const reader = new AppRepository(uniqueAccount())
    await reader.load()
    expect(await reader.aside(sidecar.meta.id, 'telas/000')).toBe(screen(0))
    expect(server.calls.some(call => call.method === 'DELETE' && /telas|volume/.test(call.path))).toBe(false)
  })
})
