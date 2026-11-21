// Shared by the generation-flow tests (model at "Gerar agora", instruction when redoing, "Refazer…", failures that keep the choices, no jump).
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import { Overlays } from '@/components/dialogs/Overlays'
import { Toasts } from '@/components/ui/Toasts'
import { defaultIndex } from '@/lib/defaults'
import { DIAGNOSIS_PROMPT } from '@/lib/generation/diagnosis'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import type { AiConfig, FileMeta, FileSidecar } from '@/types/domain'

export const GERAL = 'custom::geral'
export const FORTE = 'custom::forte'

export const CONFIG: AiConfig = {
  providers: [{ id: 'custom', type: 'custom', name: 'Exemplo', key: 'k', base: 'https://ia.exemplo.dev/v1' }],
  models: [
    { uid: GERAL, pid: 'custom', mid: 'geral', name: 'Geral' },
    { uid: FORTE, pid: 'custom', mid: 'forte', name: 'Forte' },
  ],
  defaults: { estudo: GERAL },
  steps: {},
}

export const WRITTEN = JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Limites' }, { type: 'paragraph', text: 'O texto que a IA escreveu.' }], diagrams: [] } })

const WRITERS: string[] = [PROMPTS.LESSON_PROMPT, PROMPTS.EXPLANATION_PROMPT]

export function answer(request: CapturedRequest): Response | Promise<Response> {
  const system = systemPromptOf(request)
  if (WRITERS.includes(system)) return openAiStream(WRITTEN)
  if (system === PROMPTS.COURSE_ANALYSIS_PROMPT) return openAiStream(JSON.stringify({ is_course: false, modules: [] }))
  if (system === PROMPTS.TAGS_PROMPT) return openAiStream(JSON.stringify({ etiquetas: [] }))
  if (system === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: '', nomes: [], correcoes: [] }))
  if (system === PROMPTS.TITLE_PROMPT) return openAiStream(JSON.stringify({ titulo: '' }))
  if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ assunto: 'Lançamento', temas: [{ tema: 'Data', pontos: [{ texto: 'Lançar em maio', citacao: 'vamos lançar em maio' }] }], passos: [] }))
  if (system === DIAGNOSIS_PROMPT) return openAiStream(JSON.stringify({ temas: [{ titulo: 'Limites laterais', o_que_faltou: 'Os laterais precisam ser iguais.', questoes: [1] }], formato: 'unica' }))
  return new Response(`unexpected ${system.slice(0, 40)}`, { status: 500 })
}

export function flowLibrary(responder: (request: CapturedRequest) => Response | Promise<Response> = answer) {
  const sidecars = new Map<string, FileSidecar>()
  const contents = new Map<string, string>()
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
  } as unknown as Repository
  const index = defaultIndex()
  index.settings.aiConfig = CONFIG
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ overlay: null, menu: null, toasts: [], handoffFileId: null })
  return { contents, sidecars, ...installFetch(responder) }
}

/** Where the app is: the path on screen. */
function Where() {
  const { pathname } = useLocation()
  return <output aria-label="Onde estou">{pathname}</output>
}

/** The screen at `path`, with the windows, the toasts and the corner panel of the app. */
export function renderAt(path: string, page: ReactNode = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {page}
      <Overlays />
      <Toasts />
      <Where />
    </MemoryRouter>,
  )
}

export const where = () => screen.getByLabelText('Onde estou').textContent

export const fileOf = (id: string): FileMeta => useLibraryStore.getState().files.find(file => file.id === id)!

export const sentTo = (calls: CapturedRequest[], system: string) => calls.filter(call => systemPromptOf(call) === system)

export const modelOf = (call: CapturedRequest) => call.body?.model

export { userContentOf }

/** A text note to make others from. */
export async function textSource(name = 'Pauta', folderId: string | null = null): Promise<string> {
  return (await useLibraryStore.getState().createFile({ name, type: 'reading', status: 'ready', folderId }, 'Se os laterais diferem, o limite não existe. Continuidade exige limite igual ao valor.')).id
}

/** A course folder with one module and its lessons still to write. */
export async function course(lessons: string[] = ['Aula 1', 'Aula 2']): Promise<{ root: string; module: string; ids: string[] }> {
  const library = useLibraryStore.getState()
  const root = await library.createFolder({ name: 'Cálculo', isCourse: true, courseMaterial: '# Conteúdo\n\nLimites e continuidade.' })
  const module = await library.createFolder({ name: 'Módulo 1', parentId: root.id, position: 0 })
  const ids: string[] = []
  for (const [position, name] of lessons.entries()) ids.push((await useLibraryStore.getState().createFile({ name, type: 'class', folderId: module.id, description: `cobre ${name}`, pendingExcerpt: `trecho de ${name}`, status: 'pending', position }, '')).id)
  return { root: root.id, module: module.id, ids }
}
