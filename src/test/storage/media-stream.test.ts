// Streaming (pedido do dono: "Sim, um streaming"): o player toca a mídia guardada aos pedaços, sem baixar tudo antes. A do App vai pelo
// endereço da API com o cookie da sessão; a do Drive, pelo service worker do app (/media-stream/<id>), que pede o token a esta página.
// Onde não dá (sem service worker, Firefox antes do 153), não há endereço: o player baixa a mídia inteira como antes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SourceMeta } from '@/types/domain'
import { env } from '@/lib/env'
import { AppRepository } from '@/lib/storage/app-repository'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import type { Repository } from '@/lib/storage/repository'
import { storedStream } from '@/lib/storage/source-storage'

const ID = '1AbC-d_EfGhIjKlMnOpQrStUvWxYz0123'
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const firefox = (version: number) => `Mozilla/5.0 (X11; Linux x86_64; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`

/** The browser's service workers as the page sees them: the app's worker registered, and taking the page or not. */
class FakeWorkers extends EventTarget {
  controller: object | null
  claims = vi.fn()
  registration = { active: { postMessage: (data: { type: string }) => data.type === 'claim' && this.claims() } }
  register = vi.fn(async (_url: string, _options?: RegistrationOptions) => this.registration)
  constructor(controlled: boolean) {
    super()
    this.controller = controlled ? {} : null
  }
  get ready() {
    return Promise.resolve(this.registration)
  }
  take() {
    this.controller = {}
    this.dispatchEvent(new Event('controllerchange'))
  }
}

function browser(workers: FakeWorkers | undefined, userAgent = CHROME) {
  Object.defineProperty(navigator, 'serviceWorker', { value: workers, configurable: true })
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
}

const token = vi.fn(async (options?: { force?: boolean }) => (options?.force ? 'tok-novo' : 'tok-1'))
const fresh = async () => {
  vi.resetModules()
  return import('@/lib/storage/media-stream')
}

beforeEach(() => token.mockClear())
afterEach(() => {
  vi.useRealTimers()
  browser(undefined)
})

describe('o endereço de streaming da mídia do Drive (service worker do app)', () => {
  it('com o worker tomando a página: registra o /media-stream-sw.js do app e dá /media-stream/<id>', async () => {
    const workers = new FakeWorkers(true)
    browser(workers)
    const { driveStreamUrl } = await fresh()
    expect(await driveStreamUrl(ID, token)).toBe(`/media-stream/${ID}`)
    expect(workers.register).toHaveBeenCalledWith('/media-stream-sw.js', { scope: '/' })
  })

  it('na primeira vez o worker toma a página sem recarregar; numa página aberta sem ele (recarga forçada), a página pede', async () => {
    const workers = new FakeWorkers(false)
    browser(workers)
    const { driveStreamUrl } = await fresh()
    const asked = driveStreamUrl(ID, token)
    await vi.waitFor(() => expect(workers.claims).toHaveBeenCalled())
    workers.take()
    expect(await asked).toBe(`/media-stream/${ID}`)
  })

  it('o worker que não toma a página a tempo deixa o player baixar inteiro (sem endereço)', async () => {
    vi.useFakeTimers()
    browser(new FakeWorkers(false))
    const { driveStreamUrl } = await fresh()
    const asked = driveStreamUrl(ID, token)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await asked).toBeNull()
  })

  it('sem service worker (janela anônima do Firefox, modo de bloqueio do Safari) não há endereço', async () => {
    browser(undefined)
    const { driveStreamUrl } = await fresh()
    expect(await driveStreamUrl(ID, token)).toBeNull()
  })

  it('o registro que falha não há endereço', async () => {
    const workers = new FakeWorkers(true)
    workers.register.mockRejectedValueOnce(new Error('SecurityError'))
    browser(workers)
    const { driveStreamUrl } = await fresh()
    expect(await driveStreamUrl(ID, token)).toBeNull()
  })

  it('Firefox antes do 153 esconde do worker o Range da mídia (bug 1465074): nele, baixa inteiro; do 153 em diante, streaming', async () => {
    const old = new FakeWorkers(true)
    browser(old, firefox(140))
    expect(await (await fresh()).driveStreamUrl(ID, token)).toBeNull()
    expect(old.register).not.toHaveBeenCalled()
    browser(new FakeWorkers(true), firefox(153))
    expect(await (await fresh()).driveStreamUrl(ID, token)).toBe(`/media-stream/${ID}`)
  })

  it('responde ao worker o token do Google e o endereço do Drive pelo canal que ele mandou; "force" pede um token novo', async () => {
    const workers = new FakeWorkers(true)
    browser(workers)
    const { driveStreamUrl } = await fresh()
    await driveStreamUrl(ID, token)
    const replies: unknown[] = []
    const port = { postMessage: (reply: unknown) => replies.push(reply) }
    workers.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'media-stream-token', force: true }, ports: [port] }))
    await vi.waitFor(() => expect(replies).toEqual([{ token: 'tok-novo', base: env.googleApiBase }]))
    expect(token).toHaveBeenCalledWith({ force: true })
    // another message of a worker is not a token request
    workers.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'outra-coisa' }, ports: [port] }))
    await Promise.resolve()
    expect(token).toHaveBeenCalledTimes(1)
  })

  it('o login do Google que falha responde sem token (o worker devolve a recusa ao player)', async () => {
    const workers = new FakeWorkers(true)
    browser(workers)
    const { driveStreamUrl } = await fresh()
    await driveStreamUrl(ID, async () => {
      throw new Error('O login do Google expirou. Entre de novo.')
    })
    const replies: unknown[] = []
    workers.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'media-stream-token', force: false }, ports: [{ postMessage: (reply: unknown) => replies.push(reply) }] }))
    await vi.waitFor(() => expect(replies).toEqual([{ token: null }]))
  })
})

