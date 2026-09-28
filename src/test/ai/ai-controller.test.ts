import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFetch, jsonResponse, llm7Settings, openAiStream, ovhSettings, sseResponse, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import type { AiSettings } from '@/types/domain'

async function controller() {
  vi.resetModules()
  return import('@/controllers/ai.controller')
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('listModelsController (connection test)', () => {
  it('lists models from GET {base}/models for OpenAI-format providers and sends the key', async () => {
    const { listModelsController } = await controller()
    const { calls } = installFetch(() => jsonResponse({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'gemini-2.0' }, { id: 'gemini-2.0' }] }))
    const models = await listModelsController({ provider: 'gemini', baseUrl: '', apiKey: 'AIza', model: '' })
    expect(models).toEqual(['gemini-2.0', 'gemini-2.5-flash'])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].body).toBeNull()
    expect(calls[0].headers.authorization).toBe('Bearer AIza')
  })

  it('uses GET /v1/models with Anthropic headers', async () => {
    const { listModelsController } = await controller()
    const { calls } = installFetch(() => jsonResponse({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] }))
    const models = await listModelsController({ provider: 'anthropic', baseUrl: '', apiKey: 'sk-ant', model: '' })
    expect(models).toEqual(['claude-a', 'claude-b'])
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(calls[0].method).toBe('GET')
    expect(calls[0].headers['x-api-key']).toBe('sk-ant')
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0].headers['anthropic-dangerous-direct-browser-access']).toBe('true')
  })

  it('OVHcloud without key lists models without an authorization header', async () => {
    const { listModelsController } = await controller()
    const { calls } = installFetch(() => jsonResponse({ data: [{ id: 'gpt-oss-120b' }, { id: 'Meta-Llama-3_3-70B-Instruct' }] }))
    expect(await listModelsController(ovhSettings())).toEqual(['Meta-Llama-3_3-70B-Instruct', 'gpt-oss-120b'])
    expect(calls[0].url).toBe('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models')
    expect(calls[0].headers.authorization).toBeUndefined()
  })

  it('accepts a models[] body shape with names', async () => {
    const { listModelsController } = await controller()
    installFetch(() => jsonResponse({ models: [{ name: 'llama3' }, { id: 'qwen' }] }))
    expect(await listModelsController({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' })).toEqual(['llama3', 'qwen'])
  })

  it('Pollinations without key refuses the test and makes no request', async () => {
    const { listModelsController } = await controller()
    const { calls } = installFetch(() => jsonResponse({ data: [] }))
    await expect(listModelsController({ provider: 'pollinations', baseUrl: '', apiKey: '', model: '' })).rejects.toThrow('Falta a chave.')
    expect(calls).toHaveLength(0)
  })

  it('never calls a completion endpoint for any provider', async () => {
    const { listModelsController } = await controller()
    const { calls } = installFetch(() => jsonResponse({ data: [{ id: 'm' }] }))
    const all: AiSettings[] = [
      { provider: 'anthropic', baseUrl: '', apiKey: 'k', model: '' },
      { provider: 'openai', baseUrl: '', apiKey: 'k', model: '' },
      { provider: 'gemini', baseUrl: '', apiKey: 'k', model: '' },
      { provider: 'xai', baseUrl: '', apiKey: 'k', model: '' },
      { provider: 'ovh', baseUrl: '', apiKey: '', model: '' },
      { provider: 'llm7', baseUrl: '', apiKey: 'k', model: '' },
      { provider: 'pollinations', baseUrl: '', apiKey: 'k', model: '' },
      { provider: 'custom', baseUrl: 'https://my.example/v1', apiKey: '', model: '' },
    ]
    for (const item of all) await listModelsController(item)
    expect(calls).toHaveLength(all.length)
    for (const call of calls) {
      expect(call.method).toBe('GET')
      expect(call.body).toBeNull()
      expect(call.url).not.toMatch(/chat\/completions|\/messages(\?|$)/)
      expect(call.url).toMatch(/\/models(\?|$)/)
    }
  })

  it('reports a refused key without spending anything', async () => {
    const { listModelsController } = await controller()
    installFetch(() => jsonResponse({ error: 'bad key' }, 401))
    await expect(listModelsController({ provider: 'openai', baseUrl: '', apiKey: 'x', model: '' })).rejects.toThrow('A chave foi recusada.')
  })

  it('refuses to test a keyed provider without key and makes no request', async () => {
    const { listModelsController } = await controller()
    const { calls } = installFetch(() => jsonResponse({}))
    await expect(listModelsController({ provider: 'llm7', baseUrl: '', apiKey: '', model: '' })).rejects.toThrow('Falta a chave.')
    expect(calls).toHaveLength(0)
  })
})

describe('chatController streaming', () => {
  it('LLM7 streams from api.llm7.io/v1/chat/completions with the key and joins the deltas', async () => {
    const { chatController } = await controller()
    const { calls } = installFetch(() => openAiStream('Olá, mundo! Tudo certo por aqui.', 5, { prompt_tokens: 11, completion_tokens: 7 }))
    const reply = await chatController(llm7Settings(), 'conteúdo', 'sistema')
    expect(reply.text).toBe('Olá, mundo! Tudo certo por aqui.')
    expect(reply.usage).toEqual({ inputTokens: 11, outputTokens: 7, estimated: false })
    expect(calls[0].url).toBe('https://api.llm7.io/v1/chat/completions')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers.authorization).toBeUndefined()
    expect(calls[0].body).toMatchObject({ model: 'default', stream: true, stream_options: { include_usage: true } })
    expect(systemPromptOf(calls[0])).toBe('sistema')
    expect(userContentOf(calls[0])).toBe('conteúdo')
  })

  it('parses SSE events split across arbitrary read boundaries, including multibyte characters and CRLF', async () => {
    const { chatController } = await controller()
    const events =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ação ' } }] })}\r\n\r\n` +
      ': keep-alive\n\n' +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'coração ' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: '🚀 fim' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } })}\n\n` +
      'data: [DONE]\n\n'
    const bytes = new TextEncoder().encode(events)
    const pieces: Uint8Array[] = []
    for (let start = 0; start < bytes.length; start += 7) pieces.push(bytes.slice(start, start + 7))
    const stream = new ReadableStream<Uint8Array>({
      start(stream) {
        for (const piece of pieces) stream.enqueue(piece)
        stream.close()
      },
    })
    installFetch(() => new Response(stream, { status: 200 }))
    const reply = await chatController(llm7Settings(), 'c', 's')
    expect(reply.text).toBe('ação coração 🚀 fim')
    expect(reply.usage.estimated).toBe(false)
  })

  it('handles a final data line without trailing newline', async () => {
    const { chatController } = await controller()
    installFetch(() => sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n`, `data: ${JSON.stringify({ choices: [{ delta: { content: 'b' } }] })}`]))
    expect((await chatController(llm7Settings(), 'c', 's')).text).toBe('ab')
  })

  it('estimates tokens when the provider sends no usage', async () => {
    const { chatController } = await controller()
    installFetch(() => openAiStream('12345678', 2))
    const reply = await chatController(llm7Settings(), 'abcd', 'efgh')
    expect(reply.usage).toEqual({ inputTokens: 2, outputTokens: 2, estimated: true })
  })

  it('surfaces a mid-stream error chunk', async () => {
    const { chatController, AiError } = await controller()
    installFetch(() => sseResponse([`data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`]))
    await expect(chatController(llm7Settings(), 'c', 's')).rejects.toBeInstanceOf(AiError)
  })

  it('Anthropic streams /v1/messages events and reads real usage', async () => {
    const { chatController } = await controller()
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 21 } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'Oi ' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: 'você' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}\n\n`,
    ]
    const { calls } = installFetch(() => sseResponse(events))
    const reply = await chatController({ provider: 'anthropic', baseUrl: '', apiKey: 'sk-ant', model: 'claude-x' }, 'c', 's')
    expect(reply).toEqual({ text: 'Oi você', usage: { inputTokens: 21, outputTokens: 5, estimated: false } })
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0].body).toMatchObject({ model: 'claude-x', system: 's', stream: true })
  })

  it('asks for JSON mode when the system prompt mentions JSON and drops it if the provider rejects it', async () => {
    const { chatController } = await controller()
    let first = true
    const { calls } = installFetch(() => {
      if (first) {
        first = false
        return jsonResponse({ error: { message: 'response_format unsupported' } }, 400)
      }
      return openAiStream('{"ok":true}')
    })
    const reply = await chatController(llm7Settings(), 'c', 'Responda em JSON')
    expect(reply.text).toBe('{"ok":true}')
    expect(calls).toHaveLength(2)
    expect(calls[0].body?.response_format).toEqual({ type: 'json_object' })
    expect(calls[1].body?.response_format).toBeUndefined()
  })

  it('refuses before any request when setup is missing', async () => {
    const { chatController } = await controller()
    const { calls } = installFetch(() => openAiStream('x'))
    await expect(chatController({ provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt' }, 'c', 's')).rejects.toThrow(/Falta a chave de OpenAI/)
    expect(calls).toHaveLength(0)
  })
})

describe('Pollinations needs a key', () => {
  it('with key posts to gen.pollinations.ai/v1 with the bearer key', async () => {
    const { chatController } = await controller()
    const { calls } = installFetch(() => openAiStream('ok'))
    await chatController({ provider: 'pollinations', baseUrl: '', apiKey: 'sk', model: 'openai' }, 'c', 's')
    expect(calls[0].url).toBe('https://gen.pollinations.ai/v1/chat/completions')
    expect(calls[0].headers.authorization).toBe('Bearer sk')
  })

  it('without key refuses before any request', async () => {
    const { chatController } = await controller()
    const { calls } = installFetch(() => openAiStream('ok'))
    await expect(chatController({ provider: 'pollinations', baseUrl: '', apiKey: '', model: 'openai' }, 'c', 's')).rejects.toThrow(/Falta a chave de Pollinations/)
    expect(calls).toHaveLength(0)
  })
})

describe('rate limit handling', () => {
  it('waits the Retry-After seconds on 429 and retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { chatController } = await controller()
    const times: number[] = []
    let count = 0
    installFetch(() => {
      times.push(Date.now())
      count++
      return count === 1 ? jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '3' }) : openAiStream('done')
    })
    const reply = chatController(llm7Settings(), 'c', 's')
    await vi.advanceTimersByTimeAsync(2999)
    expect(times).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await reply).text).toBe('done')
    expect(times[1] - times[0]).toBe(3000)
  })

  it('gives up after 5 retries and reports the status', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { chatController } = await controller()
    const { calls } = installFetch(() => jsonResponse({ error: 'busy' }, 429, { 'retry-after': '1' }))
    const reply = chatController(llm7Settings(), 'c', 's')
    const assertion = expect(reply).rejects.toThrow(/429/)
    await vi.advanceTimersByTimeAsync(10000)
    await assertion
    expect(calls).toHaveLength(6)
  })

  it('cancels a request waiting in the OVHcloud line when aborted', async () => {
    const { chatController, Cancelled } = await controller()
    installFetch(() => openAiStream('ok'))
    const first = chatController(ovhSettings(), 'a', 's')
    const abort = new AbortController()
    const queued = chatController(ovhSettings(), 'b', 's', undefined, abort.signal)
    const assertion = expect(queued).rejects.toBeInstanceOf(Cancelled)
    abort.abort()
    await first
    await assertion
  })
})
