import { describe, it, expect } from 'vitest'
import { withSpeakers } from '@/lib/transcription/speakers'

const turn = (start: number, end: number, speaker: string) => ({ start, end, speaker })
const segment = (start: number, end: number, text: string) => ({ start, end, text })

describe('withSpeakers', () => {
  it('without turns joins the text and skips empty segments', () => {
    expect(withSpeakers([segment(0, 1, 'oi'), segment(1, 2, ''), segment(2, 3, 'tudo bem')], [])).toBe('oi tudo bem')
  })

  it('labels each segment by the speaker with the most overlap and groups consecutive lines', () => {
    const turns = [turn(0, 5, 'Falante 1'), turn(5, 9, 'Falante 2'), turn(9, 12, 'Falante 1')]
    const text = withSpeakers([segment(0, 2, 'bom dia'), segment(2, 4.5, 'como vai'), segment(4, 8, 'vou bem'), segment(8.5, 11, 'que bom')], turns)
    expect(text).toBe('Falante 1: bom dia como vai\nFalante 2: vou bem\nFalante 1: que bom')
  })

  it('overlap is summed per speaker across split turns', () => {
    const turns = [turn(0, 1, 'Falante 1'), turn(1, 2.5, 'Falante 2'), turn(2.5, 4, 'Falante 1')]
    expect(withSpeakers([segment(0, 4, 'frase longa')], turns)).toBe('Falante 1: frase longa')
  })

  it('a segment in a gap keeps the current speaker, or gets "Falante ?" at the start', () => {
    const turns = [turn(10, 20, 'Falante 2')]
    expect(withSpeakers([segment(0, 2, 'antes'), segment(10, 12, 'dentro'), segment(25, 26, 'depois')], turns)).toBe('Falante ?: antes\nFalante 2: dentro depois')
  })

  it('zero-length segments count as no overlap', () => {
    expect(withSpeakers([segment(3, 3, 'ponto')], [turn(0, 5, 'Falante 1')])).toBe('Falante ?: ponto')
  })
})
