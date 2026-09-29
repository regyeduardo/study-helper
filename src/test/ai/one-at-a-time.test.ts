import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openAiStream, ovhSettings } from './fake-provider'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function chatController() {
  vi.resetModules()
  return (await import('@/controllers/ai.controller')).chatController
}

function trackConcurrency() {
  const state = { running: 0, peak: 0, starts: [] as number[] }
  vi.stubGlobal('fetch', vi.fn(async () => {
    state.running++
    state.peak = Math.max(state.peak, state.running)
    state.starts.push(Date.now())
    await new Promise(resolve => setTimeout(resolve, 30))
    state.running--
    return openAiStream('ok', 1, { prompt_tokens: 1, completion_tokens: 1 })
  }))
  return state
}

describe('OVHcloud sem chave aceita um pedido por vez', () => {
  it('pedidos simultâneos saem em fila, um a cada 31 s', async () => {
    const chat = await chatController()
    const state = trackConcurrency()
    const replies = Promise.all([1, 2, 3].map(() => chat(ovhSettings(), 'oi', 'sistema')))
    await vi.advanceTimersByTimeAsync(70000)
    expect((await replies).map(reply => reply.text)).toEqual(['ok', 'ok', 'ok'])
    expect(state.peak).toBe(1)
    expect(state.starts[1] - state.starts[0]).toBe(31000)
    expect(state.starts[2] - state.starts[1]).toBe(31000)
  })

  it('com chave, ou em outro provedor, continuam em paralelo', async () => {
    const chat = await chatController()
    const state = trackConcurrency()
    const withKey = Promise.all([1, 2, 3].map(() => chat(ovhSettings({ apiKey: 'chave' }), 'oi', 'sistema')))
    await vi.advanceTimersByTimeAsync(100)
    await withKey
    expect(state.peak).toBe(3)
    state.peak = 0
    const llm7 = Promise.all([1, 2, 3].map(() => chat({ provider: 'llm7', baseUrl: '', apiKey: 'chave', model: 'default' }, 'oi', 'sistema')))
    await vi.advanceTimersByTimeAsync(100)
    await llm7
    expect(state.peak).toBe(3)
  })

  it('um pedido que falha não trava a fila', async () => {
    const chat = await chatController()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++calls === 1 ? new Response('{"error":"x"}', { status: 401 }) : openAiStream('ok', 1))))
    const settled = Promise.allSettled([chat(ovhSettings(), 'oi', 's'), chat(ovhSettings(), 'oi', 's')])
    await vi.advanceTimersByTimeAsync(40000)
    const [first, second] = await settled
    expect(first.status).toBe('rejected')
    expect(second).toMatchObject({ status: 'fulfilled', value: { text: 'ok' } })
  })
})
