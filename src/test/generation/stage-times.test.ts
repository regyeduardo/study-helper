import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StageClock } from '@/lib/transcription/types'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('StageClock', () => {
  it('keeps how long each stage took, in the order they ran', async () => {
    const clock = new StageClock()
    const first = clock.run('Preparar o áudio', () => wait(1200))
    await vi.advanceTimersByTimeAsync(1200)
    await first
    const second = clock.run('Transcrever', async () => {
      await wait(24000)
      return 'texto'
    })
    await vi.advanceTimersByTimeAsync(24000)
    expect(await second).toBe('texto')
    expect(clock.stages).toEqual([
      { stage: 'Preparar o áudio', ms: 1200 },
      { stage: 'Transcrever', ms: 24000 },
    ])
  })

  it('still counts a stage that failed, and lets the failure through', async () => {
    const clock = new StageClock()
    const failing = clock.run('Guardar no Drive', async () => {
      await wait(500)
      throw new Error('sem internet')
    })
    const outcome = expect(failing).rejects.toThrow('sem internet')
    await vi.advanceTimersByTimeAsync(500)
    await outcome
    expect(clock.stages).toEqual([{ stage: 'Guardar no Drive', ms: 500 }])
  })

  it('adds the stages another clock already measured', () => {
    const clock = new StageClock()
    clock.add([{ stage: 'Transcrever', ms: 24000 }])
    expect(clock.stages).toEqual([{ stage: 'Transcrever', ms: 24000 }])
  })
})
