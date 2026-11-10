import { describe, expect, it } from 'vitest'

// FR-072: the score of a model in each step of the Ata of a video (Vídeo, Contexto, Escrita), from the list measured on 10/11.

import { ATA_STEP_IDS, recommendedPair, scoreOfStep, STEP_MIN_SCORE } from '@/lib/ai/ata-step-scores'
import { ATA_STEPS, findPair } from '@/lib/ai/recommendations'

const pair = (provider: 'openrouter' | 'deepinfra', model: string) => ({ provider, model })
const GEMINI = pair('openrouter', 'google/gemini-3.8-flash')
const LUNA = pair('openrouter', 'openai/gpt-6-luna')
const DEEPSEEK_DI = pair('deepinfra', 'deepseek-ai/DeepSeek-V4-Flash-0731')
const DEEPSEEK_OR = pair('openrouter', 'deepseek/deepseek-v4-flash-0731')
const MIMO = pair('deepinfra', 'XiaomiMiMo/MiMo-V2.6-Flash')
const GLM = pair('openrouter', 'z-ai/glm-5.3-flash')

describe('the Ata of a video, step by step', () => {
  it('has three steps, and eight is the line under which the person is warned', () => {
    expect(ATA_STEP_IDS).toEqual(['video', 'context', 'write'])
    expect(STEP_MIN_SCORE).toBe(8)
  })

  it('each step recommends the model measured for it in ATA_STEPS', () => {
    const picked = (step: string) => ATA_STEPS.find(item => item.step === step)!.picks[0].pair
    expect(recommendedPair('video')).toBe(picked('quem-fala'))
    expect(recommendedPair('context')).toBe(picked('contexto'))
    expect(recommendedPair('write')).toBe(picked('escrever'))
    expect([recommendedPair('video').name, recommendedPair('context').name, recommendedPair('write').name]).toEqual(['Gemini 3.8 Flash', 'GPT-6 Luna', 'GPT-6 Luna'])
  })

  it('Vídeo: Gemini 3.8 Flash 9 (recommended); MiMo and GLM 6, with why', () => {
    expect(scoreOfStep('video', GEMINI)).toEqual({ score: 9, recommended: true, low: false, why: null })
    expect(scoreOfStep('video', MIMO)).toMatchObject({ score: 6, recommended: false, low: true, why: expect.stringMatching(/quem gravou/) })
    expect(scoreOfStep('video', GLM)).toMatchObject({ score: 6, low: true, why: expect.stringMatching(/quadros/) })
  })

  it('Contexto: Luna 8 (recommended); DeepSeek V4 Flash 6, in either provider, "perdeu o prazo que caiu"', () => {
    expect(scoreOfStep('context', LUNA)).toEqual({ score: 8, recommended: true, low: false, why: null })
    for (const deepseek of [DEEPSEEK_DI, DEEPSEEK_OR]) expect(scoreOfStep('context', deepseek)).toMatchObject({ score: 6, recommended: false, low: true, why: 'perdeu o prazo que caiu' })
  })

  it('Escrita: Luna and Gemini 3.8 Flash passed (8); only Luna carries the star', () => {
    expect(scoreOfStep('write', LUNA)).toMatchObject({ score: 8, recommended: true, low: false })
    expect(scoreOfStep('write', GEMINI)).toEqual({ score: 8, recommended: false, low: false, why: null })
  })

  it('a model below eight in the Ata of 10/11 is warned in the text steps, GLM with its zero', () => {
    expect(scoreOfStep('write', DEEPSEEK_DI)).toMatchObject({ score: 6, low: true, why: expect.any(String) })
    expect(scoreOfStep('write', GLM)).toMatchObject({ score: 0, low: true, why: expect.stringMatching(/pensando/) })
  })

  it('a model nobody measured in that step has no score, no star and no warning', () => {
    const unknown = { provider: 'custom' as const, model: 'acme/novo' }
    for (const step of ATA_STEP_IDS) expect(scoreOfStep(step, unknown)).toEqual({ score: null, recommended: false, low: false, why: null })
    expect(scoreOfStep('write', null)).toEqual({ score: null, recommended: false, low: false, why: null })
  })

  it('every recommended pair is on the list of the app', () => {
    for (const step of ATA_STEP_IDS) expect(findPair(recommendedPair(step).provider, recommendedPair(step).model)).toBeDefined()
  })
})
