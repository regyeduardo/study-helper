// Spec 003, história 6 (T146, US6/AC1): o app abre sem internet. O service worker do app guarda os arquivos do próprio app (a página e
// os pedaços do build) e, sem internet, abre com eles; nunca guarda a API (/v1/), a mídia (/media-stream/) nem o que é de outro endereço.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SOURCE = readFileSync(resolve(__dirname, '../../../public/media-stream-sw.js'), 'utf8')
const ORIGIN = 'https://study.example'

interface FetchEvent {
  request: { url: string; method: string; mode: string; headers: Headers }
  clientId: string
  respondWith(answer: Promise<Response>): void
}

let listeners: Record<string, (event: FetchEvent) => void>
let kept: Map<string, Response>
let network: ReturnType<typeof vi.fn>

/** The worker as the browser runs it: its own `self`, the caches and the network. */
function install() {
  listeners = {}
  kept = new Map()
  const keyOf = (key: string | { url: string }) => new URL(typeof key === 'string' ? key : key.url, ORIGIN).href
  const cache = {
    put: async (key: string | { url: string }, answer: Response) => {
      kept.delete(keyOf(key))
      kept.set(keyOf(key), answer)
    },
    match: async (key: string | { url: string }) => kept.get(keyOf(key))?.clone(),
    // as the browser: in the order they were kept
    keys: async () => [...kept.keys()].map(url => ({ url })),
    delete: async (key: string | { url: string }) => kept.delete(keyOf(key)),
  }
  const self = {
    registration: { scope: `${ORIGIN}/` },
    location: new URL(`${ORIGIN}/`),
    addEventListener: (type: string, listener: (event: FetchEvent) => void) => void (listeners[type] = listener),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  }
  const caches = { open: async () => cache, match: async (key: string | { url: string }) => kept.get(keyOf(key))?.clone() }
  network = vi.fn()
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, network)
}

/** What the worker answers for a request, or null when it lets the request go to the network untouched. */
async function ask(path: string, mode = 'cors', method = 'GET'): Promise<Response | null> {
  let answer: Promise<Response> | null = null
  listeners.fetch({ request: { url: new URL(path, ORIGIN).href, method, mode, headers: new Headers() }, clientId: '', respondWith: given => void (answer = given) })
  return answer ? await answer : null
}

const page = (text: string) => new Response(`<!doctype html><title>${text}</title>`, { status: 200, headers: { 'Content-Type': 'text/html' } })

beforeEach(() => install())

describe('o app abre sem internet', () => {
  it('com internet, abre a página da rede e guarda uma cópia; sem internet, qualquer endereço do app abre a cópia', async () => {
    network.mockResolvedValueOnce(page('Estudo de hoje'))
    expect(await (await ask('/biblioteca', 'navigate'))!.text()).toContain('Estudo de hoje')

    network.mockRejectedValue(new TypeError('Failed to fetch'))
    const offline = await ask('/arquivo/abc', 'navigate')
    expect(offline!.status).toBe(200)
    expect(await offline!.text()).toContain('Estudo de hoje')
  })

  it('os pedaços do build (/assets/, com o hash no nome) vêm da cópia sem perguntar à rede', async () => {
    network.mockResolvedValueOnce(new Response('console.log(1)', { status: 200 }))
    await ask('/assets/index-abc123.js')
    expect(network).toHaveBeenCalledTimes(1)
    const again = await ask('/assets/index-abc123.js')
    expect(await again!.text()).toBe('console.log(1)')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('nunca guarda a API, a mídia, outro endereço nem o que não é leitura', async () => {
    expect(await ask('/v1/library/map')).toBeNull()
    expect(await ask('https://api.example.test/v1/me')).toBeNull()
    expect(await ask('https://fonts.googleapis.com/css2?family=Geist')).toBeNull()
    expect(await ask('/assets/x.js', 'cors', 'POST')).toBeNull()
    expect(kept.size).toBe(0)
  })

  it('a cópia não cresce sem fim a cada versão do app: passando de 300 pedaços, saem os guardados há mais tempo', async () => {
    network.mockImplementation(async () => new Response('x', { status: 200 }))
    for (let index = 0; index < 305; index++) await ask(`/assets/chunk-${index}.js`)
    const assets = [...kept.keys()].filter(url => url.includes('/assets/'))
    expect(assets).toHaveLength(300)
    expect(assets[0]).toBe(`${ORIGIN}/assets/chunk-5.js`)
  })

  it('o app registra o service worker assim que abre, para abrir sem internet da próxima vez', async () => {
    const register = vi.fn(async () => ({}))
    Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true })
    const { keepAppOffline } = await import('@/lib/storage/media-stream')
    keepAppOffline(true)
    expect(register).toHaveBeenCalledWith('/media-stream-sw.js', { scope: '/' })
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true })
  })

  it('o app tem manifest: abre da tela de início como app, com nome e ícone', () => {
    const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../../public/manifest.webmanifest'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'Estudo', start_url: '.', scope: '.', display: 'standalone' })
    for (const icon of manifest.icons) expect(readFileSync(resolve(__dirname, '../../../public', icon.src), 'utf8')).toContain('<svg')
  })

  it('uma resposta de erro da rede não toma o lugar da cópia boa', async () => {
    network.mockResolvedValueOnce(page('Estudo bom'))
    await ask('/', 'navigate')
    network.mockResolvedValueOnce(new Response('erro', { status: 502 }))
    await ask('/', 'navigate')
    network.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await (await ask('/', 'navigate'))!.text()).toContain('Estudo bom')
  })
})
