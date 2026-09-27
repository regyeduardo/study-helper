import { LONG_REPLY_MAX_TOKENS } from '@/controllers/ai.controller'
import { extractJson, generateDiagram } from '@/lib/generation/mermaid'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'

export type RawQuestion = Record<string, unknown> & { tipo: string }

type Random = () => number

const LETTERS = ['A', 'B', 'C', 'D', 'E']
const KINDS = ['unica', 'multipla', 'certo_errado', 'ordenar', 'associar', 'lacuna']
const LEVELS = ['lembrar', 'aplicar', 'analisar']
const INTERNAL_FIELDS = ['resposta_certa', 'erro_de_cada_errada', 'id']

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function hasFiveAlternatives(question: RawQuestion): boolean {
  const alternatives = question.alternativas as Record<string, unknown> | undefined
  return typeof alternatives === 'object' && alternatives !== null && LETTERS.every(letter => filled(alternatives[letter]))
}

const KIND_CHECKS: Record<string, (question: RawQuestion) => string | null> = {
  unica: question => {
    if (!hasFiveAlternatives(question)) return 'não tem as 5 alternativas'
    if (!LETTERS.includes(question.correta as string)) return 'sem letra correta válida'
    return null
  },
  multipla: question => {
    if (!hasFiveAlternatives(question)) return 'não tem as 5 alternativas'
    const letters = question.corretas
    if (!Array.isArray(letters) || !letters.every(letter => LETTERS.includes(letter)) || new Set(letters).size < 2 || new Set(letters).size > 4) {
      return 'marque todas sem 2 a 4 letras corretas válidas'
    }
    return null
  },
  certo_errado: question => (typeof question.certo === 'boolean' ? null : 'certo/errado sem gabarito'),
  ordenar: question => {
    const steps = question.passos
    if (!Array.isArray(steps) || steps.length < 3 || !steps.every(filled)) return 'ordenar com menos de 3 passos'
    if (new Set(steps).size !== steps.length) return 'ordenar com passo repetido'
    return null
  },
  associar: question => {
    const pairs = question.pares
    if (!Array.isArray(pairs) || pairs.length < 3) return 'associar com menos de 3 pares'
    if (!pairs.every(pair => typeof pair === 'object' && pair !== null && filled(pair.esquerda) && filled(pair.direita))) return 'associar com par incompleto'
    const rights = pairs.map(pair => pair.direita)
    if (new Set(rights).size !== rights.length) return 'associar com definição repetida'
    return null
  },
  lacuna: question => {
    const gaps = question.lacunas
    if (!Array.isArray(gaps) || !gaps.length) return 'lacuna sem lacunas'
    for (let number = 1; number <= gaps.length; number++) {
      const gap = gaps[number - 1]
      if (!(question.enunciado as string).includes(`[[${number}]]`)) return `lacuna [[${number}]] fora do enunciado`
      const options = typeof gap === 'object' && gap !== null ? gap.opcoes : undefined
      if (!Array.isArray(options) || options.length < 2 || !options.includes(gap.correta)) return `lacuna ${number} sem a opção certa entre as opções`
    }
    return null
  },
}

function problem(question: RawQuestion): string | null {
  if (!KINDS.includes(question.tipo)) return `tipo desconhecido: ${question.tipo}`
  if (!filled(question.enunciado)) return 'sem enunciado'
  if (!filled(question.explicacao)) return 'sem explicação'
  return KIND_CHECKS[question.tipo](question)
}

function clean(question: RawQuestion): RawQuestion {
  const cleaned = Object.fromEntries(Object.entries(question).filter(([key]) => !INTERNAL_FIELDS.includes(key))) as RawQuestion
  if (!LEVELS.includes(cleaned.nivel as string)) cleaned.nivel = null
  const wrong = cleaned.explicacao_das_erradas
  if ((question.tipo === 'unica' || question.tipo === 'multipla') && typeof wrong === 'object' && wrong !== null && !Array.isArray(wrong)) {
    const right = new Set(question.tipo === 'unica' ? [question.correta as string] : (question.corretas as string[]))
    cleaned.explicacao_das_erradas = Object.fromEntries(
      Object.entries(wrong as Record<string, unknown>)
        .filter(([letter, value]) => filled(value) && LETTERS.includes(letter) && !right.has(letter))
        .map(([letter, value]) => [letter, (value as string).trim()]),
    )
  } else {
    delete cleaned.explicacao_das_erradas
  }
  return cleaned
}

