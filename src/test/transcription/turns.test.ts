import { describe, it, expect } from 'vitest'
import { blocksFromWords } from '@/lib/transcription/turns'

const turn = (start: number, end: number, speaker: string) => ({ start, end, speaker })
const word = (start: number, end: number, text: string) => ({ start, end, text })

describe('blocksFromWords', () => {
  it('cuts the speech where the speaker changes, inside the same 30 seconds', () => {
    const words = [word(2, 2.4, 'Quanto'), word(2.4, 2.9, 'custou'), word(2.9, 3.3, 'isso?'), word(4.1, 4.5, 'Custou'), word(4.5, 5, 'dois'), word(5, 5.6, 'mil.')]
    const blocks = blocksFromWords(words, [turn(1.8, 3.6, 'speaker_0'), turn(3.9, 6, 'speaker_1')])
    expect(blocks).toEqual([
      { speaker: 'speaker_0', start: 2, end: 3.3, text: 'Quanto custou isso?' },
      { speaker: 'speaker_1', start: 4.1, end: 5.6, text: 'Custou dois mil.' },
    ])
  })

  it('a word goes to the speaker it overlaps the most', () => {
    const blocks = blocksFromWords([word(0, 1, 'oi'), word(1.8, 2.6, 'tudo'), word(2.6, 3, 'bem')], [turn(0, 2, 'a'), turn(2, 3, 'b')])
    expect(blocks.map(block => [block.speaker, block.text])).toEqual([
      ['a', 'oi'],
      ['b', 'tudo bem'],
    ])
  })

  it('a word outside every turn stays with the nearest one', () => {
    const blocks = blocksFromWords([word(0, 0.4, 'então'), word(5, 5.5, 'certo'), word(9.2, 9.6, 'isso')], [turn(4, 6, 'a'), turn(9.8, 12, 'b')])
    expect(blocks.map(block => [block.speaker, block.text])).toEqual([
      ['a', 'então certo'],
      ['b', 'isso'],
    ])
  })

  it('the same speaker coming back opens a new block', () => {
    const blocks = blocksFromWords([word(0, 1, 'um'), word(2, 3, 'dois'), word(4, 5, 'três')], [turn(0, 1.5, 'a'), turn(1.5, 3.5, 'b'), turn(3.5, 6, 'a')])
    expect(blocks.map(block => block.speaker)).toEqual(['a', 'b', 'a'])
    expect(blocks[2]).toEqual({ speaker: 'a', start: 4, end: 5, text: 'três' })
  })

  it('without turns everything is one block with no speaker', () => {
    expect(blocksFromWords([word(0, 1, 'sem'), word(1, 2, 'falantes')], [])).toEqual([{ speaker: '', start: 0, end: 2, text: 'sem falantes' }])
  })

  it('empty words are skipped', () => {
    expect(blocksFromWords([word(0, 1, ' '), word(1, 2, 'fala')], [turn(0, 3, 'a')])).toEqual([{ speaker: 'a', start: 1, end: 2, text: 'fala' }])
  })
})
