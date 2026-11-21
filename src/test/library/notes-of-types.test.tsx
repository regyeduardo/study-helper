// História 10 (003): o que a pessoa traz ou grava vira nota do seu tipo, sem `role: 'entrada'`; as notas feitas dela são filhas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { File as NodeFile } from 'node:buffer'

import type { FileMeta } from '@/types/domain'
import { isRecording, isSourceNote } from '@/lib/file-types'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { type NewContentRequest, useJobsStore } from '@/stores/jobs'
import { type CapturedRequest, installFetch, jsonResponse, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { fileOf, files, memoryLibrary } from '@/test/source-meta/fixture'

vi.mock('@/lib/transcription', () => ({
  ENGINES: [],
  transcribe: vi.fn(async () => ({
    text: 'Ana: vamos lançar em maio?',
    engine: 'groq',
    language: 'pt',
    durationSeconds: 8,
    speakers: 1,
    recording: { blocks: [{ speaker: 'mic', start: 0, end: 3, text: 'Vamos lançar em maio?' }], speakers: [{ id: 'mic', name: 'Ana', suggested: false }], marks: [] },
  })),
}))

const LESSON = { markdown: { elements: [{ type: 'heading', level: 1, text: 'Lançamento' }, { type: 'paragraph', text: 'Em maio.' }], diagrams: [] } }

function provider(request: CapturedRequest): Response {
  if (request.url.startsWith('https://youtube-transcript.ai/')) return new Response('O professor explica a derivada.')
  if (request.url.startsWith('https://www.youtube.com/oembed')) return jsonResponse({ title: 'Aula de Cálculo' })
  const system = systemPromptOf(request)
  if (system === PROMPTS.COURSE_ANALYSIS_PROMPT) return openAiStream(JSON.stringify({ is_course: false, modules: [] }))
  if (system === PROMPTS.LESSON_PROMPT || system === PROMPTS.EXPLANATION_PROMPT) return openAiStream(JSON.stringify(LESSON))
  if (system === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Lançamento em maio', nomes: [], correcoes: [] }))
  if (system === PROMPTS.TITLE_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Lançamento em maio' }))
  if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ assunto: 'Lançamento', temas: [{ tema: 'Data', pontos: [{ texto: 'Lançar em maio', citacao: 'Vamos lançar em maio', hora: '00:00' }] }], passos: [] }))
  if (system.startsWith('Você sugere')) return openAiStream('{"tags":[]}')
  return openAiStream('{}')
}

const LITTERBOX = '72h' as NewContentRequest['litterboxTime']
const media = (name: string, type: string) => new NodeFile([new Uint8Array(4)], name, { type }) as unknown as File

function request(fields: Partial<NewContentRequest>): NewContentRequest {
  return { agent: 'lesson', input: { kind: 'link', url: 'https://exemplo.com' }, name: '', description: '', folderId: 'biologia', prompt: '', storage: 'none', litterboxTime: LITTERBOX, ...fields }
}

const sourceNotes = () => files().filter(isSourceNote)
const noRole = (file: FileMeta) => expect(file.role).toBeUndefined()

beforeEach(() => {
  memoryLibrary()
  installFetch(provider)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gravar: a Gravação é nota de mídia do seu tipo', () => {
  it('o microfone gravado vira nota de Áudio, sem role, e é Gravação', async () => {
    const id = await useJobsStore.getState().saveRecording({ file: media('Reunião 20-11.webm', 'audio/webm'), storedName: null, durationSeconds: 8, folderId: 'biologia', storage: 'none', litterboxTime: LITTERBOX, marks: [], transcribe: false })
    const note = fileOf(id)
    expect(note).toMatchObject({ type: 'audio', folderId: 'biologia', parentFileId: null, origin: { input: 'recording' } })
    noRole(note)
    expect(isRecording(note)).toBe(true)
  })

  it('a reunião gravada com a tela vira nota de Vídeo', async () => {
    const id = await useJobsStore.getState().saveRecording({ file: media('Reunião 20-11.webm', 'video/webm'), storedName: null, durationSeconds: 8, folderId: null, storage: 'none', litterboxTime: LITTERBOX, marks: [], transcribe: false })
    expect(fileOf(id)).toMatchObject({ type: 'video' })
    noRole(fileOf(id))
  })
})

describe('trazer: a mídia enviada é nota de mídia, mas não Gravação', () => {
  it('"Só a transcrição" de um áudio enviado dá a nota de Áudio com a transcrição', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'reading', input: { kind: 'file', file: media('podcast.mp3', 'audio/mpeg') } }))
    await waitFor(() => expect(fileOf(id!)?.status).toBe('ready'))
    expect(fileOf(id!)).toMatchObject({ type: 'audio', origin: { input: 'file' } })
    noRole(fileOf(id!))
    expect(isRecording(fileOf(id!))).toBe(false)
  })

  it('a Aula de um áudio enviado é filha da nota de Áudio', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'lesson', input: { kind: 'file', file: media('podcast.mp3', 'audio/mpeg') } }))
    await waitFor(() => expect(fileOf(id!)?.status).toBe('ready'))
    const [source] = sourceNotes()
    expect(source).toMatchObject({ type: 'audio' })
    noRole(source)
    expect(fileOf(id!)).toMatchObject({ type: 'class', parentFileId: source.id })
  })

  it('a Ata em duas passadas de uma gravação: a nota de mídia continua Áudio, e a Ata é filha dela', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'meeting', input: { kind: 'recording', file: media('Reunião.webm', 'audio/webm') } }))
    await waitFor(() => expect(files().find(file => file.parentFileId === id)?.status).toBe('ready'))
    expect(fileOf(id!)).toMatchObject({ type: 'audio', status: 'ready' })
    noRole(fileOf(id!))
    expect(files().find(file => file.parentFileId === id)).toMatchObject({ type: 'meeting' })
  })

  it('um vídeo do YouTube vira nota de Vídeo, e a Aula é filha dela', async () => {
    const id = await useJobsStore.getState().startNewContent(request({ agent: 'lesson', input: { kind: 'link', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } }))
    await waitFor(() => expect(fileOf(id!)?.status).toBe('ready'))
    const [source] = sourceNotes()
    expect(source).toMatchObject({ type: 'video', origin: { input: 'youtube' } })
    noRole(source)
    expect(fileOf(id!).parentFileId).toBe(source.id)
  })
})
