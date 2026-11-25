import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { MemoryRouter } from 'react-router-dom'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@/routes', () => ({ router: { navigate } }))

vi.mock('@/lib/transcription', async () => {
  const { meeting } = await import('@/test/generation/ata-fixture')
  const { speakersOf } = await import('@/lib/transcription/turns')
  return {
    ENGINES: [],
    transcribe: vi.fn(async (_file: Blob, _settings: unknown, _progress: unknown, _signal: unknown, options?: { recorder?: string }) => ({
      text: 'bruto',
      engine: 'deepinfra',
      language: 'pt',
      durationSeconds: 310,
      speakers: 3,
      recording: { ...meeting, speakers: speakersOf(meeting.blocks, options?.recorder) },
    })),
  }
})

import { RecordingDoneDialog } from '@/components/dialogs/RecordDialogs'
import { defaultIndex } from '@/lib/defaults'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { listLocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import { transcribe } from '@/lib/transcription'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useRecorderStore } from '@/stores/recorder'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { textAnswer } from '@/test/generation/ata-fixture'
import type { AiConfig, FileSidecar } from '@/types/domain'

const CONFIG: AiConfig = {
  providers: [
    { id: 'custom', type: 'custom', name: 'Exemplo', key: 'k', base: 'https://ia.exemplo.dev/v1' },
    { id: 'di', type: 'deepinfra', name: 'DeepInfra', key: 'di-key', base: '' },
  ],
  models: [
    { uid: 'custom::geral', pid: 'custom', mid: 'geral', name: 'Geral' },
    { uid: 'custom::forte', pid: 'custom', mid: 'forte', name: 'Forte' },
    { uid: 'di::openai/whisper-large-v3', pid: 'di', mid: 'openai/whisper-large-v3', name: 'whisper-large-v3' },
  ],
  defaults: { estudo: 'custom::geral', transcricao: 'di::openai/whisper-large-v3' },
  steps: {},
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

function installBrowserFolder(): Map<string, Blob> {
  const files = new Map<string, Blob>()
  const handle = (name: string) => ({
    getFile: async () => new NodeFile([files.get(name) as never], name),
    createWritable: async () => {
      const parts: BlobPart[] = []
      return { write: async (data: BlobPart) => void parts.push(data), close: async () => void files.set(name, new NodeBlob(parts as never) as unknown as Blob) }
    },
  })
  const folder = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError')
      return handle(name)
    },
    removeEntry: async (name: string) => void files.delete(name),
  }
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => folder } })
  return files
}

const WRITTEN = JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Vendas' }, { type: 'paragraph', text: 'O que foi dito na gravação.' }], diagrams: [] } })

let memory: ReturnType<typeof memoryRepository>
let calls: CapturedRequest[]
const realSaveRecording = useJobsStore.getState().saveRecording

function provider(request: CapturedRequest): Response {
  const system = systemPromptOf(request)
  if (system === PROMPTS.POLISH_PROMPT) return openAiStream(JSON.stringify({ titulo: '', nomes: [], correcoes: [] }))
  if (system === PROMPTS.SPEAKER_NAMES_PROMPT) return openAiStream(JSON.stringify({ nomes: [] }))
  if (system === PROMPTS.TRANSCRIPT_REVIEW_PROMPT) return openAiStream(JSON.stringify({ correcoes: [] }))
  if (system === PROMPTS.TITLE_PROMPT) return openAiStream(JSON.stringify({ titulo: 'Conversa' }))
  if (system === PROMPTS.TAGS_PROMPT) return openAiStream(JSON.stringify({ etiquetas: [] }))
  if (system === PROMPTS.MINUTES_EXTRACT_PROMPT) return openAiStream(JSON.stringify({ assunto: 'Vendas', temas: [], passos: [] }))
  if (system === PROMPTS.LESSON_PROMPT || system === PROMPTS.EXPLANATION_PROMPT) return openAiStream(WRITTEN)
  return openAiStream(textAnswer(system, userContentOf(request)))
}

