import type { AiSettings, Settings } from '@/types/domain'
import { AiError, Cancelled, chatController, visionController } from '@/controllers/ai.controller'
import { modelOf } from '@/lib/ai/providers'
import { visionSettingsOf } from '@/lib/generation/frames'

/** Text passes that can use their own model (Configurações › IA › Geral › Avançado). */
export type TextPass = 'context' | 'candidates' | 'review' | 'pending' | 'write'

export interface TextOptions {
  max?: number
  json?: boolean
  /** Default 0.2; the reviewer and "Ficou sem dono" use 0 (relatorio-v2). */
  temperature?: number
  /** Sent where the provider takes it (Node scripts); the app only varies nothing else. */
  seed?: number
}

/** The AI the Ata pipeline talks to. The app uses chat/vision controllers; Node scripts plug their own. */
export interface AtaAi {
  readonly hasVision: boolean
  text(pass: TextPass, system: string, user: string, options?: TextOptions): Promise<string>
  see(images: string[], prompt: string, maxTokens?: number): Promise<string>
  models(): Record<string, string>
  costUsd(): number | undefined
}

export const TEXT_TIMEOUT_MS = 300_000
export const VISION_TIMEOUT_MS = 90_000
export const ATTEMPTS = 4
const TEMPERATURE = 0.2
// Vision models like MiMo reason before answering: a low max_tokens cuts the JSON.
const MIN_VISION_TOKENS = 2000

// US$ per million tokens (input, output) of the models the reports chose (DeepInfra, 10/2026).
const PRICES: Record<string, [number, number]> = {
  'deepseek-ai/DeepSeek-V3.1': [0.25, 0.95],
  'deepseek-ai/DeepSeek-V4-Pro': [1.3, 2.6],
  'deepseek-ai/DeepSeek-V4.1-Flash': [0.2, 0.6],
  'Qwen/Qwen3.7-Max': [2.5, 7.5],
}

/** Reasoning models spend part of max_tokens thinking: give them double. */
export function tokensFor(model: string, max: number): number {
  return /flash|qwen|mimo|reason|think|r1/i.test(model) ? max * 2 : max
}

export function passSettings(settings: Settings, pass: TextPass): AiSettings {
  const model = settings.aiPasses?.[pass]?.trim()
  return model ? { ...settings.ai, model } : settings.ai
}

function retryable(error: unknown): boolean {
  if (!(error instanceof AiError)) return false
  const status = /\((\d{3})\)/.exec(error.message)?.[1]
  if (status) return status === '429' || status.startsWith('5')
  return /Não consegui falar com a IA/.test(error.message)
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled())
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Cancelled())), { once: true })
  })

/** One call with its own timeout and retries on 429/5xx/timeout. Cancelling the parent signal stops at once. */
export async function withRetry<T>(run: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; timeoutMs: number; attempts?: number; backoffMs?: number }): Promise<T> {
  const { signal, timeoutMs, attempts = ATTEMPTS, backoffMs = 3000 } = options
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new Cancelled()
    const own = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => ((timedOut = true), own.abort()), timeoutMs)
    const stop = () => own.abort()
    signal?.addEventListener('abort', stop, { once: true })
    try {
      return await run(own.signal)
    } catch (error) {
      if (signal?.aborted) throw new Cancelled()
      if (!timedOut && !retryable(error)) throw error
      last = timedOut ? new AiError(`A IA não respondeu em ${Math.round(timeoutMs / 1000)} s.`) : error
      if (attempt < attempts) await pause(backoffMs * attempt, signal)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
    }
  }
  throw last
}

/** The app's AI for the Ata: text passes use the Geral AI (with per-pass model), vision uses the Visão tab. */
export function appAi(settings: Settings, signal?: AbortSignal, timeouts = { text: TEXT_TIMEOUT_MS, vision: VISION_TIMEOUT_MS }): AtaAi {
  const vision = visionSettingsOf(settings)
  const used: Record<string, string> = {}
  let dollars = 0
  let priced = false
  return {
    hasVision: Boolean(vision),
    async text(pass, system, user, options = {}) {
      const ai = passSettings(settings, pass)
      const model = modelOf(ai)
      used[pass] = model
      const max = tokensFor(model, options.max ?? 6000)
      const reply = await withRetry(own => chatController(ai, user, system, max, own, options.temperature ?? TEMPERATURE), { signal, timeoutMs: timeouts.text })
      const price = PRICES[model]
      if (price) {
        priced = true
        dollars += (reply.usage.inputTokens * price[0] + reply.usage.outputTokens * price[1]) / 1e6
      }
      return reply.text
    },
    async see(images, prompt, maxTokens = 1500) {
      if (!vision) throw new AiError('Sem modelo de visão: escolha um em Configurações › IA › Visão.')
      used.vision = modelOf(vision)
      return withRetry(own => visionController(vision, images, prompt, own, Math.max(maxTokens, MIN_VISION_TOKENS)), { signal, timeoutMs: timeouts.vision })
    },
    models: () => ({ ...used }),
    costUsd: () => (priced ? Math.round(dollars * 10000) / 10000 : undefined),
  }
}
