import { describe, expect, it, vi } from 'vitest'

import { buildAta } from '@/lib/generation/ata'
import * as P from '@/lib/generation/ata-prompts'
import { lookAtScreen, type ScreenTools } from '@/lib/generation/frames'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { indexAndRead } from '@/lib/generation/screen-reading'
import type { GenerationSession } from '@/lib/generation/session'
import { fakeAi, meeting, textAnswer } from '@/test/generation/ata-fixture'
import { fakeOcr, OCR, recordedCall } from '@/test/generation/screen-fixture'
import type { RecordingData, ScreenIndex } from '@/types/domain'

const startedAt = new Date(2026, 9, 28, 18, 15)
const difference = (a: number[], b: number[]) => Math.abs(a[0] - b[0])
const renderPrint = vi.fn(async () => 'data:image/jpeg;base64,PRINT')
const marked: RecordingData = {
  ...meeting,
  marks: [
    { id: 'm1', kind: 'note', at: 215, text: 'ano 2030' },
    { id: 'm2', kind: 'mark', at: 305, text: '' },
  ],
}
// The speech needs the screen once: "E o BGV corrigido entra quando?" (01:40).
const asks = (system: string, user: string) => (system === PROMPTS.SCREEN_ASKS_PROMPT ? '{"horas": ["01:40"]}' : textAnswer(system, user))
const SAVED: ScreenIndex = {
  width: 1920,
  height: 1080,
  area: { x: 480, y: 240, w: 960, h: 600 },
  screens: [
    { at: 1, end: 51, texts: OCR[0] },
    { at: 51, end: 151, texts: OCR[1] },
    { at: 151, end: 251, texts: OCR[2] },
    { at: 251, end: 320, texts: OCR[3] },
  ],
}

describe('what the transcription keeps of the screen', () => {
  it('the index of the video, with the text of each distinct screen, is plain data that survives the sidecar', async () => {
    const ocr = fakeOcr()
    const kept = (await indexAndRead(recordedCall(), ocr))!
    expect(kept).toMatchObject({ width: 1920, height: 1080, area: { x: 480, y: 240, w: 960, h: 600 } })
    expect(kept.screens).toHaveLength(4)
    expect(kept.screens.map(screen => screen.texts)).toEqual(OCR)
    expect(ocr.read).toHaveBeenCalledTimes(4)
    expect(JSON.parse(JSON.stringify(kept))).toEqual(kept)
  })

  it('without the OCR the screens are kept without text; a screen the OCR failed on is kept without text too', async () => {
    const bare = (await indexAndRead(recordedCall(), null))!
    expect(bare.screens).toHaveLength(4)
    expect(bare.screens.every(screen => !('texts' in screen))).toBe(true)
    const odd = { read: vi.fn(async (image: string) => (image.endsWith('-51') ? Promise.reject(new Error('quebrou')) : fakeOcr().read(image))) }
    const partial = (await indexAndRead(recordedCall(), odd))!
    expect(partial.screens.map(screen => screen.texts)).toEqual([OCR[0], undefined, OCR[2], OCR[3]])
  })

  it('no mask area means nothing is kept (the Ata finds the area the old way); no thumbnails or a cancel keep nothing', async () => {
    expect(await indexAndRead(recordedCall(false), fakeOcr())).toBeNull()
    const noThumbs = { ...recordedCall(), thumbs: undefined }
    expect(await indexAndRead(noThumbs, fakeOcr())).toBeNull()
    const stop = new AbortController()
    stop.abort()
    expect(await indexAndRead(recordedCall(), fakeOcr(), stop.signal)).toBeNull()
  })
})

describe('the transcription step saves it with the recording', () => {
  const video = new Blob(['v'], { type: 'video/webm' })
  const session = { chat: vi.fn(async () => '{"horas": ["00:31"]}') } as unknown as GenerationSession
  const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [at, at, at, at] })))
  const vision = { provider: 'openai' as const, baseUrl: '', apiKey: 'sk-teste', model: 'gpt-visao' }
  const reader = () => ({ read: vi.fn(async () => [{ text: 'VGV 2026', confidence: 0.97 }]) })

  it('with or without a vision model, the index comes with the recording, built over the video and the same OCR', async () => {
    const index = vi.fn(async () => SAVED)
    const ocr = reader()
    const tools: ScreenTools = { grab, see: vi.fn(async () => '{"texto": "Planilha"}'), ocr: () => ocr, index }
    const heard = await lookAtScreen(meeting, video, null, session, tools)
    expect(heard.screenIndex).toEqual(SAVED)
    expect(index).toHaveBeenCalledWith(video, ocr, session.signal)
    expect((await lookAtScreen(meeting, video, vision, session, tools)).screenIndex).toEqual(SAVED)
  })

  it('a failed or empty index never fails the look: the recording just comes without it', async () => {
    const make = (index: ScreenTools['index']): ScreenTools => ({ grab, see: vi.fn(async () => '{"texto": "Planilha"}'), ocr: reader, index })
    for (const index of [vi.fn(async () => null), vi.fn(async () => Promise.reject(new Error('sem miniaturas'))), undefined]) {
      const heard = await lookAtScreen(meeting, video, vision, session, make(index))
      expect(heard.screenIndex).toBeUndefined()
      expect(heard.frames?.map(frame => frame.text)).toEqual(['Planilha'])
      expect(heard.screenTerms).toContain('VGV')
    }
  })

  it('without a vision model and without an OCR the video is not looked at (nothing to build)', async () => {
    const index = vi.fn(async () => SAVED)
    const heard = await lookAtScreen(meeting, video, null, session, { grab, see: vi.fn(), ocr: () => null, index })
    expect(heard.screenIndex).toBeUndefined()
    expect(index).not.toHaveBeenCalled()
  })
})