function recorded(kind: 'audio' | 'video' = 'audio') {
  const type = kind === 'audio' ? 'audio/webm' : 'video/webm'
  const file = new NodeFile([new Uint8Array(8)], `Reunião 14-10-2026, 09-00-00.${kind === 'audio' ? 'webm' : 'mp4'}`, { type }) as unknown as File
  return { file, mime: type, durationSeconds: 310, storedName: 'gravacao-1.webm', marks: [] }
}

beforeEach(async () => {
  memory = memoryRepository()
  const folder = installBrowserFolder()
  folder.set('gravacao-1.webm', new NodeBlob([new Uint8Array(8)]) as unknown as Blob)
  folder.set('midias.json', new NodeBlob([JSON.stringify([{ storedName: 'gravacao-1.webm', name: 'Reunião.webm', mime: 'audio/webm', durationSeconds: 310, size: 8, createdAt: '2026-10-14T12:00:00Z', fileIds: [] }])]) as unknown as Blob)
  navigate.mockClear()
  vi.mocked(transcribe).mockClear()
  const index = defaultIndex()
  index.settings.aiConfig = CONFIG
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
  useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index, opened: {}, openedAt: {}, localMedia: await listLocalMedia(), sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [], saveRecording: realSaveRecording })
  useRecorderStore.setState({ result: recorded(), resultPlace: 'dialog' })
  calls = installFetch(provider).calls
})

afterEach(() => {
  vi.unstubAllGlobals()
  useJobsStore.setState({ saveRecording: realSaveRecording })
  useRecorderStore.setState({ result: null })
})

const open = () =>
  render(
    <MemoryRouter>
      <RecordingDoneDialog />
    </MemoryRouter>,
  )

const dialog = () => screen.getByRole('dialog', { name: 'Gravação pronta' })
const generate = () => within(dialog()).getByRole('group', { name: 'Gerar' })
const box = (name: string) => within(generate()).getByRole('checkbox', { name: new RegExp(`^${name}`) })
const toggle = (name: string) => fireEvent.click(box(name))
const moreOptions = () => fireEvent.click(within(dialog()).getByRole('button', { name: /^Mais opções/ }))
const save = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar' }))

/** The request the dialog sent, with the store out of the way. */
function spyOnSave() {
  const saveRecording = vi.fn(async () => 'entrada-1')
  useJobsStore.setState({ saveRecording })
  return saveRecording
}

const sentOf = (saveRecording: ReturnType<typeof spyOnSave>) => (saveRecording.mock.calls[0] as unknown as [Record<string, unknown> & { writes?: Record<string, unknown>[] }])[0]