describe('de onde o player toca a mídia guardada (storedStream)', () => {
  const kept = (storedFileId: string, extra: Partial<SourceMeta> = {}): SourceMeta => ({ input: 'recording', name: 'aula.webm', mime: 'audio/webm', sizeBytes: 10, storage: 'drive', storedFileId, ...extra })
  const side = (streamSource?: (ref: string) => unknown) => ({ kind: 'drive', ...(streamSource ? { streamSource: vi.fn(streamSource) } : {}) }) as unknown as Repository

  it('a mídia do App toca do endereço da API (o navegador pede as partes com o cookie da sessão)', async () => {
    expect(await storedStream(kept('app:n1/m1'), new AppRepository('acc1'))).toBe(`${env.apiUrl}/v1/media/n1/m1`)
  })

  it('numa conta Google, a do App vai pelo App e a do Drive pelo Drive', async () => {
    const drive = side(async ref => `/media-stream/${ref}`)
    const app = side(ref => `api:${ref}`)
    const repo = new CombinedRepository(drive, side())
    expect(await storedStream(kept('app:n1/m1'), repo)).toBeNull()
    repo.setApp(app)
    expect(await storedStream(kept('app:n1/m1'), repo)).toBe('api:app:n1/m1')
    expect(await storedStream(kept(ID), repo)).toBe(`/media-stream/${ID}`)
  })

  it('sem endereço de streaming (Local, um navegador sem o worker), a mídia baixa inteira como antes', async () => {
    expect(await storedStream(kept('local-ref'), side())).toBeNull()
    expect(await storedStream(kept(ID), side(async () => null))).toBeNull()
  })

  it('nada guardado, apagada, ou num site de terceiros (que já toca do endereço dele) não é streaming do app', async () => {
    const drive = side(async ref => `/media-stream/${ref}`)
    expect(await storedStream(kept(ID, { removedAt: '2026-11-20T10:00:00Z' }), drive)).toBeNull()
    expect(await storedStream(kept(ID, { storage: 'none' }), drive)).toBeNull()
    expect(await storedStream({ ...kept(ID), storage: 'gofile', storedFileId: undefined, storedUrl: 'https://gofile.io/d/x' }, drive)).toBeNull()
  })
})
