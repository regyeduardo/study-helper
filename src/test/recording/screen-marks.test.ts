import { describe, expect, it, vi } from 'vitest'

// T201 (dono, 28/11: "Tudo em 1 min"; research R30): a gravação marca cada tela nova enquanto grava (a hora, a foto e o texto lido pelo
// OCR do navegador), para a leitura da tela não precisar decodificar o vídeo inteiro depois (hoje: 403 s no servidor para 1h30).

import type { OcrText } from '@/lib/generation/ata-types'
import { MARK_SETTLE_MS, ScreenMarks } from '@/lib/recording/screen-marks'

const later = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(ok => (resolve = ok))
  return { promise, resolve }
}

function marker(options: { clock?: () => number | null; ocr?: { read(image: string): Promise<OcrText[]> } | null } = {}) {
  let shot = 0
  const snapshot = vi.fn(() => `data:image/jpeg;base64,TELA${shot++}`)
  const ocr = options.ocr === undefined ? { read: vi.fn(async (image: string) => [{ text: `lido ${image.slice(-5)}`, confidence: 0.9 }]) } : options.ocr
  let seconds = 0
  const marks = new ScreenMarks({ clock: options.clock ?? (() => seconds), snapshot, ocr })
  return { marks, snapshot, ocr, at: (value: number) => (seconds = value) }
}

describe('a gravação marca as telas enquanto grava (T201)', () => {
  it('a primeira tela e cada conteúdo que muda e fica parado 1 s viram uma marca, na hora da gravação', async () => {
    const { marks, at } = marker()
    marks.look('none', 0)
    marks.tick(MARK_SETTLE_MS - 1)
    expect(marks.count).toBe(0)
    at(1)
    marks.tick(MARK_SETTLE_MS)
    expect(marks.count).toBe(1)
    // a slide changes at 10 s, the screen keeps still: one more mark 1 s later
    marks.look('content', 10_000)
    at(10.5)
    marks.tick(10_500)
    expect(marks.count).toBe(1)
    at(11)
    marks.tick(11_000)
    expect(marks.count).toBe(2)
    // nothing more changes: no more marks
    marks.tick(30_000)
    expect(marks.count).toBe(2)
    expect(marks.result(40, 1920, 1080)!.index.screens.map(screen => [screen.at, screen.end])).toEqual([
      [1, 11],
      [11, 40],
    ])
  })

  it('a câmera de quem fala não marca, e o que continua mudando espera ficar parado', () => {
    const { marks } = marker()
    marks.look('none', 0)
    marks.tick(1000)
    for (let now = 1100; now < 20_000; now += 100) {
      marks.look('camera', now)
      marks.tick(now)
    }
    expect(marks.count).toBe(1)
    // a video shown on the screen: content changing all the time, no mark until it stops
    for (let now = 20_000; now < 30_000; now += 100) {
      marks.look('content', now)
      marks.tick(now)
    }
    expect(marks.count).toBe(1)
    marks.tick(31_000)
    expect(marks.count).toBe(2)
  })

  it('a pausa não conta: com a gravação parada, a marca espera a volta, na hora da gravação', () => {
    let paused = false
    let seconds = 5
    const { marks } = marker({ clock: () => (paused ? null : seconds) })
    marks.look('none', 0)
    paused = true
    marks.tick(2000)
    expect(marks.count).toBe(0)
    paused = false
    seconds = 5.2
    marks.tick(9000)
    expect(marks.count).toBe(1)
    expect(marks.result(10, 1280, 720)!.index.screens[0].at).toBe(5.2)
  })

  it('o OCR lê uma tela por vez, e a tela cujo OCR não terminou sai sem texto', async () => {
    const first = later<OcrText[]>()
    const read = vi.fn((image: string) => (read.mock.calls.length === 1 ? first.promise : Promise.resolve([{ text: `lido ${image}`, confidence: 0.8 }])))
    const { marks } = marker({ ocr: { read } })
    marks.look('none', 0)
    marks.tick(1000)
    marks.look('content', 5000)
    marks.tick(6000)
    expect(marks.count).toBe(2)
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
    // the recording ends while the first is still being read
    const ended = marks.result(10, 1280, 720)!
    expect(ended.index.screens.every(screen => !screen.texts)).toBe(true)
    first.resolve([{ text: 'Pauta', confidence: 0.95 }])
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(marks.result(10, 1280, 720)!.index.screens[1].texts).toEqual([{ text: 'lido data:image/jpeg;base64,TELA1', confidence: 0.8 }]))
    expect(marks.result(10, 1280, 720)!.index.screens[0].texts).toEqual([{ text: 'Pauta', confidence: 0.95 }])
  })

  it('o resultado: o índice como a transcrição o guarda (a tela inteira, feito na gravação) e a foto de cada tela', () => {
    const { marks } = marker({ ocr: null })
    marks.look('none', 0)
    marks.tick(1000)
    const made = marks.result(3, 1920, 1080)!
    expect(made.index).toEqual({ width: 1920, height: 1080, area: { x: 0, y: 0, w: 1920, h: 1080 }, madeBy: 'gravacao', screens: [{ at: 0, end: 3 }] })
    expect(made.images).toEqual([{ at: 0, image: 'data:image/jpeg;base64,TELA0' }])
  })

  it('sem como olhar a tela (null) ou sem foto, nada é marcado', () => {
    const { marks, snapshot } = marker()
    marks.look(null, 0)
    marks.tick(5000)
    expect(marks.count).toBe(0)
    snapshot.mockReturnValue(null as unknown as string)
    marks.look('none', 6000)
    marks.tick(8000)
    expect(marks.count).toBe(0)
    expect(marks.result(10, 1280, 720)).toBeNull()
  })
})