// Spec 007 (pedido do dono, 24/11; mocks/gravar-reuniao): "Gerar" com Transcrição, Ata, Aula e Explicação, várias ao mesmo tempo; o nome
// que a pessoa digita; sem as partes da Ata (sai com o padrão de "Gerar desta nota")
describe('Gravação pronta: o que gerar', () => {
  it('"Gerar" tem Transcrição, Ata, Aula e Explicação para marcar, com a Transcrição já marcada; o nome vem com o padrão', () => {
    open()
    const boxes = within(generate()).getAllByRole('checkbox')
    expect(boxes.map(item => item.querySelector('b')?.textContent)).toEqual(['Transcrição', 'Ata', 'Aula', 'Explicação'])
    expect(boxes.filter(item => item.getAttribute('aria-checked') === 'true').map(item => item.querySelector('b')?.textContent)).toEqual(['Transcrição'])
    expect(within(dialog()).getByRole('textbox', { name: 'Nome' })).toHaveValue('Reunião 14-10-2026, 09-00-00')
    expect(within(dialog()).queryByRole('radiogroup', { name: 'O que fazer com a gravação' })).not.toBeInTheDocument()
  })

  it('Salvar sem mexer em nada só transcreve, como antes, e a navegação é a de hoje', async () => {
    const saveRecording = spyOnSave()
    open()
    save()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/arquivo/entrada-1'))
    const sent = sentOf(saveRecording)
    expect(sent).toMatchObject({ transcribe: true, folderId: null })
    expect(sent.writes ?? []).toEqual([])
    expect(sent).not.toHaveProperty('name')
  })

  it('o nome digitado vai para a nota, e a janela lembra o padrão', async () => {
    const saveRecording = spyOnSave()
    open()
    fireEvent.change(within(dialog()).getByRole('textbox', { name: 'Nome' }), { target: { value: 'Planejamento do trimestre' } })
    expect(within(dialog()).getByText('O padrão era "Reunião 14-10-2026, 09-00-00".')).toBeInTheDocument()
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording)).toMatchObject({ name: 'Planejamento do trimestre' })
  })

  it('nada marcado só guarda: não transcreve nem escreve, e não pede modelo nenhum', async () => {
    const saveRecording = spyOnSave()
    open()
    toggle('Transcrição')
    expect(within(dialog()).getByText('Pode marcar vários. Nada marcado: só guarda.')).toBeInTheDocument()
    expect(within(dialog()).queryByRole('button', { name: /^Mais opções/ })).not.toBeInTheDocument()
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    const sent = sentOf(saveRecording)
    expect(sent).toMatchObject({ transcribe: false })
    expect(sent.writes ?? []).toEqual([])
    expect(sent).not.toHaveProperty('transcriptionModel')
  })

  it('Transcrição, Ata e Explicação de uma vez: transcreve e escreve as duas, na ordem da janela', async () => {
    const saveRecording = spyOnSave()
    open()
    toggle('Explicação')
    toggle('Ata')
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    const sent = sentOf(saveRecording)
    expect(sent.transcribe).toBe(true)
    expect(sent.writes?.map(write => write.agent)).toEqual(['meeting', 'explanation'])
  })

  it('a Ata não tem partes para escolher (24/11: "partes da ata sai"): no Padrão sai com o Resumo, sem modelo da ata', async () => {
    const saveRecording = spyOnSave()
    open()
    toggle('Ata')
    moreOptions()
    expect(within(dialog()).queryByRole('group', { name: 'Partes da ata' })).not.toBeInTheDocument()
    expect(within(dialog()).getByLabelText('Modelo da ata')).toHaveValue('')
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    const write = sentOf(saveRecording).writes![0] as { agent: string; parts: string[]; ataModel?: string; model: string }
    expect(write).toMatchObject({ agent: 'meeting', parts: ['resumo'], model: 'custom::geral' })
    expect(write.ataModel).toBeUndefined()
  })

  // T179 (dono, 25/11: "Quando seleciono ata após gravação não aparece o modelo de ata pra gerar"): marcar a Ata mostra o "Modelo da
  // ata" na hora, fora de "Mais opções", e o escolhido vai no pedido no lugar das partes
  it('marcar a Ata mostra o "Modelo da ata"; o escolhido vai no pedido', async () => {
    const saveRecording = spyOnSave()
    open()
    expect(within(dialog()).queryByLabelText('Modelo da ata')).not.toBeInTheDocument()
    toggle('Ata')
    fireEvent.change(within(dialog()).getByLabelText('Modelo da ata'), { target: { value: 'cornell' } })
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording).writes![0]).toMatchObject({ agent: 'meeting', ataModel: 'cornell', parts: [] })
  })

  it('"Mais opções" tem o modelo de cada uma marcada e a instrução, que vai para as escritas', async () => {
    const saveRecording = spyOnSave()
    open()
    toggle('Aula')
    expect(within(dialog()).queryByLabelText('Aula')).not.toBeInTheDocument()
    moreOptions()
    expect(within(dialog()).getByLabelText('Transcrição')).toBeInTheDocument()
    expect(within(dialog()).getByLabelText('Aula')).toHaveValue('custom::geral')
    fireEvent.change(within(dialog()).getByLabelText('Aula'), { target: { value: 'custom::forte' } })
    fireEvent.change(within(dialog()).getByLabelText('Instrução extra para a IA (opcional)'), { target: { value: 'foque nos exemplos' } })
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording)).toMatchObject({ transcribe: true, writes: [{ agent: 'lesson', model: 'custom::forte', instruction: 'foque nos exemplos' }] })
  })

  it('sem instrução, a instrução não vai', async () => {
    const saveRecording = spyOnSave()
    open()
    toggle('Explicação')
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    const write = sentOf(saveRecording).writes![0]
    expect(write).toMatchObject({ agent: 'explanation', model: 'custom::geral' })
    expect(write.instruction ?? '').toBe('')
  })

  it('sem modelo padrão para uma marcada, "Mais opções" abre sozinho e o Salvar espera a pessoa escolher', async () => {
    useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, aiConfig: { ...CONFIG, defaults: { transcricao: CONFIG.defaults.transcricao } } } } }))
    const saveRecording = spyOnSave()
    open()
    toggle('Aula')
    expect(within(dialog()).getByText('Sem modelo padrão para Aula: escolha um aqui.')).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Salvar' })).toBeDisabled()
    fireEvent.change(within(dialog()).getByLabelText('Aula'), { target: { value: 'custom::forte' } })
    expect(within(dialog()).getByRole('button', { name: 'Salvar' })).toBeEnabled()
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording)).toMatchObject({ writes: [{ agent: 'lesson', model: 'custom::forte' }] })
  })

  it('a pasta e onde salvar vão junto, qualquer que seja o que se gera', async () => {
    const saveRecording = spyOnSave()
    const folder = await useLibraryStore.getState().createFolder({ name: 'Reuniões' })
    open()
    toggle('Aula')
    expect(within(dialog()).getByRole('radiogroup', { name: 'Onde salvar' })).toBeInTheDocument()
    const field = within(dialog()).getByRole('group', { name: 'Pasta' })
    fireEvent.click(within(field).getByRole('button', { name: 'Trocar' }))
    const chooser = screen.getByRole('dialog', { name: 'Escolher pasta' })
    fireEvent.click(within(within(chooser).getByRole('tree', { name: 'Todas as pastas' })).getByRole('treeitem', { name: 'Reuniões' }))
    fireEvent.click(within(chooser).getByRole('button', { name: 'Usar esta pasta' }))
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording)).toMatchObject({ folderId: folder.id, storage: 'none', writes: [{ agent: 'lesson' }] })
  })
})

