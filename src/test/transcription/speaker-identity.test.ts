// FR-059 (spec 003): o reconhecimento de quem fala nunca dá o mesmo nome a duas vozes diferentes; sem certeza, fica "Falante N".
import { describe, expect, it, vi } from 'vitest'

import type { RecordingData, RecordingSpeaker, TranscriptBlock } from '@/types/domain'
import type { SeeFn, Shot } from '@/lib/generation/ata-types'
import { lookAtScreen } from '@/lib/generation/frames'
import type { GenerationSession } from '@/lib/generation/session'
import { speakersFromTiles, TILES_PROMPT, WHO_PROMPT } from '@/lib/generation/speakers-from-tiles'
import { distinctNames } from '@/lib/transcription/turns'

const voice = (id: string, name: string, suggested = false): RecordingSpeaker => ({ id, name, suggested })
const names = (speakers: RecordingSpeaker[]) => speakers.map(speaker => speaker.name)

describe('distinctNames: duas vozes nunca com o mesmo nome', () => {
  it('um nome que chegou agora para duas vozes não fica com nenhuma: as duas voltam ao nome de antes', () => {
    const before = [voice('s1', 'Falante 1'), voice('s2', 'Falante 2')]
    expect(names(distinctNames(before, [voice('s1', 'Marina Souza'), voice('s2', 'Marina Souza')]))).toEqual(['Falante 1', 'Falante 2'])
  })

  it('o nome que uma voz já tinha fica com ela; a outra, que acabou de recebê-lo, volta ao nome de antes', () => {
    const before = [voice('s1', 'Marina', true), voice('s2', 'Falante 2')]
    expect(names(distinctNames(before, [voice('s1', 'Marina', true), voice('s2', 'marina')]))).toEqual(['Marina', 'Falante 2'])
  })

  it('maiúsculas e acentos não disfarçam o mesmo nome', () => {
    const before = [voice('s1', 'Falante 1'), voice('s2', 'Falante 2'), voice('s3', 'Falante 3')]
    const after = distinctNames(before, [voice('s1', 'Mônica'), voice('s2', 'MONICA'), voice('s3', 'Bruno')])
    expect(names(after)).toEqual(['Falante 1', 'Falante 2', 'Bruno'])
  })

  it('se voltar ao nome de antes também repete, a voz fica com um "Falante N" livre', () => {
    const before = [voice('s1', 'Ana'), voice('s2', 'Ana')]
    expect(names(distinctNames(before, before))).toEqual(['Falante 1', 'Falante 2'])
  })

  it('o nome de quem gravou (o microfone com o nome da conta) nunca sai dele', () => {
    const before = [voice('mic', 'Regy Niles'), voice('s1', 'Falante 1')]
    expect(names(distinctNames(before, [voice('mic', 'Regy Niles'), voice('s1', 'Regy Niles')]))).toEqual(['Regy Niles', 'Falante 1'])
  })

  it('sem nomes repetidos, nada muda', () => {
    const after = [voice('s1', 'Ana'), voice('s2', 'Bruno')]
    expect(distinctNames([voice('s1', 'Falante 1'), voice('s2', 'Falante 2')], after)).toEqual(after)
  })
})

const vision = { provider: 'openai' as const, baseUrl: '', apiKey: 'sk-teste', model: 'gpt-visao' }
const video = new Blob(['v'], { type: 'video/webm' })
const grab = vi.fn(async (_video: Blob, times: number[]) => times.map(at => ({ at, image: `img-${at}`, signature: [at] })))
const quiet = { chat: vi.fn(async () => '{"horas": []}') } as unknown as GenerationSession

describe('o nome lido na tela da reunião', () => {
  const meeting: RecordingData = {
    blocks: [
      { speaker: 'mic', start: 0, end: 5, text: 'Bom dia.' },
      { speaker: 's1', start: 6, end: 20, text: 'Vamos ver o orçamento.' },
      { speaker: 's2', start: 21, end: 40, text: 'O prazo é março.' },
    ],
    speakers: [voice('mic', 'Regy Niles'), voice('s1', 'Falante 1'), voice('s2', 'Falante 2')],
    marks: [],
  }

  it('a tela mostra o mesmo nome para duas vozes (o quadro aceso era de outra pessoa): nenhuma das duas fica com ele', async () => {
    const see = vi.fn(async () => '{"nome": "Marina Souza"}')
    const seen = await lookAtScreen(meeting, video, vision, quiet, { grab, see })
    expect(names(seen.speakers)).toEqual(['Regy Niles', 'Falante 1', 'Falante 2'])
  })

  it('a tela mostra para uma voz o nome que outra voz já tem: a voz que já tinha fica com ele', async () => {
    const named = { ...meeting, speakers: [voice('mic', 'Regy Niles'), voice('s1', 'Marina', true), voice('s2', 'Falante 2')] }
    const see = vi.fn(async (_settings: unknown, _images: string[], prompt: string) => (prompt.includes('"Falante 2"') ? '{"nome": "Marina"}' : '{"nome": ""}'))
    const seen = await lookAtScreen(named, video, vision, quiet, { grab, see })
    expect(names(seen.speakers)).toEqual(['Regy Niles', 'Marina', 'Falante 2'])
  })
})

describe('o nome pelos quadros da chamada', () => {
  const frames = { full: vi.fn(async (at: number): Promise<Shot> => ({ at, image: `data:image/jpeg;base64,${at}`, width: 1280, height: 720, signature: [] })) }
  const timeOf = (image: string) => Number(image.split(',')[1])
  const fakeSee = (who: (at: number) => string, tiles: string[]): SeeFn =>
    vi.fn(async (images: string[], prompt: string) => {
      if (prompt === TILES_PROMPT) return JSON.stringify({ quadros: tiles })
      if (prompt !== WHO_PROMPT) return '{"falando": ""}'
      return JSON.stringify({ falando: who(timeOf(images[0])), participantes: tiles })
    })

  it('a voz sem quadro aceso não fica com o nome da conversa quando esse nome foi para a voz que o quadro mostra', async () => {
    const turns: [string, number, number][] = [['s1', 0, 10], ['s1', 10, 20], ['s2', 30, 40], ['s2', 40, 50], ['s3', 60, 70], ['s3', 70, 80]]
    const blocks: TranscriptBlock[] = turns.map(([speaker, start, end]) => ({ speaker, start, end, text: `fala ${start}` }))
    // s3 had "Bruno Lima" from the conversation; the tiles show Bruno lit while s2 speaks
    const input: RecordingData = { blocks, speakers: [voice('s1', 'Falante 1', true), voice('s2', 'Falante 2', true), voice('s3', 'Bruno Lima', true)], marks: [] }
    const result = await speakersFromTiles(input, frames, fakeSee(at => (at < 30 ? 'Ana Souza' : at < 60 ? 'Bruno Lima' : ''), ['Ana Souza', 'Bruno Lima']))
    const final = names(result.recording.speakers)
    expect(final.slice(0, 2)).toEqual(['Ana Souza', 'Bruno Lima'])
    expect(final[2]).toMatch(/^Falante \d+$/)
    expect(new Set(final).size).toBe(final.length)
  })
})
