import { describe, expect, it, vi } from 'vitest'

import { distinctFrames, lookAtScreen, screenMoments } from '@/lib/generation/frames'
import type { GenerationSession } from '@/lib/generation/session'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 10, text: 'Bom dia, vamos começar.' },
    { speaker: 'speaker_0', start: 12, end: 30, text: 'Bom dia. Eu cuido do financeiro.' },
    { speaker: 'speaker_1', start: 31, end: 60, text: 'Olha esse slide aqui, o gráfico de vendas.' },
    { speaker: 'speaker_2', start: 61, end: 80, text: 'Concordo com os números.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Falante 2', suggested: false },
    { id: 'speaker_1', name: 'Falante 3', suggested: false },
    { id: 'speaker_2', name: 'Falante 4', suggested: false },
  ],
  marks: [],
}

const vision = { provider: 'openai' as const, baseUrl: '', apiKey: 'sk-teste', model: 'gpt-visao' }

describe('which moments of the screen are looked at', () => {
  it('the speech that asks for the screen gives t, t+2s and t+5s, and each speaker gives 1 frame of the first turn', () => {
    const moments = screenMoments(recording, [31])
    expect(moments.filter(moment => moment.kind === 'tela').map(moment => moment.at)).toEqual([31, 33, 36])
    expect(moments.filter(moment => moment.kind === 'falante').map(moment => moment.speaker)).toEqual(['speaker_0', 'speaker_1', 'speaker_2'])
    expect(moments.some(moment => moment.speaker === 'mic')).toBe(false)
  })

  it('a screen that did not change between t and t+5s is sent once', () => {
    const still = [1, 1, 1, 1]
    const kept = distinctFrames([
      { at: 31, image: 'a', signature: still },
      { at: 33, image: 'b', signature: still.map(value => value + 1) },
      { at: 36, image: 'c', signature: [200, 200, 200, 200] },
    ])
    expect(kept.map(frame => frame.at)).toEqual([31, 36])
  })

  it('only the chosen frames go to the vision model, and the screen text joins the note', async () => {
    const session = { chat: vi.fn(async () => '{"horas": ["00:31"]}') } as unknown as GenerationSession
    const still = [5, 5, 5, 5]
    const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: at >= 31 && at <= 36 ? still : [at, at, at, at] })))
    const see = vi.fn(async (_settings: unknown, images: string[], _prompt: string) => (images.length > 1 || images[0].startsWith('img-3') ? '{"texto": "Gráfico de vendas do trimestre"}' : '{"nome": ""}'))
    const seen = await lookAtScreen(recording, new Blob(['v'], { type: 'video/webm' }), vision, session, { grab, see })
    const asked = grab.mock.calls[0][1] as number[]
    expect(asked).toEqual(expect.arrayContaining([31, 33, 36]))
    expect(asked).toHaveLength(6)
    const screenCall = see.mock.calls[0]
    expect(screenCall[1]).toEqual(['img-31'])
    expect(seen.frames).toEqual([{ at: 31, image: 'img-31', text: 'Gráfico de vendas do trimestre' }])
  })
})
