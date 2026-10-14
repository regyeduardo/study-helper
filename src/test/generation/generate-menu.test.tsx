import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { ItemMenu } from '@/components/library/ItemMenu'
import { defaultIndex } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
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

  it('Ata makes a new text note, model Ata, linked to the recording, that opens; the recording stays the same', async () => {
    const id = await note('Monitoria', true)
    const menu = openMenu(id)
    fireEvent.click(within(menu).getByRole('button', { name: 'Ata' }))
    await waitFor(() => expect(useLibraryStore.getState().files).toHaveLength(2))
    const ata = useLibraryStore.getState().files.find(file => file.id !== id)!
    expect(ata).toMatchObject({ type: 'meeting', parentFileId: id, description: 'gerado de Monitoria' })
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/arquivo/${ata.id}`))
    await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.id === ata.id)?.status).toBe('ready'))
    expect(memory.contents.get(ata.id)).toContain('Lançar em maio [▸ 00:04](#t=4)')
    expect(useLibraryStore.getState().files.find(file => file.id === id)).toMatchObject({ type: 'reading', name: 'Monitoria' })
    expect(memory.sidecars.get(id)?.recording?.blocks).toHaveLength(2)
  })
})
