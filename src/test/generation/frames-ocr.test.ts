import { describe, expect, it, vi } from 'vitest'

import { lookAtScreen } from '@/lib/generation/frames'
import { polishTranscript } from '@/lib/generation/polish'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 10, text: 'Bom dia, vamos começar.' },
    { speaker: 'speaker_0', start: 12, end: 30, text: 'Bom dia. Eu cuido do financeiro.' },
    { speaker: 'speaker_1', start: 31, end: 60, text: 'Olha o BGV nessa planilha aqui.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Falante 2', suggested: false },
    { id: 'speaker_1', name: 'Falante 3', suggested: false },
  ],
  marks: [],
}

const vision = { provider: 'openai' as const, baseUrl: '', apiKey: 'sk-teste', model: 'gpt-visao' }

// What the local OCR reads on each grabbed frame: the tile names, the sheet, and a formula too small to be sure of.
const ocr = () => ({
  read: vi.fn(async (image: string) =>
    image.endsWith('-13')
      ? [{ text: 'Natália Lenza', confidence: 0.96 }, { text: 'Henrique Souza', confidence: 0.95 }]
      : [{ text: 'VGV 2026', confidence: 0.97 }, { text: 'FGT5', confidence: 0.58 }],
  ),
})

describe('the local OCR in the transcription', () => {
  it('without a vision model the OCR still reads the screen: its exact terms go to the review, the unsure ones do not', async () => {
    const session = { chat: vi.fn(async () => '{"horas": ["00:31"]}') } as unknown as GenerationSession
    const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [at, at, at, at] })))
    const see = vi.fn()
    const reader = ocr()
    const seen = await lookAtScreen(recording, new Blob(['v'], { type: 'video/webm' }), null, session, { grab, see, ocr: () => reader })
    expect(see).not.toHaveBeenCalled()
    expect(reader.read).toHaveBeenCalled()
    expect(seen.screenTerms).toEqual(expect.arrayContaining(['Natália Lenza', 'Henrique Souza', 'VGV']))
    expect(seen.screenTerms).not.toContain('FGT5')
    expect(seen.frames).toBeUndefined()
    expect(seen.warning).toMatch(/Leitura de tela/)
  })

  it('with a vision model the OCR runs next to it and adds its exact terms', async () => {
    const session = { chat: vi.fn(async () => '{"horas": ["00:31"]}') } as unknown as GenerationSession
    const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [at, at, at, at] })))
    const see = vi.fn(async (_settings: unknown, _images: string[], prompt: string) => (prompt === PROMPTS.SCREEN_TEXT_PROMPT ? '{"texto": "Planilha do VGV"}' : '{"nome": ""}'))
    const seen = await lookAtScreen(recording, new Blob(['v'], { type: 'video/webm' }), vision, session, { grab, see, ocr: ocr })
    expect(seen.frames?.map(frame => frame.text)).toEqual(['Planilha do VGV'])
    expect(seen.screenTerms).toContain('VGV')
  })

  it('the review gets the exact terms and only the pairs where the speech sounds like the screen', async () => {
    const chat = vi.fn(async (_user: string, _system: string) => '{"nomes": [], "correcoes": []}')
    await polishTranscript({ ...recording, screenTerms: ['VGV', 'Natália Lenza', 'Fluxo_Analitico'] }, { chat } as unknown as GenerationSession)
    const user = chat.mock.calls.map(call => call[0]).join('\n')
    expect(user).toContain('Escrito na tela durante a reunião')
    expect(user).toContain('Natália Lenza')
    expect(user).toContain('BGV → VGV')
    expect(user).not.toMatch(/planilha → /i)
  })
})
