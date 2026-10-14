import { describe, expect, it, vi } from 'vitest'

import { lookAtScreen, screenMoments } from '@/lib/generation/frames'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { reviewTranscript } from '@/lib/generation/reviewer'
import type { GenerationSession } from '@/lib/generation/session'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 20, text: 'Bom dia, vamos começar.' },
    { speaker: 'speaker_0', start: 21, end: 70, text: 'Ontem eu falei com o João Vito sobre o contrato.' },
    { speaker: 'speaker_0', start: 71, end: 130, text: 'Ele pediu o prazo até sexta.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Falante 2', suggested: false },
  ],
  marks: [],
}

const vision = { provider: 'openai' as const, baseUrl: '', apiKey: 'sk-teste', model: 'gpt-visao' }

describe('name written on the screen fixes the transcript', () => {
  it('the screen is also looked at regularly, not only where the agent asked', () => {
    const times = screenMoments(recording, []).filter(moment => moment.kind === 'tela').map(moment => moment.at)
    expect(times).toEqual([0, 60, 120])
  })

  it('a name on the screen, outside the moments the agent marked, reaches the reviewer and fixes what was misheard', async () => {
    const lookSession = { chat: vi.fn(async () => '{"horas": []}') } as unknown as GenerationSession
    const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [7, 7, 7, 7] })))
    const see = vi.fn(async (_settings: unknown, _images: string[], prompt: string) =>
      prompt === PROMPTS.SCREEN_TEXT_PROMPT ? '{"texto": "Participantes: João Vitor Almeida, Você"}' : '{"nome": ""}',
    )
    const seen = await lookAtScreen(recording, new Blob(['v'], { type: 'video/webm' }), vision, lookSession, { grab, see })
    expect(seen.frames?.map(frame => frame.text)).toEqual(['Participantes: João Vitor Almeida, Você'])
    expect(see.mock.calls.filter(call => call[2] === PROMPTS.SCREEN_TEXT_PROMPT)).toHaveLength(1)

    const reviewSession = {
      chat: vi.fn(async (input: string) =>
        input.includes('João Vitor Almeida') ? '{"correcoes": [{"fala": 2, "de": "João Vito", "para": "João Vitor", "motivo": "nome na tela"}]}' : '{"correcoes": []}',
      ),
    } as unknown as GenerationSession
    const reviewed = await reviewTranscript(seen, reviewSession)
    expect(reviewed.blocks[1].text).toBe('Ontem eu falei com o João Vitor sobre o contrato.')
    expect(reviewed.blocks[2].text).toBe('Ele pediu o prazo até sexta.')
  })

  it('the prompts tell the agents to copy names on the screen and to trust them', () => {
    expect(PROMPTS.SCREEN_TEXT_PROMPT).not.toContain('pediu para olharem a tela')
    expect(PROMPTS.SCREEN_TEXT_PROMPT).toContain('quadro')
    expect(PROMPTS.TRANSCRIPT_REVIEW_PROMPT).toContain('Escrito na tela')
  })
})
