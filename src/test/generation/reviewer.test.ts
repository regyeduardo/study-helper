import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROMPTS } from '@/lib/generation/prompts.data'
import { reviewTranscript } from '@/lib/generation/reviewer'
import { GenerationSession } from '@/lib/generation/session'
import { installFetch, llm7Settings, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 4, text: 'Então, né, tipo, a gente fecha hoje, né?' },
    { speaker: 'speaker_0', start: 5, end: 9, text: 'Fecha. A Mariana aqui confirma com o fornecedor.' },
    { speaker: 'mic', start: 10, end: 12, text: 'É, é, beleza, o que rosto do contrato fica igual.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Marina', suggested: true },
  ],
  marks: [],
}

const answer = (corrections: unknown) => openAiStream(JSON.stringify({ correcoes: corrections }))
const session = () => new GenerationSession(llm7Settings())

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reviewTranscript', () => {
  it('"Mariana" becomes "Marina" where the context says so, and the heard text is kept', async () => {
    const { calls } = installFetch(() => answer([{ fala: 2, de: 'Mariana', para: 'Marina' }]))
    const reviewed = await reviewTranscript(recording, session())
    expect(reviewed.blocks[1]).toEqual({ speaker: 'speaker_0', start: 5, end: 9, text: 'Fecha. A Marina aqui confirma com o fornecedor.', original: 'Fecha. A Mariana aqui confirma com o fornecedor.' })
    expect(reviewed.blocks[0]).toBe(recording.blocks[0])
    expect(reviewed.blocks[2]).toBe(recording.blocks[2])
    expect(systemPromptOf(calls[0])).toBe(PROMPTS.TRANSCRIPT_REVIEW_PROMPT)
    expect(userContentOf(calls[0])).toBe(
      'Participantes: Você, Marina\n\n1 | Você: Então, né, tipo, a gente fecha hoje, né?\n2 | Marina: Fecha. A Mariana aqui confirma com o fornecedor.\n3 | Você: É, é, beleza, o que rosto do contrato fica igual.',
    )
  })

  it('speech habits stay: a correction that only removes words is refused', async () => {
    installFetch(() =>
      answer([
        { fala: 1, de: 'Então, né, tipo, a gente', para: 'A gente' },
        { fala: 1, de: ', né?', para: '?' },
        { fala: 3, de: 'É, é, beleza', para: 'Beleza' },
        { fala: 3, de: 'o que rosto do contrato', para: 'o resto do contrato' },
      ]),
    )
    const reviewed = await reviewTranscript(recording, session())
    expect(reviewed.blocks[0]).toBe(recording.blocks[0])
    expect(reviewed.blocks[2].text).toBe('É, é, beleza, o resto do contrato fica igual.')
    expect(reviewed.blocks[2].original).toBe('É, é, beleza, o que rosto do contrato fica igual.')
  })

  it('refuses a rewrite, a text that is not in the speech and a speech that does not exist', async () => {
    installFetch(() =>
      answer([
        { fala: 2, de: 'Fecha. A Mariana aqui confirma com o fornecedor.', para: 'Marina vai confirmar o fechamento junto ao fornecedor ainda hoje.' },
        { fala: 2, de: 'Mariane', para: 'Marina' },
        { fala: 9, de: 'Mariana', para: 'Marina' },
        { fala: 2, de: 'Mariana', para: '' },
      ]),
    )
    expect(await reviewTranscript(recording, session())).toBe(recording)
  })

  it('a second review keeps the text that was first heard', async () => {
    installFetch(() => answer([{ fala: 2, de: 'Mariana', para: 'Marina' }]))
    const once = await reviewTranscript(recording, session())
    installFetch(() => answer([{ fala: 2, de: 'fornecedor', para: 'Fornecedor' }]))
    const twice = await reviewTranscript(once, session())
    expect(twice.blocks[1].text).toBe('Fecha. A Marina aqui confirma com o Fornecedor.')
    expect(twice.blocks[1].original).toBe('Fecha. A Mariana aqui confirma com o fornecedor.')
  })

  it('an AI that fails or answers without JSON leaves the transcription as it was', async () => {
    installFetch(() => openAiStream('tudo certo'))
    expect(await reviewTranscript(recording, session())).toBe(recording)
    installFetch(() => new Response('x', { status: 500 }))
    expect(await reviewTranscript(recording, session())).toBe(recording)
  })
})
