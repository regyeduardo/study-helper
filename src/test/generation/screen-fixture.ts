// A recorded call for the tests of the screen reading: 4 distinct screens (320 s) and a fake local OCR that reads each.
import { vi } from 'vitest'

import type { Box, FrameSource, OcrText, ScreenOcr, Shot } from '@/lib/generation/ata-types'

/** A sheet, the VGV cell, a formula in 7 px text, and an empty desktop. */
export const screenOf = (at: number) => (at < 50 ? 0 : at < 150 ? 1 : at < 250 ? 2 : 3)

export const OCR: OcrText[][] = [
  [{ text: 'Tabela de Vendas', confidence: 0.97 }, { text: 'Valor ticket médio 288.837,14', confidence: 0.95 }],
  [{ text: 'VGV corrigido', confidence: 0.96 }, { text: 'Duque de Caxias', confidence: 0.95 }],
  [{ text: 'Painel de Controle', confidence: 0.97 }, { text: '=SE(CZ297<$C$4;0;SE($CZ$8="FGT5"', confidence: 0.61 }],
  [],
]

/** Frame that never changes, tiles that always flicker, shared screen in the middle that changes in steps. */
export function recordedCall(steps = true, size = { width: 1920, height: 1080 }): FrameSource & { crops: Box[] } {
  const crops: Box[] = []
  const shot = (kind: string, at: number): Shot => ({ at, image: `data:image/jpeg;base64,${kind}-${at}`, width: 1280, height: 720, signature: new Array(1728).fill(screenOf(at) * 10) })
  return {
    crops,
    ...size,
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

export function fakeOcr(): ScreenOcr & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async (image: string) => OCR[screenOf(Number(/-(\d+(?:\.\d+)?)$/.exec(image)?.[1] ?? 0))]) }
}
