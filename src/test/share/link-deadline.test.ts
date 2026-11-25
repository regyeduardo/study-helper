// Spec 007 (FR-032, FR-033): o prazo do link em palavras. Uma data de outro ano diz o ano; sem ele, "Venceu em 31/12" de um ano que
// passou parece um dia que ainda vem.
import { describe, expect, it } from 'vitest'

import { deadlineText } from '@/lib/link-deadline'

const TZ = 'America/Sao_Paulo'
const now = Date.parse('2026-11-24T15:00:00-03:00')

describe('o prazo do link em palavras', () => {
  it('hoje, amanhã, num dia deste ano e Permanente', () => {
    expect(deadlineText('2026-11-24T18:00:00-03:00', now, TZ)).toBe('vence hoje às 18:00')
    expect(deadlineText('2026-11-25T14:00:00-03:00', now, TZ)).toBe('vence amanhã às 14:00')
    expect(deadlineText('2026-12-01T09:30:00-03:00', now, TZ)).toBe('vence em 01/12 às 09:30')
    expect(deadlineText(null, now, TZ)).toBe('Permanente: vale até você parar de compartilhar')
  })

  it('vencido neste ano: o dia e a hora', () => {
    expect(deadlineText('2026-11-24T14:00:00-03:00', now, TZ)).toBe('Venceu em 24/11 às 14:00')
  })

  it('de outro ano: diz o ano, vencido ou por vencer', () => {
    expect(deadlineText('2025-12-31T21:00:00-03:00', now, TZ)).toBe('Venceu em 31/12/2025 às 21:00')
    const lateDecember = Date.parse('2026-12-29T10:00:00-03:00')
    expect(deadlineText('2027-01-05T10:00:00-03:00', lateDecember, TZ)).toBe('vence em 05/01/2027 às 10:00')
  })
})