describe('Gravação pronta: vídeo', () => {
  beforeEach(() => useRecorderStore.setState({ result: recorded('video') }))

  it('a Aula de um vídeo pergunta, em "Mais opções", o que a IA analisa; só a transcrição segue para a escrita', async () => {
    const saveRecording = spyOnSave()
    open()
    toggle('Aula')
    moreOptions()
    const analysis = within(dialog()).getByRole('radiogroup', { name: 'O que a IA analisa' })
    fireEvent.click(within(analysis).getByRole('radio', { name: /Só a transcrição/ }))
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording)).toMatchObject({ writes: [{ agent: 'lesson', analyze: 'transcricao' }] })
  })

  it('a Ata de um vídeo vai passo a passo, sem abrir nada, e "Mais opções" diz qual', async () => {
    const saveRecording = spyOnSave()
    open()
    toggle('Ata')
    moreOptions()
    const analysis = within(dialog()).getByRole('radiogroup', { name: 'O que a IA analisa' })
    expect(within(analysis).getByRole('radio', { name: /Transcrição \+ quadros do vídeo/ })).toHaveAttribute('aria-checked', 'true')
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording)).toMatchObject({ writes: [{ agent: 'meeting', analyze: 'quadros' }] })
  })

  // T177 (o dono escolheu B em 25/11): a Ata, a Aula e a Explicação de um vídeo têm as mesmas três escolhas
  it.each(['Ata', 'Aula'])('na %s de um vídeo vêm as mesmas três escolhas, e sem abrir nada vai o passo a passo', async name => {
    const saveRecording = spyOnSave()
    open()
    toggle(name)
    moreOptions()
    const analysis = within(dialog()).getByRole('radiogroup', { name: 'O que a IA analisa' })
    expect(within(analysis).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['Transcrição + quadros do vídeo', 'Só a transcrição', 'Tudo numa chamada'])
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording)).toMatchObject({ writes: [{ agent: name === 'Ata' ? 'meeting' : 'lesson', analyze: 'quadros' }] })
  })

  it('a Ata com "Só a transcrição" vai sem ler a tela', async () => {
    const saveRecording = spyOnSave()
    open()
    toggle('Ata')
    moreOptions()
    const analysis = within(dialog()).getByRole('radiogroup', { name: 'O que a IA analisa' })
    fireEvent.click(within(analysis).getByRole('radio', { name: /Só a transcrição/ }))
    save()
    await waitFor(() => expect(saveRecording).toHaveBeenCalled())
    expect(sentOf(saveRecording)).toMatchObject({ writes: [{ agent: 'meeting', analyze: 'transcricao' }] })
  })

  it('Ata e Aula juntas: uma escolha para cada, cada uma com o seu nome', () => {
    open()
    toggle('Ata')
    toggle('Aula')
    moreOptions()
    expect(within(dialog()).getByRole('radiogroup', { name: 'O que a IA analisa na Ata' })).toBeInTheDocument()
    expect(within(dialog()).getByRole('radiogroup', { name: 'O que a IA analisa na Aula' })).toBeInTheDocument()
  })

  it('só a Transcrição, ou nada, não pergunta o que a IA analisa', () => {
    open()
    moreOptions()
    expect(within(dialog()).queryByRole('radiogroup', { name: /O que a IA analisa/ })).not.toBeInTheDocument()
  })

  it('um áudio nunca pergunta isso', () => {
    useRecorderStore.setState({ result: recorded('audio') })
    open()
    toggle('Aula')
    moreOptions()
    expect(within(dialog()).queryByRole('radiogroup', { name: /O que a IA analisa/ })).not.toBeInTheDocument()
  })
})

