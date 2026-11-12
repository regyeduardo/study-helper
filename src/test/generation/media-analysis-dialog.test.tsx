import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// FR-046: the choice of what the AI analyzes, in the two windows, only for a video.

import { GenerateDialog } from '@/components/dialogs/GenerateDialog'
import { GenerateEntryDialog } from '@/components/dialogs/GenerateEntryDialog'
import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { installFetch } from '@/test/ai/fake-provider'
import { installBlobShim } from '@/test/imports/blob-shim'
import type { FileMeta, FileSidecar, RecordingData, SourceMeta } from '@/types/domain'

const HEARS = { uid: 'or::omni', pid: 'or', mid: 'omni', name: 'Omni' }
const DEAF = { uid: 'or::texto', pid: 'or', mid: 'texto', name: 'Só texto' }
const stamp = { at: '2026-11-03T12:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }

const VIDEO: SourceMeta = { input: 'file', name: 'aula.mp4', mime: 'video/mp4', durationSeconds: 60, storage: 'drive', storedFileId: 'drv', expiresAt: null }
const AUDIO: SourceMeta = { ...VIDEO, name: 'aula.mp3', mime: 'audio/mpeg' }
const PDF: SourceMeta = { ...VIDEO, name: 'a.pdf', mime: 'application/pdf' }
const RECORDING: RecordingData = { blocks: [{ speaker: 's', start: 0, end: 3, text: 'Olá.' }], speakers: [{ id: 's', name: 'Ana', suggested: false }], marks: [] }

function entrada(origin: SourceMeta, fields: Partial<FileMeta> = {}, transcribed = true): FileSidecar {
  const sidecar = newSidecar(newFileMeta({ id: 'e', name: 'Aula', role: 'entrada', kept: 'arquivo', type: 'reading', origin, created: stamp, updated: stamp, ...fields }))
  return transcribed ? { ...sidecar, transcript: 'Ana: Olá.', recording: RECORDING } : sidecar
}

function seed(sidecars: FileSidecar[], defaultModel = HEARS.uid) {
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    readSidecar: async (id: string) => sidecars.find(sidecar => sidecar.meta.id === id)!,
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  const index = defaultIndex()
  index.settings.aiConfig = { providers: [{ id: 'or', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }], models: [HEARS, DEAF], defaults: { estudo: defaultModel, ata: defaultModel, midia: HEARS.uid }, steps: {} }
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: sidecars.map(sidecar => sidecar.meta), index, opened: {}, openedAt: {}, localMedia: [], sharedView: null })
}

/** The catalog says who hears: `HEARS` does, `DEAF` does not. */
function catalog() {
  const models = [
    { id: 'omni', name: 'Omni', media: { texto: true, imagem: true, audio: true, video: true, pdf: null } },
    { id: 'texto', name: 'Só texto', media: { texto: true, imagem: false, audio: false, video: false, pdf: null } },
  ]
  useModelsStore.setState({ live: { or: { state: 'ok', token: 1, at: Date.now(), list: models, byId: new Map(models.map(model => [model.id, model])) } }, probes: {} })
}

const field = () => screen.getByRole('radiogroup', { name: 'O que a IA analisa' })
const noField = () => expect(screen.queryByRole('radiogroup', { name: 'O que a IA analisa' })).not.toBeInTheDocument()
const radio = (name: string) => within(field()).getByRole('radio', { name: new RegExp(`^${name.replace('+', '\\+')}`) })
const checked = () =>
  within(field())
    .getAllByRole('radio')
    .filter(item => item.getAttribute('aria-checked') === 'true')
    .map(item => item.querySelector('b')!.textContent)
const pickModel = (uid: string) => fireEvent.change(screen.getByLabelText('Modelo da IA'), { target: { value: uid } })
const generateFromNote = vi.fn(async (..._args: unknown[]) => 'nota')
const generateAta = vi.fn(async (..._args: unknown[]) => undefined)
const startNewContent = vi.fn(async (..._args: unknown[]) => null)
const REAL = useJobsStore.getState()

