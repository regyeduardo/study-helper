import { describe, expect, it, vi } from 'vitest'
import { Cancelled } from '@/controllers/ai.controller'
import type { SeeFn, Shot } from '@/lib/generation/ata-types'
import { amongPrompt, speakersFromTiles, TILES_PROMPT, WHO_PROMPT } from '@/lib/generation/speakers-from-tiles'
import type { RecordingData, TranscriptBlock } from '@/types/domain'

const TILES = ['Ana Souza', 'Bruno Lima', 'Regy Niles']

function recording(turns: [string, number, number][]): RecordingData {
  const blocks: TranscriptBlock[] = turns.map(([speaker, start, end]) => ({ speaker, start, end, text: `fala ${start}` }))
  const ids = [...new Set(blocks.map(block => block.speaker))]
  let index = 0
  return {
    blocks,
    speakers: ids.map(id => ({ id, name: id === 'mic' ? 'Você' : `Falante ${++index}`, suggested: true })),
    marks: [],
  }
}

const frames = {
  full: vi.fn(async (at: number): Promise<Shot> => ({ at, image: `data:image/jpeg;base64,${at}`, width: 1280, height: 720, signature: [] })),
}

function timeOf(image: string): number {
  return Number(image.split(',')[1])
}

/** Fake vision: `who(at)` says who is lit at that time; a thrown value is passed on. */
function fakeSee(who: (at: number) => string, tiles: string[] = TILES): SeeFn {
  return vi.fn(async (images: string[], prompt: string) => {
    const at = timeOf(images[0])
    if (prompt === TILES_PROMPT) return JSON.stringify({ quadros: tiles })
    if (prompt !== WHO_PROMPT) throw new Error('prompt inesperado')
    return '```json\n' + JSON.stringify({ falando: who(at), pista: 'ondinha', participantes: tiles }) + '\n```'
  })
}

// Ana (s1) at 0-30, Bruno (s2) at 30-60, the mic at 60-90.
const MEETING: [string, number, number][] = [
  ['s1', 0, 10], ['s1', 10, 20], ['s1', 20, 30],
  ['s2', 30, 40], ['s2', 40, 50], ['s2', 50, 60],
  ['mic', 60, 70], ['mic', 70, 80], ['mic', 80, 90],
]
const byTime = (at: number) => (at < 30 ? 'Ana Souza' : at < 60 ? 'Bruno Lima' : '')

function nameOf(data: RecordingData, id: string) {
  return data.speakers.find(speaker => speaker.id === id)?.name
}

