import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROMPTS } from '@/lib/generation/prompts.data'
import { GenerationSession } from '@/lib/generation/session'
import { suggestSpeakerNames } from '@/lib/generation/speaker-names'
import { installFetch, llm7Settings, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 3, text: 'Então fica dois mil mesmo?' },
    { speaker: 'speaker_0', start: 4, end: 7, text: 'Fica, eu confirmo com o fornecedor amanhã.' },
    { speaker: 'mic', start: 8, end: 10, text: 'Valeu, Marina.' },
    { speaker: 'speaker_1', start: 11, end: 13, text: 'Posso seguir com a pauta?' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Falante 2', suggested: false },
    { id: 'speaker_1', name: 'Falante 3', suggested: false },
  ],
  marks: [],
}

const answer = (names: unknown) => openAiStream(JSON.stringify({ nomes: names }))
const session = () => new GenerationSession(llm7Settings())

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('suggestSpeakerNames', () => {
  it('"valeu, Marina" said to Falante 2 turns Falante 2 into Marina, marked as a suggestion', async () => {
    const { calls } = installFetch(() => answer([{ falante: 'Falante 2', nome: 'Marina', citacao: 'Valeu, Marina.' }]))
    const named = await suggestSpeakerNames(recording, session())
    expect(named.speakers).toEqual([
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_0', name: 'Marina', suggested: true },
      { id: 'speaker_1', name: 'Falante 3', suggested: false },
    ])
    expect(named.blocks).toBe(recording.blocks)
    expect(calls).toHaveLength(1)
    expect(systemPromptOf(calls[0])).toBe(PROMPTS.SPEAKER_NAMES_PROMPT)
    expect(userContentOf(calls[0])).toContain('Falante 2 [00:04]: Fica, eu confirmo com o fornecedor amanhã.\nVocê [00:08]: Valeu, Marina.')
  })

  it('ignores a name nobody said, a name for "Você" and a speaker that does not exist', async () => {
    installFetch(() =>
      answer([
        { falante: 'Falante 2', nome: 'Roberto', citacao: 'inventado' },
        { falante: 'Você', nome: 'Marina', citacao: 'Valeu, Marina.' },
        { falante: 'Falante 9', nome: 'Marina', citacao: 'Valeu, Marina.' },
      ]),
    )
    expect((await suggestSpeakerNames(recording, session())).speakers).toEqual(recording.speakers)
  })

  it('never gives the same name to two speakers', async () => {
    installFetch(() =>
      answer([
        { falante: 'Falante 2', nome: 'Marina', citacao: 'Valeu, Marina.' },
        { falante: 'Falante 3', nome: 'marina', citacao: 'Valeu, Marina.' },
      ]),
    )
    expect((await suggestSpeakerNames(recording, session())).speakers.map(speaker => speaker.name)).toEqual(['Você', 'Marina', 'Falante 3'])
  })

  it('an answer without JSON, or an AI that fails, leaves the names as they were', async () => {
    installFetch(() => openAiStream('não sei'))
    expect(await suggestSpeakerNames(recording, session())).toBe(recording)
    installFetch(() => new Response('x', { status: 500 }))
    expect(await suggestSpeakerNames(recording, session())).toBe(recording)
  })

  it('does not ask the AI when there is nobody to name', async () => {
    const { calls } = installFetch(() => answer([]))
    const alone = { ...recording, blocks: recording.blocks.filter(block => block.speaker === 'mic'), speakers: recording.speakers.slice(0, 1) }
    expect(await suggestSpeakerNames(alone, session())).toBe(alone)
    expect(calls).toHaveLength(0)
  })
})