describe('the Ata reuses it', () => {
  const run = async (recording: RecordingData, options: { vision?: boolean; frames?: ReturnType<typeof recordedCall>; ocr?: ReturnType<typeof fakeOcr> } = {}) => {
    const ai = fakeAi({ vision: options.vision, text: asks })
    const frames = options.frames ?? recordedCall()
    const thumbs = vi.fn(frames.thumbs!)
    frames.thumbs = thumbs
    const ocr = options.ocr ?? fakeOcr()
    const done = await buildAta({ recording, parts: ['resumo'], startedAt }, { ai, frames, difference, renderPrint, ocr })
    return { ai, frames, thumbs, ocr, done }
  }
  const context = (ai: ReturnType<typeof fakeAi>) => ai.calls.find(call => call.system === P.ENTENDER)!.user

  it('with the saved index: no thumbnails, no OCR, no area question; only the pointed moment and the marks are cropped, and the Ata reads the same', async () => {
    const fresh = await run(marked)
    const saved = await run({ ...marked, screenIndex: SAVED })
    expect(fresh.thumbs).toHaveBeenCalled()
    expect(fresh.ocr.read).toHaveBeenCalledTimes(4)
    expect(saved.thumbs).not.toHaveBeenCalled()
    expect(saved.ocr.read).not.toHaveBeenCalled()
    expect(saved.ai.calls.some(call => call.system === P.AREA || call.system === P.LER_TELA)).toBe(false)
    // 1 pointed moment (01:40) + 2 marks + the print the Resumo asks for, all cut from the saved area
    expect(saved.frames.crops).toHaveLength(4)
    expect(saved.frames.crops.every(box => box.x === 480 && box.y === 240 && box.w === 960 && box.h === 600)).toBe(true)
    expect(saved.ai.calls.filter(call => call.pass === 'vision' && call.system.startsWith(P.SENTIDO_TELA.slice(0, 40)))).toHaveLength(3)
    expect(context(saved.ai)).toBe(context(fresh.ai))
    expect(saved.done.markdown).toBe(fresh.done.markdown)
  })

  it('without a vision model the saved index still gives the exact terms, with nothing opened at all', async () => {
    const saved = await run({ ...marked, screenIndex: SAVED }, { vision: false })
    expect(saved.thumbs).not.toHaveBeenCalled()
    expect(saved.ocr.read).not.toHaveBeenCalled()
    expect(saved.frames.crops).toHaveLength(0)
    expect(context(saved.ai)).toMatch(/TERMOS EXATOS DA TELA[^\n]*VGV/)
    expect(context(saved.ai)).toContain('BGV → VGV')
    expect(context(saved.ai)).not.toContain('FGT5')
  })

  it('a screen saved without text is read by the OCR now; the index is still not made again', async () => {
    const bare: ScreenIndex = { ...SAVED, screens: SAVED.screens.map(({ at, end }) => ({ at, end })) }
    const saved = await run({ ...marked, screenIndex: bare })
    expect(saved.thumbs).not.toHaveBeenCalled()
    expect(saved.ocr.read).toHaveBeenCalledTimes(4)
    expect(context(saved.ai)).toContain('Painel de Controle')
  })

  it('an index of another video size is not trusted: the Ata makes its own, as before', async () => {
    const other = await run({ ...marked, screenIndex: { ...SAVED, width: 1280, height: 720 } })
    expect(other.thumbs).toHaveBeenCalled()
    expect(other.ocr.read).toHaveBeenCalledTimes(4)
  })

  it('an empty saved index is not trusted either', async () => {
    const empty = await run({ ...marked, screenIndex: { ...SAVED, screens: [] } })
    expect(empty.thumbs).toHaveBeenCalled()
  })
})
