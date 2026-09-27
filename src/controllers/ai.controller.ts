import type { AiSettings } from '@/types/domain'
import { baseUrlOf, minIntervalOf, missingSetup, modelOf, providerOf } from '@/lib/ai/providers'

export const MAX_TOKENS = 16384
export const LONG_REPLY_MAX_TOKENS = 32768
const TEMPERATURE = 0.7
const RATE_LIMIT_RETRIES = 5
const ANTHROPIC_VERSION = '2023-06-01'

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  estimated: boolean
}

export interface ChatReply {
  text: string
  usage: ChatUsage
}

export class AiError extends Error {}

export class Cancelled extends Error {
  constructor() {
    super('Geração cancelada.')
  }
}

const nextSlot = new Map<string, number>()

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled())
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Cancelled())
    })
  })
}

async function waitTurn(settings: AiSettings, signal?: AbortSignal): Promise<void> {
  const interval = minIntervalOf(settings)
  if (!interval) return
  const key = `${settings.provider}|${baseUrlOf(settings)}`
  const now = Date.now()
  const slot = Math.max(now, nextSlot.get(key) ?? now)
  nextSlot.set(key, slot + interval)
  if (slot > now) await sleep(slot - now, signal)
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  const seconds = header ? Number(header) : NaN
  return Number.isFinite(seconds) ? seconds * 1000 : Math.min(2 ** attempt * 1000, 30000)
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    if (typeof body.error === 'string') return body.error
    return body.error?.message ?? body.message ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

async function send(settings: AiSettings, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(url, { ...init, signal })
    } catch (error) {
      if (signal?.aborted) throw new Cancelled()
      throw new AiError(`Não consegui falar com a IA (${providerOf(settings.provider).name}). Confira a internet e o endereço.`)
    }
    if ((response.status === 429 || response.status === 503) && attempt < RATE_LIMIT_RETRIES) {
      await sleep(retryDelay(response, attempt), signal)
      continue
    }
    return response
  }
}

async function* serverEvents(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new Cancelled()
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut = buffer.indexOf('\n')
      while (cut >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, '')
        buffer = buffer.slice(cut + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
        cut = buffer.indexOf('\n')
      }
    }
    if (buffer.startsWith('data:')) yield buffer.slice(5).trim()
  } catch (error) {
    if (signal?.aborted) throw new Cancelled()
    throw error
  } finally {
    reader.releaseLock()
  }
}

function estimate(content: string, systemPrompt: string, text: string): ChatUsage {
  return { inputTokens: Math.round((content.length + systemPrompt.length) / 4), outputTokens: Math.round(text.length / 4), estimated: true }
}

