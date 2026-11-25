import '@/test/account/storage-shim'
import { beforeEach, describe, expect, it } from 'vitest'

import { advance, clockOf, estimate, isStalled, progressText, sentence, startWait } from '@/lib/wait'
import { historyOf, recordWait } from '@/lib/wait-history'

// Princípio IV da constituição e spec 007 (FR-060 a FR-063, research R15): toda espera diz o que está acontecendo, quanto já foi,
// quando deve terminar (horário, recalculado a cada parte) e que não travou. Nada de porcentagem nem horário inventados.

const at = (hours: number, minutes: number, seconds = 0) => new Date(2026, 10, 24, hours, minutes, seconds).getTime()

describe('quanto já foi', () => {
  it('conta as partes com a unidade', () => {
    const wait = advance(startWait('gerando', { unit: 'pedaços', total: 6, now: at(1, 30) }), { done: 5 }, at(1, 40))
    expect(progressText(wait)).toBe('5 de 6 pedaços')
  })

  it('conta os bytes quando a parte é tamanho', () => {
    // o mesmo formatBytes do resto do app (base 1024)
    const wait = advance(startWait('Enviando a mídia', { totalBytes: 480 * 1024 ** 2, now: at(1, 0) }), { doneBytes: 120 * 1024 ** 2 }, at(1, 1))
    expect(progressText(wait)).toBe('120 MB de 480 MB')
  })

  it('sem total, diz o que já foi contado e que o total ainda não se sabe, sem porcentagem', () => {
    const wait = advance(startWait('Lendo o link', { unit: 'páginas lidas', now: at(1, 0) }), { done: 3 }, at(1, 0, 20))
    expect(progressText(wait)).toBe('3 páginas lidas · o total ainda não se sabe')
    expect(estimate(wait, at(1, 0, 21))).toBeNull()
  })
})

describe('quando deve terminar', () => {
  it('é um horário, pela média das últimas partes, e muda a cada parte', () => {
    let wait = startWait('gerando', { unit: 'pedaços', total: 6, now: at(1, 0) })
    wait = advance(wait, { done: 1 }, at(1, 2))
    wait = advance(wait, { done: 2 }, at(1, 4))
    const first = estimate(wait, at(1, 4))!
    expect(first.basis).toBe('parts')
    // 4 pedaços a 2 min cada: por volta de 01:12
    expect(clockOf(first.etaAt)).toBe('01:12')
    // as partes ficaram mais lentas: o horário muda, com peso maior nas recentes
    wait = advance(wait, { done: 3 }, at(1, 10))
    const second = estimate(wait, at(1, 10))!
    expect(second.etaAt).toBeGreaterThan(first.etaAt)
    expect(second.etaAt).toBeLessThan(at(1, 10) + 3 * 6 * 60_000 + 1)
  })

  it('antes da primeira parte, só com o histórico de esperas parecidas, e diz isso', () => {
    const wait = startWait('Escrevendo a Ata', { unit: 'etapas', total: 4, now: at(1, 0), history: { ms: 5 * 60_000, label: 'Atas' } })
    const guess = estimate(wait, at(1, 0, 10))!
    expect(guess.basis).toBe('history')
    expect(clockOf(guess.etaAt)).toBe('01:05')
    // sem histórico, não há horário até a primeira parte
    expect(estimate(startWait('Escrevendo a Ata', { unit: 'etapas', total: 4, now: at(1, 0) }), at(1, 0, 10))).toBeNull()
  })

  it('não mostra um horário que já passou: com o histórico vencido, espera a primeira parte', () => {
    const wait = startWait('Escrevendo a Ata', { unit: 'etapas', total: 4, now: at(1, 0), history: { ms: 60_000, label: 'Atas' } })
    expect(estimate(wait, at(1, 3))).toBeNull()
  })
})

describe('que não travou', () => {
  it('fica parado depois do dobro do tempo normal da etapa sem andar', () => {
    let wait = startWait('Lendo a tela', { unit: 'quadros', total: 40, now: at(1, 0), normalStepMs: 60_000 })
    wait = advance(wait, { done: 1, label: 'quadro 1 de 40 lido' }, at(1, 1))
    expect(wait.lastProgress).toBe('quadro 1 de 40 lido')
    expect(isStalled(wait, at(1, 2, 59))).toBe(false)
    expect(isStalled(wait, at(1, 3, 1))).toBe(true)
    // andou de novo: deixa de estar parado
    expect(isStalled(advance(wait, { done: 2 }, at(1, 3, 30)), at(1, 3, 31))).toBe(false)
  })

  it('o servidor pode dizer que parou (trabalho da conta)', () => {
    const wait = { ...startWait('Transcrevendo', { unit: 'pedaços', total: 12, now: at(1, 0) }), stalledSince: at(1, 5) }
    expect(isStalled(wait, at(1, 6))).toBe(true)
  })
})

describe('a frase do dono', () => {
  it('monta o exemplo da constituição', () => {
    let wait = startWait('gerando', { unit: 'pedaços', total: 6, now: at(1, 20) })
    for (let part = 1; part <= 5; part++) wait = advance(wait, { done: part }, at(1, 20 + part * 4))
    expect(sentence(wait, at(1, 40))).toBe('Ainda está gerando, sem travar: 5 dos 6 pedaços já saíram, e deve terminar por volta de 01:44')
  })

  it('parado, diz desde quando nada anda', () => {
    let wait = startWait('Escrevendo a Ata', { unit: 'etapas', total: 4, now: at(1, 30), normalStepMs: 60_000 })
    wait = advance(wait, { done: 1 }, at(1, 38))
    expect(sentence(wait, at(1, 45))).toBe('Nada andou desde 01:38.')
  })
})

describe('histórico local de esperas', () => {
  beforeEach(() => localStorage.clear())

  it('guarda as últimas 20 de cada tipo por conta e dá a mediana', () => {
    expect(historyOf('conta-a', 'youtube')).toBeNull()
    recordWait('conta-a', 'youtube', 10_000)
    expect(historyOf('conta-a', 'youtube')).toBeNull()
    recordWait('conta-a', 'youtube', 30_000)
    recordWait('conta-a', 'youtube', 20_000)
    expect(historyOf('conta-a', 'youtube')).toBe(20_000)
    expect(historyOf('conta-b', 'youtube')).toBeNull()
    for (let n = 0; n < 30; n++) recordWait('conta-a', 'youtube', 1_000)
    expect(historyOf('conta-a', 'youtube')).toBe(1_000)
  })
})
