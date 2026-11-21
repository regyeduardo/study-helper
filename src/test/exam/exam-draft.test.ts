import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Certainty, StoredQuestion, UserAnswer } from '@/types/domain'
import { questionFromStored, shuffleExam } from '@/lib/exam'
import { clearExamDraft, examDraftKey, loadExamDraft, peekExamDraft, saveExamDraft, selectionScope, stoppedAt } from '@/lib/exam-draft'

const stored = (storedId: string, extra: Partial<StoredQuestion> = {}): StoredQuestion => ({
  storedId,
  tipo: 'unica',
  enunciado: `Pergunta ${storedId}`,
  alternativas: { A: 'um', B: 'dois', C: 'tres', D: 'quatro', E: 'cinco' },
  correta: 'C',
  explicacao: 'porque sim',
  explicacao_das_erradas: { A: 'não é um', B: 'não é dois' },
  ...extra,
})

const QUESTIONS: StoredQuestion[] = [
  stored('q1'),
  stored('q2', { tipo: 'multipla', correta: undefined, corretas: ['A', 'D'] }),
  stored('q3', { tipo: 'ordenar', alternativas: {}, correta: undefined, passos: ['primeiro', 'segundo', 'terceiro', 'quarto'] }),
  stored('q4', { tipo: 'associar', alternativas: {}, correta: undefined, pares: [{ esquerda: 'a', direita: 'x' }, { esquerda: 'b', direita: 'y' }, { esquerda: 'c', direita: 'z' }] }),
  stored('q5', { tipo: 'lacuna', alternativas: {}, correta: undefined, enunciado: 'Um [[1]] e um [[2]].', lacunas: [{ opcoes: ['a', 'b', 'c'], correta: 'a' }, { opcoes: ['d', 'e', 'f'], correta: 'e' }] }),
  stored('q6', { tipo: 'certo_errado', alternativas: {}, correta: undefined, certo: true }),
]

