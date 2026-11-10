import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

// FR-072: the Ata of a video goes step by step, and each step uses the model chosen for it:
// Vídeo (who speaks and the screen, by the frames), Contexto (context and final state) and Escrita (the writing).

vi.mock('@/lib/generation/video-source', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/generation/video-source')>()),
  openVideoFrames: vi.fn(async () => (await import('@/test/generation/ata-fixture')).fakeFrames()),
}))

// jsdom does not load images: the print is a data URL made of its caption
vi.mock('@/lib/generation/prints', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/generation/prints')>()), renderPrint: vi.fn(async (_image: string, _marks: unknown[], caption: string) => `data:image/jpeg;base64,PRINT ${caption}`) }))

import { defaultIndex } from '@/lib/defaults'
import { type AtaModels, appAi, passSettings } from '@/lib/generation/ata-ai'
import * as P from '@/lib/generation/ata-prompts'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { meeting, textAnswer, visionAnswer } from '@/test/generation/ata-fixture'
import type { AiConfig, FileSidecar, Settings } from '@/types/domain'

const OR = { id: 'or', type: 'openrouter' as const, name: 'OpenRouter', key: 'k', base: '' }
const model = (mid: string, name: string) => ({ uid: `or::${mid}`, pid: 'or', mid, name })
const GEMINI = model('google/gemini-3.8-flash', 'Gemini 3.8 Flash')
const LUNA = model('openai/gpt-6-luna', 'GPT-6 Luna')
const GEMMA = model('google/gemma-4-26b-a4b-it', 'Gemma 4 26B')
const DEEPSEEK = model('deepseek/deepseek-v4-flash-0731', 'DeepSeek V4 Flash')
const LITE = model('google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite')
const config = (steps: AiConfig['steps'] = {}): AiConfig => ({ providers: [OR], models: [GEMINI, LUNA, GEMMA, DEEPSEEK, LITE], defaults: { estudo: LUNA.uid, ata: LUNA.uid, midia: GEMINI.uid, tela: GEMINI.uid }, steps })

describe('the AI of the Ata, step by step', () => {
  const settings = (aiConfig: AiConfig): Settings => ({ ...defaultIndex().settings, aiConfig })

  it('Contexto and Escrita follow the model picked for them; a step with its own model keeps it unless the person picked now', () => {
    const own = settings(config({ revisar: DEEPSEEK.uid }))
    expect(passSettings(own, 'context', { model: LITE.uid }).model).toBe(LITE.mid)
    expect(passSettings(own, 'context', { model: LITE.uid, context: DEEPSEEK.uid }).model).toBe(DEEPSEEK.mid)
    expect(passSettings(own, 'write', { model: LITE.uid, context: DEEPSEEK.uid }).model).toBe(LITE.mid)
    // an own model of the writing steps wins over the default of the window, but not over a pick made there
    expect(passSettings(own, 'review', { model: LITE.uid }).model).toBe(DEEPSEEK.mid)
    expect(passSettings(own, 'review', { model: LITE.uid, write: LITE.uid }).model).toBe(LITE.mid)
    // without a pick: the default of Ata, as before
    expect(passSettings(own, 'context').model).toBe(LUNA.mid)
  })

  it('the screen and who speaks go to the Vídeo model picked, else to Leitura de tela', async () => {
    const { calls } = installFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ quadros: [] }) } }] })))
    const base = settings(config())
    await appAi(base).see(['data:image/jpeg;base64,x-1'], 'quadros')
    await appAi(base, undefined, undefined, { video: GEMMA.uid }).see(['data:image/jpeg;base64,x-1'], 'quadros')
    expect(calls.map(call => call.body?.model)).toEqual([GEMINI.mid, GEMMA.mid])
    const ai = appAi(base, undefined, undefined, { video: GEMMA.uid })
    expect(ai.hasVision).toBe(true)
    await ai.see(['data:image/jpeg;base64,x-1'], 'quadros')
    expect(ai.models().vision).toBe(GEMMA.mid)
  })
})

