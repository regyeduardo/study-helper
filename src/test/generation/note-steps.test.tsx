import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

// T177 (o dono escolheu B em 25/11): a Aula e a Explicação de um vídeo, passo a passo, usam o modelo de cada passo, como a Ata:
// o Vídeo vê a tela, o Contexto acha onde a fala aponta para ela, e a Escrita escreve com a transcrição e a leitura da tela.

const ocr = vi.hoisted(() => ({ reader: null as unknown as { read: ReturnType<typeof vi.fn>; close?: () => void } }))
vi.mock('@/lib/generation/screen-ocr', () => ({ browserOcr: () => ocr.reader }))
vi.mock('@/lib/generation/video-source', async () => ({ ...(await vi.importActual<object>('@/lib/generation/video-source')), openVideoFrames: vi.fn() }))
vi.mock('@/lib/recording/media-library', async () => ({ ...(await vi.importActual<object>('@/lib/recording/media-library')), readLocalMedia: vi.fn(async () => new File(['v'], 'aula.webm', { type: 'video/webm' })) }))

import { defaultIndex } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { openVideoFrames } from '@/lib/generation/video-source'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { meeting, textAnswer, visionAnswer } from '@/test/generation/ata-fixture'
import { fakeOcr, recordedCall } from '@/test/generation/screen-fixture'
import type { AiConfig, FileSidecar } from '@/types/domain'

const OR = { id: 'or', type: 'openrouter' as const, name: 'OpenRouter', key: 'k', base: '' }
const model = (mid: string, name: string) => ({ uid: `or::${mid}`, pid: 'or', mid, name })
const GEMINI = model('google/gemini-3.8-flash', 'Gemini 3.8 Flash')
const LUNA = model('openai/gpt-6-luna', 'GPT-6 Luna')
const GEMMA = model('google/gemma-4-26b-a4b-it', 'Gemma 4 26B')
const DEEPSEEK = model('deepseek/deepseek-v4-flash-0731', 'DeepSeek V4 Flash')
const CONFIG: AiConfig = { providers: [OR], models: [GEMINI, LUNA, GEMMA, DEEPSEEK], defaults: { estudo: LUNA.uid, ata: LUNA.uid, midia: GEMINI.uid, tela: GEMINI.uid }, steps: {} }
const WRITTEN = JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Tabela de Vendas' }, { type: 'paragraph', text: 'A tabela mostra o VGV.' }], diagrams: [] } })
/** What the vision model says the screen means where the speech points at it. */
const MEANING = 'a coluna VGV corrigido da planilha'

type Part = { type: string; text?: string; image_url?: { url: string } }
const userParts = (call: CapturedRequest): Part[] => {
  const user = ((call.body?.messages ?? []) as { role: string; content: string | Part[] }[]).find(message => message.role === 'user')?.content ?? ''
  return Array.isArray(user) ? user : [{ type: 'text', text: user }]
}
const sees = (call: CapturedRequest) => userParts(call).some(part => part.type === 'image_url')

function provider(request: CapturedRequest): Response {
  const parts = userParts(request)
  if (sees(request)) {
    const image = parts.find(part => part.type === 'image_url')!.image_url!.url
    const prompt = parts.find(part => part.type === 'text')?.text ?? ''
    const answer = prompt.startsWith('Sentido da tela') ? JSON.stringify({ tela: 'Planilha de vendas', o_que_mostra: MEANING, termos: [] }) : visionAnswer(image, prompt)
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }))
  }
  const system = systemPromptOf(request)
  if (system === PROMPTS.LESSON_PROMPT || system === PROMPTS.EXPLANATION_PROMPT) return openAiStream(WRITTEN)
  // where the speech points at the screen: "Natália, ajusta a Tabela de Vendas" (00:30)
  if (system === PROMPTS.SCREEN_ASKS_PROMPT) return openAiStream(JSON.stringify({ horas: ['00:30'] }))
  if (system.startsWith('Você sugere')) return openAiStream('{"tags":[]}')
  // a pass the fixture does not know answers an empty JSON, not a reply the app would ask again (and wait)
  const answer = textAnswer(system, userContentOf(request))
  return openAiStream(answer.startsWith('inesperado') ? '{}' : answer)
}

const sidecars = new Map<string, FileSidecar>()
const contents = new Map<string, string>()
const repo = {
  kind: 'local',
  accountId: 'local',
  readContent: async (id: string) => contents.get(id) ?? '',
  readSidecar: async (id: string) => sidecars.get(id)!,
  saveFile: async (sidecar: FileSidecar, content?: string) => {
    sidecars.set(sidecar.meta.id, sidecar)
    if (content !== undefined) contents.set(sidecar.meta.id, content)
    return sidecar
  },
  saveFolder: async () => undefined,
  saveIndex: async () => undefined,
  fileSizes: async () => ({}),
} as unknown as Repository

