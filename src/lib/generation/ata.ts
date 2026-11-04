// The "Ata": ONE document made of the parts the person checked, in this order: Resumo, Levantamento
// de tarefas, Perguntas em aberto, Linha do tempo, 1:1; or, with a "Modelo da ata", ONE document in
// that model's skeleton. Shared steps: real names from the call tiles, the screen reading, and the
// context + glossary pass.
import type { AtaImage, AtaModelId, AtaPart, RecordingData, RecordingMark, StageTime } from '@/types/domain'
import { Cancelled } from '@/controllers/ai.controller'
import type { AtaAi } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import type { Box, FrameSource, Mark, ScreenOcr } from '@/lib/generation/ata-types'
import { askedMoments } from '@/lib/generation/frames'
import { accentNames, clock, groupReadings, jsonIn, linkMoments, list, meetingMaterial, oneLine, pool, type ScreenGroup, short, type Speech, understandMeeting } from '@/lib/generation/meeting-material'
import { browserOcr } from '@/lib/generation/screen-ocr'
import { MARK_BEFORE, readScreen } from '@/lib/generation/screen-reading'
import { personNames, termsForGlossary } from '@/lib/generation/screen-terms'
import { speakersFromTiles } from '@/lib/generation/speakers-from-tiles'
import { type BasePart, type PartResult, writePart } from '@/lib/generation/summary'
import { buildTasks, type PrintRequest } from '@/lib/generation/tasks'
import { StageClock } from '@/lib/transcription/types'
import { MICROPHONE } from '@/lib/transcription/turns'

export const PART_ORDER: AtaPart[] = ['resumo', 'tarefas', 'perguntas', 'linha', 'um-a-um']

export const PART_LABEL: Record<AtaPart, string> = { resumo: 'Resumo', tarefas: 'Levantamento de tarefas', perguntas: 'Perguntas em aberto', linha: 'Linha do tempo', 'um-a-um': '1:1' }

const model = (name: string, skeleton: string) => ({ name, prompt: `${P.ABERTURA_MODELO}\n\n${skeleton}` })

/** The options of "Modelo da ata", in the order of modelos-de-ata/01..15. */
export const ATA_MODELS: Record<AtaModelId, { name: string; prompt: string }> = {
  fathom: model('Fathom', P.MODELO_FATHOM),
  fireflies: model('Fireflies', P.MODELO_FIREFLIES),
  'google-meet': model('Google Meet (Gemini)', P.MODELO_GOOGLE_MEET),
  'zoom-ai': model('Zoom AI Companion', P.MODELO_ZOOM_AI),
  'read-ai': model('Read.ai', P.MODELO_READ_AI),
  tldv: model('tl;dv Smart Topics', P.MODELO_TLDV),
  'ata-executiva': model('Ata executiva brasileira', P.MODELO_ATA_EXECUTIVA),
  confluence: model('Confluence Meeting notes', P.MODELO_CONFLUENCE),
  adi: model('A/D/I por assunto', P.MODELO_ADI),
  'decision-first': model('Decision-first de 1 página', P.MODELO_DECISION_FIRST),
  'decisoes-proximos-passos': model('Decisões e próximos passos', P.MODELO_DECISOES_PROXIMOS_PASSOS),
  kt: model('Sessão de KT', P.MODELO_KT),
  cornell: model('Cornell', P.MODELO_CORNELL),
  adr: model('Registro de decisão ADR', P.MODELO_ADR),
  raid: model('Registro RAID', P.MODELO_RAID),
}

/** Markdown points at prints as "imagens/NAME"; the note keeps the images and the viewer swaps the path for the image. */
export const IMAGE_DIR = 'imagens/'

export interface AtaTools {
  ai: AtaAi
  /** Stills of the recorded video; null for audio-only notes. */
  frames: FrameSource | null
  difference(a: number[], b: number[]): number
  /** Draws the marks and the caption on the still; returns a JPEG data URL. */
  renderPrint(image: string, marks: Mark[], caption: string): Promise<string>
  /** The local OCR; left out, the browser's (none in tests and Node). */
  ocr?: ScreenOcr | null
}

