import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildAta } from '@/lib/generation/ata'
import { appAi } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import type { Box, FrameSource, OcrText, ScreenOcr, Shot } from '@/lib/generation/ata-types'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { defaultIndex } from '@/lib/defaults'
import { installFetch, jsonResponse, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { fakeAi, meeting, textAnswer, visionAnswer } from '@/test/generation/ata-fixture'
import type { RecordingData, Settings } from '@/types/domain'

const startedAt = new Date(2026, 9, 28, 18, 15)
const difference = (a: number[], b: number[]) => Math.abs(a[0] - b[0])
const renderPrint = vi.fn(async (_image: string, _marks: unknown[], caption: string) => `data:image/jpeg;base64,PRINT ${caption}`)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// The 4 screens of the meeting (320 s): a sheet, the VGV cell, a formula in 7 px text, and an empty desktop.
const screenOf = (at: number) => (at < 50 ? 0 : at < 150 ? 1 : at < 250 ? 2 : 3)
const OCR: OcrText[][] = [
  [{ text: 'Tabela de Vendas', confidence: 0.97 }, { text: 'Valor ticket médio 288.837,14', confidence: 0.95 }],
  [{ text: 'VGV corrigido', confidence: 0.96 }, { text: 'Duque de Caxias', confidence: 0.95 }],
  [{ text: 'Painel de Controle', confidence: 0.97 }, { text: '=SE(CZ297<$C$4;0;SE($CZ$8="FGT5"', confidence: 0.61 }],
  [],
]

/** A recorded call: frame that never changes, tiles that always flicker, shared screen in the middle that changes in steps. */
function recordedCall(steps = true): FrameSource & { crops: Box[] } {
  const crops: Box[] = []
  const shot = (kind: string, at: number): Shot => ({ at, image: `data:image/jpeg;base64,${kind}-${at}`, width: 1280, height: 720, signature: new Array(1728).fill(screenOf(at) * 10) })
  return {
    crops,
    width: 1920,
    height: 1080,
    duration: 320,
    full: async at => shot('full', at),
    crop: async (at, box) => (crops.push(box), shot('crop', at)),
    thumbs: async (times, width, height) =>
      times.map(at => {
        const data = new Uint8Array(width * height)
        const screen = steps ? screenOf(at) : 0
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const inside = x >= width / 4 && x < (width * 3) / 4 && y >= (height * 2) / 9 && y < (height * 7) / 9
            data[y * width + x] = x >= width * 0.85 ? (Math.round(at) * 37 + x * 11 + y * 7) % 251 : inside ? ((x * (screen + 2)) % 9 < 4 ? 40 + screen * 50 : 230) : 120
          }
        return data
      }),
  }
}

function fakeOcr(): ScreenOcr & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async (image: string) => OCR[screenOf(Number(/-(\d+(?:\.\d+)?)$/.exec(image)?.[1] ?? 0))]) }
}

const marked: RecordingData = {
  ...meeting,
  marks: [
    { id: 'm1', kind: 'note', at: 215, text: 'ano 2030' },
    { id: 'm2', kind: 'mark', at: 305, text: '' },
  ],
}

// The transcription marks one moment where the speech needs the screen: "E o BGV corrigido entra quando?" (01:40).
const asks = (system: string, user: string) => (system === PROMPTS.SCREEN_ASKS_PROMPT ? '{"horas": ["01:40"]}' : textAnswer(system, user))
const MEANING = { tela: 'Planilha de VGV', o_que_mostra: 'A célula do VGV corrigido.', a_fala_se_refere_a: 'o VGV corrigido', termos: ['VGV'] }
const looks = (ai: ReturnType<typeof fakeAi>) => ai.calls.filter(call => call.pass === 'vision' && call.system.startsWith(P.SENTIDO_TELA.slice(0, 40)))

