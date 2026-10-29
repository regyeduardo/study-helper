// The "Ata": ONE document made of the parts the person checked, in this order: Resumo, Levantamento
// de tarefas, Perguntas em aberto, Linha do tempo, 1:1. Shared steps: real names from the call tiles,
// the screen reading, and the context + glossary pass.
import type { AtaImage, AtaPart, RecordingData, StageTime } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import type { AtaAi } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import type { Box, FrameSource, Mark } from '@/lib/generation/ata-types'
import { accentNames, clock, groupReadings, jsonIn, linkMoments, list, meetingMaterial, pool, type ScreenGroup, understandMeeting } from '@/lib/generation/meeting-material'
import { readScreen } from '@/lib/generation/screen-reading'
import { speakersFromTiles } from '@/lib/generation/speakers-from-tiles'
import { type BasePart, type PartResult, writePart } from '@/lib/generation/summary'
import { buildTasks, type PrintRequest } from '@/lib/generation/tasks'
import { StageClock } from '@/lib/transcription/types'
import { MICROPHONE } from '@/lib/transcription/turns'

export const PART_ORDER: AtaPart[] = ['resumo', 'tarefas', 'perguntas', 'linha', 'um-a-um']

export const PART_LABEL: Record<AtaPart, string> = { resumo: 'Resumo', tarefas: 'Levantamento de tarefas', perguntas: 'Perguntas em aberto', linha: 'Linha do tempo', 'um-a-um': '1:1' }

/** Markdown points at prints as "imagens/NAME"; the note keeps the images and the viewer swaps the path for the image. */
export const IMAGE_DIR = 'imagens/'

export interface AtaTools {
  ai: AtaAi
  /** Stills of the recorded video; null for audio-only notes. */
  frames: FrameSource | null
  difference(a: number[], b: number[]): number
  /** Draws the marks and the caption on the still; returns a JPEG data URL. */
  renderPrint(image: string, marks: Mark[], caption: string): Promise<string>
}

export interface AtaRequest {
  recording: RecordingData
  parts: AtaPart[]
  startedAt: Date
  onProgress?(message: string): void
}

export interface AtaResult {
  markdown: string
  title: string
  images: AtaImage[]
  /** The recording with speakers renamed from the call tiles (same object when nothing changed). */
  recording: RecordingData
  models: Record<string, string>
  costUsd?: number
  stages: StageTime[]
}

async function quiet<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work
  } catch (error) {
    if (error instanceof Cancelled) throw error
    return null
  }
}

/** Never "Você" or "Falante N" in a document: when no real name is known, a neutral description. */
function documentNames(recording: RecordingData): RecordingData {
  let changed = false
  const speakers = recording.speakers.map((speaker, index) => {
    if (speaker.id === MICROPHONE && speaker.name === 'Você') return ((changed = true), { ...speaker, name: 'Quem gravou' })
    if (/^Falante \d+$/.test(speaker.name)) return ((changed = true), { ...speaker, name: `Participante ${index + 1}` })
    return speaker
  })
  return changed ? { ...recording, speakers } : recording
}

export function chosenParts(parts: AtaPart[]): AtaPart[] {
  return PART_ORDER.filter(part => parts.includes(part))
}

async function makePrints(requests: PrintRequest[], tools: AtaTools, box: Box | null, readTimes: number[]): Promise<Map<string, AtaImage>> {
  const made = new Map<string, AtaImage>()
  const frames = tools.frames
  if (!frames || !tools.ai.hasVision) return made
  const area: Box = box ?? { x: 0, y: 0, w: frames.width, h: frames.height }
  await pool(requests, 8, async request => {
    const near = readTimes.filter(at => Math.abs(at - request.at) <= 25 && at !== request.at).sort((a, b) => Math.abs(a - request.at) - Math.abs(b - request.at))
    for (const at of [request.at, ...near.slice(0, 2)]) {
      const shot = await quiet(frames.crop(at, area))
      if (!shot) continue
      const got = jsonIn((await quiet(tools.ai.see([shot.image], P.MARCAR.replace('{{marcar}}', request.marcar), 800))) ?? '')
      const marks = list(got?.itens)
        .filter(item => Array.isArray(item.caixa) && item.caixa.length === 4 && item.caixa.every((n: unknown) => typeof n === 'number'))
        .map(item => ({ box: item.caixa as number[], label: String(item.rotulo ?? '') }))
      if (got?.achou === false || !marks.length) continue
      const dataUrl = await quiet(tools.renderPrint(shot.image, marks, `▸ ${clock(at)} · ${request.legenda}`))
      if (!dataUrl) continue
      made.set(request.name, { name: request.name, dataUrl })
      return
    }
  })
  return made
}

