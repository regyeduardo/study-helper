import type { AiSettings } from '@/types/domain'
import { baseUrlOf, modelOf, providerOf } from '@/lib/ai/providers'

export interface ProbeReply {
  status: number
  text: string
  /** Pages the provider says the reply read (OpenAI-style url_citation annotations): only a real web search fills it. */
  cited: string[]
}

const TIMEOUT_MS = 60000

/** One small, non-streamed call with the given content parts (OpenAI or Anthropic shape). Throws only when nothing answers. */
export async function askOnceController(target: AiSettings, parts: unknown[], maxTokens: number, extra: Record<string, unknown> = {}): Promise<ProbeReply> {
  const anthropic = providerOf(target.provider).format === 'anthropic'
  const headers: Record<string, string> = anthropic
    ? { 'content-type': 'application/json', 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : { 'content-type': 'application/json', ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}) }
  const url = anthropic ? `${baseUrlOf(target)}/v1/messages` : `${baseUrlOf(target)}/chat/completions`
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { method: 'POST', headers, signal: control.signal, body: JSON.stringify({ ...extra, model: modelOf(target), max_tokens: maxTokens, messages: [{ role: 'user', content: parts }] }) })
    const raw = await response.text().catch(() => '')
    let text = ''
    let cited: string[] = []
    try {
      const body = JSON.parse(raw) as { content?: { text?: string }[]; choices?: { message?: { content?: string; annotations?: { url_citation?: { url?: string } }[] } }[] }
      text = anthropic ? (body.content ?? []).map(part => part.text ?? '').join('') : (body.choices?.[0]?.message?.content ?? '')
      cited = (body.choices?.[0]?.message?.annotations ?? []).flatMap(item => (item.url_citation?.url ? [item.url_citation.url] : []))
    } catch {
      text = ''
    }
    return { status: response.status, text, cited }
  } finally {
    clearTimeout(timer)
  }
}
