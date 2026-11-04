import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { GenerateDialog } from '@/components/dialogs/GenerateDialog'
import { CourseProposalDialog, OrderDialog } from '@/components/dialogs/MoreDialogs'
import { ItemMenu } from '@/components/library/ItemMenu'
import { defaultIndex, newFolderMeta } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { type CourseProposal, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import type { FileSidecar, RecordingData } from '@/types/domain'

const heard: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 3, text: 'Vamos lançar em maio?' },
    { speaker: 'speaker_0', start: 4, end: 8, text: 'Vamos lançar em maio, eu mando a proposta.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Bruno', suggested: false },
  ],
  marks: [],
}

function memoryRepository() {
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
  return { repo, sidecars, contents }
}

function provider(request: CapturedRequest): Response {
  const system = systemPromptOf(request)
  if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ assunto: 'Lançamento', temas: [{ tema: 'Data', pontos: [{ texto: 'Lançar em maio', citacao: 'Vamos lançar em maio, eu mando', hora: '00:04' }] }], passos: [] }))
  if (system === PROMPTS.TAGS_PROMPT) return openAiStream(JSON.stringify({ etiquetas: ['lancamento'] }))
  return new Response('unexpected', { status: 500 })
}

let memory: ReturnType<typeof memoryRepository>

async function note(name: string, transcribed: boolean): Promise<string> {
  const library = useLibraryStore.getState()
  const meta = await library.createFile({ name, type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: `${name}.webm`, mime: 'audio/webm', durationSeconds: 10, storage: 'none' } }, transcribed ? 'Você [00:00]: Vamos lançar em maio?' : '')
  if (transcribed) await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: heard }))
  return meta.id
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

const openMenu = (id: string) => {
  useUiStore.getState().openMenu({ kind: 'file', id, x: 10, y: 10 })
  render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<><ItemMenu /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
  return screen.getByRole('menu')
}

beforeEach(() => {
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.ai = { provider: 'custom', baseUrl: 'https://api.exemplo.dev/v1', apiKey: 'test-key', model: 'default' }
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ menu: null })
  installFetch(provider)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const items = (menu: HTMLElement) => within(menu).getAllByRole('button').map(button => `${button.textContent}${(button as HTMLButtonElement).disabled ? ' [off]' : ''}`)

describe('the ellipsis menu of a note', () => {
  it('has one Gerar group with the study tools, Ata and Aula, then Sugerir etiquetas, Detalhes, Mover, Renomear and Apagar', async () => {
    const id = await note('Monitoria', true)
    const menu = openMenu(id)
    expect(within(menu).getByText('Gerar')).toBeInTheDocument()
    const list = items(menu)
    for (const label of ['Prova', 'Ata', 'Aula', 'Sugerir etiquetas', 'Detalhes', 'Mover', 'Renomear', 'Apagar']) expect(list).toContain(label)
    for (const label of ['Mapa mental', 'Cartões', 'Tutor']) expect(list.some(item => item.startsWith(label))).toBe(true)
  })

  it('without transcription the Gerar items ask to transcribe first', async () => {
    const id = await note('Conversa', false)
    const menu = openMenu(id)
    expect(within(menu).getByText('Gerar (precisa de transcrição)')).toBeInTheDocument()
    expect(items(menu)).toEqual(expect.arrayContaining(['Atatranscrever antes [off]', 'Aulatranscrever antes [off]', 'Provatranscrever antes [off]', 'Sugerir etiquetas [off]']))
  })

  it('Ata of a recording opens the checkboxes of the parts first, generating nothing yet', async () => {
    const id = await note('Monitoria', true)
    const menu = openMenu(id)
    fireEvent.click(within(menu).getByRole('button', { name: 'Ata' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'ata-parts', fileId: id })
    expect(useJobsStore.getState().jobs).toHaveLength(0)
    expect(within(document.body).queryByRole('button', { name: /escolher partes/ })).not.toBeInTheDocument()
  })

  it('a note with text only still makes a new note with the Ata', async () => {
    const meta = await useLibraryStore.getState().createFile({ name: 'Pauta', type: 'reading', status: 'ready', folderId: null }, 'Vamos lançar em maio, eu mando a proposta.')
    const menu = openMenu(meta.id)
    fireEvent.click(within(menu).getByRole('button', { name: 'Ata' }))
    // The model selector comes first, with the default preselected.
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate', fileId: meta.id, agent: 'meeting' })
    render(
      <MemoryRouter>
        <GenerateDialog fileId={meta.id} agent="meeting" />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue('custom::default')
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useLibraryStore.getState().files).toHaveLength(2))
    expect(useLibraryStore.getState().files.find(file => file.id !== meta.id)).toMatchObject({ type: 'meeting', parentFileId: meta.id })
  })
})