describe('speakersFromTiles', () => {
  it('renomeia as vozes remotas pela maioria e dá ao microfone o nome restante', async () => {
    const input = recording(MEETING)
    const result = await speakersFromTiles(input, frames, fakeSee(byTime))
    expect(nameOf(result.recording, 's1')).toBe('Ana Souza')
    expect(nameOf(result.recording, 's2')).toBe('Bruno Lima')
    expect(nameOf(result.recording, 'mic')).toBe('Regy Niles')
    expect(result.recording.speakers.every(speaker => !speaker.suggested)).toBe(true)
    expect(result.recording.blocks).toBe(input.blocks)
    expect(result.tiles).toEqual(TILES)
    expect(result.votes.find(vote => vote.id === 's1')).toEqual({ id: 's1', name: 'Ana Souza', votes: 3, total: 3 })
  })

  it('o microfone nunca fica "Você", mesmo quando os votos dele apontam outra pessoa', async () => {
    const who = (at: number) => (at < 30 ? 'Ana Souza' : at < 60 ? 'Bruno Lima' : 'Ana Souza')
    const result = await speakersFromTiles(recording(MEETING), frames, fakeSee(who))
    expect(nameOf(result.recording, 'mic')).toBe('Regy Niles')
    expect(result.recording.speakers.map(speaker => speaker.name)).not.toContain('Você')
  })

  it('sem nome sobrando nos quadros, o microfone usa o próprio voto', async () => {
    const who = (at: number) => (at < 30 ? 'Ana Souza' : at < 60 ? 'Bruno Lima' : 'Carla Dias')
    const result = await speakersFromTiles(recording(MEETING), frames, fakeSee(who, ['Ana Souza', 'Bruno Lima']))
    expect(nameOf(result.recording, 'mic')).toBe('Carla Dias')
  })

  it('voz com só 1 voto fica com esse nome do quadro (não com "Falante N")', async () => {
    const input = recording([['s1', 0, 10], ['s1', 10, 20], ['s2', 30, 40], ['s1', 40, 50], ['s1', 50, 60], ['s1', 60, 70]])
    const result = await speakersFromTiles(input, frames, fakeSee(at => (at >= 30 && at < 40 ? 'Bruno Lima' : 'Ana Souza')))
    expect(nameOf(result.recording, 's1')).toBe('Ana Souza')
    const s2 = result.recording.speakers.find(speaker => speaker.id === 's2')
    expect(s2).toEqual({ id: 's2', name: 'Bruno Lima', suggested: false })
  })

  it('duas vozes com o mesmo nome: fica com quem tem mais votos', async () => {
    const input = recording([['s1', 0, 10], ['s1', 10, 20], ['s1', 20, 30], ['s2', 30, 40], ['s2', 40, 50]])
    const result = await speakersFromTiles(input, frames, fakeSee(() => 'Ana Souza'))
    expect(nameOf(result.recording, 's1')).toBe('Ana Souza')
    expect(nameOf(result.recording, 's2')).toBe('Bruno Lima')
  })

  it('nunca fica um nome adivinhado pela conversa: a voz sem voto pega o quadro livre que mais acendeu, o microfone o que menos', async () => {
    const input = recording([['s0', 0, 10], ['s0', 10, 20], ['s2', 30, 40], ['s2', 40, 50], ['mic', 60, 70], ['mic', 70, 80]])
    input.speakers = [
      { id: 's0', name: 'Henrique', suggested: true },
      { id: 's2', name: 'Luan', suggested: true },
      { id: 'mic', name: 'Você', suggested: false },
    ]
    const tiles = ['Henrique Souza', 'Natália Lenza', 'Regy Niles']
    const result = await speakersFromTiles(input, frames, fakeSee(at => (at < 30 ? 'Natália Lenza' : at < 60 ? '' : at < 70 ? 'Henrique Souza' : ''), tiles))
    expect(result.recording.speakers.map(speaker => `${speaker.id}=${speaker.name}`)).toEqual(['s0=Natália Lenza', 's2=Henrique Souza', 'mic=Regy Niles'])
    // one weak vote is enough when the name is free
    const weak = await speakersFromTiles(input, frames, fakeSee(at => (at < 30 ? 'Natália Lenza' : at === 35 ? 'Henrique Souza' : ''), tiles))
    expect(weak.recording.speakers.map(speaker => speaker.name)).toEqual(['Natália Lenza', 'Henrique Souza', 'Regy Niles'])
  })

  it('o microfone fica com o quadro que acende quando ele fala, não com o de quem está mudo (reunião de 09/11)', async () => {
    // Ana fala 0-30; o microfone (Regy) fala 60-90 e o quadro DELE acende (borda); Bruno está mudo e nunca acende.
    const who = (at: number) => (at < 30 ? 'Ana Souza' : at >= 60 ? 'Regy Niles' : '')
    const result = await speakersFromTiles(recording([['s1', 0, 10], ['s1', 10, 20], ['s1', 20, 30], ['mic', 60, 70], ['mic', 70, 80], ['mic', 80, 90]]), frames, fakeSee(who))
    expect(nameOf(result.recording, 's1')).toBe('Ana Souza')
    expect(nameOf(result.recording, 'mic')).toBe('Regy Niles')
  })

  it('o microfone que já tem o nome real de quem gravou o mantém, e nenhuma outra voz leva esse nome (quadro mudo e quadro próprio nunca acendem: não dá para escolher entre eles)', async () => {
    // Ana fala; o microfone é o Regy (conta Google do app); Bruno está mudo. Ninguém acende enquanto o microfone fala.
    const input = recording([['s1', 0, 10], ['s1', 10, 20], ['s1', 20, 30], ['mic', 60, 70], ['mic', 70, 80]])
    input.speakers = input.speakers.map(speaker => (speaker.id === 'mic' ? { ...speaker, name: 'Regy Niles' } : speaker))
    const result = await speakersFromTiles(input, frames, fakeSee(at => (at < 30 ? 'Ana Souza' : ''), ['Ana Souza', 'Bruno Lima', 'Regy Niles']))
    expect(nameOf(result.recording, 'mic')).toBe('Regy Niles')
    expect(nameOf(result.recording, 's1')).toBe('Ana Souza')
  })

  it('o microfone com um só bloco longo (e sobreposto à outra voz) vota também nos blocos curtos, onde o quadro dele acende sozinho (reunião de 09/11, quadros reais)', async () => {
    // Ana fala 0-30; o microfone tem um bloco longo 60-72 em que Ana fala por cima (a visão vê Ana) e três respostas curtas em que só o quadro do Regy acende; Bruno está mudo.
    const input = recording([['s1', 0, 10], ['s1', 10, 20], ['s1', 20, 30], ['mic', 60, 72], ['mic', 75, 77], ['mic', 80, 82], ['mic', 85, 87]])
    const who = (at: number) => (at < 30 || at === 66 ? 'Ana Souza' : 'Regy Niles')
    const result = await speakersFromTiles(input, frames, fakeSee(who, ['Ana Souza', 'Bruno Lima', 'Regy Niles']))
    expect(nameOf(result.recording, 'mic')).toBe('Regy Niles')
    expect(nameOf(result.recording, 's1')).toBe('Ana Souza')
  })

  it('a visão que sempre aponta a apresentadora não decide o microfone: ele pergunta só entre os quadros que sobram, e o mudo nunca acende (reunião de 09/11, quadros reais)', async () => {
    // Ana apresenta e fala 0-30. Quando o microfone fala (60+), a visão ainda aponta Ana (o nome dela está em destaque). Entre Bruno (mudo) e Regy, só o quadro do Regy acende.
    const input = recording([['s1', 0, 10], ['s1', 10, 20], ['s1', 20, 30], ['mic', 60, 72], ['mic', 75, 77], ['mic', 80, 82], ['mic', 85, 87]])
    const tiles = ['Ana Souza', 'Bruno Lima', 'Regy Niles']
    const see: SeeFn = vi.fn(async (images: string[], prompt: string) => {
      const at = timeOf(images[0])
      if (prompt === TILES_PROMPT) return JSON.stringify({ quadros: tiles })
      if (prompt === WHO_PROMPT) return JSON.stringify({ falando: 'Ana Souza' })
      if (prompt === amongPrompt(['Bruno Lima', 'Regy Niles'])) return JSON.stringify({ falando: at >= 60 ? 'Regy Niles' : '' })
      throw new Error('prompt inesperado')
    })
    const result = await speakersFromTiles(input, frames, see)
    expect(nameOf(result.recording, 'mic')).toBe('Regy Niles')
    expect(nameOf(result.recording, 's1')).toBe('Ana Souza')
  })

  it('a voz remota que a visão confunde com o nome de quem gravou fica com outro quadro', async () => {
    const input = recording([['s1', 0, 10], ['s1', 10, 20], ['s1', 20, 30], ['mic', 60, 70]])
    input.speakers = input.speakers.map(speaker => (speaker.id === 'mic' ? { ...speaker, name: 'Regy Niles' } : speaker))
    const result = await speakersFromTiles(input, frames, fakeSee(at => (at < 30 ? 'Regy Niles' : ''), ['Ana Souza', 'Bruno Lima', 'Regy Niles']))
    expect(nameOf(result.recording, 'mic')).toBe('Regy Niles')
    expect(nameOf(result.recording, 's1')).not.toBe('Regy Niles')
  })

  it('falha da visão em alguns quadros não derruba o resto', async () => {
    const see = fakeSee(at => {
      if (at === 5 || at === 45) throw new Error('timeout')
      return byTime(at)
    })
    const result = await speakersFromTiles(recording(MEETING), frames, see)
    expect(nameOf(result.recording, 's1')).toBe('Ana Souza')
    expect(nameOf(result.recording, 's2')).toBe('Bruno Lima')
    expect(result.votes.find(vote => vote.id === 's1')?.total).toBe(2)
  })

  it('Cancelled é repassado', async () => {
    const see = fakeSee(at => {
      if (at === 45) throw new Cancelled()
      return byTime(at)
    })
    await expect(speakersFromTiles(recording(MEETING), frames, see)).rejects.toBeInstanceOf(Cancelled)
  })

  it('respeita a concorrência (no máximo 3 de uma vez por padrão)', async () => {
    let active = 0
    let peak = 0
    const see: SeeFn = async (images, prompt) => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return prompt === TILES_PROMPT ? JSON.stringify({ quadros: TILES }) : JSON.stringify({ falando: byTime(timeOf(images[0])) })
    }
    await speakersFromTiles(recording(MEETING), frames, see)
    expect(peak).toBe(3)
    peak = 0
    await speakersFromTiles(recording(MEETING), frames, see, { concurrency: 1 })
    expect(peak).toBe(1)
  })

  it('sem falas, não chama a visão', async () => {
    const see = vi.fn<SeeFn>()
    const full = vi.fn()
    const input: RecordingData = { blocks: [], speakers: [{ id: 'mic', name: 'Você', suggested: false }], marks: [] }
    const result = await speakersFromTiles(input, { full }, see)
    expect(see).not.toHaveBeenCalled()
    expect(full).not.toHaveBeenCalled()
    expect(result.recording).toBe(input)
  })
})
