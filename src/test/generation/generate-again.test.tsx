import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

// Minute links become real links, so a click reaches the player.
vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown" dangerouslySetInnerHTML={{ __html: markdown.replace(/\[([^\]]+)\]\((#[^)]+)\)/g, '<a href="$2">$1</a>') }} />,
}))

vi.mock('@/utils/download', async importOriginal => ({ ...(await importOriginal<typeof import('@/utils/download')>()), downloadBlob: vi.fn() }))

vi.mock('@/lib/exports/pdf', () => ({ printMarkdownAsPdf: vi.fn(async () => undefined) }))

import { AtaPartsDialog } from '@/components/dialogs/AtaPartsDialog'
import { GenerateDialog } from '@/components/dialogs/GenerateDialog'
import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { ItemMenu } from '@/components/library/ItemMenu'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { defaultIndex } from '@/lib/defaults'
import { exportFileAsMarkdown } from '@/lib/exports/library-export'
import { printMarkdownAsPdf } from '@/lib/exports/pdf'
import { ATA_MODELS } from '@/lib/generation/ata'
import * as P from '@/lib/generation/ata-prompts'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { buildShareContent } from '@/lib/share'
import type { Repository } from '@/lib/storage/repository'
import { homeFolderOf, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { meeting, MODEL_DOCUMENT, textAnswer } from '@/test/generation/ata-fixture'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { AiConfig, FileSidecar, MeetingDocument } from '@/types/domain'
import { downloadBlob } from '@/utils/download'
import { shortDate } from '@/utils/format'

installBlobShim()

const CONFIG: AiConfig = {
  providers: [{ id: 'custom', type: 'custom', name: 'Exemplo', key: 'k', base: 'https://ia.exemplo.dev/v1' }],
  models: [
    { uid: 'custom::geral', pid: 'custom', mid: 'geral', name: 'Geral' },
    { uid: 'custom::forte', pid: 'custom', mid: 'forte', name: 'Forte' },
  ],
  defaults: { estudo: 'custom::geral' },
  steps: {},
}

const named = { ...meeting, speakers: [{ id: 'mic', name: 'Regy Niles', suggested: false }, { id: 'speaker_0', name: 'Henrique Souza', suggested: false }, { id: 'speaker_1', name: 'Natália Lenza', suggested: false }] }

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
  if (system === PROMPTS.TAGS_PROMPT) return openAiStream(JSON.stringify({ etiquetas: [] }))
  return openAiStream(textAnswer(system, userContentOf(request)))
}

let memory: ReturnType<typeof memoryRepository>
let calls: CapturedRequest[]

beforeEach(() => {
  memory = memoryRepository()
  const index = defaultIndex()
  index.settings.aiConfig = CONFIG
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ menu: null, overlay: null })
  calls = installFetch(provider).calls
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function recordingNote(folderId: string | null = null): Promise<string> {
  const meta = await useLibraryStore.getState().createFile(
    { name: 'Revisão do orçamento', type: 'reading', status: 'ready', folderId, origin: { input: 'recording', name: 'Reunião 28-10-2026, 18-15-41.webm', mime: 'audio/webm', durationSeconds: 320, storage: 'none' } },
    'Regy Niles [00:10]: Boa tarde',
  )
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: named }))
  return meta.id
}

async function textNote(folderId: string | null = null): Promise<string> {
  return (await useLibraryStore.getState().createFile({ name: 'Pauta', type: 'reading', status: 'ready', folderId }, 'Vamos lançar em maio, eu mando a proposta.')).id
}

const file = (id: string) => useLibraryStore.getState().files.find(item => item.id === id)!
const folderNamed = (name: string) => useLibraryStore.getState().folders.find(folder => folder.name === name)
const saveIn = (dialog: HTMLElement) => within(dialog).getByRole('group', { name: 'Salvar em' })
const folderWindow = () => screen.getByRole('dialog', { name: 'Onde salvar a nota nova' })
const chosenFolder = (dialog: HTMLElement) => ((within(dialog).getByLabelText('Pasta') as HTMLSelectElement).selectedOptions[0].textContent ?? '').trim()
const tabs = () => screen.getAllByRole('tab').map(tab => `${tab.textContent}${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}`)

function menuOf(id: string): HTMLElement {
  useUiStore.getState().openMenu({ kind: 'file', id, x: 1, y: 1 })
  render(
    <MemoryRouter>
      <ItemMenu />
    </MemoryRouter>,
  )
  return screen.getByRole('menu')
}

