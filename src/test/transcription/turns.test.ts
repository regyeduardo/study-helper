import { describe, it, expect } from 'vitest'
import { blocksFromWords, wordsInSpeech } from '@/lib/transcription/turns'

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

describe('wordsInSpeech', () => {
  it('drops the words Whisper invents in the silence, outside every stretch of voice', () => {
    const words = [word(4, 4.6, 'Tchau.'), word(34.4, 34.8, 'Pode'), word(34.8, 35.1, 'ir?'), word(38.2, 38.7, 'Obrigado.'), word(41.9, 42.3, 'É'), word(44.9, 45.6, 'isso.')]
    const kept = wordsInSpeech(words, [turn(34.4, 35.2, 'a'), turn(41.8, 44.4, 'b'), turn(44.8, 45.1, 'b')])
    expect(kept.map(item => item.text)).toEqual(['Pode', 'ir?', 'É', 'isso.'])
  })

  it('keeps every word when the voices were not separated', () => {
    const words = [word(4, 4.6, 'Tchau.'), word(10, 10.4, 'oi')]
    expect(wordsInSpeech(words, [])).toEqual(words)
  })
})

describe('a sentence and its speaker', () => {
  it('a few words of a sentence given to someone else go back to who said the rest', () => {
    const words = [word(1, 1.3, 'Essa'), word(1.3, 1.6, 'aí'), word(1.6, 1.9, 'eu'), word(1.9, 2.3, 'entendi,'), word(2.3, 2.6, 'é'), word(2.6, 2.8, 'só'), word(2.8, 3.1, 'arrumar'), word(3.1, 3.3, 'o'), word(3.3, 3.6, 'campo'), word(3.7, 4, 'ali.')]
    const blocks = blocksFromWords(words, [turn(0.9, 3.65, 'a'), turn(3.65, 4.2, 'b')])
    expect(blocks.map(block => [block.speaker, block.text])).toEqual([['a', 'Essa aí eu entendi, é só arrumar o campo ali.']])
  })

  it('a real change of speaker in the middle of a long sentence stays', () => {
    const words = [word(1, 1.3, 'um'), word(1.3, 1.6, 'dois'), word(1.6, 1.9, 'três'), word(2, 2.3, 'quatro'), word(2.3, 2.6, 'cinco'), word(2.6, 2.9, 'seis'), word(3, 3.3, 'sete'), word(3.3, 3.6, 'oito.')]
    const blocks = blocksFromWords(words, [turn(0.9, 1.95, 'a'), turn(1.95, 3.7, 'b')])
    expect(blocks.map(block => block.speaker)).toEqual(['a', 'b'])
  })
})
