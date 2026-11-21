// What the tests of a source kept in the note share: a library in memory and an AI that answers by the prompt.
import { waitFor } from '@testing-library/react'
import { expect, vi } from 'vitest'

import type { FileMeta, FileSidecar, FolderMeta } from '@/types/domain'
import { defaultIndex } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, jsonResponse, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { isSourceNote } from '@/lib/file-types'

export const PAGE_URL = 'https://exemplo.com/fotossintese'
export const PAGE_TITLE = 'Fotossíntese explicada'
export const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
export const VIDEO_TITLE = 'Aula de Cálculo'
export const SAID = 'O professor explica a derivada como a inclinação da reta tangente.'

const JINA_BODY = `Title: ${PAGE_TITLE}\n\nMarkdown Content:\n# Fotossíntese\n\nA planta usa luz.`
const LESSON = { markdown: { elements: [{ type: 'heading', level: 1, text: 'Fotossíntese' }, { type: 'paragraph', text: 'A planta transforma luz em energia.' }], diagrams: [] } }
const MINUTES = { assunto: 'Lançamento', temas: [{ tema: 'Data', pontos: [{ texto: 'Lançar em maio', citacao: 'lançar em maio', hora: '' }] }], passos: [] }

export function provider(request: CapturedRequest): Response {
  if (request.url.startsWith('https://r.jina.ai/')) return new Response(JINA_BODY)
  if (request.url.startsWith('https://youtube-transcript.ai/')) return new Response(SAID)
  if (request.url.startsWith('https://www.youtube.com/oembed')) return jsonResponse({ title: VIDEO_TITLE })
  const system = systemPromptOf(request)
  if (system === PROMPTS.COURSE_ANALYSIS_PROMPT) return openAiStream(JSON.stringify({ is_course: false, modules: [] }))
  if (system === PROMPTS.LESSON_PROMPT || system === PROMPTS.EXPLANATION_PROMPT || system === PROMPTS.MEETING_PROMPT) return openAiStream(JSON.stringify(LESSON))
  if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify(MINUTES))
  if (system.startsWith('Você sugere')) return openAiStream('{"tags":[]}')
  return openAiStream('{}')
}

export function memoryLibrary(seed: { files?: FileMeta[]; folders?: FolderMeta[]; contents?: Record<string, string> } = {}) {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>(Object.entries(seed.contents ?? {}))
  for (const meta of seed.files ?? []) sidecars.set(meta.id, { meta, questions: [], attempts: [], highlights: [] })
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents.get(id) ?? '',
    readSidecar: async (id: string) => {
      const sidecar = sidecars.get(id)
      if (!sidecar) throw new Error(`missing ${id}`)
      return sidecar
    },
    saveFile: async (sidecar: FileSidecar, content?: string) => {
      sidecars.set(sidecar.meta.id, sidecar)
      if (content !== undefined) contents.set(sidecar.meta.id, content)
      return sidecar
    },
    saveFolder: async () => undefined,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
    putSource: vi.fn(async (fileId: string) => ({ ref: `drive-${fileId}` })),
  } as unknown as Repository
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.exemplo.dev/v1', apiKey: 'test-key', model: 'default' }
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: seed.folders ?? [], files: seed.files ?? [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ overlay: null, toasts: [], selection: new Set(), menu: null })
  const fetched = installFetch(provider)
  return { repo, sidecars, contents, calls: fetched.calls }
}

export const files = () => useLibraryStore.getState().files
export const fileOf = (id: string) => files().find(file => file.id === id)!
export const entradas = () => files().filter(file => isSourceNote(file))

export async function ready(id: string | null): Promise<FileMeta> {
  expect(id).toBeTruthy()
  await waitFor(() => expect(fileOf(id!)?.status).toBe('ready'))
  return fileOf(id!)
}