export function validateQuestions(questions: unknown[]): RawQuestion[] {
  const accepted: RawQuestion[] = []
  for (const item of questions) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const question = { ...(item as Record<string, unknown>), tipo: ((item as Record<string, unknown>).tipo as string) || 'unica' } as RawQuestion
    if (problem(question)) continue
    accepted.push(clean(question))
  }
  return accepted
}

function withDiagram(question: RawQuestion): RawQuestion | null {
  const spec = question.diagrama
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return { ...question, diagrama: null }
  try {
    const record = spec as Record<string, unknown>
    return { ...question, diagrama: generateDiagram((record.tipo as string) ?? '', record.dados) }
  } catch {
    if (question.formato === 'interpretar_dado') return null
    return { ...question, diagrama: null }
  }
}

function shuffle<T>(items: T[], random: Random): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

function getsDrawnLetter(question: RawQuestion): boolean {
  return question.tipo === 'unica' && question.formato !== 'assercao_razao'
}

function balancedLetters(count: number, random: Random): string[] {
  const letters: string[] = []
  while (letters.length < count) letters.push(...shuffle(LETTERS, random))
  return shuffle(letters.slice(0, count), random)
}

function relabel(question: RawQuestion, order: string[]): RawQuestion {
  const newLetter = Object.fromEntries(order.map((old, index) => [old, LETTERS[index]]))
  const alternatives = question.alternativas as Record<string, string>
  const relabeled: RawQuestion = { ...question, alternativas: Object.fromEntries(order.map(old => [newLetter[old], alternatives[old]])) }
  if (question.tipo === 'unica') relabeled.correta = newLetter[question.correta as string]
  else relabeled.corretas = (question.corretas as string[]).map(letter => newLetter[letter]).sort()
  if ('explicacao_das_erradas' in question) {
    relabeled.explicacao_das_erradas = Object.fromEntries(
      Object.entries(question.explicacao_das_erradas as Record<string, string>).map(([letter, value]) => [newLetter[letter], value]),
    )
  }
  return relabeled
}

function moveRightLetter(question: RawQuestion, target: string, random: Random): RawQuestion {
  const others = shuffle(
    LETTERS.filter(letter => letter !== question.correta),
    random,
  )
  others.splice(LETTERS.indexOf(target), 0, question.correta as string)
  return relabel(question, others)
}

export function finishQuestions(questions: RawQuestion[], random: Random = Math.random): RawQuestion[] {
  const built = questions.map(withDiagram).filter((question): question is RawQuestion => question !== null)
  const targets = balancedLetters(built.filter(getsDrawnLetter).length, random)
  return built.map(question => {
    if (getsDrawnLetter(question)) return moveRightLetter(question, targets.pop()!, random)
    if (question.tipo === 'multipla') return relabel(question, shuffle(LETTERS, random))
    return question
  })
}

export async function reviewQuestions(questions: RawQuestion[], session: GenerationSession): Promise<RawQuestion[]> {
  if (!questions.length) return questions
  const numbered = questions.map((question, index) => ({ ...question, id: index + 1 }))
  let raw: string
  try {
    raw = await session.chat(JSON.stringify({ questions: numbered }), PROMPTS.EXAM_REVIEW_PROMPT, LONG_REPLY_MAX_TOKENS)
  } catch (error) {
    if (session.signal?.aborted) throw error
    return questions
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = extractJson(raw)
  }
  const items = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).vereditos : null
  if (!Array.isArray(items)) return questions
  const verdicts = new Map<number, Record<string, unknown>>()
  for (const item of items) if (typeof item === 'object' && item !== null && Number.isInteger(item.id)) verdicts.set(item.id, item)

  const kept: RawQuestion[] = []
  questions.forEach((question, index) => {
    const verdict = verdicts.get(index + 1) ?? {}
    if (verdict.veredito === 'descarta') return
    const fixed = verdict.questao
    if (verdict.veredito === 'corrige' && typeof fixed === 'object' && fixed !== null && !Array.isArray(fixed)) {
      const record = fixed as Record<string, unknown>
      kept.push({ ...record, tipo: (record.tipo as string) || question.tipo } as RawQuestion)
      return
    }
    kept.push(question)
  })
  return kept
}
