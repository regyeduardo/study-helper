import { describe, expect, it, vi } from 'vitest'

// T203 (dono, 28/11: "Tudo em 1 min"; research R30): com as telas marcadas na gravação, a leitura da tela não abre o vídeo: o quadro de um
// momento é a foto da tela marcada daquele momento, os termos saem do texto que o OCR leu na gravação, e o índice é o da gravação.

import type { GenerationSession } from '@/lib/generation/session'
import { lookAtScreen } from '@/lib/generation/frames'
import { markedFrameSource, markedTools, screenAt } from '@/lib/generation/marked-screens'
import type { RecordingData, ScreenIndex } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'speaker_0', start: 12, end: 30, text: 'Bom dia. Vamos ver a migração do Postgres.' },
    { speaker: 'speaker_1', start: 31, end: 60, text: 'Olha esse slide aqui, o SLA do suporte.' },
  ],
  speakers: [
    { id: 'speaker_0', name: 'Falante 1', suggested: false },
    { id: 'speaker_1', name: 'Falante 2', suggested: false },
  ],
  marks: [],
}
const INDEX: ScreenIndex = {
  width: 1920,
  height: 1080,
  area: { x: 0, y: 0, w: 1920, h: 1080 },
  madeBy: 'gravacao',
  screens: [
    { at: 1, end: 30, texts: [{ text: 'Migração do Postgres', confidence: 0.97 }] },
    { at: 30, end: 50, texts: [{ text: 'SLA do suporte', confidence: 0.96 }] },
    { at: 50, end: 80 },
  ],
}
const vision = { provider: 'openrouter' as const, baseUrl: '', apiKey: 'k', model: 'visao' }
const session = () => ({ chat: vi.fn(async () => '{"horas": ["00:31", "00:55"]}') }) as unknown as GenerationSession

function marked() {
  const image = vi.fn(async (n: number) => `data:image/jpeg;base64,TELA${n}`)
  const base = { grab: vi.fn(async () => []), see: vi.fn(async (_settings: unknown, images: string[]) => `{"texto": "lido de ${images.join(',')}", "nome": ""}`), ocr: vi.fn(() => ({ read: vi.fn(async () => [{ text: 'OCR de agora', confidence: 0.9 }]) })), index: vi.fn(async () => null) }
  return { tools: markedTools({ index: INDEX, image }, base), image, base }
}

describe('a leitura da tela pelas marcas da gravação (T203)', () => {
  it('a tela de um momento é a última marcada até ele (antes da primeira, a primeira)', () => {
    expect(screenAt(INDEX, 0)).toBe(0)
    expect(screenAt(INDEX, 29.9)).toBe(0)
    expect(screenAt(INDEX, 30)).toBe(1)
    expect(screenAt(INDEX, 79)).toBe(2)
    expect(screenAt(INDEX, 500)).toBe(2)
  })

  it('sem o vídeo: os quadros são as fotos das telas marcadas, o vídeo nunca é aberto, e o índice é o da gravação', async () => {
    const { tools, image, base } = marked()
    const seen = await lookAtScreen(recording, null, vision, session(), tools, { strict: true })
    expect(base.grab).not.toHaveBeenCalled()
    expect(base.index).not.toHaveBeenCalled()
    expect(image).toHaveBeenCalledWith(1)
    expect(image).toHaveBeenCalledWith(2)
    expect(seen.frames?.map(frame => frame.image)).toEqual(expect.arrayContaining(['data:image/jpeg;base64,TELA1']))
    expect(seen.screenIndex).toEqual(INDEX)
  })

  it('os termos saem do texto lido na gravação; só a tela sem texto passa pelo OCR de agora', async () => {
    const { tools, base } = marked()
    const seen = await lookAtScreen(recording, null, null, session(), tools)
    const ocr = base.ocr.mock.results[0]?.value as { read: ReturnType<typeof vi.fn> } | undefined
    // the moment 00:55 falls on the screen without text: only it is read now
    expect(ocr?.read.mock.calls.map(call => call[0])).toEqual(['data:image/jpeg;base64,TELA2'])
    expect(seen.screenTerms ?? []).toEqual(expect.any(Array))
  })

  it('uma foto que não vem (a parte faltou) não derruba a leitura: aquele momento fica de fora', async () => {
    const image = vi.fn(async (n: number) => (n === 1 ? null : `data:image/jpeg;base64,TELA${n}`))
    const see = vi.fn(async () => '{"texto": "algo", "nome": ""}')
    const tools = markedTools({ index: INDEX, image }, { grab: vi.fn(), see, ocr: () => null })
    const seen = await lookAtScreen(recording, null, vision, session(), tools)
    expect(seen.frames?.every(frame => frame.image !== 'data:image/jpeg;base64,TELA1')).toBe(true)
  })

  it('a fonte de quadros das marcas (para a conferência e a Ata): o tamanho e a duração do índice, e o quadro de um momento é a foto da tela daquele momento', async () => {
    const image = vi.fn(async (n: number) => `data:image/jpeg;base64,TELA${n}`)
    const frames = markedFrameSource({ index: INDEX, image })
    expect([frames.width, frames.height, frames.duration]).toEqual([1920, 1080, 80])
    const shot = await frames.full(35)
    expect(shot.image).toBe('data:image/jpeg;base64,TELA1')
    expect(shot.at).toBe(35)
    // the check of T188 looks for a dark video by the signature: a photo it cannot measure here is not taken for a dark one
    expect(shot.signature.some(value => value > 24)).toBe(true)
    expect((await frames.shots!([1, 60])).map(item => item?.image)).toEqual(['data:image/jpeg;base64,TELA0', 'data:image/jpeg;base64,TELA2'])
  })

  it('uma foto que não vem, na fonte de quadros, falha dizendo qual tela', async () => {
    const frames = markedFrameSource({ index: INDEX, image: async () => null })
    await expect(frames.full(10)).rejects.toThrow(/tela marcada/)
  })
})
