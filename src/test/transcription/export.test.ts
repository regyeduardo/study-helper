import { describe, expect, it } from 'vitest'

import { transcriptSrt, transcriptText } from '@/lib/transcription/export'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 4.2, text: 'Quanto custou isso?' },
    { speaker: 'speaker_0', start: 72.5, end: 80, text: 'Custou dois mil.' },
    { speaker: 'mic', start: 3725.04, end: 3730.9, text: 'Fechado.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Marina', suggested: true },
  ],
  marks: [],
}

describe('transcriptText', () => {
  it('writes one line per speech as "Nome [hora]: fala"', () => {
    expect(transcriptText(recording)).toBe('Você [00:00]: Quanto custou isso?\nMarina [01:12]: Custou dois mil.\nVocê [1:02:05]: Fechado.\n')
  })

  it('without speakers keeps the time and the speech', () => {
    expect(
      transcriptText({
        blocks: [{ speaker: '', start: 5, end: 9, text: 'Bom dia a todos.' }],
        speakers: [],
        marks: [],
      }),
    ).toBe('[00:05] Bom dia a todos.\n')
  })
})

describe('transcriptSrt', () => {
  it('numbers each speech, with start and end in SRT time and the speaker in front', () => {
    expect(transcriptSrt(recording)).toBe(['1', '00:00:00,000 --> 00:00:04,200', 'Você: Quanto custou isso?', '', '2', '00:01:12,500 --> 00:01:20,000', 'Marina: Custou dois mil.', '', '3', '01:02:05,040 --> 01:02:10,900', 'Você: Fechado.', ''].join('\n'))
  })

  it('a speech without an end still gets a positive duration, and without speakers no name', () => {
    expect(
      transcriptSrt({
        blocks: [{ speaker: '', start: 5, end: 5, text: 'Bom dia.' }],
        speakers: [],
        marks: [],
      }),
    ).toBe('1\n00:00:05,000 --> 00:00:06,000\nBom dia.\n')
  })
})
