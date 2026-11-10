import { ATA_STEPS, listDayOf, type ModelPair, recommendationOf } from '@/lib/ai/recommendations'
import { MIN_SCORE } from '@/lib/ai/use-requirements'
import type { AiProviderId } from '@/types/domain'

/**
 * The Ata of a video step by step (FR-072), as the window "Gerar desta entrada" shows it: Vídeo, Contexto and Escrita.
 * Pure: the scores are the ones of `recommendations.ts`, measured on the real meeting of `ATA_LIST_DATE`; none is made up here.
 */

export type AtaStepId = 'video' | 'context' | 'write'

export const ATA_STEP_IDS: AtaStepId[] = ['video', 'context', 'write']

/** Under this score in the step, the person is warned. */
export const STEP_MIN_SCORE = MIN_SCORE

export interface StepScore {
  /** The score of the model in this step; null: nobody measured it here. */
  score: number | null
  /** It is the model the list recommends for this step. */
  recommended: boolean
  low: boolean
  /** Why it scored low, said in a few words after the score; null when it did not. */
  why: string | null
}

const step = (id: 'quem-fala' | 'contexto' | 'escrever') => ATA_STEPS.find(item => item.step === id)!

// Vídeo is "Quem fala" and "Leitura da tela" in one model (the app uses the Leitura de tela model for both): the recommended is the one
// measured on who speaks, and its score is the one of the Leitura de tela list, where the models were compared for both.
const RECOMMENDED: Record<AtaStepId, ModelPair> = { video: step('quem-fala').picks[0].pair, context: step('contexto').picks[0].pair, write: step('escrever').picks[0].pair }

export const recommendedPair = (id: AtaStepId): ModelPair => RECOMMENDED[id]

const keyOf = (pair: { provider: AiProviderId; model: string }) => `${pair.provider}::${pair.model}`

const scoresOf = (use: 'tela' | 'ata') => {
  const { ladder, outside } = recommendationOf(use)
  return new Map([...ladder, ...outside].map(rung => [keyOf(rung.pair), rung.listScore]))
}

const SCREEN = scoresOf('tela')
// Contexto and Escrita: what ATA_STEPS measured for the step; the others, the Ata made with them (the Ata ladder).
const WHOLE_ATA = scoresOf('ata')
const PASSED: Record<'context' | 'write', Map<string, number>> = {
  context: new Map(step('contexto').picks.map(pick => [keyOf(pick.pair), pick.score])),
  write: new Map(step('escrever').picks.map(pick => [keyOf(pick.pair), pick.score])),
}

const scoreIn = (id: AtaStepId, key: string): number | null => (id === 'video' ? SCREEN.get(key) : (PASSED[id].get(key) ?? WHOLE_ATA.get(key))) ?? null

const DEEPSEEK = ['deepseek-ai/DeepSeek-V4-Flash-0731', 'deepseek/deepseek-v4-flash-0731']

/** Why a model scored low, from the notes of the measurement (recommendations.ts), by the model id in the provider. */
const WHY: Record<AtaStepId, Record<string, string>> = {
  video: { 'XiaomiMiMo/MiMo-V2.6-Flash': 'trocou o quadro de quem gravou por outro', 'z-ai/glm-5.3-flash': 'citou quadros que não estavam na chamada' },
  context: Object.fromEntries(DEEPSEEK.map(model => [model, 'perdeu o prazo que caiu'])),
  write: { ...Object.fromEntries(DEEPSEEK.map(model => [model, 'manteve o prazo que caiu'])), 'z-ai/glm-5.3-flash': 'gastou todos os tokens pensando e não respondeu' },
}

const NOT_SAID = (): string => `ficou abaixo de ${STEP_MIN_SCORE} na reunião real de ${listDayOf('ata')}`

/** The score of a model in a step. A model outside the list, or one the step never measured, has no score: no star, no warning. */
export function scoreOfStep(id: AtaStepId, pair: { provider: AiProviderId; model: string } | null | undefined): StepScore {
  if (!pair) return { score: null, recommended: false, low: false, why: null }
  const score = scoreIn(id, keyOf(pair))
  const low = score !== null && score < STEP_MIN_SCORE
  return { score, recommended: keyOf(pair) === keyOf(RECOMMENDED[id]), low, why: low ? (WHY[id][pair.model] ?? NOT_SAID()) : null }
}

/** "Nota de 0 a 10, medido na aba Recomendações (10/11)". */
export const STEP_SCORES_SOURCE = `Nota de 0 a 10, medido na aba Recomendações (${listDayOf('ata')})`