describe('generateAta passo a passo', () => {
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
      return new Response(JSON.stringify({ choices: [{ message: { content: visionAnswer(image, prompt) } }] }))
    }
    // a pass the fixture does not know answers an empty JSON, not a reply the app would ask again (and wait)
    const answer = textAnswer(systemPromptOf(request), userContentOf(request))
    return openAiStream(answer.startsWith('inesperado') ? '{}' : answer)
  }

  let calls: CapturedRequest[]

  async function video(): Promise<string> {
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião de planejamento', role: 'entrada', kept: 'registro', type: 'reading', status: 'ready', folderId: null, origin: { input: 'file', name: 'reuniao.webm', mime: 'video/webm', durationSeconds: 320, storage: 'none' } }, 'Regy: Boa tarde')
    await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: meeting }))
    return meta.id
  }

  const ataOf = (id: string) => useLibraryStore.getState().files.find(file => file.parentFileId === id && file.type === 'meeting')
  const frames = () => new File([new Uint8Array([26, 69, 223, 163])], 'reuniao.webm', { type: 'video/webm' })

  beforeEach(() => {
    sidecars.clear()
    contents.clear()
    const index = defaultIndex()
    index.settings.aiConfig = config()
    useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
    useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
    calls = installFetch(provider).calls
  })

  afterEach(() => vi.unstubAllGlobals())

  async function run(chosen: AtaModels): Promise<{ id: string; models: Record<string, string> }> {
    const source = await video()
    await useJobsStore.getState().generateAta(source, ['resumo'], undefined, chosen, 'home', '', frames(), 'transcricao')
    await waitFor(() => expect(ataOf(source)).toBeDefined())
    const saved = sidecars.get(ataOf(source)!.id)!.documents![0]
    return { id: ataOf(source)!.id, models: saved.models as Record<string, string> }
  }

  it('sem trocar nada, cada passo usa o de hoje: Leitura de tela vê, e os de texto usam o modelo da Ata', async () => {
    const { id, models } = await run({ model: LUNA.uid })
    expect(models).toMatchObject({ vision: GEMINI.mid, context: LUNA.mid, write: LUNA.mid })
    const seen = calls.filter(sees)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(call => call.body?.model === GEMINI.mid)).toBe(true)
    expect(calls.filter(call => !sees(call)).every(call => call.body?.model === LUNA.mid)).toBe(true)
    expect(useLibraryStore.getState().files.find(file => file.id === id)?.made).toMatchObject({ model: LUNA.uid, analyze: 'transcricao', parts: ['resumo'], steps: { video: GEMINI.uid, context: LUNA.uid } })
  })

  it('cada passo usa o modelo escolhido para ele, e a escolha fica no `made` para "Gerar de novo"', async () => {
    const { id, models } = await run({ model: LITE.uid, write: LITE.uid, video: GEMMA.uid, context: DEEPSEEK.uid })
    expect(models).toMatchObject({ vision: GEMMA.mid, context: DEEPSEEK.mid, write: LITE.mid })
    const seen = calls.filter(sees)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(call => call.body?.model === GEMMA.mid)).toBe(true)
    const entender = calls.filter(call => systemPromptOf(call) === P.ENTENDER)
    expect(entender.length).toBeGreaterThan(0)
    expect(entender.every(call => call.body?.model === DEEPSEEK.mid)).toBe(true)
    const writing = calls.filter(call => systemPromptOf(call).startsWith(P.BASE) && systemPromptOf(call).endsWith(P.RESUMO))
    expect(writing.length).toBe(1)
    expect(writing[0].body?.model).toBe(LITE.mid)
    expect(useLibraryStore.getState().files.find(file => file.id === id)?.made).toMatchObject({ model: LITE.uid, analyze: 'transcricao', steps: { video: GEMMA.uid, context: DEEPSEEK.uid } })
  })
})
