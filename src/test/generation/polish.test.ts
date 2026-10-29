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
      { id: 'mic', name: 'Regy Niles', suggested: false },
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
    { falante: 'Regy Niles', nome: 'João', citacao: 'João Vito' },
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
    expect(recording.speakers.map(speaker => speaker.name)).toEqual(['Regy Niles', 'Marina', 'João Vitor Almeida'])
    expect(recording.blocks[0].text).toBe('Marina, você manda a proposta do PIX?')
    expect(recording.blocks[1]).toMatchObject({ text: 'Mando sim, falei com o João Vitor ontem.', original: 'Mando sim, falei com o João Vito ontem.' })
  })

  it('a long transcript goes in small pieces asked all at once, and the title comes from its own call over the opening', async () => {
    let active = 0
    let peak = 0
    const session = {
      chat: vi.fn(async (_input: string, system: string) => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active--
        return system === PROMPTS.TITLE_PROMPT ? '{"titulo": "Proposta do PIX para maio"}' : '{"nomes": [], "correcoes": [{"fala": 1, "de": "pics", "para": "PIX"}]}'
      }),
    } as unknown as GenerationSession
    const long = meeting(Math.ceil((CHUNK_CHARS * 1.5) / 400))
    const { recording, title } = await polishTranscript(long, session)
    const calls = vi.mocked(session.chat).mock.calls as unknown as [string, string][]
    const pieces = calls.filter(([, system]) => system === PROMPTS.POLISH_PROMPT).map(([input]) => input)
    const titles = calls.filter(([, system]) => system === PROMPTS.TITLE_PROMPT).map(([input]) => input)
    expect(pieces.length).toBeGreaterThanOrEqual(4)
    expect(pieces.every(input => input.includes('não devolva "titulo"') && input.length < CHUNK_CHARS / 2)).toBe(true)
    expect(pieces.every(input => input.includes('Escrito na tela durante a reunião: Participantes: João Vitor Almeida'))).toBe(true)
    expect(titles).toHaveLength(1)
    expect(titles[0]).toContain('1 | Regy Niles [00:00]: Marina, você manda a proposta do pics?')
    expect(titles[0].length).toBeGreaterThan(CHUNK_CHARS * 0.9)
    expect(title).toBe('Proposta do PIX para maio')
    expect(peak).toBe(calls.length)
    expect(recording.blocks[0].text).toBe('Marina, você manda a proposta do PIX?')
  })

  it('without the name of who recorded, the microphone voice is named from the conversation like any other speaker', async () => {
    const unnamed: RecordingData = {
      blocks: [
        { speaker: 'speaker_0', start: 0, end: 3, text: 'Pode ir, Reg?' },
        { speaker: 'mic', start: 4, end: 8, text: 'Posso, vou mostrar a tela.' },
      ],
      speakers: [
        { id: 'speaker_0', name: 'Falante 1', suggested: false },
        { id: 'mic', name: 'Quem gravou', suggested: false },
      ],
      marks: [],
    }
    const session = { chat: vi.fn(async () => JSON.stringify({ titulo: '', nomes: [{ falante: 'Quem gravou', nome: 'Reg', citacao: 'Pode ir, Reg?' }], correcoes: [] })) } as unknown as GenerationSession
    const { recording } = await polishTranscript(unnamed, session)
    const [input] = vi.mocked(session.chat).mock.calls[0] as unknown as [string, string]
    expect(input).toContain('2 | Quem gravou [00:04]: Posso, vou mostrar a tela.')
    expect(recording.speakers[1]).toEqual({ id: 'mic', name: 'Reg', suggested: true })
    expect(PROMPTS.POLISH_PROMPT).not.toContain('nunca recebe nome')
    expect(PROMPTS.POLISH_PROMPT).toContain('"Quem gravou"')
  })

  it('the text read on the screen is the glossary of the review: a sigla misheard becomes the one on the screen', async () => {
    const screen = { ...meeting(), blocks: [{ speaker: 'speaker_0', start: 4, end: 8, text: 'O BGF do soluto subiu.' }], frames: [{ at: 4, image: 'i', text: 'VGV e Pró Soluto por mês' }] }
    const session = {
      chat: vi.fn(async (input: string) =>
        input.includes('Escrito na tela durante a reunião: VGV e Pró Soluto por mês')
          ? JSON.stringify({ titulo: '', nomes: [], correcoes: [{ fala: 1, de: 'BGF', para: 'VGV' }, { fala: 1, de: 'soluto', para: 'Pró Soluto' }] })
          : '{"titulo": "", "nomes": [], "correcoes": []}',
      ),
    } as unknown as GenerationSession
    const { recording } = await polishTranscript(screen, session)
    expect(recording.blocks[0].text).toBe('O VGV do Pró Soluto subiu.')
    expect(PROMPTS.POLISH_PROMPT).toMatch(/^- .*sigla.*"Escrito na tela durante a reunião".*"VGV"/m)
  })
})

it('when the AI fails, the transcription stays as heard and says why on screen', async () => {
  const session = { chat: vi.fn(async () => { throw new Error('402 sem saldo') }) } as unknown as GenerationSession
  const { recording } = await polishTranscript(meeting(), session)
  expect(recording.blocks).toEqual(meeting().blocks)
  expect(recording.warning).toBe('A revisão por IA não rodou (nomes e palavras ficaram como o áudio saiu): 402 sem saldo')
})