describe('the screen of the Ata: local index, local OCR, vision only where it matters', () => {
  it('every distinct screen is read locally; the vision model is asked only where the speech points and at each mark', async () => {
    const ai = fakeAi({ text: asks })
    const ocr = fakeOcr()
    const frames = recordedCall()
    await buildAta({ recording: marked, parts: ['resumo'], startedAt }, { ai, frames, difference, renderPrint, ocr })
    // 4 distinct screens, each read once by the OCR
    expect(ocr.read).toHaveBeenCalledTimes(4)
    // the area came from the mask: no AREA call, and every crop is the middle of the frame
    expect(ai.calls.some(call => call.system === P.AREA)).toBe(false)
    expect(frames.crops.every(box => box.x === 480 && box.y === 240 && box.w === 960 && box.h === 600)).toBe(true)
    // nothing is transcribed by the vision model anymore
    expect(ai.calls.some(call => call.system === P.LER_TELA)).toBe(false)
    // 1 pointed moment (01:40, the VGV screen) + 2 marks = 3 short questions
    const asked = looks(ai)
    expect(asked).toHaveLength(3)
    // each question brings the exact text, the doubtful text as a hint only, the speech and the note
    const pointed = asked.find(call => call.user.includes('crop-100'))!
    expect(pointed.system).toContain('VGV corrigido')
    expect(pointed.system).toContain('E o BGV corrigido entra quando?')
    const note = asked.find(call => call.system.includes('ano 2030'))!
    expect(note.system).toMatch(/dúvida[^\n]*FGT5/)
    expect(note.system).not.toMatch(/certeza[^\n]*FGT5/)
  })

  it('the exact terms of the OCR feed the glossary; the unsure ones never do; speech is corrected only where it agrees with the screen', async () => {
    const ai = fakeAi({ text: asks })
    await buildAta({ recording: marked, parts: ['resumo'], startedAt }, { ai, frames: recordedCall(), difference, renderPrint, ocr: fakeOcr() })
    const context = ai.calls.find(call => call.system === P.ENTENDER)!.user
    // the screen nobody pointed at still comes as text (cheap)
    expect(context).toContain('Tabela de Vendas')
    expect(context).toContain('Painel de Controle')
    expect(context).toMatch(/TERMOS EXATOS DA TELA[^\n]*VGV/)
    expect(context).toContain('BGV → VGV')
    expect(context).not.toContain('FGT5')
    expect(context).not.toContain('CZ297')
  })

  it('counted at the provider: no AREA, no LER_TELA, one short call per pointed screen and per mark', async () => {
    const settings: Settings = { ...defaultIndex().settings, ai: { provider: 'custom', baseUrl: 'https://ia.exemplo.dev/v1', apiKey: 'k', model: 'geral' }, vision: { provider: 'custom', model: 'visao' } }
    const { calls } = installFetch(request => {
      const content = ((request.body?.messages ?? []) as { content: unknown }[])[0]?.content
      if (Array.isArray(content)) {
        const prompt = String((content as { type: string; text?: string }[]).find(part => part.type === 'text')?.text ?? '')
        const image = String((content as { type: string; image_url?: { url: string } }[]).find(part => part.type === 'image_url')?.image_url?.url ?? '')
        const answer = prompt.startsWith(P.SENTIDO_TELA.slice(0, 40)) ? JSON.stringify(MEANING) : visionAnswer(image, prompt)
        return jsonResponse({ choices: [{ message: { content: answer } }] })
      }
      return openAiStream(asks(systemPromptOf(request), userContentOf(request)))
    })
    const ai = appAi(settings, undefined, { text: 1000, vision: 1000, backoffMs: 1 })
    expect(ai.hasVision).toBe(true)
    await buildAta({ recording: marked, parts: ['resumo'], startedAt }, { ai, frames: recordedCall(), difference, renderPrint, ocr: fakeOcr() })
    const vision = calls.filter(call => Array.isArray(((call.body?.messages ?? []) as { content: unknown }[])[0]?.content))
    const prompts = vision.map(call => String((((call.body?.messages as { content: { type: string; text?: string }[] }[])[0].content).find(part => part.type === 'text')?.text ?? '')))
    expect(prompts.filter(prompt => prompt === P.AREA || prompt === P.LER_TELA)).toEqual([])
    expect(prompts.filter(prompt => prompt.startsWith(P.SENTIDO_TELA.slice(0, 40)))).toHaveLength(3)
  })

  it('when the mask finds no shared area, the vision model finds it the old way', async () => {
    const ai = fakeAi({ text: asks })
    const frames = recordedCall(false)
    await buildAta({ recording: meeting, parts: ['resumo'], startedAt }, { ai, frames, difference, renderPrint, ocr: fakeOcr() })
    expect(ai.calls.filter(call => call.system === P.AREA).length).toBeGreaterThan(0)
    expect(frames.crops.every(box => box.x === 376 && box.y === 264 && box.w === 976 && box.h === 714)).toBe(true)
  })

  it('without a vision model the OCR alone still reads the screen and fixes the terms; nothing goes to a vision model', async () => {
    const ai = fakeAi({ vision: false, text: asks })
    const ocr = fakeOcr()
    const done = await buildAta({ recording: marked, parts: ['resumo'], startedAt }, { ai, frames: recordedCall(), difference, renderPrint, ocr })
    expect(ai.calls.some(call => call.pass === 'vision')).toBe(false)
    expect(ocr.read).toHaveBeenCalled()
    expect(ai.calls.find(call => call.system === P.ENTENDER)!.user).toContain('BGV → VGV')
    expect(done.markdown).toContain('## Marcados durante a gravação')
  })
})

describe('the marks of the recording in the Ata', () => {
  it('each mark is a must-look moment and gets a line: clickable time, its note, what was on screen and what was being said', async () => {
    const ai = fakeAi({ text: asks })
    const done = await buildAta({ recording: marked, parts: ['resumo'], startedAt }, { ai, frames: recordedCall(), difference, renderPrint, ocr: fakeOcr() })
    const md = done.markdown
    expect(md).toContain('## Marcados durante a gravação')
    const lines = md.slice(md.indexOf('## Marcados durante a gravação')).split('\n').filter(line => line.startsWith('- '))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[▸ 03:35](#t=215) **ano 2030**')
    expect(lines[0]).toContain('Painel de Controle')
    expect(lines[0]).toContain('O BGV corrigido fica para sexta')
    expect(lines[1]).toContain('[▸ 05:05](#t=305)')
    expect(lines[1]).toContain('Fechado então')
  })

  it('without marks there is no block', async () => {
    const done = await buildAta({ recording: meeting, parts: ['resumo'], startedAt }, { ai: fakeAi({ text: asks }), frames: recordedCall(), difference, renderPrint, ocr: fakeOcr() })
    expect(done.markdown).not.toContain('Marcados durante a gravação')
  })

  it('an audio-only recording with marks lists them by the speech alone', async () => {
    const done = await buildAta({ recording: marked, parts: ['resumo'], startedAt }, { ai: fakeAi({ vision: false }), frames: null, difference, renderPrint })
    const md = done.markdown
    expect(md).toContain('[▸ 03:35](#t=215) **ano 2030**')
    expect(md).not.toContain('Na tela')
  })
})
