import { afterEach, describe, expect, it, vi } from 'vitest'

import { chatController } from '@/controllers/ai.controller'
import { openAiStream } from './fake-provider'

afterEach(() => vi.unstubAllGlobals())

function trackConcurrency() {
  const state = { running: 0, peak: 0 }
  vi.stubGlobal('fetch', vi.fn(async () => {
    state.running++
    state.peak = Math.max(state.peak, state.running)
    await new Promise(resolve => setTimeout(resolve, 30))
    state.running--
    return openAiStream('ok', 1, { prompt_tokens: 1, completion_tokens: 1 })
  }))
  return state
}

describe('LLM7 sem chave aceita um pedido por vez', () => {
  it('pedidos simultâneos ao LLM7 sem chave saem em fila', async () => {
    const state = trackConcurrency()
    const settings = { provider: 'llm7' as const, baseUrl: '', apiKey: '', model: '' }
    const replies = await Promise.all([1, 2, 3].map(() => chatController(settings, 'oi', 'sistema')))
    expect(replies.map(reply => reply.text)).toEqual(['ok', 'ok', 'ok'])
    expect(state.peak).toBe(1)
  })

  it('com chave, ou em outro provedor, continuam em paralelo', async () => {
    const state = trackConcurrency()
    const settings = { provider: 'llm7' as const, baseUrl: '', apiKey: 'chave', model: 'default' }
    await Promise.all([1, 2, 3].map(() => chatController(settings, 'oi', 'sistema')))
    expect(state.peak).toBe(3)
  })

  it('um pedido que falha não trava a fila', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++calls === 1 ? new Response('{"error":"x"}', { status: 401 }) : openAiStream('ok', 1))))
    const settings = { provider: 'llm7' as const, baseUrl: '', apiKey: '', model: '' }
    const [first, second] = await Promise.allSettled([chatController(settings, 'oi', 's'), chatController(settings, 'oi', 's')])
    expect(first.status).toBe('rejected')
    expect(second).toMatchObject({ status: 'fulfilled', value: { text: 'ok' } })
  })
})
