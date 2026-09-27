import type { BloomLevel, Certainty, Question, QuestionType, StoredQuestion, UserAnswer } from '@/types/domain'
import type { RawQuestion } from '@/lib/generation/exam-questions'
import { newId } from '@/lib/ids'

export const LETTERS = ['A', 'B', 'C', 'D', 'E']

export const CERTAINTY_LABELS: Record<Certainty, string> = { 1: 'Baixa', 2: 'Média', 3: 'Alta' }

export const LEVEL_LABELS: Record<BloomLevel, string> = {
  lembrar: 'Lembrar e entender',
  aplicar: 'Aplicar',
  analisar: 'Analisar e avaliar',
}

const CERTAINTY_TABLE: Record<Certainty, { right: number; wrong: number }> = {
  1: { right: 1, wrong: 0 },
  2: { right: 2, wrong: -2 },
  3: { right: 3, wrong: -6 },
}

type Random = () => number

export function questionType(question: Question): QuestionType {
  return question.tipo ?? 'unica'
}

export function isAnswered(answer: UserAnswer | undefined): boolean {
  if (answer === undefined) return false
  return Array.isArray(answer) ? answer.some(Boolean) : answer !== ''
}

export function scoreQuestion(question: Question, answer: UserAnswer | undefined): number {
  if (!isAnswered(answer)) return 0
  switch (questionType(question)) {
    case 'unica':
      return answer === question.correta ? 1 : 0
    case 'certo_errado':
      return answer === (question.certo ? 'certo' : 'errado') ? 1 : 0
    case 'multipla': {
      const right = question.corretas ?? []
      const marked = answer as string[]
      const hits = marked.filter(letter => right.includes(letter)).length
      const misses = marked.length - hits
      return right.length ? Math.max(0, (hits - misses) / right.length) : 0
    }
    case 'ordenar':
      return share(question.passos ?? [], answer as string[])
    case 'associar':
      return share((question.pares ?? []).map(pair => pair.direita), answer as string[])
    case 'lacuna':
      return share((question.lacunas ?? []).map(gap => gap.correta), answer as string[])
  }
}

function share(expected: string[], given: string[]): number {
  if (!expected.length) return 0
  return expected.filter((value, index) => given[index] === value).length / expected.length
}

export function certaintyPoints(score: number, certainty: Certainty | undefined, answered = true): number {
  if (!answered) return 0
  const row = CERTAINTY_TABLE[certainty ?? 1]
  return score === 1 ? row.right : row.wrong
}

export interface ExamSummary {
  score: number
  total: number
  certaintyPoints: number
  maxCertaintyPoints: number
  overconfident: Question[]
  scores: Record<number, number>
}

export function summarizeExam(
  questions: Question[],
  answers: Record<number, UserAnswer>,
  certainty: Record<number, Certainty>,
): ExamSummary {
  const scores: Record<number, number> = {}
  let points = 0
  const overconfident: Question[] = []
  for (const question of questions) {
    const answer = answers[question.id]
    const score = scoreQuestion(question, answer)
    scores[question.id] = score
    points += certaintyPoints(score, certainty[question.id], isAnswered(answer))
    if (isAnswered(answer) && score < 1 && certainty[question.id] === 3) overconfident.push(question)
  }
  return {
    score: Object.values(scores).reduce((sum, value) => sum + value, 0),
    total: questions.length,
    certaintyPoints: points,
    maxCertaintyPoints: questions.length * CERTAINTY_TABLE[3].right,
    overconfident,
    scores,
  }
}

export function shuffleExam(questions: Question[], random: Random = Math.random): Question[] {
  return shuffled(questions, random).map(question => shuffleQuestion(question, random))
}

function shuffleQuestion(question: Question, random: Random): Question {
  switch (questionType(question)) {
    case 'unica':
      return question.formato === 'assercao_razao' ? question : relabel(question, shuffled(LETTERS, random))
    case 'multipla':
      return relabel(question, shuffled(LETTERS, random))
    case 'lacuna':
      return {
        ...question,
        lacunas: question.lacunas?.map(gap => ({ ...gap, opcoes: shuffled(gap.opcoes, random) })),
      }
    case 'ordenar':
      return { ...question, ordemInicial: unsolved(question.passos ?? [], random) }
    case 'associar':
      return { ...question, direitas: shuffled((question.pares ?? []).map(pair => pair.direita), random) }
    default:
      return question
  }
}

function relabel(question: Question, order: string[]): Question {
  const shown: Record<string, string> = {}
  order.forEach((original, index) => {
    shown[original] = LETTERS[index]
  })
  const original = question.letraOriginal ?? Object.fromEntries(LETTERS.map(letter => [letter, letter]))
  return {
    ...question,
    alternativas: Object.fromEntries(order.map(letter => [shown[letter], question.alternativas[letter]])),
    correta: question.correta ? shown[question.correta] : question.correta,
    corretas: question.corretas?.map(letter => shown[letter]).sort(),
    explicacao_das_erradas: question.explicacao_das_erradas
      ? Object.fromEntries(Object.entries(question.explicacao_das_erradas).map(([letter, text]) => [shown[letter], text]))
      : question.explicacao_das_erradas,
    letraOriginal: Object.fromEntries(order.map(letter => [shown[letter], original[letter]])),
  }
}

function unsolved(steps: string[], random: Random): string[] {
  if (steps.length < 2) return [...steps]
  let order = shuffled(steps, random)
  while (order.every((step, index) => step === steps[index])) order = shuffled(steps, Math.random)
  return order
}

function shuffled<T>(items: T[], random: Random): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

export function storedAnswer(question: Question, answer: UserAnswer | undefined): string | null {
  if (!isAnswered(answer)) return null
  const original = question.letraOriginal
  if (Array.isArray(answer)) {
    const letters = questionType(question) === 'multipla' && original ? answer.map(letter => original[letter]).sort() : answer
    return JSON.stringify(letters)
  }
  return original?.[answer as string] ?? (answer as string)
}

export function storedFromRaw(raw: RawQuestion): StoredQuestion {
  return { ...(raw as unknown as Omit<StoredQuestion, 'storedId'>), storedId: newId() }
}

export function questionFromStored(stored: StoredQuestion, index: number): Question {
  return { ...stored, id: index, alternativas: stored.alternativas ?? {}, explicacao: stored.explicacao ?? '' }
}

export function masteryOf(correct: number, total: number): number | null {
  return total ? Math.round((correct / total) * 100) : null
}

const ROMAN_MARKER = /(^|\s)((?:IV|V|I{1,3})[.)\-–]\s)/g
const NUMBER_MARKER = /(^|\s)([1-9][.)]\s)/g

function splitMarkers(text: string, marker: RegExp): string {
  const found = [...text.matchAll(marker)]
  if (found.length < 2) return text
  return text.replace(marker, (whole, space: string, label: string, offset: number) => (offset === 0 ? whole : `\n${label}`))
}

export function statementLines(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(block => (/^\s*\|/.test(block) ? block : splitMarkers(splitMarkers(block, ROMAN_MARKER), NUMBER_MARKER)))
    .join('\n\n')
}

