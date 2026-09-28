import { vi } from 'vitest'
import type { AiSettings } from '@/types/domain'

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

export function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

export function openAiStream(text: string, pieces = 3, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  const size = Math.max(1, Math.ceil(text.length / pieces))
  const events: string[] = []
  for (let start = 0; start < text.length; start += size) {
    events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(start, start + size) } }] })}\n\n`)
  }
  if (usage) events.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
  events.push('data: [DONE]\n\n')
  return sseResponse(events)
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function headersOf(init?: RequestInit): Record<string, string> {
  const raw = init?.headers
  if (!raw) return {}
  if (raw instanceof Headers) return Object.fromEntries(raw.entries())
  if (Array.isArray(raw)) return Object.fromEntries(raw)
  return { ...(raw as Record<string, string>) }
}

export function capture(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
  return { url, method: (init?.method ?? 'GET').toUpperCase(), headers: headersOf(init), body }
}

export type Responder = (request: CapturedRequest) => Response | Promise<Response>

export function installFetch(responder: Responder): { calls: CapturedRequest[]; mock: ReturnType<typeof vi.fn> } {
  const calls: CapturedRequest[] = []
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = capture(input, init)
    calls.push(request)
    return responder(request)
  })
  vi.stubGlobal('fetch', mock)
  return { calls, mock }
}

export function systemPromptOf(request: CapturedRequest): string {
  const messages = (request.body?.messages ?? []) as { role: string; content: string }[]
  return messages.find(message => message.role === 'system')?.content ?? ''
}

export function userContentOf(request: CapturedRequest): string {
  const messages = (request.body?.messages ?? []) as { role: string; content: string }[]
  return messages.find(message => message.role === 'user')?.content ?? ''
}

export function llm7Settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return { provider: 'llm7', baseUrl: '', apiKey: 'chave-llm7', model: 'default', ...overrides }
}

export function ovhSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return { provider: 'ovh', baseUrl: '', apiKey: '', model: '', ...overrides }
}
