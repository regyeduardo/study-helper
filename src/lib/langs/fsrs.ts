/**
 * A repetição espaçada de cada card (spec 004, FR-028 a FR-030, FR-039; dono, 24/11: "é por card… melhores práticas do anki"):
 * o FSRS-6, o agendador do Anki, para lembrar com 90% de chance, com os passos curtos do Anki (1 e 10 min; 10 min ao errar) e
 * uma pequena variação nas datas que depende do card (o mesmo card com as mesmas respostas dá as mesmas datas). Vale para os
 * três lugares (App, Drive e Local): o servidor só guarda o que sai daqui.
 */
import { DefaultScheduler, Rating } from 'ts-fsrs'

export type Rate = 1 | 2 | 3

export interface Schedule {
  state: 'new' | 'learning' | 'review' | 'relearning'
  step: number
  stability: number
  difficulty: number
  dueAt: string | null
  lastReviewAt: string | null
  scheduledDays: number
  reps: number
  lapses: number
}

const STATES = ['new', 'learning', 'review', 'relearning'] as const
const FIXED_DAYS = 21
const LEECH_LAPSES = 8

let scheduler: ReturnType<typeof DefaultScheduler> | null = null
const get = () =>
  (scheduler ??= DefaultScheduler({
    version: 'FSRS-6',
    desiredRetention: 0.9,
    enableShortTerm: true,
    learningSteps: ['1m', '10m'],
    relearningSteps: ['10m'],
    enableFuzz: true,
    maximumInterval: 36_500,
  }))

export const newSchedule = (): Schedule => ({ state: 'new', step: 0, stability: 0, difficulty: 0, dueAt: null, lastReviewAt: null, scheduledDays: 0, reps: 0, lapses: 0 })

/** Errou = Again; acertou = Good; acertou só depois do card de aprender (`retry`) = Hard. */
export const rate = (ok: boolean, retry: boolean): Rate => (!ok ? Rating.Again : retry ? Rating.Hard : Rating.Good) as Rate

export const isDue = (s: Schedule, now: Date) => s.state !== 'new' && s.dueAt !== null && new Date(s.dueAt).getTime() <= now.getTime()

/** Fixado = intervalo de 21 dias ou mais (o "maduro" do Anki). */
export const isFixed = (s: Schedule) => s.state === 'review' && s.scheduledDays >= FIXED_DAYS

/** Errado 8 vezes depois de aprendido (o "leech" do Anki). */
export const isLeech = (s: Schedule) => s.lapses >= LEECH_LAPSES

/** A repetição depois de uma resposta. Acertar um card de revisão antes de vencer não adianta nada (a prática mostra todos). */
export async function review(cardId: string, s: Schedule, rating: Rate, now: Date): Promise<Schedule> {
  if (s.state === 'review' && rating !== Rating.Again && !isDue(s, now)) return s
  const fsrs = await get()
  const index = STATES.indexOf(s.state)
  const card =
    s.state === 'new'
      ? fsrs.newCard({ now, cardId })
      : {
          stability: s.stability,
          difficulty: s.difficulty,
          state: index,
          scheduleStatus: s.state === 'review' ? 'review' : 'learning',
          dueAt: new Date(s.dueAt ?? now),
          lastReviewAt: s.lastReviewAt ? new Date(s.lastReviewAt) : null,
          cardId,
          reps: s.reps,
          lapses: s.lapses,
          scheduledDays: s.scheduledDays,
          learningStep: s.step,
        }
  const next = fsrs.review({ card: card as never, grade: rating as never, now }).card as unknown as {
    stability: number
    difficulty: number
    state: number
    dueAt: Date
    lastReviewAt: Date | null
    reps: number
    lapses: number
    scheduledDays: number
    learningStep: number
  }
  return {
    state: STATES[next.state],
    step: next.learningStep ?? 0,
    stability: next.stability,
    difficulty: next.difficulty,
    dueAt: next.dueAt.toISOString(),
    lastReviewAt: next.lastReviewAt ? next.lastReviewAt.toISOString() : null,
    scheduledDays: next.scheduledDays,
    reps: next.reps,
    lapses: next.lapses,
  }
}
