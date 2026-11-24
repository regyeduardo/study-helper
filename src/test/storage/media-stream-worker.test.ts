// @vitest-environment node
// Streaming do Drive (pedido do dono: "Sim, um streaming"): um <video src> não manda o cabeçalho Authorization que o Drive exige, então o
// player pede /media-stream/<id> no endereço do próprio app e o service worker do app pede ao Drive os mesmos bytes (o Range que o
// navegador pediu) com o token, que ele pega da página a cada pedido e nunca guarda nem põe em endereço.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const SOURCE = readFileSync(path.resolve(__dirname, '../../../public/media-stream-sw.js'), 'utf8')
const APP = 'https://study.test'
const DRIVE = 'https://drive.test'
const ID = '1AbC-d_EfGhIjKlMnOpQrStUvWxYz0123'
const BYTES = 'abcdefghij'

type Listener = (event: never) => void

interface Asked {
  type: string
  force: boolean
}

interface Worker {
  on: Record<string, Listener>
  asked: Asked[]
  claim: ReturnType<typeof vi.fn>
  skipWaiting: ReturnType<typeof vi.fn>
}

/** The Drive as the worker sees it from the app's origin: Range answered in part, the token checked, and what CORS lets it read. */
function fakeDrive({ hideRange = false, tokens = ['tok-1'] } = {}) {
  const calls: { url: string; auth: string | null; range: string | null }[] = []
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    calls.push({ url: input, auth: headers.get('Authorization'), range: headers.get('Range') })
    if (!tokens.includes((headers.get('Authorization') ?? '').replace('Bearer ', ''))) return new Response('{"error":"invalid"}', { status: 401 })
    const url = new URL(input)
    if (url.pathname !== `/drive/v3/files/${ID}`) return new Response('{"error":"notFound"}', { status: 404 })
    if (url.searchParams.get('fields') === 'size') return Response.json({ size: String(BYTES.length) })
    const asked = /^bytes=(\d*)-(\d*)$/.exec(headers.get('Range') ?? '')
    if (!asked) return new Response(BYTES, { status: 200, headers: { 'Content-Type': 'video/webm', 'Content-Length': '10' } })
    const start = asked[1] === '' ? BYTES.length - Number(asked[2]) : Number(asked[1])
    const end = asked[1] === '' || asked[2] === '' ? BYTES.length - 1 : Math.min(Number(asked[2]), BYTES.length - 1)
    const part = BYTES.slice(start, end + 1)
    const sent = new Headers({ 'Content-Type': 'video/webm', 'Content-Length': String(part.length) })
    // a CORS answer shows the worker only the headers the Drive exposes
    if (!hideRange) sent.set('Content-Range', `bytes ${start}-${end}/${BYTES.length}`)
    return new Response(part, { status: 206, headers: sent })
  })
  return { fetch, calls }
}

/** Runs the worker's file as the browser does, with a page (client) that answers the token. */
function startWorker(fetch: (input: string, init?: RequestInit) => Promise<Response>, answer: (asked: Asked) => unknown = asked => ({ token: asked.force ? 'tok-2' : 'tok-1', base: DRIVE })): Worker {
  const worker: Worker = { on: {}, asked: [], claim: vi.fn(async () => undefined), skipWaiting: vi.fn(async () => undefined) }
  const page = {
    id: 'page-1',
    postMessage(data: Asked, [port]: MessagePort[]) {
      worker.asked.push(data)
      const reply = answer(data)
      if (reply !== undefined) port.postMessage(reply)
    },
  }
  const self = {
    location: new URL(`${APP}/media-stream-sw.js`),
    registration: { scope: `${APP}/` },
    addEventListener: (name: string, listener: Listener) => void (worker.on[name] = listener),
    skipWaiting: worker.skipWaiting,
    clients: { claim: worker.claim, get: async (id: string) => (id === page.id ? page : undefined), matchAll: async () => [page] },
  }
  new Function('self', 'fetch', SOURCE)(self, fetch)
  return worker
}

