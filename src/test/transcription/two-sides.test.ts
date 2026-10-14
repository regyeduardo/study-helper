import { describe, expect, it } from 'vitest'

import { SAMPLE_RATE } from '@/lib/transcription/audio'
import { blocksFromWords, computerWords, microphoneWords, speakersOf } from '@/lib/transcription/turns'

const turn = (start: number, end: number, speaker: string) => ({ start, end, speaker })
const word = (start: number, end: number, text: string) => ({ start, end, text })

function channel(...stretches: [number, number][]): Float32Array {
  const samples = new Float32Array(stretches.reduce((sum, [seconds]) => sum + seconds, 0) * SAMPLE_RATE)
  let at = 0
  for (const [seconds, level] of stretches) {
    for (let index = 0; index < seconds * SAMPLE_RATE; index++) samples[at + index] = index % 2 ? level : -level
    at += seconds * SAMPLE_RATE
  }
  return samples
}

const sides = {
  microphone: channel([3, 0.4], [3, 0], [2, 0.4], [2, 0]),
  computer: channel([3, 0], [3, 0.4], [2, 0.3], [2, 0.4]),
}

const words = [
  word(0.5, 1.5, 'Oi'),
  word(1.5, 2.5, 'pessoal.'),
  word(3, 4, 'Tudo'),
  word(4, 5, 'certo.'),
  word(6.2, 7.5, 'Eu'),
  word(8.2, 9.5, 'concordo.'),
]

const turns = [turn(0, 2.8, 'speaker_0'), turn(2.8, 5.8, 'speaker_1'), turn(5.8, 10, 'speaker_0')]

describe('microphone is always "Você", people are only told apart on the computer side', () => {
  it('your speech over the computer sound stays "Você", and the computer speech the service gave to you goes to the person on the computer', () => {
    const blocks = blocksFromWords(words, turns, microphoneWords(sides), computerWords(sides))
    expect(blocks.map(block => [block.speaker, block.text])).toEqual([
      ['mic', 'Oi pessoal.'],
      ['speaker_1', 'Tudo certo.'],
      ['mic', 'Eu'],
      ['speaker_1', 'concordo.'],
    ])
    expect(speakersOf(blocks).map(speaker => speaker.name)).toEqual(['Você', 'Falante 2'])
  })

  it('with no computer sound nothing changes: a meeting in the room keeps the speakers the service found', () => {
    const room = { microphone: channel([10, 0.4]), computer: channel([10, 0]) }
    const blocks = blocksFromWords(words, turns, microphoneWords(room), computerWords(room))
    expect([...new Set(blocks.map(block => block.speaker))]).toEqual(['speaker_0', 'speaker_1'])
  })
})