let calls: CapturedRequest[]
const fileOf = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)!

/** A recorded video, transcribed, with the video kept in this browser. */
async function videoNote(): Promise<string> {
  const meta = await useLibraryStore.getState().createFile({ name: 'Aula da tabela', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Aula 25-11-2026.webm', mime: 'video/webm', durationSeconds: 320, storage: 'none' } }, '')
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: meeting }))
  useLibraryStore.setState({ localMedia: [{ storedName: 'aula.webm', name: 'aula.webm', mime: 'video/webm', durationSeconds: 320, size: 8, createdAt: '2026-11-25T10:00:00Z', fileIds: [meta.id] }] })
  return meta.id
}

beforeEach(() => {
  sidecars.clear()
  contents.clear()
  const index = defaultIndex()
  index.settings.aiConfig = CONFIG
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  calls = installFetch(provider).calls
  ocr.reader = fakeOcr()
  vi.mocked(openVideoFrames).mockReset()
  vi.mocked(openVideoFrames).mockResolvedValue(recordedCall())
})

afterEach(() => vi.unstubAllGlobals())

describe('a Aula e a Explicação de um vídeo, passo a passo', () => {
  it('cada passo usa o modelo escolhido: o Vídeo vê a tela, o Contexto acha onde a fala aponta e a Escrita escreve com o que a tela mostra', async () => {
    const source = await videoNote()
    const id = await useJobsStore.getState().generateFromNote(source, 'lesson', LUNA.uid, 'home', '', 'quadros', { video: GEMMA.uid, context: DEEPSEEK.uid })
    await waitFor(() => expect(fileOf(id!).status).toBe('ready'))
    const seen = calls.filter(sees)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(call => call.body?.model === GEMMA.mid)).toBe(true)
    const asks = calls.filter(call => systemPromptOf(call) === PROMPTS.SCREEN_ASKS_PROMPT)
    expect(asks.length).toBeGreaterThan(0)
    expect(asks.every(call => call.body?.model === DEEPSEEK.mid)).toBe(true)
    const written = calls.filter(call => systemPromptOf(call) === PROMPTS.LESSON_PROMPT)
    expect(written).toHaveLength(1)
    expect(written[0].body?.model).toBe(LUNA.mid)
    expect(userContentOf(written[0])).toContain(MEANING)
    expect(userContentOf(written[0])).toContain('Painel de Controle')
    expect(fileOf(id!).made).toMatchObject({ model: LUNA.uid, analyze: 'quadros', steps: { video: GEMMA.uid, context: DEEPSEEK.uid } })
  })

  it('sem escolher, cada passo usa o de hoje: a Leitura de tela vê, e onde a fala aponta vai no modelo da escrita', async () => {
    const source = await videoNote()
    const id = await useJobsStore.getState().generateFromNote(source, 'explanation', null, 'home', '', 'quadros')
    await waitFor(() => expect(fileOf(id!).status).toBe('ready'))
    const seen = calls.filter(sees)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(call => call.body?.model === GEMINI.mid)).toBe(true)
    expect(calls.filter(call => systemPromptOf(call) === PROMPTS.SCREEN_ASKS_PROMPT).every(call => call.body?.model === LUNA.mid)).toBe(true)
    const written = calls.filter(call => systemPromptOf(call) === PROMPTS.EXPLANATION_PROMPT)
    expect(written).toHaveLength(1)
    expect(userContentOf(written[0])).toContain(MEANING)
    expect(fileOf(id!).made).toMatchObject({ model: LUNA.uid, analyze: 'quadros', steps: { video: GEMINI.uid, context: LUNA.uid } })
  })

  it('"Só a transcrição" não abre o vídeo nem chama a visão: vai só o texto', async () => {
    const source = await videoNote()
    const id = await useJobsStore.getState().generateFromNote(source, 'lesson', LUNA.uid, 'home', '', 'transcricao')
    await waitFor(() => expect(fileOf(id!).status).toBe('ready'))
    expect(openVideoFrames).not.toHaveBeenCalled()
    expect(calls.some(sees)).toBe(false)
    expect(userContentOf(calls.find(call => systemPromptOf(call) === PROMPTS.LESSON_PROMPT)!)).not.toContain(MEANING)
    expect(fileOf(id!).made).not.toHaveProperty('steps')
  })
})
