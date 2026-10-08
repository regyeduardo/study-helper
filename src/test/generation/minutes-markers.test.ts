import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildMinutes } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { GenerationSession } from '@/lib/generation/session'
import { installFetch, llm7Settings, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 20, text: 'Vamos começar.' },
    { speaker: 'speaker_0', start: 60, end: 70, text: 'O preço fica em dois mil.' },
    { speaker: 'mic', start: 80, end: 85, text: 'Fechado.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Marina', suggested: false },
  ],
  marks: [
    { id: 'm2', kind: 'note', at: 82, text: 'conferir o preço' },
    { id: 'm1', kind: 'mark', at: 65, text: '' },
  ],
}

function install() {
  return installFetch(request => (systemPromptOf(request) === PROMPTS.MINUTES_EXTRACT_PROMPT ? openAiStream(JSON.stringify({ itens: [] })) : openAiStream(JSON.stringify({ assunto: 'Preço', resumo: '', itens: [] }))))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the minutes agent sees what the owner marked', () => {
  it('the request carries the marked moment and the note, each with its time, next to the speech it belongs to', async () => {
    const { calls } = install()
    await buildMinutes('', new GenerationSession(llm7Settings()), () => {}, recording)
    expect(userContentOf(calls[0])).toBe(
      ['Você [00:00]: Vamos começar.', 'Marina [01:00]: O preço fica em dois mil.', '>> MOMENTO MARCADO [01:05]', 'Você [01:20]: Fechado.', '>> ANOTAÇÃO [01:22]: conferir o preço', ''].join('\n'),
    )
  })

  it('the agent is told what those lines are and what to do with them', () => {
    expect(PROMPTS.MINUTES_EXTRACT_PROMPT).toContain('>> MOMENTO MARCADO [hora]')
    expect(PROMPTS.MINUTES_EXTRACT_PROMPT).toContain('>> ANOTAÇÃO [hora]: texto')
  })

  it('a mark made before the first speech comes first, and a recording without marks has no such lines', async () => {
    const { calls } = install()
    await buildMinutes('', new GenerationSession(llm7Settings()), () => {}, { ...recording, blocks: recording.blocks.slice(1), marks: [{ id: 'm0', kind: 'mark', at: 3, text: '' }] })
    expect(userContentOf(calls[0]).startsWith('>> MOMENTO MARCADO [00:03]\nMarina [01:00]:')).toBe(true)
    const plain = install()
    await buildMinutes('', new GenerationSession(llm7Settings()), () => {}, { ...recording, marks: [] })
    expect(userContentOf(plain.calls[0])).not.toContain('>>')
  })
})