describe('a note made from another opens the folder picker, with the folder named after the source chosen', () => {
  it('when that folder does not exist it is made where the source is, and the source goes in with the new note', async () => {
    const work = await useLibraryStore.getState().createFolder({ name: 'Trabalho' })
    const id = await textNote(work.id)
    render(
      <MemoryRouter>
        <GenerateDialog fileId={id} agent="meeting" />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar a Ata' })
    expect(within(dialog).queryByLabelText('Pasta')).not.toBeInTheDocument()
    expect(saveIn(dialog)).toHaveTextContent('Trabalho › Pauta (pasta nova)')
    expect(saveIn(dialog)).toHaveTextContent('Cria a pasta “Pauta” em Trabalho e leva a nota “Pauta” junto.')
    fireEvent.click(within(saveIn(dialog)).getByRole('button', { name: 'Trocar' }))
    expect(within(folderWindow()).getByText('Para qual pasta')).toBeInTheDocument()
    expect(chosenFolder(folderWindow())).toBe('Pauta (pasta nova)')
    expect(folderWindow()).toHaveTextContent('Trabalho › Pauta › Ata: Pauta')
    fireEvent.click(within(folderWindow()).getByRole('button', { name: 'Usar esta pasta' }))
    expect(screen.queryByRole('dialog', { name: 'Onde salvar a nota nova' })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useLibraryStore.getState().files).toHaveLength(2))
    const home = folderNamed('Pauta')!
    expect(home.parentId).toBe(work.id)
    expect(file(id).folderId).toBe(home.id)
    expect(useLibraryStore.getState().files.find(item => item.id !== id)).toMatchObject({ folderId: home.id, parentFileId: id, type: 'meeting' })
  })

  it('a source already in a folder with its own name: both stay there, no folder is made', async () => {
    const home = await useLibraryStore.getState().createFolder({ name: 'Pauta' })
    const id = await textNote(home.id)
    render(
      <MemoryRouter>
        <GenerateDialog fileId={id} agent="lesson" />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar a Aula' })
    expect(saveIn(dialog)).toHaveTextContent('Pauta')
    expect(saveIn(dialog)).toHaveTextContent('A nota “Pauta” já está nessa pasta.')
    fireEvent.click(within(saveIn(dialog)).getByRole('button', { name: 'Trocar' }))
    expect(within(folderWindow()).getByLabelText('Pasta')).toHaveValue(home.id)
    fireEvent.click(within(folderWindow()).getByRole('button', { name: 'Voltar' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useLibraryStore.getState().files).toHaveLength(2))
    expect(useLibraryStore.getState().folders).toHaveLength(1)
    expect(file(id).folderId).toBe(home.id)
    expect(useLibraryStore.getState().files.find(item => item.id !== id)).toMatchObject({ folderId: home.id, type: 'class' })
  })

  it('a folder with the source name beside it is the one chosen: the source moves in', async () => {
    const beside = await useLibraryStore.getState().createFolder({ name: 'Pauta' })
    const id = await textNote()
    expect(homeFolderOf(file(id), useLibraryStore.getState().folders)).toMatchObject({ id: beside.id })
    const made = await useJobsStore.getState().generateFromNote(id, 'meeting', null, 'home')
    expect(useLibraryStore.getState().folders).toHaveLength(1)
    expect(file(id).folderId).toBe(beside.id)
    expect(file(made!).folderId).toBe(beside.id)
  })

  it('another folder picked in the window: only the new note goes there; Voltar changes nothing', async () => {
    const other = await useLibraryStore.getState().createFolder({ name: 'Outra' })
    const id = await textNote()
    render(
      <MemoryRouter>
        <GenerateDialog fileId={id} agent="meeting" />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar a Ata' })
    fireEvent.click(within(saveIn(dialog)).getByRole('button', { name: 'Trocar' }))
    fireEvent.change(within(folderWindow()).getByLabelText('Pasta'), { target: { value: other.id } })
    expect(folderWindow()).toHaveTextContent('Só a nota nova vai para essa pasta.')
    fireEvent.click(within(folderWindow()).getByRole('button', { name: 'Voltar' }))
    expect(saveIn(dialog)).toHaveTextContent('Pauta (pasta nova)')
    fireEvent.click(within(saveIn(dialog)).getByRole('button', { name: 'Trocar' }))
    expect(chosenFolder(folderWindow())).toBe('Pauta (pasta nova)')
    fireEvent.change(within(folderWindow()).getByLabelText('Pasta'), { target: { value: other.id } })
    fireEvent.click(within(folderWindow()).getByRole('button', { name: 'Usar esta pasta' }))
    expect(saveIn(dialog)).toHaveTextContent('Outra')
    expect(saveIn(dialog)).toHaveTextContent('Só a nota nova vai para essa pasta.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useLibraryStore.getState().files).toHaveLength(2))
    expect(file(id).folderId).toBeNull()
    expect(useLibraryStore.getState().files.find(item => item.id !== id)!.folderId).toBe(other.id)
    expect(folderNamed('Pauta')).toBeUndefined()
  })
})

describe('the Ata of a recording is its own note', () => {
  it('Gerar a Ata makes a new note linked to the recording, in the folder named after it; the recording note has no Ata', async () => {
    const id = await recordingNote()
    render(
      <MemoryRouter>
        <AtaPartsDialog fileId={id} />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar a Ata' })
    expect(saveIn(dialog)).toHaveTextContent('Revisão do orçamento (pasta nova)')
    fireEvent.click(within(dialog).getByLabelText('Levantamento de tarefas'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useLibraryStore.getState().files).toHaveLength(2))
    const ata = useLibraryStore.getState().files.find(item => item.id !== id)!
    const home = folderNamed('Revisão do orçamento')!
    expect(ata).toMatchObject({ name: 'Ata: Revisão do orçamento', type: 'meeting', status: 'ready', parentFileId: id, folderId: home.id, made: { parts: ['resumo', 'tarefas'], model: 'custom::geral' } })
    expect(file(id).folderId).toBe(home.id)
    expect(memory.contents.get(ata.id)).toContain('## Levantamento de tarefas')
    expect(memory.contents.get(ata.id)).toContain('[▸ 00:30](#t=30)')
    expect(memory.sidecars.get(ata.id)!.documents![0]).toMatchObject({ kind: 'ata', parts: ['resumo', 'tarefas'] })
    expect(memory.sidecars.get(id)!.documents).toBeUndefined()
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'done', fileId: ata.id })
    render(
      <MemoryRouter>
        <DocumentBody fileId={id} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(tabs()).toEqual(['Transcrição*']))
  })

  it('in the Ata note a minute link plays that moment of the recording, in its own player', async () => {
    const id = await recordingNote()
    const ataId = (await useJobsStore.getState().generateAta(id, ['resumo', 'tarefas']))!
    const stored = new Map<string, Blob>([['reuniao.webm', new NodeBlob([new Uint8Array(8)]) as unknown as Blob]])
    const folder = { getFileHandle: async (name: string) => ({ getFile: async () => new NodeFile([stored.get(name) as never], name) }) }
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => folder } })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:reuniao', revokeObjectURL: () => undefined }))
    useLibraryStore.setState({ localMedia: [{ storedName: 'reuniao.webm', name: 'Reunião.webm', mime: 'audio/webm', durationSeconds: 320, size: 8, createdAt: '2026-10-28T21:15:00Z', fileIds: [id] }] })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
    render(
      <MemoryRouter>
        <DocumentBody fileId={ataId} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('audio')!.getAttribute('src')).toBe('blob:reuniao'))
    fireEvent.click(document.querySelector('a[href="#t=30"]')!)
    expect(document.querySelector('audio')!.currentTime).toBe(30)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('an old note with the Ata inside still shows it in its Ata tab', async () => {
    const id = await recordingNote()
    const before: MeetingDocument = { id: 'ata-1', kind: 'ata', parts: ['resumo'], markdown: '## Resumo\n\nA de antes.', images: [], createdAt: '2026-10-28T12:00:00.000Z', models: {} }
    await useLibraryStore.getState().updateSidecar(id, sidecar => ({ ...sidecar, documents: [before] }))
    render(
      <MemoryRouter>
        <DocumentBody fileId={id} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(tabs()).toEqual(['Transcrição', 'Ata*']))
    expect(screen.getByTestId('markdown')).toHaveTextContent('A de antes.')
    expect(memory.sidecars.get(id)!.documents).toEqual([before])
  })

  it('exporting (.md and PDF) and sharing the Ata note carry its own Ata, prints included, without the transcription', async () => {
    const id = await recordingNote()
    const ataId = (await useJobsStore.getState().generateAta(id, ['resumo', 'tarefas']))!
    const library = useLibraryStore.getState()
    await library.updateSidecar(ataId, sidecar => ({ ...sidecar, documents: sidecar.documents!.map(item => ({ ...item, images: [{ name: 'print-1.png', dataUrl: 'data:image/png;base64,AAAA' }] })) }))
    await library.saveContent(ataId, `${memory.contents.get(ataId)}\n![Tela](imagens/print-1.png)\n`)
    await exportFileAsMarkdown(ataId)
    const text = await (vi.mocked(downloadBlob).mock.calls.at(-1)![0] as Blob).text()
    expect(text).toContain('## Levantamento de tarefas')
    expect(text).toContain('![Tela](data:image/png;base64,AAAA)')
    expect(text).not.toContain('# Transcrição')
    const menu = menuOf(ataId)
    fireEvent.click(within(menu).getByRole('button', { name: 'Exportar PDF' }))
    await waitFor(() => expect(printMarkdownAsPdf).toHaveBeenCalledWith(expect.stringContaining('![Tela](data:image/png;base64,AAAA)'), 'Ata: Revisão do orçamento'))
    expect(vi.mocked(printMarkdownAsPdf).mock.calls[0][0]).not.toContain('imagens/print-1.png')
    const shared = await buildShareContent({ kind: 'file', id: ataId }, useLibraryStore.getState().folders, useLibraryStore.getState().files, useLibraryStore.getState().openFile, false)
    expect(shared.files[0].content).toContain('## Levantamento de tarefas')
    expect(shared.files[0].documents?.[0].images).toEqual([{ name: 'print-1.png', dataUrl: 'data:image/png;base64,AAAA' }])
  })
})

describe('Gerar de novo', () => {
  it('is the first line of the ⋯ of a note made from another, with the ata model, the AI model and the date; not on the source', async () => {
    const id = await recordingNote()
    const ataId = (await useJobsStore.getState().generateAta(id, [], 'fathom', { model: 'custom::forte' }))!
    const when = shortDate(file(ataId).made!.at, useLibraryStore.getState().index.settings.timezone)
    const menu = menuOf(ataId)
    expect(within(menu).getAllByRole('button')[0]).toHaveTextContent(`Gerar de novo…Ata Fathom · Forte · em ${when}`)
    fireEvent.click(within(menu).getAllByRole('button')[0])
    expect(useUiStore.getState().overlay).toEqual({ kind: 'ata-parts', fileId: id, again: ataId })
    cleanup()
    menuOf(id)
    expect(screen.queryByRole('button', { name: /Gerar de novo/ })).not.toBeInTheDocument()
  })

  it('opens the Ata dialog with the last Modelo da ata and Modelo da IA; Substituir writes into the same note', async () => {
    const id = await recordingNote()
    const ataId = (await useJobsStore.getState().generateAta(id, ['resumo', 'perguntas'], undefined, { model: 'custom::forte' }))!
    const before = file(ataId)
    render(
      <MemoryRouter>
        <AtaPartsDialog fileId={id} again={ataId} />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar de novo a Ata' })
    expect(dialog).toHaveTextContent('Da última vez: Ata Padrão · Forte')
    expect(within(dialog).getByLabelText('Modelo da ata')).toHaveValue('')
    expect(within(dialog).getAllByRole('checkbox').filter(box => (box as HTMLInputElement).checked).map(box => box.parentElement?.textContent)).toEqual(['Resumo', 'Perguntas em aberto'])
    expect(within(dialog).getByLabelText('Modelo da IA')).toHaveValue('custom::forte')
    expect(within(dialog).getByRole('radio', { name: /Substituir esta nota/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).queryByRole('group', { name: 'Salvar em' })).not.toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText('Modelo da ata'), { target: { value: 'cornell' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(memory.sidecars.get(ataId)!.documents![0].ataModel?.id).toBe('cornell'))
    expect(useLibraryStore.getState().files).toHaveLength(2)
    expect(file(ataId)).toMatchObject({ name: before.name, folderId: before.folderId, made: { ataModel: 'cornell', model: 'custom::forte' } })
    expect(memory.contents.get(ataId)).toBe(MODEL_DOCUMENT)
    expect(calls.some(call => systemPromptOf(call) === ATA_MODELS.cornell.prompt && call.body?.model === 'forte')).toBe(true)
    expect(memory.sidecars.get(id)!.documents).toBeUndefined()
  })

  it('Criar nota nova opens the folder picker with the folder named after the source chosen; the note of now stays', async () => {
    const id = await recordingNote()
    const ataId = (await useJobsStore.getState().generateAta(id, [], 'fathom'))!
    const first = memory.contents.get(ataId)
    const home = folderNamed('Revisão do orçamento')!
    render(
      <MemoryRouter>
        <AtaPartsDialog fileId={id} again={ataId} />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar de novo a Ata' })
    expect(within(dialog).getByLabelText('Modelo da ata')).toHaveValue('fathom')
    fireEvent.click(within(dialog).getByRole('radio', { name: /Criar nota nova/ }))
    expect(within(folderWindow()).getByLabelText('Pasta')).toHaveValue(home.id)
    fireEvent.click(within(folderWindow()).getByRole('button', { name: 'Usar esta pasta' }))
    expect(saveIn(dialog)).toHaveTextContent('Revisão do orçamento')
    expect(within(saveIn(dialog)).getByRole('button', { name: 'Trocar' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useLibraryStore.getState().files).toHaveLength(3))
    const newer = useLibraryStore.getState().files.find(item => item.id !== id && item.id !== ataId)!
    expect(newer).toMatchObject({ type: 'meeting', parentFileId: id, folderId: home.id, made: { ataModel: 'fathom' } })
    expect(memory.contents.get(ataId)).toBe(first)
  })

  it('an Ata or Aula from a text note comes back with its Modelo da IA; Substituir keeps the name and the folder', async () => {
    const id = await textNote()
    const madeId = (await useJobsStore.getState().generateFromNote(id, 'meeting', 'custom::forte'))!
    await waitFor(() => expect(file(madeId).status).toBe('ready'))
    await useLibraryStore.getState().updateFile(madeId, { name: 'Ata do lançamento' })
    const menu = menuOf(madeId)
    fireEvent.click(within(menu).getByRole('button', { name: /^Gerar de novo…/ }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate', fileId: id, agent: 'meeting', again: madeId })
    render(
      <MemoryRouter>
        <GenerateDialog fileId={id} agent="meeting" again={madeId} />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar de novo a Ata' })
    expect(within(dialog).queryByLabelText('Modelo da ata')).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText('Modelo da IA')).toHaveValue('custom::forte')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(calls.filter(call => systemPromptOf(call) === PROMPTS.MINUTES_EXTRACT_PROMPT)).toHaveLength(2))
    await waitFor(() => expect(file(madeId).status).toBe('ready'))
    expect(useLibraryStore.getState().files).toHaveLength(2)
    expect(file(madeId)).toMatchObject({ name: 'Ata do lançamento', folderId: file(id).folderId })
  })
})

describe('Instrução extra para a IA', () => {
  const FOCUS = 'foque nas decisões sobre o reajuste do INCC e liste todas as tarefas do Henrique'
  const BLOCK = `${INSTRUCTION_HEAD}\n\n${FOCUS}`
  const PAUTA = '# Conteúdo\n\nVamos lançar em maio, eu mando a proposta.'
  const LESSON = JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Lançamento' }, { type: 'paragraph', text: 'Em maio.' }], diagrams: [] } })
  const writes = (request: CapturedRequest) => (systemPromptOf(request) === PROMPTS.LESSON_PROMPT || systemPromptOf(request) === PROMPTS.EXPLANATION_PROMPT ? openAiStream(LESSON) : provider(request))
  const field = (dialog: HTMLElement) => within(dialog).getByLabelText('Instrução extra para a IA (opcional)')
  const sent = (system: string) => calls.filter(call => systemPromptOf(call) === system).map(userContentOf)

  it('Ata of a recording, through the transcription: typed in Mais opções, it reaches the context, the parts and the tasks, and the note keeps it', async () => {
    const id = await recordingNote()
    render(
      <MemoryRouter>
        <AtaPartsDialog fileId={id} />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar a Ata' })
    expect(field(dialog).closest('details')).not.toHaveAttribute('open')
    fireEvent.click(within(dialog).getByLabelText('Levantamento de tarefas'))
    fireEvent.change(field(dialog), { target: { value: FOCUS } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useLibraryStore.getState().files).toHaveLength(2))
    const reached = calls.filter(call => userContentOf(call).includes(BLOCK)).map(systemPromptOf)
    expect(reached).toEqual(expect.arrayContaining([P.ENTENDER, P.CANDIDATAS, P.ESCREVER_GERAL, `${P.BASE}\n\n${P.RESUMO}`]))
    expect(useLibraryStore.getState().files.find(item => item.id !== id)!.made).toMatchObject({ parts: ['resumo', 'tarefas'], instruction: FOCUS })
  })

  it('Gerar de novo comes with the last instruction, open to see; cleared, the request goes as before and the note forgets it', async () => {
    const id = await recordingNote()
    const ataId = (await useJobsStore.getState().generateAta(id, ['resumo'], undefined, undefined, 'home', FOCUS))!
    render(
      <MemoryRouter>
        <AtaPartsDialog fileId={id} again={ataId} />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar de novo a Ata' })
    expect(field(dialog)).toHaveValue(FOCUS)
    expect(field(dialog).closest('details')).toHaveAttribute('open')
    fireEvent.change(field(dialog), { target: { value: '' } })
    const before = calls.length
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useJobsStore.getState().jobs[0]).toMatchObject({ status: 'done', fileId: ataId }))
    expect(calls.length).toBeGreaterThan(before)
    expect(calls.slice(before).some(call => userContentOf(call).includes(INSTRUCTION_HEAD))).toBe(false)
    expect(file(ataId).made).not.toHaveProperty('instruction')
  })

  it('Aula of a note: the instruction is the marked end of the request; empty, the request is the one of before', async () => {
    calls = installFetch(writes).calls
    const id = await textNote()
    render(
      <MemoryRouter>
        <GenerateDialog fileId={id} agent="lesson" />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Gerar a Aula' })
    expect(field(dialog)).toHaveAttribute('placeholder', 'Ex.: foque na parte prática')
    fireEvent.change(field(dialog), { target: { value: FOCUS } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(useLibraryStore.getState().files.find(item => item.id !== id)?.status).toBe('ready'))
    expect(sent(PROMPTS.LESSON_PROMPT)).toEqual([`${PAUTA}\n\n${BLOCK}`])
    expect(useLibraryStore.getState().files.find(item => item.id !== id)!.made).toMatchObject({ instruction: FOCUS })
    cleanup()
    calls.length = 0
    const plain = (await useJobsStore.getState().generateFromNote(id, 'lesson', null, { folderId: null }, ''))!
    await waitFor(() => expect(file(plain).status).toBe('ready'))
    expect(sent(PROMPTS.LESSON_PROMPT)).toEqual([PAUTA])
    expect(file(plain).made).not.toHaveProperty('instruction')
  })

  it('the Ata of a text note and Refazer carry it too', async () => {
    calls = installFetch(writes).calls
    const id = await textNote()
    render(
      <MemoryRouter>
        <GenerateDialog fileId={id} agent="meeting" />
      </MemoryRouter>,
    )
    let dialog = screen.getByRole('dialog', { name: 'Gerar a Ata' })
    expect(field(dialog)).toHaveAttribute('placeholder', 'Ex.: foque nas decisões e nas tarefas')
    fireEvent.change(field(dialog), { target: { value: FOCUS } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(sent(PROMPTS.MINUTES_EXTRACT_PROMPT)).toEqual([`${PAUTA}\n\n${BLOCK}`]))
    cleanup()
    const recorded = await recordingNote()
    await useLibraryStore.getState().updateFile(recorded, { type: 'class' })
    render(
      <MemoryRouter>
        <GenerateDialog fileId={recorded} agent="lesson" redo />
      </MemoryRouter>,
    )
    dialog = screen.getByRole('dialog', { name: 'Refazer a Aula' })
    fireEvent.change(field(dialog), { target: { value: FOCUS } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(sent(PROMPTS.LESSON_PROMPT)).toHaveLength(1))
    expect(sent(PROMPTS.LESSON_PROMPT)[0]).toMatch(/^# Conteúdo\n\nRegy Niles \[00:10\]/)
    expect(sent(PROMPTS.LESSON_PROMPT)[0].endsWith(`\n\n${BLOCK}`)).toBe(true)
  })

  it('Explicação of a theme in Novo conteúdo: the instruction of Mais opções reaches the request', async () => {
    calls = installFetch(writes).calls
    render(
      <MemoryRouter>
        <NewContentDialog />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Tema' }))
    fireEvent.change(screen.getByLabelText('Tema'), { target: { value: 'Buracos negros' } })
    fireEvent.change(screen.getByLabelText('Instrução extra para a IA (opcional)'), { target: { value: FOCUS } })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar explicação' }))
    await waitFor(() => expect(sent(PROMPTS.EXPLANATION_PROMPT)).toEqual([`Buracos negros\n\n${BLOCK}`]))
  })
})