export interface AtaRequest {
  recording: RecordingData
  parts: AtaPart[]
  /** A "Modelo da ata": the parts are ignored and ONE document comes out in the model's skeleton. */
  model?: AtaModelId
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

/** "Marcados durante a gravação": each mark with its time, its note, what was on the screen and what was being said. */
function marksBlock(marks: RecordingMark[], blocks: Speech[], seen: Map<string, string>): string {
  if (!marks.length) return ''
  const lines = [...marks]
    .sort((a, b) => a.at - b.at)
    .map(mark => {
      const said = blocks
        .filter(block => block.end >= mark.at - MARK_BEFORE && block.at <= mark.at + 3)
        .slice(-2)
        .map(block => `${block.who}: "${short(block.text, 160)}"`)
        .join(' ')
      const note = oneLine(mark.text)
      return [`- [▸ ${clock(mark.at)}] ${note ? `**${note}**` : 'Marcação sem nota'}`, seen.has(mark.id) ? `Na tela: ${seen.get(mark.id)}` : '', said ? `Falando: ${said}` : ''].filter(Boolean).join(' · ')
    })
  return `## Marcados durante a gravação\n\n${lines.join('\n')}\n`
}

/** The model's answer without thinking, code fences or minute marks (never "when"). */
function modelDocument(raw: string): string {
  return (
    raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^```(markdown|md)?\s*$/gm, '')
      .replace(/[ \t]*\[▸[^\]]*\](\(#t=\d+\))?/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  )
}

export async function buildAta(request: AtaRequest, tools: AtaTools): Promise<AtaResult> {
  const parts = request.model ? [] : chosenParts(request.parts)
  if (!request.model && !parts.length) throw new Error('Marque ao menos uma parte da ata.')
  const progress = request.onProgress ?? (() => {})
  const stages = new StageClock()
  const { ai, frames } = tools
  const looks = Boolean(frames && ai.hasVision)
  // visão 4.1: the local OCR reads each distinct screen, with or without a vision model
  const ocr = frames ? (tools.ocr === undefined ? browserOcr() : tools.ocr) : null
  // where the speech points at the screen, asked while the call tiles are read
  const asked = looks ? askedMoments(request.recording, (user, system) => ai.text('context', system, user, { max: 2000, json: true })).catch(() => []) : []

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
  let exact: string[] = []
  let seen = new Map<string, string>()
  const marks = recording.marks ?? []
  if (frames && (looks || ocr)) {
    const spoken = meetingMaterial(documentNames(recording), request.startedAt, [])
    const read = await stages.run('Ler a tela compartilhada', () => readScreen(frames, ai, tools.difference, progress, { ocr, asked, marks, saved: request.recording.screenIndex, speech: spoken.falasEntre })).finally(() => ocr?.close?.())
    screen = read.screen ?? groupReadings(read.readings)
    area = read.area
    readTimes = read.times
    exact = read.terms?.exact ?? []
    seen = read.marked ?? seen
  }

  const voices = documentNames(recording)
  const material = meetingMaterial(voices, request.startedAt, screen, termsForGlossary(exact, voices.blocks.map(block => block.text).join('\n')))
  progress('Entendendo a reunião: contexto e glossário')
  const context = await stages.run('Contexto e glossário', () => understandMeeting(material, ai))
  const names = [...material.people, ...list(context.brief.pessoas).map(p => String(p.nome ?? '')), ...personNames(exact)]
  const marked = linkMoments(marksBlock(marks, material.blocks, seen))

  if (request.model) {
    // one write in the model's skeleton; failing here fails the Ata (no half document)
    const chosen = ATA_MODELS[request.model]
    progress(`Escrevendo a ata no modelo ${chosen.name}`)
    const user = `${material.dados}\n\n${context.contextoGeral}\n\nFALAS:\n${material.falas}\n\nLEITURA DA TELA:\n${material.tela}`
    const raw = await stages.run(`Modelo: ${chosen.name}`, () => ai.text('write', chosen.prompt, user, { max: 8000, json: false }))
    const markdown = accentNames(modelDocument(raw) + (marked ? `\n${marked}` : ''), names)
    const title = /^#\s+(.+)$/m.exec(markdown)?.[1].trim() || String(context.brief.assunto ?? '') || 'Reunião'
    return { markdown, title, images: [], recording, models: ai.models(), costUsd: ai.costUsd(), stages: stages.stages }
  }

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
  if (marked) out.push(marked)
  const legend = new Map(requests.map(item => [item.name, item.legenda]))
  let markdown = out
    .join('\n')
    .replace(/[ \t]*\{\{img:([^}]+)\}\}[ \t]*/g, (all, name: string) => (images.has(name) ? `${all.startsWith(' ') ? ' ' : ''}![${(legend.get(name) ?? '').replace(/[[\]]/g, '')}](${IMAGE_DIR}${name})` : ''))
    .replace(/\n{3,}/g, '\n\n')
  markdown = accentNames(linkMoments(markdown), names)
  const used = [...images.values()].filter(image => markdown.includes(`${IMAGE_DIR}${image.name}`))
  return { markdown: markdown.trim() + '\n', title, images: used, recording, models: ai.models(), costUsd: ai.costUsd(), stages: stages.stages }
}

/** Swaps "imagens/NAME" for the stored image so the viewer shows it. */
export function withImages(markdown: string, images: AtaImage[]): string {
  const byName = new Map(images.map(image => [image.name, image.dataUrl]))
  return markdown.replace(/\]\(imagens\/([^)\s]+)\)/g, (all, name: string) => (byName.has(name) ? `](${byName.get(name)})` : all))
}
