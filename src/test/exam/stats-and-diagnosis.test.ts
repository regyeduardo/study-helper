import { describe, expect, it } from 'vitest'

import type { Question } from '@/types/domain'
import { examStats, givenAnswerText, rightAnswerText } from '@/lib/exam'
import { gapExcerpt, readDiagnosis } from '@/lib/generation/diagnosis'

const unica = (id: number, correta: string): Question => ({ id, tipo: 'unica', enunciado: `Q${id}`, alternativas: { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' }, correta, explicacao: '' })

describe('examStats: nota só das questões feitas', () => {
  it('2 de 5 feitas, 1 certa → 50%, 3 sem fazer', () => {
    const questions = [unica(0, 'A'), unica(1, 'B'), unica(2, 'C'), unica(3, 'D'), unica(4, 'E')]
    const stats = examStats(questions, { 0: 'A', 1: 'C' }, { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 })
    expect(stats).toEqual({ done: 2, right: 1, partial: 0, wrong: 1, blank: 3, percent: 50 })
  })

  it('parcial conta pelo que acertou', () => {
    const questions = [unica(0, 'A'), { ...unica(1, 'A'), tipo: 'ordenar' as const, passos: ['1', '2'] }]
    expect(examStats(questions, { 0: 'A', 1: ['1', '3'] }, { 0: 1, 1: 0.5 })).toMatchObject({ done: 2, right: 1, partial: 1, wrong: 0, percent: 75 })
  })
})

describe('textos das respostas para o diagnóstico', () => {
  it('mostra a certa e a do aluno', () => {
    expect(rightAnswerText(unica(0, 'B'))).toBe('B) b')
    expect(givenAnswerText(unica(0, 'B'), 'D')).toBe('D) d')
    expect(givenAnswerText(unica(0, 'B'), undefined)).toBe('sem resposta')
  })
})

describe('readDiagnosis', () => {
  it('lê temas e formato, e um tema só vira nota única', () => {
    expect(readDiagnosis({ temas: [{ titulo: 'Juros', o_que_faltou: 'confunde', questoes: [1] }, { titulo: ' ' }], formato: 'por_tema' })).toEqual({ gaps: [{ title: 'Juros', missing: 'confunde', questions: [1] }], single: true })
    expect(readDiagnosis({ temas: [{ titulo: 'A' }, { titulo: 'B' }], formato: 'por_tema' }).single).toBe(false)
    expect(readDiagnosis(null)).toEqual({ gaps: [], single: true })
  })

  it('o trecho de cada tema leva as questões erradas dele', () => {
    const text = gapExcerpt([{ title: 'Juros', missing: 'confunde simples e composto', questions: [2] }], [{ number: 2, statement: 'Quanto rende?', right: 'B) 121', given: 'A) 120', explanation: '' }])
    expect(text).toContain('Tema: Juros')
    expect(text).toContain('Questão errada: Quanto rende? (certa: B) 121; a do aluno: A) 120)')
  })
})
