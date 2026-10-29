import { describe, expect, it, vi } from 'vitest'

import { distinctFrames, lookAtScreen, screenMoments } from '@/lib/generation/frames'
import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
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
    expect(moments.filter(moment => moment.kind === 'tela' && moment.from === 31).map(moment => moment.at)).toEqual([31, 33, 36])
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
    expect(asked).toEqual([13, 31, 32, 33, 36, 62])
    const screenCall = see.mock.calls[0]
    expect(screenCall[1]).toEqual(['img-31'])
    expect(seen.frames).toEqual([{ at: 31, image: 'img-31', text: 'Gráfico de vendas do trimestre' }])
  })

  it('without a speech that needs the screen, only the first turn of each speaker is looked at', () => {
    const moments = screenMoments(recording, [])
    expect(moments.filter(moment => moment.kind === 'tela')).toEqual([])
    expect(moments.map(moment => moment.at)).toEqual([13, 32, 62])
  })

  it('the agent marks the speech that needs the screen: names, siglas, terms and numbers said, and who is on the call', () => {
    const prompt = PROMPTS.SCREEN_ASKS_PROMPT
    for (const asked of ['sigla', 'termo', 'número', 'nome de pessoa', 'quadros da chamada', '"VGV"', '"Pró Soluto"']) expect(prompt).toContain(asked)
    expect(prompt).toContain('{"horas": ["12:40"]}')
  })
})

const video = new Blob(['v'], { type: 'video/webm' })
const asking = (hours: string[]) => ({ chat: vi.fn(async () => JSON.stringify({ horas: hours })) }) as unknown as GenerationSession
const everyScreenDiffers = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [at * 10, at * 10, at * 10, at * 10] })))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('the vision calls run side by side', () => {
  it('the screen and the speaker frames go to the vision model at once: the whole look takes about one call', async () => {
    let active = 0
    let peak = 0
    const see = vi.fn(async (_settings: unknown, _images: string[], prompt: string) => {
      active++
      peak = Math.max(peak, active)
      await wait(60)
      active--
      return prompt === PROMPTS.SCREEN_TEXT_PROMPT ? '{"texto": "Slide de vendas"}' : '{"nome": ""}'
    })
    const started = Date.now()
    await lookAtScreen(recording, video, vision, asking(['00:31']), { grab: everyScreenDiffers, see })
    const took = Date.now() - started
    expect(see).toHaveBeenCalledTimes(4)
    expect(peak).toBe(4)
    expect(took).toBeLessThan(3 * 60)
  })

  it('frames and names keep the order of the meeting even when the later calls answer first', async () => {
    let calls = 0
    const names: Record<string, string> = { 'Falante 2': 'Ana Lima', 'Falante 3': 'Bruno Dias', 'Falante 4': 'Carla Reis' }
    const see = vi.fn(async (_settings: unknown, images: string[], prompt: string) => {
      await wait(60 - 10 * calls++)
      if (prompt === PROMPTS.SCREEN_TEXT_PROMPT) return JSON.stringify({ texto: `Tela ${images[0]}` })
      const heard = Object.keys(names).find(name => prompt.includes(`"${name}"`))
      return JSON.stringify({ nome: heard ? names[heard] : '' })
    })
    const seen = await lookAtScreen(recording, video, vision, asking(['00:12', '01:01']), { grab: everyScreenDiffers, see })
    expect(seen.frames).toEqual([
      { at: 12, image: 'img-17', text: 'Tela img-12' },
      { at: 61, image: 'img-66', text: 'Tela img-61' },
    ])
    expect(seen.speakers.map(speaker => speaker.name)).toEqual(['Você', 'Ana Lima', 'Bruno Dias', 'Carla Reis'])
    expect(seen.speakers.slice(1).every(speaker => !speaker.suggested)).toBe(true)
  })

  it('a screen already read at an earlier moment is not sent again', async () => {
    const same = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [9, 9, 9, 9] })))
    const see = vi.fn(async (_settings: unknown, _images: string[], prompt: string) => (prompt === PROMPTS.SCREEN_TEXT_PROMPT ? '{"texto": "Mesmo slide"}' : '{"nome": ""}'))
    const seen = await lookAtScreen(recording, video, vision, asking(['00:12', '01:01']), { grab: same, see })
    expect(see.mock.calls.filter(call => call[2] === PROMPTS.SCREEN_TEXT_PROMPT)).toHaveLength(1)
    expect(seen.frames).toEqual([{ at: 12, image: 'img-12', text: 'Mesmo slide' }])
  })

  it('the pieces of a long transcript are asked about the screen at the same time', async () => {
    const long: RecordingData = {
      ...recording,
      blocks: [
        { speaker: 'speaker_0', start: 0, end: 30, text: 'a'.repeat(CHUNK_CHARS) },
        { speaker: 'speaker_1', start: 31, end: 60, text: 'b'.repeat(CHUNK_CHARS) },
      ],
    }
    let active = 0
    let peak = 0
    const chat = vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await wait(20)
      active--
      return '{"horas": []}'
    })
    await lookAtScreen(long, video, vision, { chat } as unknown as GenerationSession, { grab: vi.fn(async () => []), see: vi.fn() })
    expect(chat.mock.calls.length).toBeGreaterThan(1)
    expect(peak).toBe(chat.mock.calls.length)
  })
})
