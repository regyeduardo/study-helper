import { describe, expect, it, vi } from 'vitest'
import { Cancelled } from '@/controllers/ai.controller'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import { titleFromTranscript } from '@/lib/generation/title'

function session(answer: () => Promise<string>): GenerationSession & { chat: ReturnType<typeof vi.fn> } {
  return { chat: vi.fn(answer) } as unknown as GenerationSession & { chat: ReturnType<typeof vi.fn> }
}

const TRANSCRIPT = 'Você: então fecha sexta? Ana: fecha, desde que o orçamento saia até quarta.'

describe('titleFromTranscript', () => {
  it('names the recording by its subject', async () => {
    const ai = session(async () => '{"titulo": "Prazo de sexta e orçamento do projeto"}')
    expect(await titleFromTranscript(TRANSCRIPT, ai)).toBe('Prazo de sexta e orçamento do projeto')
    expect(ai.chat).toHaveBeenCalledWith(expect.stringContaining('fecha sexta'), PROMPTS.TITLE_PROMPT, expect.any(Number))
  })

  it('cuts a title that came too long and drops quotes and the final period', async () => {
    const ai = session(async () => `{"titulo": "\\"${'Muito '.repeat(30)}longo.\\""}`)
    const title = await titleFromTranscript(TRANSCRIPT, ai)
    expect(title!.length).toBeLessThanOrEqual(80)
    expect(title).not.toMatch(/["“”.]$/)
    expect(title).not.toMatch(/^["“”]/)
  })

  it('gives nothing back when the AI fails or answers empty, so the date stays', async () => {
    expect(await titleFromTranscript(TRANSCRIPT, session(async () => { throw new Error('fora do ar') }))).toBeNull()
    expect(await titleFromTranscript(TRANSCRIPT, session(async () => '{"titulo": ""}'))).toBeNull()
    expect(await titleFromTranscript('   ', session(async () => '{"titulo": "x"}'))).toBeNull()
  })

  it('lets a cancel through', async () => {
    await expect(titleFromTranscript(TRANSCRIPT, session(async () => { throw new Cancelled() }))).rejects.toBeInstanceOf(Cancelled)
  })
})
