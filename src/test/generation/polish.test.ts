import { describe, expect, it, vi } from 'vitest'

import { CHUNK_CHARS } from '@/lib/generation/minutes'
import { polishTranscript } from '@/lib/generation/polish'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { GenerationSession } from '@/lib/generation/session'
import type { RecordingData } from '@/types/domain'

function meeting(extra = 0): RecordingData {
  const filler = Array.from({ length: extra }, (_, index) => ({ speaker: 'speaker_1', start: 20 + index, end: 21 + index, text: 'x'.repeat(400) }))
  return {
    blocks: [
      { speaker: 'mic', start: 0, end: 3, text: 'Marina, você manda a proposta do pics?' },
      { speaker: 'speaker_0', start: 4, end: 8, text: 'Mando sim, falei com o João Vito ontem.' },
      ...filler,
      { speaker: 'mic', start: 900, end: 901, text: 'Valeu, Marina.' },
    ],
    speakers: [
      { id: 'mic', name: 'Você', suggested: false },
      { id: 'speaker_0', name: 'Falante 2', suggested: false },
      { id: 'speaker_1', name: 'João Vitor Almeida', suggested: false },
    ],
    marks: [],
    frames: [{ at: 0, image: 'i', text: 'Participantes: João Vitor Almeida' }],
  }
}

const ANSWER = JSON.stringify({
  titulo: 'Proposta do PIX para maio.',
  nomes: [
    { falante: 'Falante 2', nome: 'Marina', citacao: 'Marina, você manda' },
    { falante: 'João Vitor Almeida', nome: 'João', citacao: 'João Vito' },
  ],
  correcoes: [
    { fala: 1, de: 'pics', para: 'PIX' },
    { fala: 2, de: 'João Vito', para: 'João Vitor' },
  ],
})

describe('the finishing of the transcript in one pass', () => {
  it('title, speaker names and corrections come from one call, with the same rules as before', async () => {
    const session = { chat: vi.fn(async () => ANSWER) } as unknown as GenerationSession
    const { recording, title } = await polishTranscript(meeting(), session, 'PIX')
    expect(vi.mocked(session.chat)).toHaveBeenCalledTimes(1)
    const [input, system] = vi.mocked(session.chat).mock.calls[0] as unknown as [string, string]
    expect(system).toBe(PROMPTS.POLISH_PROMPT)
    expect(input).toContain('Primeiro trecho: devolva também o "titulo".')
    expect(input).toContain('Termos que aparecem nesta gravação: PIX.')
    expect(input).toContain('Escrito na tela durante a reunião: Participantes: João Vitor Almeida')
    expect(input).toContain('2 | Falante 2 [00:04]: Mando sim, falei com o João Vito ontem.')
    expect(title).toBe('Proposta do PIX para maio')
    expect(recording.speakers.map(speaker => speaker.name)).toEqual(['Você', 'Marina', 'João Vitor Almeida'])
    expect(recording.blocks[0].text).toBe('Marina, você manda a proposta do PIX?')
    expect(recording.blocks[1]).toMatchObject({ text: 'Mando sim, falei com o João Vitor ontem.', original: 'Mando sim, falei com o João Vito ontem.' })
  })

  it('a long transcript is one call per piece, and only the first one asks for the title', async () => {
    const session = { chat: vi.fn(async () => '{"titulo": "", "nomes": [], "correcoes": []}') } as unknown as GenerationSession
    const long = meeting(Math.ceil((CHUNK_CHARS * 1.5) / 400))
    await polishTranscript(long, session)
    const inputs = vi.mocked(session.chat).mock.calls.map(call => call[0] as string)
    expect(inputs.length).toBe(2)
    expect(inputs[0]).toContain('Primeiro trecho')
    expect(inputs[1]).toContain('não devolva "titulo"')
  })
})

it('when the AI fails, the transcription stays as heard and says why on screen', async () => {
  const session = { chat: vi.fn(async () => { throw new Error('402 sem saldo') }) } as unknown as GenerationSession
  const { recording } = await polishTranscript(meeting(), session)
  expect(recording.blocks).toEqual(meeting().blocks)
  expect(recording.warning).toBe('A revisão por IA não rodou (nomes e palavras ficaram como o áudio saiu): 402 sem saldo')
})
