import { describe, expect, it, vi } from 'vitest'

import { lookAtScreen } from '@/lib/generation/frames'
import type { GenerationSession } from '@/lib/generation/session'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 5, text: 'Oi, Mariana.' },
    { speaker: 'speaker_0', start: 6, end: 20, text: 'Oi! Vamos ver o orçamento.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Mariana', suggested: true },
  ],
  marks: [],
}

const vision = { provider: 'openai' as const, baseUrl: '', apiKey: 'sk-teste', model: 'gpt-visao' }

describe('the name on the screen', () => {
  it('corrects the name heard, without the suggestion mark', async () => {
    const session = { chat: vi.fn(async () => '{"horas": []}') } as unknown as GenerationSession
    const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [at] })))
    const see = vi.fn(async (_settings: unknown, _images: string[], prompt: string) => (prompt.includes('Mariana') ? '{"nome": "Marina Souza"}' : '{"nome": ""}'))
    const seen = await lookAtScreen(recording, new Blob(['v'], { type: 'video/webm' }), vision, session, { grab, see })
    expect(seen.speakers[1]).toEqual({ id: 'speaker_0', name: 'Marina Souza', suggested: false })
    expect(seen.speakers[0]).toEqual(recording.speakers[0])
  })

  it('keeps the name heard when the screen shows no name', async () => {
    const session = { chat: vi.fn(async () => '{"horas": []}') } as unknown as GenerationSession
    const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [at] })))
    const see = vi.fn(async () => '{"nome": ""}')
    const seen = await lookAtScreen(recording, new Blob(['v'], { type: 'video/webm' }), vision, session, { grab, see })
    expect(seen.speakers).toEqual(recording.speakers)
  })
})