describe('Salvar a gravação e já começar a nota (a loja de verdade)', () => {
  const request = (extra: Record<string, unknown> = {}) => {
    const { file, storedName } = recorded()
    return { file, storedName, durationSeconds: 310, folderId: null, storage: 'none' as const, litterboxTime: '72h' as never, marks: [], transcribe: false, ...extra }
  }
  const entry = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)!
  const child = (id: string) => useLibraryStore.getState().files.find(file => file.parentFileId === id)!
  const finished = (id: string) => waitFor(() => expect(child(id)?.status, JSON.stringify(useJobsStore.getState().jobs.map(job => [job.kind, job.status, job.error, job.message]))).toBe('ready'), { timeout: 4000 })
  const sentTo = (prompt: string) => calls.filter(call => systemPromptOf(call) === prompt)

  it('Aula: guarda a gravação, transcreve antes e a Aula fica debaixo da entrada, na mesma pasta', async () => {
    const folder = await useLibraryStore.getState().createFolder({ name: 'Reuniões' })
    const id = await useJobsStore.getState().saveRecording(request({ folderId: folder.id, write: { agent: 'lesson', model: null } }))
    expect(entry(id)).toMatchObject({ type: 'audio', folderId: folder.id })
    await finished(id)
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(memory.sidecars.get(id)?.recording?.blocks).toHaveLength(7)
    expect(child(id)).toMatchObject({ type: 'class', name: expect.stringMatching(/^Aula: /), parentFileId: id, folderId: folder.id })
    expect(sentTo(PROMPTS.LESSON_PROMPT)).toHaveLength(1)
    expect(userContentOf(sentTo(PROMPTS.LESSON_PROMPT)[0])).toContain('Boa tarde, vamos ver a tabela de vendas.')
    expect(useLibraryStore.getState().files.filter(file => file.id !== id && file.parentFileId !== id)).toHaveLength(0)
  })

  it('Explicação: uma nota do tipo explicação, filha da entrada', async () => {
    const id = await useJobsStore.getState().saveRecording(request({ write: { agent: 'explanation', model: null } }))
    await finished(id)
    expect(child(id)).toMatchObject({ type: 'explanation', parentFileId: id })
    expect(sentTo(PROMPTS.EXPLANATION_PROMPT)).toHaveLength(1)
  })

  it('a instrução extra chega à IA', async () => {
    const id = await useJobsStore.getState().saveRecording(request({ write: { agent: 'lesson', model: null, instruction: 'foque nos exemplos' } }))
    await finished(id)
    const asked = userContentOf(sentTo(PROMPTS.LESSON_PROMPT)[0])
    expect(asked).toContain(INSTRUCTION_HEAD)
    expect(asked).toContain('foque nos exemplos')
    expect(child(id).made).toMatchObject({ instruction: 'foque nos exemplos' })
  })

  it('o modelo escolhido para a escrita é o que escreve', async () => {
    const id = await useJobsStore.getState().saveRecording(request({ write: { agent: 'lesson', model: 'custom::forte' } }))
    await finished(id)
    expect(sentTo(PROMPTS.LESSON_PROMPT)[0].body?.model).toBe('forte')
    expect(child(id).made).toMatchObject({ model: 'custom::forte' })
  })

  it('Ata: transcreve antes e a Ata (uma nota do tipo ata) fica debaixo da entrada', async () => {
    const id = await useJobsStore.getState().saveRecording(request({ write: { agent: 'meeting', model: null, parts: ['resumo'] } }))
    await finished(id)
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(child(id)).toMatchObject({ type: 'meeting', name: expect.stringMatching(/^Ata: /), parentFileId: id })
    expect(child(id).made).toMatchObject({ parts: ['resumo'] })
    expect(memory.contents.get(child(id).id)).toContain('Participantes')
  })

  it('Ata com Modelo da ata: o modelo no lugar das partes', async () => {
    const id = await useJobsStore.getState().saveRecording(request({ write: { agent: 'meeting', model: null, parts: [], ataModel: 'cornell' } }))
    await finished(id)
    expect(child(id)).toMatchObject({ type: 'meeting', parentFileId: id })
    expect(child(id).made).toMatchObject({ ataModel: 'cornell' })
  })

  it('sem "write" nada muda: só a entrada, sem nenhuma chamada à IA', async () => {
    const id = await useJobsStore.getState().saveRecording(request())
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(entry(id)).toMatchObject({ type: 'audio' })
    expect(useLibraryStore.getState().files).toHaveLength(1)
    expect(transcribe).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('várias de uma vez: transcreve uma vez só, primeiro, e escreve a Ata e a Explicação debaixo da entrada', async () => {
    const id = await useJobsStore.getState().saveRecording(request({ transcribe: true, writes: [{ agent: 'meeting', model: null, parts: ['resumo'] }, { agent: 'explanation', model: null }] }))
    await waitFor(() => expect(useLibraryStore.getState().files.filter(file => file.parentFileId === id && file.status === 'ready').map(file => file.type).sort(), JSON.stringify(useJobsStore.getState().jobs.map(job => [job.kind, job.status, job.error]))).toEqual(['explanation', 'meeting']), { timeout: 6000 })
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(memory.sidecars.get(id)?.recording?.blocks).toHaveLength(7)
  })

  it('o nome escolhido é o nome da nota, e a transcrição não troca pelo título da IA', async () => {
    const id = await useJobsStore.getState().saveRecording(request({ transcribe: true, name: 'Planejamento do trimestre' }))
    expect(entry(id).name).toBe('Planejamento do trimestre')
    await waitFor(() => expect(memory.sidecars.get(id)?.recording?.blocks).toHaveLength(7))
    expect(entry(id).name).toBe('Planejamento do trimestre')
  })

  it('"Só transcrever" continua só transcrevendo, sem nota nova', async () => {
    const id = await useJobsStore.getState().saveRecording(request({ transcribe: true }))
    await waitFor(() => expect(memory.sidecars.get(id)?.recording?.blocks).toHaveLength(7))
    expect(useLibraryStore.getState().files.filter(file => file.parentFileId === id)).toHaveLength(0)
    expect(sentTo(PROMPTS.LESSON_PROMPT)).toHaveLength(0)
  })
})