describe('the ellipsis menu of a folder', () => {
  const openFolderMenu = (id: string) => {
    useUiStore.getState().openMenu({ kind: 'folder', id, x: 10, y: 10 })
    render(
      <MemoryRouter>
        <ItemMenu />
      </MemoryRouter>,
    )
    return items(screen.getByRole('menu'))
  }

  it('no course wording nor mark/unmark; a folder with folders inside keeps Ordenar aulas e módulos and Gerar as aulas que faltam', () => {
    const course = newFolderMeta({ name: 'Inglês' })
    useLibraryStore.setState({ folders: [course, newFolderMeta({ name: 'Módulo 1', parentId: course.id })] })
    const list = openFolderMenu(course.id)
    expect(list).toEqual(expect.arrayContaining(['Compartilhar a pasta', 'Ordenar aulas e módulos', 'Gerar as aulas que faltam']))
    expect(list.some(item => /curso/i.test(item))).toBe(false)
  })

  it('a folder marked as course before but with no folders inside is a plain folder', () => {
    const marked = newFolderMeta({ name: 'Marcado antes', isCourse: true })
    useLibraryStore.setState({ folders: [marked] })
    const list = openFolderMenu(marked.id)
    expect(list).toContain('Compartilhar a pasta')
    for (const label of ['Ordenar aulas e módulos', 'Gerar as aulas que faltam']) expect(list).not.toContain(label)
    expect(list.some(item => /curso/i.test(item))).toBe(false)
  })
})

describe('no "curso" in the texts of the course tools', () => {
  it('"Ordenar aulas e módulos" says Ordem das aulas and Descrição da pasta', () => {
    const folder = newFolderMeta({ name: 'Inglês' })
    useLibraryStore.setState({ folders: [folder, newFolderMeta({ name: 'Módulo 1', parentId: folder.id })] })
    render(<OrderDialog folderId={folder.id} />)
    const dialog = screen.getByRole('dialog', { name: 'Ordem das aulas · Inglês' })
    expect(within(dialog).getByLabelText('Descrição da pasta')).toBeInTheDocument()
    expect(dialog.textContent).not.toMatch(/curso/i)
  })

  it('the proposal of the generation speaks of a folder with modules and lessons', () => {
    const analysis = { isCourse: true, name: 'Inglês', description: 'Do zero.', modules: [{ title: 'Módulo 1', covers: '', excerpt: '', lessons: [] }], lessonCount: 2 }
    useJobsStore.setState({ proposals: [{ analysis, request: { folderId: null }, resolved: {} } as unknown as CourseProposal] })
    render(
      <MemoryRouter>
        <CourseProposalDialog />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Isso rende uma pasta com aulas' })
    expect(within(dialog).getByRole('button', { name: 'Criar a pasta com as aulas' })).toBeInTheDocument()
    expect(within(dialog).getByText('Onde criar a pasta')).toBeInTheDocument()
    expect(dialog.textContent).not.toMatch(/curso/i)
  })
})
