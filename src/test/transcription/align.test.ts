import { describe, expect, it } from 'vitest'

import { alignWords } from '@/lib/transcription/align'

const word = (start: number, end: number, text: string) => ({ start, end, text })

describe('alignWords', () => {
  it('keeps the better words and takes the time of each one from the timed transcription', () => {
    const timed = [word(101, 101.4, 'Calcular'), word(101.4, 101.8, 'para'), word(101.8, 102.1, 'o'), word(102.1, 102.6, 'assolo'), word(102.6, 103, 'por'), word(103, 103.3, 'mês')]
    const words = alignWords(timed, 'Calcular pro soluto por mês.', 100, 400)
    expect(words.map(item => item.text)).toEqual(['Calcular', 'pro', 'soluto', 'por', 'mês.'])
    expect(words[0]).toMatchObject({ start: 101, end: 101.4 })
    expect(words[3]).toMatchObject({ start: 102.6, end: 103 })
    expect(words[4]).toMatchObject({ start: 103, end: 103.3 })
    for (let index = 1; index < words.length; index++) expect(words[index].start).toBeGreaterThanOrEqual(words[index - 1].start)
  })

  it('drops what only the timed transcription heard in the silence', () => {
    const timed = [word(4, 4.5, 'Tchau.'), word(9, 9.5, 'Obrigado.'), word(34.4, 34.8, 'Pode'), word(34.8, 35, 'ir,'), word(35, 35.3, 'Reg?')]
    expect(alignWords(timed, 'Pode ir, Reg?', 0, 300).map(item => item.text)).toEqual(['Pode', 'ir,', 'Reg?'])
  })

  it('keeps a long stretch the text left out, but not a repeated one', () => {
    const kept = [word(10, 10.3, 'aí'), word(10.3, 10.6, 'você'), word(10.6, 10.9, 'pega'), word(10.9, 11.2, 'o'), word(11.2, 11.6, 'período'), word(11.6, 12, 'menor')]
    const repeated = [word(20, 20.2, 'E'), word(20.2, 20.4, 'aí'), word(20.4, 20.6, 'E'), word(20.6, 20.8, 'aí'), word(20.8, 21, 'E'), word(21, 21.2, 'aí')]
    const words = alignWords([word(1, 1.4, 'Bom'), word(1.4, 1.8, 'dia'), ...kept, ...repeated, word(30, 30.4, 'Até'), word(30.4, 30.8, 'logo')], 'Bom dia. Até logo.', 0, 300)
    expect(words.map(item => item.text)).toEqual(['Bom', 'dia.', 'aí', 'você', 'pega', 'o', 'período', 'menor', 'Até', 'logo.'])
  })

  it('a word only the text heard comes right after the previous one', () => {
    const words = alignWords([word(50, 50.4, 'Tem'), word(60, 60.4, 'rápida')], 'Tem que fazer essa coisa rápida', 0, 300)
    expect(words.map(item => item.text)).toEqual(['Tem', 'que', 'fazer', 'essa', 'coisa', 'rápida'])
    expect(words[1].start).toBe(50.4)
    expect(words[1].end).toBeCloseTo(50.75)
    expect(words[4].end).toBeLessThanOrEqual(60)
  })

  it('without the text, the timed words stay as they are', () => {
    const timed = [word(1, 2, 'oi')]
    expect(alignWords(timed, '  ', 0, 300)).toBe(timed)
  })
})
