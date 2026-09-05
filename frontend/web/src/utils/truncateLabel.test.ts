import { describe, it, expect } from 'vitest'
import { truncateLabel } from './truncateLabel'

describe('truncateLabel', () => {
  it('returns empty string for empty input', () => {
    expect(truncateLabel('')).toBe('')
  })
  it('returns full text for single word ≤ 25 chars', () => {
    expect(truncateLabel('Biologia')).toBe('Biologia')
  })
  it('returns full text for two words ≤ 25 chars', () => {
    expect(truncateLabel('Biologia Celular')).toBe('Biologia Celular')
  })
  it('returns full text for three words exactly 22 chars', () => {
    expect(truncateLabel('Engenharia de Software')).toBe('Engenharia de Software')
  })
  it('drops last word for three words 28 chars', () => {
    expect(truncateLabel('Desenvolvimento Web Avançado')).toBe('Desenvolvimento Web…')
  })
  it('drops last word for four words 34 chars', () => {
    expect(truncateLabel('Processamento de Linguagem Natural')).toBe('Processamento de Linguagem…')
  })
  it('returns "…" for a single long word > 25 chars', () => {
    expect(truncateLabel('abcdefghijklmnopqrstuvwxyz')).toBe('…')
  })
})
