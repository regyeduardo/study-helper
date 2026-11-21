import type { Certainty, Question, StoredQuestion, UserAnswer } from '@/types/domain'
import { isAnswered, questionFromStored } from '@/lib/exam'

/**
 * The exam being taken, kept in this browser so that closing the window by accident does not lose it (T139).
 * Only localStorage, every access guarded: without it the exam works as before, just without the draft.
 */

const PREFIX = 'study-helper:exam-draft'
const VERSION = 1
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Where the person was in an exam: what the screen shows, so what is saved is what comes back. */
export interface ExamRunState {
  /** The questions in the order they were drawn, each already shuffled inside. */
  exam: Question[]
  answers: Record<number, UserAnswer>
  certainty: Record<number, Certainty>
  /** The question shown in "uma por vez". */
  current: number
  oneAtATime: boolean
}

type Shuffled = Partial<Question>

interface Saved {
  version: number
  savedAt: number
  /** The stored ids of the questions in the exam: another set discards the draft. */
  ids: string[]
  order: { storedId: string; id: number; shuffled: Shuffled }[]
  answers: Record<number, UserAnswer>
  certainty: Record<number, Certainty>
  current: number
  oneAtATime: boolean
}

/** The draft of one exam: a note (`file:<id>`), a folder (`folder:<id>`) or a selection (`selection:<hash>`), per account. */
export const examDraftKey = (accountId: string | null, scope: string) => `${PREFIX}:${accountId ?? 'local'}:${scope}`

/** A selection of files is one exam whatever the order it was picked in. */
export function selectionScope(fileIds: string[]): string {
  const text = [...fileIds].sort().join('|')
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  return `selection:${hash.toString(36)}`
}

const sameSet = (left: string[], right: string[]) => left.length === right.length && [...left].sort().join('\u0000') === [...right].sort().join('\u0000')

/** What drawing changed in a question (the order of alternatives, steps, pairs and gaps), without repeating what it did not change. */
function shuffledPart(base: Question, shuffled: Question): Shuffled {
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(shuffled) as (keyof Question)[]) {
    if (JSON.stringify(shuffled[key]) !== JSON.stringify(base[key])) changed[key] = shuffled[key]
  }
  return changed as Shuffled
}

function read(key: string): Saved | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const saved = JSON.parse(raw) as Saved
    const valid = saved?.version === VERSION && Array.isArray(saved.ids) && Array.isArray(saved.order) && typeof saved.savedAt === 'number' && saved.order.every(item => typeof item?.storedId === 'string')
    return valid ? saved : null
  } catch {
    return null
  }
}

export function clearExamDraft(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    return
  }
}

/** Drafts nobody came back to are not worth the space. */
function pruneOld(now: number): void {
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (!key?.startsWith(`${PREFIX}:`)) continue
      const saved = read(key)
      if (!saved || now - saved.savedAt > MAX_AGE_MS) localStorage.removeItem(key)
    }
  } catch {
    return
  }
}

/** `questions`: the exam as stored, before drawing, to keep only what the drawing changed. */
export function saveExamDraft(key: string, run: ExamRunState, questions: StoredQuestion[]): void {
  const now = Date.now()
  const original = new Map(questions.map(question => [question.storedId, question]))
  const saved: Saved = {
    version: VERSION,
    savedAt: now,
    ids: run.exam.map(question => question.storedId ?? ''),
    order: run.exam.flatMap(question => {
      const base = original.get(question.storedId ?? '')
      return base ? [{ storedId: base.storedId, id: question.id, shuffled: shuffledPart(questionFromStored(base, question.id), question) }] : []
    }),
    answers: run.answers,
    certainty: run.certainty,
    current: run.current,
    oneAtATime: run.oneAtATime,
  }
  try {
    localStorage.setItem(key, JSON.stringify(saved))
  } catch {
    return
  }
  pruneOld(now)
}

/** Which questions the draft is of (in the order they were drawn), to open the exam without asking again. */
export function peekExamDraft(key: string): string[] | null {
  const saved = read(key)
  return saved && Date.now() - saved.savedAt <= MAX_AGE_MS ? saved.order.map(item => item.storedId) : null
}

/** The draft, if it is of exactly these questions: any other set (a new exam was made, a question is gone) discards it. */
export function loadExamDraft(key: string, questions: StoredQuestion[]): ExamRunState | null {
  const saved = read(key)
  if (!saved) return null
  const stored = new Map(questions.map(question => [question.storedId, question]))
  if (Date.now() - saved.savedAt > MAX_AGE_MS || !sameSet(saved.ids, questions.map(question => question.storedId)) || !saved.order.every(item => stored.has(item.storedId))) {
    clearExamDraft(key)
    return null
  }
  return {
    exam: saved.order.map(item => ({ ...questionFromStored(stored.get(item.storedId)!, item.id), ...item.shuffled })),
    answers: saved.answers ?? {},
    certainty: saved.certainty ?? {},
    current: Math.min(Math.max(0, Number(saved.current) || 0), Math.max(0, saved.order.length - 1)),
    oneAtATime: Boolean(saved.oneAtATime),
  }
}

/** The question the person stopped at (0-based): the one on screen in "uma por vez"; in the list, the first one still blank (the last when all are answered). */
export function stoppedAt(run: ExamRunState): number {
  if (run.oneAtATime) return run.current
  const blank = run.exam.findIndex(question => !isAnswered(run.answers[question.id]))
  return blank === -1 ? run.exam.length - 1 : blank
}