/** A request of the page's <video>: what the worker answered, or null when it let the request go to the network untouched. */
async function ask(worker: Worker, url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response | null> {
  let answered: Promise<Response> | null = null
  const event = { request: new Request(url, { method, headers }), clientId: 'page-1', respondWith: (response: Promise<Response>) => void (answered = response), waitUntil: () => undefined }
  worker.on.fetch(event as never)
  return answered ? await answered : null
}

let drive: ReturnType<typeof fakeDrive>

beforeEach(() => {
  drive = fakeDrive()
})

describe('o service worker que toca a mídia do Drive aos pedaços', () => {
  it('repassa o Range do player ao Drive com o token da página e devolve o pedaço (206), sem o token no endereço', async () => {
    const worker = startWorker(drive.fetch)
    const response = (await ask(worker, `${APP}/media-stream/${ID}`, { Range: 'bytes=2-5' }))!
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('cdef')
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(response.headers.get('Content-Length')).toBe('4')
    expect(response.headers.get('Content-Type')).toBe('video/webm')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(drive.calls).toEqual([{ url: `${DRIVE}/drive/v3/files/${ID}?alt=media`, auth: 'Bearer tok-1', range: 'bytes=2-5' }])
    expect(worker.asked).toEqual([{ type: 'media-stream-token', force: false }])
  })

  it('o primeiro pedido do Safari (bytes=0-1) e um salto do fim (bytes=-3) também voltam em parte', async () => {
    const worker = startWorker(drive.fetch)
    const first = (await ask(worker, `${APP}/media-stream/${ID}`, { Range: 'bytes=0-1' }))!
    expect([first.status, await first.text(), first.headers.get('Content-Range')]).toEqual([206, 'ab', 'bytes 0-1/10'])
    const tail = (await ask(worker, `${APP}/media-stream/${ID}`, { Range: 'bytes=-3' }))!
    expect([tail.status, await tail.text(), tail.headers.get('Content-Range')]).toEqual([206, 'hij', 'bytes 7-9/10'])
  })

  it('quando o CORS do Drive esconde o Content-Range, o worker o refaz pelo tamanho do arquivo', async () => {
    drive = fakeDrive({ hideRange: true })
    const worker = startWorker(drive.fetch)
    const middle = (await ask(worker, `${APP}/media-stream/${ID}`, { Range: 'bytes=4-' }))!
    expect([middle.status, await middle.text(), middle.headers.get('Content-Range')]).toEqual([206, 'efghij', 'bytes 4-9/10'])
    const tail = (await ask(worker, `${APP}/media-stream/${ID}`, { Range: 'bytes=-3' }))!
    expect(tail.headers.get('Content-Range')).toBe('bytes 7-9/10')
    expect(drive.calls.filter(call => call.url.includes('fields=size')).every(call => call.auth === 'Bearer tok-1')).toBe(true)
  })

  it('um token vencido (401) pede um novo à página uma vez e tenta de novo', async () => {
    drive = fakeDrive({ tokens: ['tok-2'] })
    const worker = startWorker(drive.fetch)
    const response = (await ask(worker, `${APP}/media-stream/${ID}`, { Range: 'bytes=0-' }))!
    expect([response.status, await response.text()]).toEqual([206, BYTES])
    expect(worker.asked.map(asked => asked.force)).toEqual([false, true])
    expect(drive.calls.map(call => call.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })

  it('o que o Drive recusa chega ao player como recusa (404), para ele dizer o motivo', async () => {
    const worker = startWorker(drive.fetch)
    const response = (await ask(worker, `${APP}/media-stream/1ZZZ-outro-arquivo`, { Range: 'bytes=0-' }))!
    expect(response.status).toBe(404)
  })

  it('sem uma página que dê o token, não pede nada ao Drive (503)', async () => {
    const worker = startWorker(drive.fetch, () => ({ token: null }))
    const response = (await ask(worker, `${APP}/media-stream/${ID}`, { Range: 'bytes=0-' }))!
    expect(response.status).toBe(503)
    expect(drive.calls).toEqual([])
  })

  it('só aceita um id de arquivo do Drive: nada de caminho para outro lugar da API', async () => {
    const worker = startWorker(drive.fetch)
    for (const bad of ['..%2Fabout', 'a%3Ffields%3D*', '', 'a%2Fb']) {
      const response = (await ask(worker, `${APP}/media-stream/${bad}`, { Range: 'bytes=0-' }))!
      expect(response.status).toBe(404)
    }
    expect(drive.calls).toEqual([])
    expect(worker.asked).toEqual([])
  })

  // the page and the pieces of the build are the app's own files, kept for opening without internet (app-offline-shell.test.ts)
  it('não mexe na API nem no que não é leitura, e não pede ao Drive nada além da mídia', async () => {
    const worker = startWorker(drive.fetch)
    expect(await ask(worker, `https://api.study.test/v1/media/n1/m1`, { Range: 'bytes=0-' })).toBeNull()
    expect(await ask(worker, `${APP}/v1/library/map`)).toBeNull()
    expect(await ask(worker, `${APP}/media-stream/${ID}`, {}, 'POST')).toBeNull()
    expect(drive.calls).toEqual([])
  })

  it('assume a página na hora (sem recarregar) e quando a página pede', async () => {
    const worker = startWorker(drive.fetch)
    worker.on.install({ waitUntil: () => undefined } as never)
    expect(worker.skipWaiting).toHaveBeenCalled()
    let claimed: Promise<unknown> | null = null
    worker.on.activate({ waitUntil: (work: Promise<unknown>) => void (claimed = work) } as never)
    await claimed
    expect(worker.claim).toHaveBeenCalledTimes(1)
    worker.on.message({ data: { type: 'claim' }, waitUntil: (work: Promise<unknown>) => void (claimed = work) } as never)
    await claimed
    expect(worker.claim).toHaveBeenCalledTimes(2)
  })
})