const KEY = examDraftKey('local', 'file:abc')
const run = (overrides = {}) => {
  const exam = shuffleExam(QUESTIONS.map(questionFromStored))
  const answers: Record<number, UserAnswer> = { [exam[0].id]: 'B', [exam[2].id]: ['A'] }
  const certainty: Record<number, Certainty> = { [exam[0].id]: 3 }
  return { exam, answers, certainty, current: 2, oneAtATime: true, ...overrides }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('rascunho de prova', () => {
  it('guarda a ordem embaralhada, as respostas, a certeza, a questão atual e o modo uma por vez, e devolve tudo igual', () => {
    const saved = run()
    saveExamDraft(KEY, saved, QUESTIONS)
    const back = loadExamDraft(KEY, QUESTIONS)!
    expect(back.exam).toEqual(saved.exam)
    expect(back.exam.map(question => question.storedId)).toEqual(saved.exam.map(question => question.storedId))
    expect(back.answers).toEqual(saved.answers)
    expect(back.certainty).toEqual(saved.certainty)
    expect(back.current).toBe(2)
    expect(back.oneAtATime).toBe(true)
  })

  it('as letras das alternativas voltam como estavam na tela (a resposta "B" continua sendo a mesma alternativa)', () => {
    const saved = run()
    saveExamDraft(KEY, saved, QUESTIONS)
    const back = loadExamDraft(KEY, QUESTIONS)!
    expect(back.exam[0].alternativas).toEqual(saved.exam[0].alternativas)
    expect(back.exam[0].correta).toBe(saved.exam[0].correta)
    expect(back.exam[0].letraOriginal).toEqual(saved.exam[0].letraOriginal)
  })

  it('as respostas continuam presas ao número da questão, mesmo que a lista chegue em outra ordem', () => {
    const saved = run()
    saveExamDraft(KEY, saved, QUESTIONS)
    const back = loadExamDraft(KEY, [...QUESTIONS].reverse())!
    expect(back.exam).toEqual(saved.exam)
    expect(back.answers).toEqual(saved.answers)
  })

  it('outro conjunto de questões descarta o rascunho e apaga o que estava guardado', () => {
    saveExamDraft(KEY, run(), QUESTIONS)
    const changed = [...QUESTIONS.slice(1), stored('q7')]
    expect(loadExamDraft(KEY, changed)).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('uma questão a menos também descarta', () => {
    saveExamDraft(KEY, run(), QUESTIONS)
    expect(loadExamDraft(KEY, QUESTIONS.slice(1))).toBeNull()
  })

  it('peek diz quais questões o rascunho tem, na ordem em que a prova foi montada', () => {
    expect(peekExamDraft(KEY)).toBeNull()
    saveExamDraft(KEY, run(), QUESTIONS)
    expect(peekExamDraft(KEY)?.slice().sort()).toEqual(QUESTIONS.map(question => question.storedId).sort())
  })

  it('clear apaga', () => {
    saveExamDraft(KEY, run(), QUESTIONS)
    clearExamDraft(KEY)
    expect(peekExamDraft(KEY)).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('cada prova e cada conta tem o seu rascunho', () => {
    saveExamDraft(examDraftKey('local', 'file:a'), run(), QUESTIONS)
    expect(peekExamDraft(examDraftKey('local', 'file:b'))).toBeNull()
    expect(peekExamDraft(examDraftKey('google-1', 'file:a'))).toBeNull()
    expect(peekExamDraft(examDraftKey('local', 'file:a'))).not.toBeNull()
    // the library not opened yet is still the Local profile
    expect(examDraftKey(null, 'file:a')).toBe(examDraftKey('local', 'file:a'))
  })

  it('a seleção de arquivos tem uma chave só, em qualquer ordem', () => {
    expect(selectionScope(['b', 'a'])).toBe(selectionScope(['a', 'b']))
    expect(selectionScope(['a', 'b'])).not.toBe(selectionScope(['a', 'c']))
  })

  it('texto estragado no armazenamento vira "sem rascunho"', () => {
    localStorage.setItem(KEY, '{não é json')
    expect(loadExamDraft(KEY, QUESTIONS)).toBeNull()
    expect(peekExamDraft(KEY)).toBeNull()
    localStorage.setItem(KEY, JSON.stringify({ version: 1, ids: 'x' }))
    expect(loadExamDraft(KEY, QUESTIONS)).toBeNull()
  })

  it('rascunho de mais de 30 dias não volta, e salvar outro limpa os velhos', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'))
    const old = examDraftKey('local', 'file:velha')
    saveExamDraft(old, run(), QUESTIONS)
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'))
    expect(loadExamDraft(old, QUESTIONS)).toBeNull()
    saveExamDraft(old, run(), QUESTIONS)
    vi.setSystemTime(new Date('2026-12-20T10:00:00Z'))
    saveExamDraft(KEY, run(), QUESTIONS)
    expect(localStorage.getItem(old)).toBeNull()
    expect(localStorage.getItem(KEY)).not.toBeNull()
  })

  it('sem armazenamento (leitura e escrita falham) nada quebra', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('cheio', 'QuotaExceededError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('bloqueado', 'SecurityError')
    })
    expect(() => saveExamDraft(KEY, run(), QUESTIONS)).not.toThrow()
    expect(loadExamDraft(KEY, QUESTIONS)).toBeNull()
    expect(peekExamDraft(KEY)).toBeNull()
    expect(() => clearExamDraft(KEY)).not.toThrow()
  })
})

describe('onde a pessoa parou', () => {
  it('uma por vez: a questão da tela', () => {
    expect(stoppedAt(run({ current: 4, oneAtATime: true }))).toBe(4)
  })

  it('na lista: a primeira ainda em branco', () => {
    const saved = run({ oneAtATime: false })
    const answers = { [saved.exam[0].id]: 'A', [saved.exam[1].id]: 'B', [saved.exam[3].id]: 'C' }
    expect(stoppedAt({ ...saved, answers })).toBe(2)
  })

  it('na lista com tudo respondido: a última', () => {
    const saved = run({ oneAtATime: false })
    const answers = Object.fromEntries(saved.exam.map(question => [question.id, 'A']))
    expect(stoppedAt({ ...saved, answers })).toBe(saved.exam.length - 1)
  })
})
