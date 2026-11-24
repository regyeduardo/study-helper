// T110 (spec 004, FR-028 a FR-030, FR-039): a repetição espaçada de cada card, com o FSRS-6 do Anki (retenção de 90%).
// O app corrige sozinho: errou = Again, acertou = Good, acertou só depois do card de aprender = Hard.
import { describe, expect, it } from 'vitest'

import { type Schedule, isDue, isFixed, isLeech, newSchedule, rate, review } from '@/lib/langs/fsrs'

const at = (iso: string) => new Date(iso)
const minutes = (from: Date, n: number) => new Date(from.getTime() + n * 60_000)
const days = (from: Date, n: number) => new Date(from.getTime() + n * 86_400_000)

describe('nota de cada resposta', () => {
  it('errou = Again; acertou = Good; acertou depois do card de aprender = Hard', () => {
    expect(rate(false, false)).toBe(1)
    expect(rate(false, true)).toBe(1)
    expect(rate(true, false)).toBe(3)
    expect(rate(true, true)).toBe(2)
  })
})

describe('repetição de um card', () => {
  it('card novo: acertar entra nos passos curtos (10 min) e depois vira revisão em dias', async () => {
    const t0 = at('2026-11-24T10:00:00Z')
    const first = await review('c1', newSchedule(), 3, t0)
    expect(first).toMatchObject({ state: 'learning', reps: 1, lapses: 0, dueAt: minutes(t0, 10).toISOString() })
    const second = await review('c1', first, 3, minutes(t0, 10))
    expect(second.state).toBe('review')
    expect(second.scheduledDays).toBeGreaterThanOrEqual(1)
    expect(isDue(second, minutes(t0, 11))).toBe(false)
    expect(isDue(second, days(t0, 30))).toBe(true)
  })

  it('errar um card de revisão volta a reaprender, com o card de novo em 10 min, e conta o erro', async () => {
    let s = newSchedule()
    let now = at('2026-11-24T10:00:00Z')
    s = await review('c2', s, 3, now)
    now = minutes(now, 10)
    s = await review('c2', s, 3, now)
    now = new Date(s.dueAt!)
    const wrong = await review('c2', s, 1, now)
    expect(wrong).toMatchObject({ state: 'relearning', lapses: 1, dueAt: minutes(now, 10).toISOString() })
  })

  it('acertar antes de vencer não adianta a revisão (a prática mostra todos os cards do texto)', async () => {
    let now = at('2026-11-24T10:00:00Z')
    let s = await review('c3', newSchedule(), 3, now)
    now = minutes(now, 10)
    s = await review('c3', s, 3, now)
    const early = await review('c3', s, 3, minutes(now, 60))
    expect(early).toEqual(s)
  })

  it('fixado = intervalo de 21 dias ou mais (o "maduro" do Anki)', async () => {
    let now = at('2026-11-24T10:00:00Z')
    let s: Schedule = newSchedule()
    for (let i = 0; i < 12 && !isFixed(s); i++) {
      s = await review('c4', s, 3, now)
      now = s.dueAt ? new Date(s.dueAt) : now
    }
    expect(isFixed(s)).toBe(true)
    expect(s.scheduledDays).toBeGreaterThanOrEqual(21)
  })

  it('8 erros depois de aprendido = leech', () => {
    expect(isLeech({ ...newSchedule(), lapses: 7 })).toBe(false)
    expect(isLeech({ ...newSchedule(), lapses: 8 })).toBe(true)
  })

  it('o mesmo card com as mesmas respostas dá as mesmas datas (a variação depende do card, não do acaso)', async () => {
    const run = async () => {
      let now = at('2026-11-24T10:00:00Z')
      let s = newSchedule()
      for (let i = 0; i < 6; i++) {
        s = await review('mesmo', s, 3, now)
        now = new Date(s.dueAt!)
      }
      return s
    }
    expect(await run()).toEqual(await run())
  })
})