beforeEach(() => {
  installBlobShim()
  installFetch(() => new Response('{}'))
  generateFromNote.mockClear()
  generateAta.mockClear()
  startNewContent.mockClear()
  useJobsStore.setState({ jobs: [], generateFromNote, generateAta, startNewContent } as never)
  catalog()
})

afterEach(() => {
  useJobsStore.setState({ generateFromNote: REAL.generateFromNote, generateAta: REAL.generateAta, startNewContent: REAL.startNewContent })
  vi.unstubAllGlobals()
})

describe('"Gerar desta entrada"', () => {
  async function open(sidecar: FileSidecar, defaultModel?: string) {
    seed([sidecar], defaultModel)
    render(
      <MemoryRouter>
        <GenerateEntryDialog fileId="e" />
      </MemoryRouter>,
    )
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
  }
  const goal = (name: string) => fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${name}`) }))
  const go = () => fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))

  // in the Ata of a video the two ways are others (FR-072, entry-page.test.tsx); Aula and Explicação keep these three
  it('numa Aula de um vídeo pergunta, e com um modelo que ouve vem "Só o vídeo", como hoje', async () => {
    await open(entrada(VIDEO))
    goal('Aula')
    expect(within(field()).getAllByRole('radio').map(item => item.querySelector('b')!.textContent)).toEqual(['Só o vídeo', 'Só a transcrição', 'Transcrição + vídeo'])
    expect(checked()).toEqual(['Só o vídeo'])
    expect(radio('Só o vídeo')).toHaveAttribute('aria-disabled', 'false')
  })

  it('o modelo que não ouve: vem "Só a transcrição", e as outras ficam visíveis, desligadas, dizendo por quê', async () => {
    await open(entrada(VIDEO), DEAF.uid)
    goal('Aula')
    expect(checked()).toEqual(['Só a transcrição'])
    for (const name of ['Só o vídeo', 'Transcrição + vídeo']) {
      expect(radio(name)).toHaveAttribute('aria-disabled', 'true')
      expect(radio(name)).toHaveTextContent('não ouve a mídia')
      fireEvent.click(radio(name))
    }
    expect(checked()).toEqual(['Só a transcrição'])
  })

  it('trocar para um modelo que não ouve tira a escolha da mídia', async () => {
    await open(entrada(VIDEO))
    goal('Aula')
    fireEvent.click(radio('Transcrição + vídeo'))
    expect(checked()).toEqual(['Transcrição + vídeo'])
    pickModel(DEAF.uid)
    expect(checked()).toEqual(['Só a transcrição'])
    go()
    expect(generateFromNote.mock.calls[0][5]).toBeUndefined()
  })

  it('sem a mídia guardada, só a transcrição, dizendo por quê', async () => {
    await open(entrada({ ...VIDEO, storage: 'none', storedFileId: undefined }, { kept: 'registro' }))
    goal('Aula')
    expect(checked()).toEqual(['Só a transcrição'])
    expect(radio('Só o vídeo')).toHaveAttribute('aria-disabled', 'true')
    expect(radio('Só o vídeo')).toHaveTextContent('Guardado só como registro')
  })

  it('o que foi marcado vai na Ata e nas notas; na Ata vai sempre o que a janela mostra', async () => {
    await open(entrada(VIDEO))
    go()
    expect(generateAta.mock.calls[0][7]).toBe('transcricao')
    generateAta.mockClear()
    fireEvent.click(radio('Tudo numa chamada'))
    go()
    expect(generateAta.mock.calls[0][7]).toBe('video')
    goal('Aula')
    fireEvent.click(radio('Só a transcrição'))
    go()
    expect(generateFromNote).toHaveBeenLastCalledWith('e', 'lesson', HEARS.uid, { folderId: null }, '', 'transcricao')
  })

  it('não aparece ao pedir a transcrição', async () => {
    await open(entrada(VIDEO))
    goal('Refazer a transcrição')
    noField()
  })

  it.each([
    ['áudio', AUDIO],
    ['PDF', PDF],
  ])('em %s não pergunta', async (_name, origin) => {
    await open(entrada(origin))
    noField()
  })
})

describe('Novo conteúdo', () => {
  async function open(file: File, defaultModel?: string) {
    seed([], defaultModel)
    render(
      <MemoryRouter>
        <NewContentDialog />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Arquivo/ }))
    fireEvent.change(document.getElementById('nc-file') as HTMLInputElement, { target: { files: [file] } })
    await screen.findByText('O que guardar da fonte')
  }
  const video = () => new File(['x'], 'aula.mp4', { type: 'video/mp4' })
  const start = () => fireEvent.click(screen.getByRole('button', { name: 'Gerar aula' }))

  it('um vídeo pergunta, e o modelo que ouve vem com "Só o vídeo"; sem marcar, o pedido vai como hoje', async () => {
    await open(video())
    await waitFor(() => expect(checked()).toEqual(['Só o vídeo']))
    start()
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).not.toHaveProperty('analyze')
  })

  it('o que foi marcado vai no pedido', async () => {
    await open(video())
    await waitFor(() => expect(checked()).toEqual(['Só o vídeo']))
    fireEvent.click(radio('Transcrição + vídeo'))
    start()
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ analyze: 'ambos' })
  })

  it('o modelo que não ouve: "Só a transcrição", e as outras desligadas, dizendo por quê', async () => {
    await open(video(), DEAF.uid)
    await waitFor(() => expect(checked()).toEqual(['Só a transcrição']))
    expect(radio('Só o vídeo')).toHaveAttribute('aria-disabled', 'true')
    expect(radio('Só o vídeo')).toHaveTextContent('não ouve a mídia')
  })

  it('a Ata de um vídeo tem as duas formas (passo a passo e tudo numa chamada) e os modelos por passo; Aula e Explicação seguem como antes', async () => {
    await open(video())
    await waitFor(() => expect(checked()).toEqual(['Só o vídeo']))
    expect(screen.queryByRole('group', { name: 'Modelos por passo' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /^Ata/ }))
    expect(within(field()).getAllByRole('radio').map(item => item.querySelector('b')!.textContent)).toEqual(['Transcrição + quadros do vídeo', 'Tudo numa chamada'])
    expect(checked()).toEqual(['Transcrição + quadros do vídeo'])
    expect(screen.getByRole('group', { name: 'Modelos por passo' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar ata' }))
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ agent: 'meeting', analyze: 'transcricao', models: { write: HEARS.uid } })
    expect(startNewContent.mock.calls[0][0]).not.toHaveProperty('models.everyStep')
  })

  it('"Tudo numa chamada" na Ata vai no pedido e some os modelos por passo', async () => {
    await open(video())
    await waitFor(() => expect(checked()).toEqual(['Só o vídeo']))
    fireEvent.click(screen.getByRole('radio', { name: /^Ata/ }))
    fireEvent.click(radio('Tudo numa chamada'))
    expect(screen.queryByRole('group', { name: 'Modelos por passo' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Gerar ata' }))
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ agent: 'meeting', analyze: 'video' })
  })

  describe('a caixa "o modelo de vídeo também escreve o documento"', () => {
    const BOX = 'O modelo de vídeo (Omni · OpenRouter) também escreve o documento'

    it('numa Aula de um vídeo volta como era: marcada, o modelo de vídeo escreve e o pedido diz isso', async () => {
      await open(video(), DEAF.uid)
      await waitFor(() => expect(checked()).toEqual(['Só a transcrição']))
      expect(screen.getByLabelText('Modelo da IA')).toHaveValue(DEAF.uid)
      fireEvent.click(screen.getByLabelText(BOX))
      expect(screen.getByLabelText('Modelo da IA')).toBeDisabled()
      // the video model hears the media: "Só o vídeo" opens
      await waitFor(() => expect(checked()).toEqual(['Só o vídeo']))
      start()
      await waitFor(() => expect(startNewContent).toHaveBeenCalled())
      expect(startNewContent.mock.calls[0][0]).toMatchObject({ agent: 'lesson', models: { write: HEARS.uid, everyStep: true } })
    })

    it('sem marcar, o pedido vai com o "Modelo da IA" e sem a marca', async () => {
      await open(video(), DEAF.uid)
      // as in the test above: the box comes once the dialog has read the video and the models
      await waitFor(() => expect(checked()).toEqual(['Só a transcrição']))
      expect(await screen.findByLabelText(BOX)).not.toBeChecked()
      fireEvent.click(screen.getByLabelText(BOX))
      fireEvent.click(screen.getByLabelText(BOX))
      expect(screen.getByLabelText('Modelo da IA')).toBeEnabled()
      start()
      await waitFor(() => expect(startNewContent).toHaveBeenCalled())
      expect(startNewContent.mock.calls[0][0]).toMatchObject({ agent: 'lesson', models: { write: DEAF.uid } })
      expect(startNewContent.mock.calls[0][0]).not.toHaveProperty('models.everyStep')
    })

    it('na Ata de um vídeo não existe', async () => {
      await open(video(), DEAF.uid)
      fireEvent.click(screen.getByRole('radio', { name: /^Ata/ }))
      expect(screen.queryByLabelText(/também escreve o documento/)).not.toBeInTheDocument()
    })
  })

  it('"Só guardar para ler" não pergunta', async () => {
    await open(video())
    await waitFor(() => expect(checked()).toEqual(['Só o vídeo']))
    fireEvent.click(screen.getByRole('radio', { name: /Só guardar para ler/ }))
    noField()
  })

  it.each([
    ['áudio', () => new File(['x'], 'aula.mp3', { type: 'audio/mpeg' })],
    ['texto', () => new File(['x'], 'notas.txt', { type: 'text/plain' })],
  ])('%s não pergunta', async (_name, file) => {
    await open(file())
    noField()
  })
})

describe('Novo conteúdo: a pasta', () => {
  it('é o campo com "Trocar" do seletor novo, e a pasta escolhida vai no pedido', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    seed([])
    useLibraryStore.setState({ folders: [newFolderMeta({ id: 'atas', name: 'Atas' })] })
    render(
      <MemoryRouter>
        <NewContentDialog />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('combobox', { name: 'Pasta' })).not.toBeInTheDocument()
    const folder = screen.getByRole('group', { name: 'Pasta' })
    fireEvent.click(within(folder).getByRole('button', { name: 'Trocar' }))
    const chooser = screen.getByRole('dialog', { name: 'Escolher pasta' })
    fireEvent.click(within(chooser).getByRole('treeitem', { name: /Atas/ }))
    fireEvent.click(within(chooser).getByRole('button', { name: 'Usar esta pasta' }))
    fireEvent.click(screen.getByRole('button', { name: /Texto/ }))
    fireEvent.change(screen.getByLabelText('Texto'), { target: { value: 'Um texto bem maior que dez letras.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar aula' }))
    await waitFor(() => expect(startNewContent).toHaveBeenCalled())
    expect(startNewContent.mock.calls[0][0]).toMatchObject({ folderId: 'atas' })
  })
})

describe('"Gerar de novo"', () => {
  it('volta com o que a IA analisou da última vez', async () => {
    const source = entrada(VIDEO)
    const before = newSidecar(newFileMeta({ id: 'a', name: 'Aula: x', type: 'class', parentFileId: 'e', origin: { input: 'text', name: 'x', storage: 'none' }, made: { at: stamp.at, analyze: 'ambos' }, created: stamp, updated: stamp }))
    seed([source, before])
    render(
      <MemoryRouter>
        <GenerateDialog fileId="e" agent="lesson" again="a" />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    expect(generateFromNote.mock.calls[0][5]).toBe('ambos')
  })
})
