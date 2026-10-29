import { Cancelled } from '@/controllers/ai.controller'
import type { FrameSource, SeeFn } from '@/lib/generation/ata-types'
import { extractJson } from '@/lib/generation/mermaid'
import { MICROPHONE } from '@/lib/transcription/turns'
import type { RecordingData, RecordingSpeaker, TranscriptBlock } from '@/types/domain'

export const WHO_PROMPT = 'Esta é a tela de uma chamada de vídeo. Olhe os quadros de vídeo dos participantes (cada um com um nome escrito). Quem está FALANDO agora é o quadro com o indicador de som aceso: ondinha ou barrinhas de áudio animadas ao lado do nome, ou borda acesa. NÃO são sinal de fala: o ícone de compartilhar tela (seta ou monitor, muitas vezes verde), o microfone apenas ligado, e o nome escrito embaixo ou em cima da tela compartilhada (é de quem compartilha). Devolva SOMENTE um JSON: {"falando": "nome escrito no quadro com o indicador de som aceso, ou \'\' se nenhum", "pista": "o que na tela mostra isso", "compartilhando": "quem está compartilhando a tela, se aparece, ou \'\'", "participantes": ["nomes escritos nos quadros"]}'

export const TILES_PROMPT = 'Esta é a tela de uma chamada de vídeo. Devolva SOMENTE um JSON: {"quadros": ["nome escrito em cada quadro de vídeo de participante"]}. Não inclua nomes de notificações, listas de reuniões ou da barra lateral.'

export interface TileVote {
  id: string
  name: string
  votes: number
  total: number
}

const VOTE_FRAMES = 7
const LONG_BLOCK_SECONDS = 4
const MIN_VOTES = 2

function validName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name === 'Você' || /^Falante \d+$/.test(name)) return ''
  return name
}

function length(block: TranscriptBlock): number {
  return block.end - block.start
}

function voteBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const sorted = [...blocks].sort((a, b) => length(b) - length(a))
  const long = sorted.filter(block => length(block) >= LONG_BLOCK_SECONDS)
  return (long.length ? long : sorted).slice(0, VOTE_FRAMES)
}

async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let stopped = false
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (!stopped && next < items.length) {
      const index = next++
      try {
        out[index] = await run(items[index])
      } catch (error) {
        stopped = true
        throw error
      }
    }
  }))
  return out
}

function ranked(count: Map<string, number>): [string, number][] {
  return [...count].sort((a, b) => b[1] - a[1])
}

export async function speakersFromTiles(
  recording: RecordingData,
  frames: Pick<FrameSource, 'full'>,
  see: SeeFn,
  options: { concurrency?: number } = {},
): Promise<{ recording: RecordingData; votes: TileVote[]; tiles: string[] }> {
  const blocks = recording.blocks
  if (!blocks.length) return { recording, votes: [], tiles: [] }

  const ask = async (at: number, prompt: string) => {
    try {
      const shot = await frames.full(at)
      return extractJson(await see([shot.image], prompt))
    } catch (error) {
      if (error instanceof Cancelled) throw error
      return null
    }
  }

  const voices = recording.speakers.filter(speaker => blocks.some(block => block.speaker === speaker.id))
  type Job = { kind: 'who'; id: string; at: number } | { kind: 'tiles'; at: number }
  const jobs: Job[] = voices.flatMap(speaker =>
    voteBlocks(blocks.filter(block => block.speaker === speaker.id))
      .map(block => ({ kind: 'who' as const, id: speaker.id, at: (block.start + block.end) / 2 })))
  const clamp = (index: number) => Math.min(blocks.length - 1, Math.max(0, index))
  const tileTimes = [...new Set([5, Math.floor(blocks.length / 2), blocks.length - 5].map(index => blocks[clamp(index)].start))]
  for (const at of tileTimes) jobs.push({ kind: 'tiles', at })

  const answers = await pool(jobs, options.concurrency ?? 3, job => ask(job.at, job.kind === 'who' ? WHO_PROMPT : TILES_PROMPT))

  const counts = new Map<string, Map<string, number>>(voices.map(speaker => [speaker.id, new Map()]))
  const tileCount = new Map<string, number>()
  jobs.forEach((job, index) => {
    const answer = answers[index]
    if (!answer) return
    if (job.kind === 'who') {
      const name = validName(answer.falando)
      if (!name) return
      const count = counts.get(job.id)!
      count.set(name, (count.get(name) ?? 0) + 1)
    } else {
      const names = Array.isArray(answer.quadros) ? answer.quadros : []
      for (const name of new Set(names.map(validName).filter(Boolean))) tileCount.set(name, (tileCount.get(name) ?? 0) + 1)
    }
  })
  const tiles = ranked(tileCount).map(([name]) => name)

  const votes: TileVote[] = voices.map(speaker => {
    const count = counts.get(speaker.id)!
    const [name, top] = ranked(count)[0] ?? ['', 0]
    const total = [...count.values()].reduce((sum, value) => sum + value, 0)
    return { id: speaker.id, name, votes: top, total }
  })

  // Who gets which tile name. Names guessed from the conversation (e.g. a name heard in the speech)
  // never survive when there is a tile left: every voice ends with a tile name.
  const names = new Map(recording.speakers.map(speaker => [speaker.id, speaker.name]))
  const taken = new Set<string>()
  const assigned = new Set<string>()
  const assign = (id: string, name: string) => (taken.add(name), assigned.add(id), names.set(id, name))
  const remote = votes.filter(vote => vote.id !== MICROPHONE)
  // 1) confident votes: at least 2 and more than half of the voice's votes; more votes win a conflict
  for (const vote of [...remote].filter(v => v.votes >= MIN_VOTES && v.votes > v.total / 2).sort((a, b) => b.votes - a.votes)) if (!taken.has(vote.name)) assign(vote.id, vote.name)
  // 2) a voice without a confident vote: its best voted name still free
  for (const vote of remote) {
    if (assigned.has(vote.id)) continue
    const best = ranked(counts.get(vote.id)!).find(([name]) => !taken.has(name))
    if (best) assign(vote.id, best[0])
  }
  // how often each tile was seen lit by any voice: the recorder's own tile is the one that almost never lights
  const lit = new Map<string, number>()
  for (const count of counts.values()) for (const [name, n] of count) lit.set(name, (lit.get(name) ?? 0) + n)
  const free = () => [...new Set([...tiles, ...lit.keys()])].filter(name => !taken.has(name))
  // 3) a voice with no usable vote: the free tile that lit the most
  for (const vote of remote) {
    if (assigned.has(vote.id)) continue
    const pick = free().sort((a, b) => (lit.get(b) ?? 0) - (lit.get(a) ?? 0))[0]
    if (pick) assign(vote.id, pick)
  }
  // 4) the microphone (who recorded): the free tile that lit the least, else its own vote
  const mic = voices.find(speaker => speaker.id === MICROPHONE)
  if (mic) {
    const own = ranked(counts.get(MICROPHONE) ?? new Map()).find(([name]) => !taken.has(name))?.[0] ?? ''
    const name = free().sort((a, b) => (lit.get(a) ?? 0) - (lit.get(b) ?? 0))[0] ?? own
    if (name) assign(MICROPHONE, name)
  }

  const speakers: RecordingSpeaker[] = recording.speakers.map(speaker => {
    const name = names.get(speaker.id)!
    return name === speaker.name ? speaker : { ...speaker, name, suggested: false }
  })
  return { recording: { ...recording, speakers }, votes, tiles }
}