async function anthropicChat(settings: AiSettings, content: string, systemPrompt: string, maxTokens: number, signal?: AbortSignal): Promise<ChatReply> {
  const response = await send(
    settings,
    `${baseUrlOf(settings)}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: modelOf(settings),
        max_tokens: maxTokens,
        temperature: TEMPERATURE,
        system: systemPrompt,
        messages: [{ role: 'user', content }],
        stream: true,
      }),
    },
    signal,
  )
  if (!response.ok) throw new AiError(`A IA (Anthropic) recusou o pedido (${response.status}): ${await errorText(response)}`)
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  for await (const data of serverEvents(response, signal)) {
    if (!data) continue
    const event = JSON.parse(data) as {
      type: string
      delta?: { text?: string }
      message?: { usage?: { input_tokens?: number } }
      usage?: { output_tokens?: number }
      error?: { message?: string }
    }
    if (event.type === 'content_block_delta' && event.delta?.text) text += event.delta.text
    if (event.type === 'message_start') inputTokens = event.message?.usage?.input_tokens ?? 0
    if (event.type === 'message_delta') outputTokens = event.usage?.output_tokens ?? outputTokens
    if (event.type === 'error') throw new AiError(`A IA (Anthropic) parou no meio: ${event.error?.message ?? 'erro'}`)
  }
  return { text, usage: inputTokens || outputTokens ? { inputTokens, outputTokens, estimated: false } : estimate(content, systemPrompt, text) }
}

interface OpenAiOptions {
  max_tokens?: number
  response_format?: { type: string }
  stream_options?: { include_usage: boolean }
}

async function openAiChat(settings: AiSettings, content: string, systemPrompt: string, maxTokens: number, signal?: AbortSignal): Promise<ChatReply> {
  const options: OpenAiOptions = { max_tokens: maxTokens, stream_options: { include_usage: true } }
  if (systemPrompt.toLowerCase().includes('json')) options.response_format = { type: 'json_object' }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`

  while (true) {
    const response = await send(
      settings,
      `${baseUrlOf(settings)}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelOf(settings),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content },
          ],
          temperature: TEMPERATURE,
          stream: true,
          ...options,
        }),
      },
      signal,
    )
    if (response.status === 400 || response.status === 422) {
      const dropped = (['response_format', 'stream_options', 'max_tokens'] as const).find(key => key in options)
      if (dropped) {
        await response.body?.cancel()
        delete options[dropped]
        continue
      }
    }
    if (!response.ok) {
      const detail = await errorText(response)
      if (settings.provider === 'pollinations' && !settings.apiKey && /turnstile/i.test(detail)) {
        throw new AiError('A Pollinations sem chave passou a pedir verificação anti-robô para pedidos do navegador. Use a LLM7 (também sem chave) ou ponha uma chave da Pollinations nas Configurações.')
      }
      throw new AiError(`A IA (${providerOf(settings.provider).name}) recusou o pedido (${response.status}): ${detail}`)
    }

    let text = ''
    let usage: ChatUsage | null = null
    for await (const data of serverEvents(response, signal)) {
      if (!data || data === '[DONE]') continue
      const chunk = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        error?: { message?: string }
      }
      if (chunk.error) throw new AiError(`A IA parou no meio: ${chunk.error.message ?? 'erro'}`)
      for (const choice of chunk.choices ?? []) text += choice.delta?.content ?? ''
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0, estimated: false }
    }
    return { text, usage: usage ?? estimate(content, systemPrompt, text) }
  }
}

export async function chatController(
  settings: AiSettings,
  content: string,
  systemPrompt: string,
  maxTokens = MAX_TOKENS,
  signal?: AbortSignal,
): Promise<ChatReply> {
  const problem = missingSetup(settings)
  if (problem) throw new AiError(problem)
  await waitTurn(settings, signal)
  return providerOf(settings.provider).format === 'anthropic'
    ? anthropicChat(settings, content, systemPrompt, maxTokens, signal)
    : openAiChat(settings, content, systemPrompt, maxTokens, signal)
}

export async function listModelsController(settings: AiSettings): Promise<string[]> {
  const provider = providerOf(settings.provider)
  const base = baseUrlOf(settings)
  if (!base) throw new AiError('Informe a URL base.')
  if (provider.needsKey && !settings.apiKey) throw new AiError('Falta a chave.')

  if (provider.id === 'pollinations' && !settings.apiKey) {
    const response = await send(settings, 'https://text.pollinations.ai/models', {})
    if (!response.ok) throw new AiError(`Pollinations não respondeu (${response.status}).`)
    const body = (await response.json()) as ({ name?: string } | string)[]
    return body.map(item => (typeof item === 'string' ? item : (item.name ?? ''))).filter(Boolean)
  }

  const headers: Record<string, string> =
    provider.format === 'anthropic'
      ? { 'x-api-key': settings.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' }
      : settings.apiKey
        ? { authorization: `Bearer ${settings.apiKey}` }
        : {}
  const url = provider.format === 'anthropic' ? `${base}/v1/models?limit=1000` : `${base}/models`
  const response = await send(settings, url, { headers })
  if (response.status === 401 || response.status === 403) throw new AiError('A chave foi recusada.')
  if (!response.ok) throw new AiError(`O serviço respondeu ${response.status}: ${await errorText(response)}`)
  const body = (await response.json()) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] }
  const ids = (body.data ?? body.models ?? []).map(item => item.id || item.name || '').filter(Boolean)
  return [...new Set(ids.map(id => id.replace(/^models\//, '')))].sort()
}