export async function buildAta(request: AtaRequest, tools: AtaTools): Promise<AtaResult> {
  const parts = chosenParts(request.parts)
  if (!parts.length) throw new Error('Marque ao menos uma parte da ata.')
  const progress = request.onProgress ?? (() => {})
  const stages = new StageClock()
  const { ai, frames } = tools
  const looks = Boolean(frames && ai.hasVision)

  let recording = request.recording
  if (looks && frames) {
    progress('Vendo quem fala pelos quadros da chamada')
    const named = await stages.run('Quem fala (quadros da chamada)', () => quiet(speakersFromTiles(recording, frames, (images, prompt, max) => ai.see(images, prompt, max))))
    if (named) {
      recording = named.recording
      progress(`Quem fala: ${named.votes.map(vote => `${vote.id} → ${vote.name || '?'} (${vote.votes}/${vote.total})`).join(', ')}; quadros: ${named.tiles.join(', ')}`)
    }
  }

  let screen: ScreenGroup[] = []
  let area: Box | null = null
  let readTimes: number[] = []
  if (looks && frames) {
    const read = await stages.run('Ler a tela compartilhada', () => readScreen(frames, ai, tools.difference, progress))
    screen = groupReadings(read.readings)
    area = read.area
    readTimes = read.times
  }

  const material = meetingMaterial(documentNames(recording), request.startedAt, screen)
  progress('Entendendo a reunião: contexto e glossário')
  const context = await stages.run('Contexto e glossário', () => understandMeeting(material, ai))

  const look = looks && frames ? async (at: number) => (await frames.crop(at, area ?? { x: 0, y: 0, w: frames.width, h: frames.height })).image : null
  const written = new Map<AtaPart, PartResult>()
  await Promise.all(
    parts.map(async part => {
      try {
        if (part === 'tarefas') {
          const tasks = await stages.run(PART_LABEL[part], () => buildTasks(material, context, ai, look, progress))
          written.set(part, { markdown: tasks.markdown, title: tasks.title, prints: tasks.prints })
          return
        }
        progress(`Escrevendo: ${PART_LABEL[part]}`)
        written.set(part, await stages.run(PART_LABEL[part], () => writePart(part as BasePart, material, context, ai)))
      } catch (error) {
        if (error instanceof Cancelled) throw error
        // one part failing never takes the others down, and never passes for "nothing in the meeting"
        const why = error instanceof Error ? error.message : String(error)
        written.set(part, { markdown: `> Esta parte não saiu: ${why.replace(/\.?$/, '.')} Use "Refazer a Ata" para tentar de novo.\n`, title: '', prints: [] })
      }
    }),
  )

  const requests = parts.flatMap(part => written.get(part)?.prints ?? [])
  let images = new Map<string, AtaImage>()
  if (requests.length && looks) {
    progress(`Fazendo os prints marcados (${requests.length})`)
    images = await stages.run('Prints marcados', () => makePrints(requests, tools, area, readTimes))
  }

  const title = written.get('tarefas')?.title || written.get('resumo')?.title || String(context.brief.assunto ?? '') || 'Reunião'
  const out: string[] = [`> Participantes: ${material.participants || 'não identificados'}.`, '', `# ${title}`, '']
  for (const part of parts) out.push(`## ${PART_LABEL[part]}`, '', written.get(part)?.markdown.trim() ?? 'Não apareceu na reunião.', '')
  const legend = new Map(requests.map(item => [item.name, item.legenda]))
  let markdown = out
    .join('\n')
    .replace(/[ \t]*\{\{img:([^}]+)\}\}[ \t]*/g, (all, name: string) => (images.has(name) ? `${all.startsWith(' ') ? ' ' : ''}![${(legend.get(name) ?? '').replace(/[[\]]/g, '')}](${IMAGE_DIR}${name})` : ''))
    .replace(/\n{3,}/g, '\n\n')
  markdown = accentNames(linkMoments(markdown), [...material.people, ...list(context.brief.pessoas).map(p => String(p.nome ?? ''))])
  const used = [...images.values()].filter(image => markdown.includes(`${IMAGE_DIR}${image.name}`))
  return { markdown: markdown.trim() + '\n', title, images: used, recording, models: ai.models(), costUsd: ai.costUsd(), stages: stages.stages }
}

/** Swaps "imagens/NAME" for the stored image so the viewer shows it. */
export function withImages(markdown: string, images: AtaImage[]): string {
  const byName = new Map(images.map(image => [image.name, image.dataUrl]))
  return markdown.replace(/\]\(imagens\/([^)\s]+)\)/g, (all, name: string) => (byName.has(name) ? `](${byName.get(name)})` : all))
}
