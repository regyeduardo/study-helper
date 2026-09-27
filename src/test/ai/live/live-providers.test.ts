import { describe, it, vi } from 'vitest'
import { AiError, chatController } from '@/controllers/ai.controller'
import type { AiSettings } from '@/types/domain'

const LIVE = process.env.LIVE === '1'

async function attempt(label: string, settings: AiSettings): Promise<void> {
  const started = Date.now()
  try {
    const reply = await chatController(settings, 'Responda em uma frase curta: qual é a capital do Brasil?', 'Você é um assistente conciso. Responda em português.', 200)
    console.log(`[LIVE] ${label} OK in ${Date.now() - started} ms usage=${JSON.stringify(reply.usage)} text=${JSON.stringify(reply.text.slice(0, 200))}`)
  } catch (error) {
    console.log(`[LIVE] ${label} FAILED in ${Date.now() - started} ms ${error instanceof AiError ? 'AiError' : 'Error'}: ${String(error instanceof Error ? error.message : error).slice(0, 400)}`)
  }
}

describe.skipIf(!LIVE)('live keyless providers', () => {
  it('LLM7 without key', async () => {
    await attempt('llm7', { provider: 'llm7', baseUrl: '', apiKey: '', model: '' })
  }, 90000)

  it('Pollinations without key', async () => {
    await attempt('pollinations', { provider: 'pollinations', baseUrl: '', apiKey: '', model: '' })
  }, 90000)

  it('Pollinations without key with a browser Origin header', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => original(input, { ...init, headers: { ...(init?.headers as Record<string, string>), Origin: 'https://study-helper.example' } }))
    try {
      await attempt('pollinations+origin', { provider: 'pollinations', baseUrl: '', apiKey: '', model: '' })
    } finally {
      vi.unstubAllGlobals()
    }
  }, 90000)
})
