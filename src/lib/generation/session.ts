import type { AiSettings } from '@/types/domain'
import { chatController, MAX_TOKENS } from '@/controllers/ai.controller'
import { modelOf } from '@/lib/ai/providers'

export interface SessionUsage {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  estimated: boolean
  calls: number
  startedAt: string
  durationMs: number
}

export class GenerationSession {
  private readonly startedAt = Date.now()
  private inputTokens = 0
  private outputTokens = 0
  private estimated = false
  private calls = 0

  constructor(
    readonly settings: AiSettings,
    readonly signal?: AbortSignal,
  ) {}

  async chat(content: string, systemPrompt: string, maxTokens = MAX_TOKENS): Promise<string> {
    const reply = await chatController(this.settings, content, systemPrompt, maxTokens, this.signal)
    this.calls++
    this.inputTokens += reply.usage.inputTokens
    this.outputTokens += reply.usage.outputTokens
    this.estimated ||= reply.usage.estimated
    return reply.text
  }

  usage(): SessionUsage {
    return {
      provider: this.settings.provider,
      model: modelOf(this.settings),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimated: this.estimated,
      calls: this.calls,
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Date.now() - this.startedAt,
    }
  }
}
