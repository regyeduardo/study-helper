import { describe, expect, it, vi } from 'vitest'

// T191 (dono, 27/11: "Corrija tudo… quero 0 problemas"): a Ata lia a tela com um pulo do <video> para cada recorte (no caminho antigo, até
// 400 para separar as telas e de novo para ler; no novo, um para cada tela que o OCR lê). Com uma fonte que lê muitos quadros numa
// passada, os recortes saem dela de uma vez, e a leitura dá o mesmo resultado.

import type { Box } from '@/lib/generation/ata-types'
import { readScreen } from '@/lib/generation/screen-reading'
import { fakeAi } from '@/test/generation/ata-fixture'
import { fakeOcr, recordedCall } from '@/test/generation/screen-fixture'

const difference = (a: number[], b: number[]) => Math.abs(a[0] - b[0])
const withShots = (steps = true) => {
  const source = recordedCall(steps)
  const crop = vi.spyOn(source, 'crop')
  const shots = vi.fn((times: number[], box?: Box) => Promise.all(times.map(at => (box ? source.crop(at, box) : source.full(at)))))
  return { source: { ...source, shots }, crop, shots }
}

describe('a Ata lê a tela numa passada (T191)', () => {
  it('o caminho antigo (sem o índice): todos os recortes numa chamada, e os escolhidos são lidos dos mesmos recortes, sem pular de novo', async () => {
    const plain = await readScreen(recordedCall(false), fakeAi(), difference)
    const { source, crop, shots } = withShots(false)
    crop.mockClear()
    const read = await readScreen(source, fakeAi(), difference)
    expect(shots).toHaveBeenCalledTimes(1)
    // the crops seen by the shots are the only ones (the spy counts the fake's own calls from inside shots)
    expect(crop).toHaveBeenCalledTimes(shots.mock.calls[0][0].length)
    expect(read.times).toEqual(plain.times)
    expect(read.readings.map(reading => reading.at)).toEqual(plain.readings.map(reading => reading.at))
  })

  it('o caminho novo (índice, OCR e onde a fala aponta): o OCR das telas vem de uma chamada, e o resultado é o mesmo', async () => {
    const looks = (ocr = fakeOcr()) => ({ ocr, asked: [100], marks: [], speech: () => '' })
    const plain = await readScreen(recordedCall(), fakeAi(), difference, () => {}, looks())
    const { source, shots } = withShots()
    const read = await readScreen(source, fakeAi(), difference, () => {}, looks())
    expect(shots).toHaveBeenCalled()
    expect(shots.mock.calls.length).toBeLessThanOrEqual(2)
    expect(read.screen).toEqual(plain.screen)
    expect(read.terms).toEqual(plain.terms)
  })
})
