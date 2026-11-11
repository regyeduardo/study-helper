import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { ArtifactSummary, FileMeta, FileSidecar, FolderMeta, RecordingData, SourceMeta } from '@/types/domain'
import { GenerateEntryDialog } from '@/components/dialogs/GenerateEntryDialog'
import { EntryPage } from '@/components/reader/EntryPage'
import { useViewRoute } from '@/hooks/use-view-route'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { paths } from '@/lib/paths'
import type { LocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import { ColumnsWorkspace } from '@/pages/workspace/container/columns'
import { CommandsWorkspace } from '@/pages/workspace/container/commands'
import { FocusWorkspace } from '@/pages/workspace/container/focus'
import { ReaderWorkspace } from '@/pages/workspace/container/reader'
import { type Job, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import { installBlobShim } from '@/test/imports/blob-shim'

const MB = 1024 * 1024
const day = (iso: string) => ({ at: iso, deviceId: 'd1', deviceName: 'Notebook' })
const CREATED = day('2026-11-03T12:00:00.000Z')

const VIDEO: SourceMeta = { input: 'file', name: 'kickoff.mp4', sizeBytes: 184 * MB, mime: 'video/mp4', durationSeconds: 52 * 60, storage: 'drive', storedFileId: 'drv-video', expiresAt: null }
const RECORDING: RecordingData = {
  blocks: [
    { speaker: 's1', start: 12, end: 20, text: 'Vamos revisar o cronograma antes de fechar o contrato.' },
    { speaker: 's2', start: 100, end: 110, text: 'O fornecedor pediu mais duas semanas.' },
  ],
  speakers: [
    { id: 's1', name: 'Marina', suggested: false },
    { id: 's2', name: 'Rafael', suggested: false },
  ],
  marks: [],
}
const PDF: SourceMeta = { input: 'file', name: 'contrato.pdf', sizeBytes: 2 * MB, mime: 'application/pdf', storage: 'drive', storedFileId: 'drv-pdf', expiresAt: null }
const LINK: SourceMeta = { input: 'url', name: 'Guia de juros', url: 'https://exemplo.org/juros', storage: 'none' }
const PASTED: SourceMeta = { input: 'text', name: 'texto colado', storage: 'none' }
const TOPIC: SourceMeta = { input: 'topic', name: 'Orçamento base zero', storage: 'none' }
const AUDIO: SourceMeta = { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', storage: 'none' }
const IN_BROWSER: LocalMedia = { storedName: 'a.webm', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 60, size: 2 * MB, createdAt: CREATED.at, fileIds: ['e'] }
const GONE = '2026-11-05T12:00:00.000Z'
const LONG_AGO = '2026-09-15T12:00:00.000Z'
const noFile = (origin: SourceMeta): SourceMeta => ({ ...origin, storage: 'none', storedFileId: undefined })

const art = (id: string, name: string, kind: ArtifactSummary['kind'] = 'mapa'): ArtifactSummary => ({ id, kind, name, updatedAt: CREATED.at })

let aurora: FolderMeta
let atas: FolderMeta
let trabalho: FolderMeta

function item(id: string, fields: Partial<FileMeta> = {}): FileSidecar {
  return newSidecar(newFileMeta({ id, name: id, type: 'class', created: CREATED, updated: CREATED, ...fields }))
}

function entrada(id: string, name: string, origin: SourceMeta | null, fields: Partial<FileMeta> = {}): FileSidecar {
  return item(id, { name, role: 'entrada', kept: 'arquivo', type: 'reading', origin, folderId: aurora.id, ...fields })
}

function withTranscript(sidecar: FileSidecar): FileSidecar {
  return { ...sidecar, transcript: 'Marina: vamos revisar o cronograma.', recording: RECORDING }
}

/** What was born of `id`: ata (Atas, 2 artefatos) with a child explicacao (Trabalho), and one in the Lixeira. */
function family(id: string): FileSidecar[] {
  return [
    item('ata', { name: 'Ata do kickoff', type: 'meeting', parentFileId: id, folderId: atas.id, artifacts: [art('m1', 'Decisões do cronograma'), art('c1', 'Prazos e responsáveis', 'cartoes')] }),
    item('explicacao', { name: 'Explicação: caminho crítico', type: 'explanation', parentFileId: 'ata', folderId: trabalho.id }),
    item('antiga', { name: 'Nota apagada', parentFileId: id, folderId: trabalho.id, deletedAt: '2026-11-01T10:00:00.000Z' }),
  ]
}

function seed(sidecars: FileSidecar[], contents: Record<string, string> = {}, localMedia: LocalMedia[] = [], sources: Record<string, Blob> = {}) {
  const kept = new Map(sidecars.map(sidecar => [sidecar.meta.id, sidecar]))
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async (id: string) => contents[id] ?? '',
    readSidecar: async (id: string) => kept.get(id)!,
    saveFile: async (saved: FileSidecar, content?: string) => {
      kept.set(saved.meta.id, saved)
      if (content !== undefined) contents[saved.meta.id] = content
      return saved
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
    getSource: async (ref: string) => sources[ref],
  } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [aurora, atas, trabalho], files: sidecars.map(sidecar => sidecar.meta), index: defaultIndex(), opened: {}, openedAt: {}, localMedia, sharedView: null, sizes: {} })
}

function renderEntry(id: string, props: Partial<Parameters<typeof EntryPage>[0]> = {}) {
  return render(
    <MemoryRouter>
      <EntryPage fileId={id} {...props} />
    </MemoryRouter>,
  )
}

const card = (name: string) => screen.getByRole('region', { name })
const noPlayer = () => expect(screen.queryByRole('region', { name: 'Player da gravação' })).not.toBeInTheDocument()
const metaLine = (kind: string) => screen.getByText(kind).parentElement!.textContent
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }))

beforeEach(() => {
  aurora = newFolderMeta({ id: 'aurora', name: 'Projeto Aurora' })
  atas = newFolderMeta({ id: 'atas', name: 'Atas' })
  trabalho = newFolderMeta({ id: 'trabalho', name: 'Trabalho' })
  useUiStore.setState({ overlay: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
})

const REAL_JOBS = useJobsStore.getState()

afterEach(() => {
  useJobsStore.setState({ generateFromNote: REAL_JOBS.generateFromNote, generateAta: REAL_JOBS.generateAta, transcribeNote: REAL_JOBS.transcribeNote, generatePending: REAL_JOBS.generatePending })
  vi.unstubAllGlobals()
})

describe('cabeçalho', () => {
  it('mostra o nome e a linha "Entrada · tipo · pasta · data · nível"', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    renderEntry('video')
    expect(screen.getByRole('heading', { level: 1, name: 'Reunião de kickoff.mp4' })).toBeInTheDocument()
    const line = metaLine('Entrada · Vídeo')
    expect(line).toContain('Projeto Aurora')
    expect(line).toContain('03/11/2026')
    expect(line).toContain('Registro e arquivo')
  })

  it('"Gerar desta entrada" abre a janela de gerar', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO), ...family('video')])
    renderEntry('video')
    fireEvent.click(screen.getByRole('button', { name: 'Gerar desta entrada' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate-entry', fileId: 'video' })
  })

  it('"Apagar…" abre o apagar em família, que também confirma quando não há descendentes', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO), ...family('video'), entrada('sozinha', 'Sozinha.pdf', PDF)])
    const first = renderEntry('video')
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apagar…' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'delete-family', fileId: 'video' })
    first.unmount()
    renderEntry('sozinha')
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apagar…' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'delete-family', fileId: 'sozinha' })
  })

  it('depois de apagada, a página volta para a pasta da entrada', async () => {
    function Where() {
      return <span data-testid="where">{useLocation().pathname}</span>
    }
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    render(
      <MemoryRouter initialEntries={['/entrada/video']}>
        <EntryPage fileId="video" />
        <Where />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('where')).toHaveTextContent('/entrada/video')
    act(() => useLibraryStore.setState(state => ({ files: state.files.map(file => ({ ...file, deletedAt: GONE })) })))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(paths.folder('aurora')))
  })

  it('Renomear e Mover para… abrem as janelas que já existem', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    renderEntry('video')
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'rename', target: 'file', id: 'video' })
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para…' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'move', fileIds: ['video'], folderIds: [] })
  })

  it('"Apagar só a mídia…" pede confirmação e apaga só a mídia', async () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    const removeMedia = vi.fn(async () => undefined)
    useLibraryStore.setState({ removeMedia })
    renderEntry('video')
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apagar só a mídia…' }))
    const overlay = useUiStore.getState().overlay
    expect(overlay).toMatchObject({ kind: 'confirm', ok: 'Apagar só a mídia', danger: true })
    expect(removeMedia).not.toHaveBeenCalled()
    await (overlay as Extract<typeof overlay, { kind: 'confirm' }>).onConfirm()
    expect(removeMedia).toHaveBeenCalledWith('video')
  })

  it('"Apagar só a mídia…" só existe em mídia com a mídia guardada', () => {
    const cases = [
      entrada('pdf', 'Contrato.pdf', { input: 'file', name: 'contrato.pdf', mime: 'application/pdf', storage: 'drive', storedFileId: 'drv-pdf' }),
      entrada('apagada', 'Apagada.mp4', { ...VIDEO, storedFileId: undefined, removedAt: '2026-11-05T12:00:00.000Z' }),
      entrada('registro', 'Registro.mp4', { ...VIDEO, storage: 'none', storedFileId: undefined }, { kept: 'registro' }),
    ]
    seed(cases)
    for (const entry of cases) {
      const { unmount } = renderEntry(entry.meta.id)
      openMenu()
      expect(screen.queryByRole('menuitem', { name: 'Apagar só a mídia…' })).not.toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Apagar…' })).toBeInTheDocument()
      unmount()
    }
  })

  it('no compartilhado, só leitura: sem gerar e sem o menu', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    useLibraryStore.setState({ sharedView: { item: { files: [] } as never, rootId: null } })
    renderEntry('video')
    expect(screen.queryByRole('button', { name: 'Gerar desta entrada' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mais ações' })).not.toBeInTheDocument()
  })
})

describe('Original conforme o tipo', () => {
  it('vídeo guardado no Drive: o player e onde está guardado', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    renderEntry('video')
    const original = within(card('Original'))
    expect(original.getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    expect(original.getByText('Google Drive')).toBeInTheDocument()
    expect(original.getByText(/52 min/)).toBeInTheDocument()
  })

  it('áudio guardado só neste navegador: o player e "Só neste navegador"', () => {
    const local: LocalMedia = { storedName: 'a.webm', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 60, size: 2 * MB, createdAt: CREATED.at, fileIds: ['audio'] }
    seed([entrada('audio', 'Gravação da aula 3.webm', { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', storage: 'none' })], {}, [local])
    renderEntry('audio')
    expect(metaLine('Entrada · Áudio')).toBeTruthy()
    const original = within(card('Original'))
    expect(original.getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    expect(original.getByText('Só neste navegador')).toBeInTheDocument()
    expect(original.getByRole('button', { name: 'Salvar no meu Drive' })).toBeInTheDocument()
  })

  it('PDF guardado: o arquivo, o tamanho e como abrir, sem player e sem transcrição', () => {
    seed([entrada('pdf', 'Contrato de serviços.pdf', { input: 'file', name: 'contrato.pdf', sizeBytes: 2 * MB, mime: 'application/pdf', storage: 'drive', storedFileId: 'drv-pdf' })])
    renderEntry('pdf')
    expect(metaLine('Entrada · PDF')).toBeTruthy()
    const original = within(card('Original'))
    expect(original.getByText('contrato.pdf')).toBeInTheDocument()
    expect(original.getByText('2 MB')).toBeInTheDocument()
    expect(original.getByRole('button', { name: 'Baixar o arquivo' })).toBeInTheDocument()
    noPlayer()
    expect(screen.queryByRole('region', { name: 'Transcrição' })).not.toBeInTheDocument()
  })

  it('link em "Só o registro": nome, link e origem, sem player', () => {
    seed([entrada('link', 'Guia de juros compostos', { input: 'url', name: 'Guia de juros', url: 'https://exemplo.org/juros', storage: 'none' }, { kept: 'registro' })])
    renderEntry('link')
    expect(metaLine('Entrada · Link')).toContain('Só o registro')
    const original = within(card('Original'))
    expect(original.getByText('Guia de juros')).toBeInTheDocument()
    expect(original.getByRole('link', { name: 'exemplo.org/juros' })).toHaveAttribute('href', 'https://exemplo.org/juros')
    expect(original.getByText('Veio de')).toBeInTheDocument()
    expect(original.getByText('Novo conteúdo, link')).toBeInTheDocument()
    noPlayer()
  })

  it('texto colado: o próprio texto, que fica no conteúdo da entrada', async () => {
    seed([entrada('texto', 'Texto colado · 06/11', { input: 'text', name: 'texto colado', storage: 'none' }, { kept: 'registro', words: 8 })], { texto: 'A inflação de serviços segue acima da média.' })
    renderEntry('texto')
    expect(metaLine('Entrada · Texto colado')).toBeTruthy()
    expect(await within(card('Original')).findByText('A inflação de serviços segue acima da média.')).toBeInTheDocument()
    expect(within(card('Original')).getByText('8 palavras')).toBeInTheDocument()
    noPlayer()
  })

  it('tema: o tema escrito, sem arquivo', () => {
    seed([entrada('tema', 'Tema: orçamento base zero', { input: 'topic', name: 'Orçamento base zero', storage: 'none' }, { kept: 'registro' })])
    renderEntry('tema')
    expect(metaLine('Entrada · Tema')).toBeTruthy()
    const original = within(card('Original'))
    expect(original.getByText('Orçamento base zero')).toBeInTheDocument()
    expect(original.getByText(/Não há arquivo/)).toBeInTheDocument()
    noPlayer()
  })
})

describe('Transcrição', () => {
  it('em mídia, é um card próprio entre o original e a árvore, marcado como parte da mídia', async () => {
    seed([withTranscript(entrada('video', 'Reunião de kickoff.mp4', VIDEO))])
    renderEntry('video')
    const trans = within(card('Transcrição'))
    expect(await trans.findByText('Vamos revisar o cronograma antes de fechar o contrato.')).toBeInTheDocument()
    expect(trans.getByText('Marina')).toBeInTheDocument()
    expect(trans.getByText('Faz parte da mídia')).toBeInTheDocument()
    expect(screen.getAllByRole('region').filter(region => region.tagName === 'SECTION' && region.classList.contains('ep-card')).map(region => region.getAttribute('aria-label'))).toEqual(['Original', 'Transcrição', 'O que nasceu daqui'])
  })

  it('clicar no nome de quem fala abre o campo e troca o nome em todas as falas, sem tocar o trecho', async () => {
    seed([withTranscript(entrada('video', 'Reunião de kickoff.mp4', VIDEO))])
    renderEntry('video')
    const trans = within(card('Transcrição'))
    fireEvent.click(await trans.findByRole('button', { name: 'Renomear Marina' }))
    const field = trans.getByRole('textbox', { name: 'Nome do falante' })
    fireEvent.change(field, { target: { value: 'Marina Costa' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await trans.findByText('Marina Costa')).toBeInTheDocument()
    const saved = await useLibraryStore.getState().repo!.readSidecar('video')
    expect(saved.recording?.speakers.find(speaker => speaker.id === 's1')?.name).toBe('Marina Costa')
    expect(saved.transcript).toContain('Marina Costa')
  })

  it('com transcrição, "Refazer a transcrição" abre a mesma janela de transcrever do zero', async () => {
    seed([withTranscript(entrada('video', 'Reunião de kickoff.mp4', VIDEO))])
    renderEntry('video')
    const trans = within(card('Transcrição'))
    fireEvent.click(await trans.findByRole('button', { name: 'Refazer a transcrição' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'transcribe', fileId: 'video' })
  })

  it('transcrição só em texto também pode ser refeita do zero', async () => {
    seed([{ ...entrada('video', 'Seminário.mp4', VIDEO), transcript: 'No seminário a turma resolveu o exercício 3.' }])
    renderEntry('video')
    fireEvent.click(await within(card('Transcrição')).findByRole('button', { name: 'Refazer a transcrição' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'transcribe', fileId: 'video' })
  })

  it('transcrição só em texto, sem falas: mostra o texto', async () => {
    seed([{ ...entrada('video', 'Seminário.mp4', VIDEO), transcript: 'No seminário a turma resolveu o exercício 3.' }])
    renderEntry('video')
    expect(await within(card('Transcrição')).findByText('No seminário a turma resolveu o exercício 3.')).toBeInTheDocument()
  })

  it('sem transcrição: avisa e oferece transcrever', async () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    renderEntry('video')
    const trans = within(card('Transcrição'))
    expect(await trans.findByText('Sem transcrição ainda')).toBeInTheDocument()
    fireEvent.click(trans.getByRole('button', { name: 'Transcrever' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'transcribe', fileId: 'video' })
  })
})

describe('entrada que não existe', () => {
  it('diz que não achou e leva de volta para a lista', () => {
    seed([])
    renderEntry('sumiu')
    expect(screen.getByText('Entrada não encontrada.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ver as entradas' })).toHaveAttribute('href', paths.entries)
  })
})

describe('quando a mídia não está mais lá', () => {
  it('"Só o registro" de mídia: nome e origem, sem player; a transcrição fica', async () => {
    seed([withTranscript(entrada('video', 'Reunião de kickoff.mp4', { ...VIDEO, storage: 'none', storedFileId: undefined }, { kept: 'registro' }))])
    renderEntry('video')
    expect(metaLine('Entrada · Vídeo')).toContain('Só o registro')
    const original = within(card('Original'))
    expect(original.getByText('kickoff.mp4')).toBeInTheDocument()
    expect(original.getByText('Veio de')).toBeInTheDocument()
    expect(original.getByText('Novo conteúdo, arquivo')).toBeInTheDocument()
    noPlayer()
    expect(await within(card('Transcrição')).findByText('Vamos revisar o cronograma antes de fechar o contrato.')).toBeInTheDocument()
  })

  it('mídia apagada: a entrada fica com a transcrição e as notas e diz que a mídia foi apagada', async () => {
    seed([withTranscript(entrada('video', 'Reunião de kickoff.mp4', { ...VIDEO, storedFileId: undefined, removedAt: '2026-11-05T12:00:00.000Z' })), ...family('video')])
    renderEntry('video')
    const original = within(card('Original'))
    expect(original.getByText('Mídia apagada em 05/11/2026')).toBeInTheDocument()
    expect(original.getByText(/A transcrição e as notas continuam aqui/)).toBeInTheDocument()
    noPlayer()
    expect(await within(card('Transcrição')).findByText('O fornecedor pediu mais duas semanas.')).toBeInTheDocument()
    expect(within(card('O que nasceu daqui')).getByRole('link', { name: 'Ata do kickoff' })).toBeInTheDocument()
  })

  it('apagada e sem transcrição: não oferece transcrever, porque não há o que ouvir', async () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', { ...VIDEO, storedFileId: undefined, removedAt: '2026-11-05T12:00:00.000Z' })])
    renderEntry('video')
    const trans = within(card('Transcrição'))
    expect(await trans.findByText('Sem transcrição ainda')).toBeInTheDocument()
    expect(trans.queryByRole('button', { name: 'Transcrever' })).not.toBeInTheDocument()
  })

  it.each([
    ['transcrição e notas', true, true, 'O vídeo foi apagado para liberar espaço. A transcrição e as notas continuam aqui.'],
    ['só a transcrição', true, false, 'O vídeo foi apagado para liberar espaço. A transcrição continua aqui.'],
    ['só as notas', false, true, 'O vídeo foi apagado para liberar espaço. As notas continuam aqui.'],
    ['nada', false, false, 'O vídeo foi apagado para liberar espaço.'],
  ])('mídia apagada, com %s: só diz que continua o que existe', async (_case, transcribed, notes, text) => {
    const gone = entrada('video', 'Reunião de kickoff.mp4', { ...VIDEO, storedFileId: undefined, removedAt: GONE })
    seed([transcribed ? withTranscript(gone) : gone, ...(notes ? family('video') : [])])
    renderEntry('video')
    const original = within(card('Original'))
    await waitFor(() => expect(useLibraryStore.getState().opened.video).toBeDefined())
    expect(await original.findByText(text)).toBeInTheDocument()
  })

  it('arquivo temporário vencido e nada feito dele: não diz que algo continua', async () => {
    seed([entrada('video', 'Palestra.mp4', { ...VIDEO, storedFileId: undefined, storedUrl: 'https://x/y.mp4', storage: 'litterbox', expiresAt: GONE })])
    renderEntry('video')
    await waitFor(() => expect(useLibraryStore.getState().opened.video).toBeDefined())
    expect(await within(card('Original')).findByText('O vídeo saiu do serviço temporário.')).toBeInTheDocument()
  })

  it('só como registro, sem transcrição e sem notas: não diz que algo continua', async () => {
    seed([entrada('video', 'Reunião.mp4', noFile(VIDEO), { kept: 'registro' })])
    renderEntry('video')
    await waitFor(() => expect(useLibraryStore.getState().opened.video).toBeDefined())
    expect(await within(card('Original')).findByText('Guardado só como registro: o arquivo não foi copiado.')).toBeInTheDocument()
  })

  it('PDF apagado sem notas: não diz que as notas continuam', () => {
    seed([entrada('pdf', 'contrato.pdf', { ...PDF, storedFileId: undefined, removedAt: GONE })])
    renderEntry('pdf')
    expect(within(card('Original')).getByText('O arquivo foi apagado para liberar espaço.')).toBeInTheDocument()
  })

  it('sem o arquivo e sem transcrição: não promete uma transcrição que não dá para fazer', async () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', { ...VIDEO, storedFileId: undefined, removedAt: GONE })])
    renderEntry('video')
    const trans = within(card('Transcrição'))
    expect(await trans.findByText('Sem o arquivo, não dá para transcrever.')).toBeInTheDocument()
    expect(trans.queryByText('Ela fica junto da mídia quando for feita.')).not.toBeInTheDocument()
  })

  it('arquivo temporário vencido: diz que expirou e o resto continua', async () => {
    seed([withTranscript(entrada('video', 'Treinamento.mp4', { ...VIDEO, storage: 'litterbox', storedFileId: undefined, storedUrl: 'https://litter.example/x.mp4', expiresAt: '2026-09-15T12:00:00.000Z' })), ...family('video')])
    renderEntry('video')
    const original = within(card('Original'))
    expect(original.getByText('O arquivo temporário expirou em 15/09/2026')).toBeInTheDocument()
    noPlayer()
    expect(await within(card('Transcrição')).findByText('O fornecedor pediu mais duas semanas.')).toBeInTheDocument()
    expect(within(card('O que nasceu daqui')).getByRole('link', { name: 'Ata do kickoff' })).toBeInTheDocument()
  })

  it('vencido no host, mas ainda neste navegador: toca daqui', () => {
    const local: LocalMedia = { storedName: 'x.mp4', name: 'x.mp4', mime: 'video/mp4', durationSeconds: 60, size: 2 * MB, createdAt: CREATED.at, fileIds: ['video'] }
    seed([entrada('video', 'Treinamento.mp4', { ...VIDEO, storage: 'litterbox', storedFileId: undefined, storedUrl: 'https://litter.example/x.mp4', expiresAt: '2026-09-15T12:00:00.000Z' })], {}, [local])
    renderEntry('video')
    expect(within(card('Original')).getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    expect(within(card('Original')).queryByText(/expirou/)).not.toBeInTheDocument()
  })
})

describe('rolagem', () => {
  it('a página não rola e cada card rola por dentro', () => {
    seed([withTranscript(entrada('video', 'Reunião de kickoff.mp4', VIDEO)), ...family('video')])
    const { container } = renderEntry('video')
    expect(getComputedStyle(container.querySelector('.entry-page')!).overflow).toBe('hidden')
    for (const name of ['Original', 'Transcrição', 'O que nasceu daqui']) {
      const body = card(name).querySelector('.ep-card-body')
      expect(body, name).not.toBeNull()
      expect(getComputedStyle(body!).overflow, name).toBe('auto')
    }
  })
})

describe('"O que nasceu daqui"', () => {
  it('mostra todos os descendentes, de qualquer pasta, com a pasta de cada um e a contagem', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO), ...family('video')])
    renderEntry('video')
    const tree = within(card('O que nasceu daqui'))
    expect(tree.getByText('2 notas · 2 artefatos')).toBeInTheDocument()
    expect(tree.getByRole('link', { name: 'Ata do kickoff' })).toHaveAttribute('href', paths.file('ata'))
    expect(tree.getByRole('link', { name: 'Explicação: caminho crítico' })).toHaveAttribute('href', paths.file('explicacao'))
    expect(tree.getByText('Atas')).toBeInTheDocument()
    expect(tree.getByText('Trabalho')).toBeInTheDocument()
    expect(tree.queryByText('Nota apagada')).not.toBeInTheDocument()
  })

  it('a filha de uma nota aparece dentro da nota, e os artefatos ficam na nota deles', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO), ...family('video')])
    renderEntry('video')
    const ata = within(within(card('O que nasceu daqui')).getByRole('link', { name: 'Ata do kickoff' }).closest('li')!)
    expect(ata.getByRole('link', { name: 'Explicação: caminho crítico' })).toBeInTheDocument()
    expect(ata.getByRole('link', { name: 'Decisões do cronograma' })).toHaveAttribute('href', paths.file('ata'))
    expect(ata.getByRole('link', { name: 'Prazos e responsáveis' })).toBeInTheDocument()
  })

  it('no singular', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO), item('ata', { name: 'Ata', parentFileId: 'video', artifacts: [art('m1', 'Mapa')] })])
    renderEntry('video')
    expect(within(card('O que nasceu daqui')).getByText('1 nota · 1 artefato')).toBeInTheDocument()
  })

  it('sem nada, com o arquivo e sem transcrição: a dica inclui transcrever', async () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    renderEntry('video')
    expect(await within(card('O que nasceu daqui')).findByText('Gere uma transcrição, uma ata ou uma aula a partir desta gravação.')).toBeInTheDocument()
  })

  it('sem nada e já transcrita: a dica não sugere outra transcrição', async () => {
    seed([withTranscript(entrada('video', 'Reunião de kickoff.mp4', VIDEO))])
    renderEntry('video')
    expect(await within(card('O que nasceu daqui')).findByText('Gere uma ata, uma aula ou uma explicação a partir desta entrada.')).toBeInTheDocument()
  })

  it('sem nada e sem o arquivo: a dica não sugere transcrever', async () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', { ...VIDEO, storedFileId: undefined, removedAt: GONE })])
    renderEntry('video')
    expect(await within(card('O que nasceu daqui')).findByText('Gere uma ata, uma aula ou uma explicação a partir desta entrada.')).toBeInTheDocument()
  })

  it('sem nada: diz que não há notas e oferece gerar', () => {
    seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO)])
    renderEntry('video')
    const tree = within(card('O que nasceu daqui'))
    expect(tree.getByText('Nenhuma nota ainda')).toBeInTheDocument()
    expect(tree.getByText('Nada nasceu daqui ainda')).toBeInTheDocument()
    fireEvent.click(tree.getByRole('button', { name: 'Gerar desta entrada' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate-entry', fileId: 'video' })
  })
})

describe('"O que nasceu daqui": gerando, pronta e falhou', () => {
  const job = (fields: Partial<Job>): Job => ({ id: 'j1', kind: 'generation', title: 'Aula: Reunião', fileId: null, status: 'running', message: 'Escrevendo a aula', fraction: null, error: null, startedAt: 0, ...fields })
  const note = (fields: Partial<FileMeta>) => item('aula', { name: 'Aula: Reunião', parentFileId: 'video', folderId: aurora.id, ...fields })
  const tree = () => within(card('O que nasceu daqui'))

  it('gerando: o nome sem link, "gerando…", o que está fazendo e a barra; já conta na família', () => {
    seed([entrada('video', 'Reunião', VIDEO), note({ status: 'generating' })])
    useJobsStore.setState({ jobs: [job({ fileId: 'aula', message: 'Desenhando os diagramas', fraction: 0.38 })] })
    renderEntry('video')
    expect(tree().getByText('Aula: Reunião')).toBeInTheDocument()
    expect(tree().queryByRole('link', { name: 'Aula: Reunião' })).not.toBeInTheDocument()
    expect(tree().getByText('gerando…')).toBeInTheDocument()
    expect(tree().getByText('Desenhando os diagramas')).toBeInTheDocument()
    expect(tree().getByRole('progressbar')).toHaveAttribute('aria-valuenow', '38')
    expect(tree().getByText('1 nota')).toBeInTheDocument()
  })

  it('pronta: vira link e sai o aviso', () => {
    seed([entrada('video', 'Reunião', VIDEO), note({ status: 'ready' })])
    useJobsStore.setState({ jobs: [job({ fileId: 'aula', status: 'done', message: 'Pronta e salva na Biblioteca.' })] })
    renderEntry('video')
    expect(tree().getByRole('link', { name: 'Aula: Reunião' })).toHaveAttribute('href', paths.file('aula'))
    expect(tree().queryByText('gerando…')).not.toBeInTheDocument()
    expect(tree().queryByText('falhou')).not.toBeInTheDocument()
  })

  it('falhou: diz o motivo, sem link, e "Tentar de novo" refaz aquela nota', () => {
    const generatePending = vi.fn(async () => undefined)
    useJobsStore.setState({ generatePending })
    seed([entrada('video', 'Reunião', VIDEO), note({ status: 'pending', pendingExcerpt: 'material' })])
    useJobsStore.setState({ jobs: [job({ fileId: 'aula', status: 'error', message: 'A geração falhou.', error: 'A IA recusou o pedido.' })] })
    renderEntry('video')
    expect(tree().getByText('falhou')).toBeInTheDocument()
    expect(tree().getByRole('alert')).toHaveTextContent('A IA recusou o pedido.')
    expect(tree().queryByRole('link', { name: 'Aula: Reunião' })).not.toBeInTheDocument()
    fireEvent.click(tree().getByRole('button', { name: 'Tentar de novo' }))
    expect(generatePending).toHaveBeenCalledWith('aula')
  })

  it('parou sem terminar (a página foi fechada): falhou, dizendo que o material ficou guardado', () => {
    seed([entrada('video', 'Reunião', VIDEO), note({ status: 'generating', pendingExcerpt: 'material' })])
    renderEntry('video')
    expect(tree().getByText('falhou')).toBeInTheDocument()
    expect(tree().getByRole('alert')).toHaveTextContent('O material ficou guardado')
  })

  it('aula de curso ainda não escrita não é falha: é link, com o aviso', () => {
    const modulo = newFolderMeta({ id: 'modulo', name: 'Módulo', parentId: 'curso' })
    const curso = newFolderMeta({ id: 'curso', name: 'Curso' })
    seed([entrada('video', 'Reunião', VIDEO), note({ status: 'pending', folderId: 'modulo' })])
    useLibraryStore.setState(state => ({ folders: [...state.folders, curso, modulo] }))
    renderEntry('video')
    expect(tree().getByRole('link', { name: 'Aula: Reunião' })).toBeInTheDocument()
    expect(tree().getByText('ainda não escrita')).toBeInTheDocument()
    expect(tree().queryByText('falhou')).not.toBeInTheDocument()
  })

  it('a Ata ainda sem nota aparece pelo trabalho, sem o "nada nasceu daqui"', () => {
    seed([entrada('video', 'Reunião', VIDEO)])
    useJobsStore.setState({ jobs: [job({ fileId: 'video', title: 'Ata: Reunião', message: 'Escrevendo: Resumo' })] })
    renderEntry('video')
    expect(tree().getByText('Ata: Reunião')).toBeInTheDocument()
    expect(tree().getByText('gerando…')).toBeInTheDocument()
    expect(tree().getByText('Escrevendo: Resumo')).toBeInTheDocument()
    expect(tree().queryByText('Nada nasceu daqui ainda')).not.toBeInTheDocument()
  })

  it('a Ata que falhou antes de ter nota diz o motivo e "Tentar de novo" reabre a janela', () => {
    seed([entrada('video', 'Reunião', VIDEO)])
    useJobsStore.setState({ jobs: [job({ fileId: 'video', title: 'Ata: Reunião', status: 'error', message: 'A ata não saiu.', error: 'O modelo não respondeu.' })] })
    renderEntry('video')
    expect(tree().getByText('falhou')).toBeInTheDocument()
    expect(tree().getByRole('alert')).toHaveTextContent('O modelo não respondeu.')
    fireEvent.click(tree().getByRole('button', { name: 'Tentar de novo' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate-entry', fileId: 'video' })
    expect(useJobsStore.getState().jobs).toHaveLength(0)
  })

  it('transcrevendo aparece no card da transcrição, não na árvore', async () => {
    seed([entrada('video', 'Reunião', VIDEO)])
    useJobsStore.setState({ jobs: [job({ kind: 'transcription', fileId: 'video', title: 'Reunião', message: 'Transcrevendo a gravação' })] })
    renderEntry('video')
    const trans = within(card('Transcrição'))
    expect(await trans.findByText('Transcrevendo a gravação')).toBeInTheDocument()
    expect(trans.queryByText('Sem transcrição ainda')).not.toBeInTheDocument()
    expect(tree().queryByText('gerando…')).not.toBeInTheDocument()
    expect(tree().getByText('Nada nasceu daqui ainda')).toBeInTheDocument()
  })

  it('a transcrição que falhou diz o motivo no card', async () => {
    seed([entrada('video', 'Reunião', VIDEO)])
    useJobsStore.setState({ jobs: [job({ kind: 'transcription', fileId: 'video', status: 'error', message: 'A transcrição não saiu.', error: 'Sem saldo no provedor.' })] })
    renderEntry('video')
    expect(await within(card('Transcrição')).findByRole('alert')).toHaveTextContent('Sem saldo no provedor.')
  })
})

describe('"Gerar desta entrada": o que a janela oferece', () => {
  const MINE = { id: 'mine', type: 'custom' as const, name: 'Minha IA', key: 'k', base: 'https://api.exemplo.dev/v1' }
  const A = { uid: 'mine::a', pid: 'mine', mid: 'a', name: 'Modelo A' }

  function withModels() {
    useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, aiConfig: { providers: [MINE], models: [A], defaults: { estudo: A.uid, midia: A.uid }, steps: {} } } } }))
  }

  async function openDialog(id = 'e') {
    withModels()
    render(
      <MemoryRouter>
        <GenerateEntryDialog fileId={id} />
      </MemoryRouter>,
    )
    return screen.findByRole('dialog', { name: 'Gerar desta entrada' })
  }

  const goals = () =>
    within(screen.getByRole('radiogroup', { name: 'O que gerar' }))
      .getAllByRole('radio')
      .map(radio => `${radio.querySelector('b')!.textContent}${radio.getAttribute('aria-checked') === 'true' ? '*' : ''}`)
  const pick = (label: string) => fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${label}`) }))
  const go = () => fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))

  beforeEach(() => {
    installFetch(() => new Response('{}'))
  })

  it.each<[string, () => void, string[]]>([
    ['vídeo com transcrição', () => seed([withTranscript(entrada('e', 'v.mp4', VIDEO))]), ['Ata*', 'Aula', 'Explicação', 'Refazer a transcrição']],
    ['vídeo sem transcrição', () => seed([entrada('e', 'v.mp4', VIDEO)]), ['Transcrever*', 'Ata', 'Aula', 'Explicação']],
    ['áudio só neste navegador, sem transcrição', () => seed([entrada('e', 'a.webm', AUDIO)], {}, [IN_BROWSER]), ['Transcrever*', 'Ata', 'Aula', 'Explicação']],
    ['PDF guardado', () => seed([entrada('e', 'c.pdf', PDF)]), ['Ata*', 'Aula', 'Explicação']],
    ['link', () => seed([entrada('e', 'Guia', LINK, { kept: 'registro' })]), ['Ata*', 'Aula', 'Explicação']],
    ['texto colado', () => seed([entrada('e', 'Texto', PASTED, { kept: 'registro' })], { e: 'Um texto colado aqui.' }), ['Ata*', 'Aula', 'Explicação']],
    ['tema', () => seed([entrada('e', 'Tema', TOPIC, { kept: 'registro' })]), ['Ata*', 'Aula', 'Explicação']],
    ['mídia apagada, com transcrição', () => seed([withTranscript(entrada('e', 'v.mp4', { ...noFile(VIDEO), removedAt: GONE }))]), ['Ata*', 'Aula', 'Explicação']],
    ['mídia só como registro, com transcrição', () => seed([withTranscript(entrada('e', 'v.mp4', noFile(VIDEO), { kept: 'registro' }))]), ['Ata*', 'Aula', 'Explicação']],
    ['arquivo temporário vencido, com transcrição', () => seed([withTranscript(entrada('e', 'v.mp4', { ...VIDEO, storage: 'litterbox', storedFileId: undefined, storedUrl: 'https://l.example/x', expiresAt: LONG_AGO }))]), ['Ata*', 'Aula', 'Explicação']],
  ])('%s', async (_name, arrange, expected) => {
    arrange()
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    expect(goals()).toEqual(expected)
  })

  it.each<[string, () => void, RegExp]>([
    ['um PDF só como registro', () => seed([entrada('e', 'c.pdf', noFile(PDF), { kept: 'registro' })]), /Guardado só como registro/],
    ['um PDF vencido', () => seed([entrada('e', 'c.pdf', { ...PDF, storage: 'litterbox', storedFileId: undefined, storedUrl: 'https://l.example/x', expiresAt: LONG_AGO })]), /expirou/],
    ['um PDF apagado', () => seed([entrada('e', 'c.pdf', { ...noFile(PDF), removedAt: GONE })]), /foi apagado/],
    ['uma mídia só como registro, sem transcrição', () => seed([entrada('e', 'v.mp4', noFile(VIDEO), { kept: 'registro' })]), /não há transcrição/],
    ['uma mídia apagada, sem transcrição', () => seed([entrada('e', 'v.mp4', { ...noFile(VIDEO), removedAt: GONE })]), /foi apagado/],
    ['um texto colado que não foi guardado', () => seed([entrada('e', 'Texto', PASTED, { kept: 'registro' })]), /não foi guardado/],
  ])('não dá para gerar de %s: diz por quê e o botão fica desligado', async (_name, arrange, reason) => {
    arrange()
    const dialog = await openDialog()
    expect(await within(dialog).findByRole('status')).toHaveTextContent(reason)
    expect(screen.queryByRole('radiogroup', { name: 'O que gerar' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Gerar' })).toBeDisabled()
  })

  it('tem Modelo da IA, "Salvar em" com a pasta da entrada e "Trocar", e "Mais opções"', async () => {
    seed([entrada('e', 'c.pdf', PDF)])
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    expect(screen.getByLabelText('Modelo da IA')).toHaveValue(A.uid)
    const saveIn = screen.getByRole('group', { name: 'Salvar em' })
    expect(saveIn).toHaveTextContent('Projeto Aurora')
    expect(within(saveIn).getByRole('button', { name: 'Trocar' })).toBeInTheDocument()
    expect(screen.getByText('Mais opções')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
  })

  it('"Trocar" muda a pasta da nota, e a nota sai filha da entrada na pasta escolhida', async () => {
    const generateFromNote = vi.fn(async () => 'nota')
    useJobsStore.setState({ generateFromNote })
    Element.prototype.scrollIntoView = vi.fn()
    seed([entrada('e', 'c.pdf', PDF)])
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    fireEvent.click(within(screen.getByRole('group', { name: 'Salvar em' })).getByRole('button', { name: 'Trocar' }))
    const chooser = screen.getByRole('dialog', { name: 'Onde salvar a nota nova' })
    fireEvent.click(within(chooser).getByRole('treeitem', { name: /Trabalho/ }))
    fireEvent.click(within(chooser).getByRole('button', { name: 'Usar esta pasta' }))
    expect(screen.getByRole('group', { name: 'Salvar em' })).toHaveTextContent('Trabalho')
    pick('Aula')
    go()
    expect(generateFromNote).toHaveBeenCalledWith('e', 'lesson', A.uid, { folderId: 'trabalho' }, '', undefined)
  })

  it('escolher Aula ou Explicação chama o gerar da entrada, com a instrução; a janela fecha e a página fica', async () => {
    const generateFromNote = vi.fn(async () => 'nota')
    useJobsStore.setState({ generateFromNote })
    useUiStore.setState({ overlay: { kind: 'generate-entry', fileId: 'e' } })
    seed([entrada('e', 'Guia', LINK, { kept: 'registro' })])
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    pick('Explicação')
    fireEvent.change(screen.getByLabelText('Instrução extra para a IA (opcional)'), { target: { value: 'foque nos juros' } })
    go()
    expect(generateFromNote).toHaveBeenCalledWith('e', 'explanation', A.uid, { folderId: 'aurora' }, 'foque nos juros', undefined)
    expect(useUiStore.getState().overlay).toBeNull()
  })

  it('a Ata de uma entrada de texto usa o mesmo gerar', async () => {
    const generateFromNote = vi.fn(async () => 'nota')
    useJobsStore.setState({ generateFromNote })
    seed([entrada('e', 'c.pdf', PDF)])
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    go()
    expect(generateFromNote).toHaveBeenCalledWith('e', 'meeting', A.uid, { folderId: 'aurora' }, '', undefined)
  })

  it('a Ata de uma mídia com falas vai pela Ata em partes, com o Resumo', async () => {
    const generateAta = vi.fn(async () => undefined)
    useJobsStore.setState({ generateAta })
    seed([withTranscript(entrada('e', 'v.mp4', VIDEO))])
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    go()
    expect(generateAta).toHaveBeenCalledWith('e', ['resumo'], undefined, { model: A.uid }, { folderId: 'aurora' }, '', undefined, 'transcricao')
  })

  describe('Modelo da ata', () => {
    const modelPick = () => screen.getByLabelText('Modelo da ata') as HTMLSelectElement
    const parts = () => screen.queryByRole('group', { name: 'Partes da ata' })
    const ask = async (extra: FileSidecar[] = []) => {
      seed([withTranscript(entrada('e', 'v.mp4', VIDEO)), ...extra])
      await openDialog()
      await screen.findByRole('radiogroup', { name: 'O que gerar' })
    }

    it('na Ata oferece o Modelo da ata (Padrão e os 15 modelos) e as partes do Padrão; em Aula, some', async () => {
      await ask()
      expect(within(modelPick()).getAllByRole('option')).toHaveLength(16)
      expect(modelPick().value).toBe('')
      expect(within(modelPick()).getByRole('option', { name: 'Fathom' })).toBeInTheDocument()
      expect(parts()).toBeInTheDocument()
      expect((screen.getByRole('checkbox', { name: 'Resumo' }) as HTMLInputElement).checked).toBe(true)
      pick('Aula')
      expect(screen.queryByLabelText('Modelo da ata')).not.toBeInTheDocument()
      expect(parts()).not.toBeInTheDocument()
    })

    it('um modelo esconde as partes e vai para a Ata sem elas', async () => {
      const generateAta = vi.fn(async () => undefined)
      useJobsStore.setState({ generateAta })
      await ask()
      fireEvent.change(modelPick(), { target: { value: 'fathom' } })
      expect(parts()).not.toBeInTheDocument()
      go()
      expect(generateAta).toHaveBeenCalledWith('e', [], 'fathom', { model: A.uid }, { folderId: 'aurora' }, '', undefined, 'transcricao')
    })

    it('as partes marcadas do Padrão vão na ordem da ata; sem nenhuma, não gera', async () => {
      const generateAta = vi.fn(async () => undefined)
      useJobsStore.setState({ generateAta })
      await ask()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Resumo' }))
      expect(screen.getByRole('button', { name: 'Gerar' })).toBeDisabled()
      expect(screen.getByText('Marque ao menos uma parte.')).toBeInTheDocument()
      const tasks = screen.getByRole('checkbox', { name: 'Levantamento de tarefas' })
      const questions = screen.getByRole('checkbox', { name: /^Perguntas/ })
      fireEvent.click(questions)
      fireEvent.click(tasks)
      go()
      expect(generateAta).toHaveBeenCalledWith('e', ['tarefas', 'perguntas'], undefined, { model: A.uid }, { folderId: 'aurora' }, '', undefined, 'transcricao')
    })

    it('começa no modelo da última Ata feita desta entrada', async () => {
      await ask([item('velha', { name: 'Ata antiga', type: 'meeting', parentFileId: 'e', made: { at: '2026-11-01T10:00:00.000Z', ataModel: 'tldv' } }), item('nova', { name: 'Ata nova', type: 'meeting', parentFileId: 'e', made: { at: '2026-11-05T10:00:00.000Z', ataModel: 'cornell' } })])
      expect(modelPick().value).toBe('cornell')
      expect(parts()).not.toBeInTheDocument()
    })

    it('começa nas partes do Padrão da última Ata feita desta entrada', async () => {
      await ask([item('ata-partes', { name: 'Ata em partes', type: 'meeting', parentFileId: 'e', made: { at: '2026-11-05T10:00:00.000Z', parts: ['tarefas', 'linha'] } })])
      expect(modelPick().value).toBe('')
      expect((screen.getByRole('checkbox', { name: 'Resumo' }) as HTMLInputElement).checked).toBe(false)
      expect((screen.getByRole('checkbox', { name: 'Levantamento de tarefas' }) as HTMLInputElement).checked).toBe(true)
    })

    it('sem Ata desta entrada, começa na última feita em outra', async () => {
      await ask([item('outra', { name: 'Ata de outra', type: 'meeting', parentFileId: 'outra-entrada', made: { at: '2026-11-02T10:00:00.000Z', ataModel: 'read-ai' } })])
      expect(modelPick().value).toBe('read-ai')
    })
  })

  it('a Ata de uma mídia com a transcrição só em texto, sem falas, vai pelo texto', async () => {
    const generateFromNote = vi.fn(async () => 'nota')
    const generateAta = vi.fn(async () => undefined)
    useJobsStore.setState({ generateFromNote, generateAta })
    seed([{ ...entrada('e', 'v.mp4', VIDEO), transcript: 'A turma resolveu o exercício 3.' }], { e: 'A turma resolveu o exercício 3.' })
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    go()
    expect(generateAta).not.toHaveBeenCalled()
    expect(generateFromNote).toHaveBeenCalledWith('e', 'meeting', A.uid, { folderId: 'aurora' }, '', undefined)
  })

  it('Transcrever e Refazer a transcrição não pedem pasta nem instrução: é a transcrição da entrada, com o modelo escolhido', async () => {
    const transcribeNote = vi.fn(async () => undefined)
    useJobsStore.setState({ transcribeNote })
    seed([withTranscript(entrada('e', 'v.mp4', VIDEO))])
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    pick('Refazer a transcrição')
    expect(screen.queryByRole('group', { name: 'Salvar em' })).not.toBeInTheDocument()
    expect(screen.queryByText('Mais opções')).not.toBeInTheDocument()
    go()
    expect(transcribeNote).toHaveBeenCalledWith('e', undefined, A.uid)
  })

  const transcribing = { id: 'j', kind: 'transcription' as const, title: 'v', fileId: 'e', status: 'running' as const, message: '', fraction: null, error: null, startedAt: 0 }

  it('transcrevendo e sem transcrição: diz para esperar, porque a nota depende dela', async () => {
    seed([entrada('e', 'v.mp4', VIDEO)])
    useJobsStore.setState({ jobs: [transcribing] })
    const dialog = await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    pick('Aula')
    expect(within(dialog).getByRole('status')).toHaveTextContent(/espere terminar/)
    expect(screen.getByRole('button', { name: 'Gerar' })).toBeDisabled()
  })

  it('com uma transcrição refazendo, a nota sai da que já existe; só refazer de novo é que espera', async () => {
    seed([withTranscript(entrada('e', 'v.mp4', VIDEO))])
    useJobsStore.setState({ jobs: [transcribing] })
    await openDialog()
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
    pick('Aula')
    expect(screen.getByRole('button', { name: 'Gerar' })).toBeEnabled()
    pick('Refazer a transcrição')
    expect(screen.getByRole('button', { name: 'Gerar' })).toBeDisabled()
  })
})

// FR-072: the Ata of a video goes step by step with a model for each step; "Tudo numa chamada" only with a writer that sees video.
describe('"Gerar desta entrada": a Ata de vídeo, passo a passo', () => {
  const OR = { id: 'or', type: 'openrouter' as const, name: 'OpenRouter', key: 'k', base: '' }
  const DI = { id: 'di', type: 'deepinfra' as const, name: 'DeepInfra', key: 'k', base: '' }
  const GEMINI = { uid: 'or::google/gemini-3.8-flash', pid: 'or', mid: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' }
  const LUNA = { uid: 'or::openai/gpt-6-luna', pid: 'or', mid: 'openai/gpt-6-luna', name: 'GPT-6 Luna' }
  const DEEPSEEK = { uid: 'di::deepseek-ai/DeepSeek-V4-Flash-0731', pid: 'di', mid: 'deepseek-ai/DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash' }
  const NEW = { uid: 'or::acme/novo', pid: 'or', mid: 'acme/novo', name: 'Novo da Acme' }
  const generateAta = vi.fn(async (..._args: unknown[]) => undefined)
  const generateFromNote = vi.fn(async (..._args: unknown[]) => 'nota')

  function catalog() {
    const text = { texto: true, imagem: true, audio: false, video: false, pdf: null }
    const gemini = { id: GEMINI.mid, name: GEMINI.name, media: { texto: true, imagem: true, audio: true, video: true, pdf: null } }
    const list = [gemini, { id: LUNA.mid, name: LUNA.name, media: text }, { id: NEW.mid, name: NEW.name, media: text }]
    const only = [{ id: DEEPSEEK.mid, name: DEEPSEEK.name, media: { texto: true, imagem: false, audio: false, video: false, pdf: null } }]
    const live = (items: typeof list) => ({ state: 'ok' as const, token: 1, at: Date.now(), list: items, byId: new Map(items.map(item => [item.id, item])) })
    useModelsStore.setState({ live: { or: live(list), di: live(only) }, probes: {} } as never)
  }

  async function open(fields: { made?: FileMeta['made'] } = {}, entry: FileSidecar = withTranscript(entrada('e', 'v.mp4', VIDEO))) {
    const extra = fields.made ? [item('velha', { name: 'Ata antiga', type: 'meeting', parentFileId: 'e', made: fields.made })] : []
    seed([entry, ...extra])
    useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, aiConfig: { providers: [OR, DI], models: [GEMINI, LUNA, DEEPSEEK, NEW], defaults: { estudo: LUNA.uid, ata: LUNA.uid, midia: GEMINI.uid, tela: GEMINI.uid }, steps: {} } } } }))
    catalog()
    render(
      <MemoryRouter>
        <GenerateEntryDialog fileId="e" />
      </MemoryRouter>,
    )
    await screen.findByRole('radiogroup', { name: 'O que gerar' })
  }

  const field = () => screen.getByRole('radiogroup', { name: 'O que a IA analisa' })
  const labels = () => within(field()).getAllByRole('radio').map(radio => radio.querySelector('b')!.textContent)
  const checked = () => within(field()).getAllByRole('radio').filter(radio => radio.getAttribute('aria-checked') === 'true').map(radio => radio.querySelector('b')!.textContent)
  const option = (name: string) => within(field()).getByRole('radio', { name: new RegExp(`^${name}`) })
  const section = () => screen.getByRole('group', { name: 'Modelos por passo' })
  const reveal = () => {
    const toggle = within(section()).getByRole('button', { name: /^Modelos por passo/ })
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  }
  const step = (name: string) => within(section()).getByRole('group', { name })
  const stepModel = (name: string) => within(step(name)).getByRole('combobox') as HTMLSelectElement
  const setStep = (name: string, uid: string) => fireEvent.change(stepModel(name), { target: { value: uid } })
  const writer = () => screen.getByLabelText('Modelo da IA') as HTMLSelectElement
  const go = () => fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))

  beforeEach(() => {
    generateAta.mockClear()
    generateFromNote.mockClear()
    useJobsStore.setState({ generateAta, generateFromNote } as never)
    installFetch(() => new Response('{}'))
  })

  it('o padrão é "Transcrição + quadros do vídeo · passo a passo", que funciona com um modelo que só lê texto; "Só o texto" não existe', async () => {
    await open()
    expect(labels()).toEqual(['Transcrição + quadros do vídeo', 'Tudo numa chamada'])
    expect(checked()).toEqual(['Transcrição + quadros do vídeo'])
    expect(option('Transcrição \\+ quadros do vídeo')).toHaveTextContent('passo a passo')
    expect(option('Transcrição \\+ quadros do vídeo')).toHaveTextContent('GPT-6 Luna')
    expect(option('Transcrição \\+ quadros do vídeo')).toHaveAttribute('aria-disabled', 'false')
    expect(within(field()).queryByRole('radio', { name: /Só o texto|Só a transcrição|Só o vídeo/ })).not.toBeInTheDocument()
    expect(option('Transcrição \\+ quadros do vídeo')).toHaveTextContent('recomendado')
  })

  it('"Tudo numa chamada" fica visível, desligado e diz por quê quando o modelo da escrita não vê vídeo', async () => {
    await open()
    expect(option('Tudo numa chamada')).toHaveAttribute('aria-disabled', 'true')
    expect(option('Tudo numa chamada')).toHaveTextContent('Só abre com um modelo que veja vídeo')
    expect(option('Tudo numa chamada')).toHaveTextContent('GPT-6 Luna')
    fireEvent.click(option('Tudo numa chamada'))
    expect(checked()).toEqual(['Transcrição + quadros do vídeo'])
  })

  it('"Tudo numa chamada" abre com um modelo que vê vídeo e vai na geração; trocar de volta para um que não vê tira a escolha', async () => {
    await open()
    fireEvent.change(writer(), { target: { value: GEMINI.uid } })
    expect(option('Tudo numa chamada')).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(option('Tudo numa chamada'))
    expect(checked()).toEqual(['Tudo numa chamada'])
    go()
    expect(generateAta).toHaveBeenCalledWith('e', ['resumo'], undefined, { model: GEMINI.uid }, { folderId: 'aurora' }, '', undefined, 'video')
    generateAta.mockClear()
    fireEvent.change(writer(), { target: { value: LUNA.uid } })
    expect(checked()).toEqual(['Transcrição + quadros do vídeo'])
  })

  it('numa Aula ou Explicação a pergunta continua a de antes', async () => {
    await open()
    fireEvent.click(screen.getByRole('radio', { name: /^Aula/ }))
    expect(labels()).toEqual(['Só o vídeo', 'Só a transcrição', 'Transcrição + vídeo'])
    expect(screen.queryByRole('group', { name: 'Modelos por passo' })).not.toBeInTheDocument()
  })

  it('numa entrada de áudio não há os quadros do vídeo: nem a pergunta nem a seção', async () => {
    await open({}, withTranscript(entrada('e', 'a.webm', AUDIO)))
    expect(screen.queryByRole('radiogroup', { name: 'O que a IA analisa' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Modelos por passo' })).not.toBeInTheDocument()
  })

  it('a seção "Modelos por passo" traz Vídeo, Contexto e Escrita no modelo recomendado, com o selo e a nota', async () => {
    await open()
    reveal()
    expect(stepModel('Vídeo').value).toBe(GEMINI.uid)
    expect(stepModel('Contexto').value).toBe(LUNA.uid)
    expect(stepModel('Escrita').value).toBe(LUNA.uid)
    expect(step('Vídeo')).toHaveTextContent('recomendado · nota 9')
    expect(step('Contexto')).toHaveTextContent('recomendado · nota 8')
    expect(step('Escrita')).toHaveTextContent('recomendado · nota 8')
    expect(step('Vídeo')).toHaveTextContent('Lê a tela e diz quem fala')
    expect(step('Escrita')).toHaveTextContent('Igual ao Modelo da IA')
    expect(section()).toHaveTextContent('Nota de 0 a 10, medido na aba Recomendações (10/11)')
    expect(within(section()).queryByText(/Pode piorar/)).not.toBeInTheDocument()
  })

  it('cada passo só oferece o que serve a ele: o Vídeo precisa ler imagem', async () => {
    await open()
    reveal()
    const names = (name: string) => within(stepModel(name)).getAllByRole('option').map(item => item.textContent)
    expect(names('Vídeo')).toEqual(expect.arrayContaining(['Gemini 3.8 Flash · OpenRouter', 'GPT-6 Luna · OpenRouter']))
    expect(names('Vídeo')).not.toContain('DeepSeek V4 Flash · DeepInfra')
    expect(names('Contexto')).toContain('DeepSeek V4 Flash · DeepInfra')
  })

  it('um modelo com nota abaixo de 8 no passo avisa com a nota e o motivo, e o selo some', async () => {
    await open()
    reveal()
    setStep('Contexto', DEEPSEEK.uid)
    expect(step('Contexto')).toHaveTextContent('DeepSeek V4 Flash: nota 6 neste passo')
    expect(step('Contexto')).toHaveTextContent('perdeu o prazo que caiu')
    expect(step('Contexto')).toHaveTextContent('Pode piorar a ata')
    expect(step('Contexto')).not.toHaveTextContent('recomendado')
    expect(step('Vídeo')).toHaveTextContent('recomendado · nota 9')
  })

  it('um modelo sem nota medida no passo diz isso, sem selo e sem aviso', async () => {
    await open()
    reveal()
    setStep('Contexto', NEW.uid)
    expect(step('Contexto')).toHaveTextContent('Sem nota medida neste passo')
    expect(step('Contexto')).not.toHaveTextContent('recomendado')
    expect(step('Contexto')).not.toHaveTextContent('Pode piorar')
  })

  it('um modelo que passou, mas não é o recomendado, mostra a nota sem a estrela', async () => {
    await open()
    reveal()
    setStep('Escrita', GEMINI.uid)
    expect(step('Escrita')).toHaveTextContent('nota 8')
    expect(step('Escrita')).not.toHaveTextContent('recomendado')
    expect(step('Escrita')).not.toHaveTextContent('Pode piorar')
  })

  describe('"Usar recomendados" e "Desfazer"', () => {
    const use = () => within(section()).getByRole('button', { name: 'Usar recomendados' })
    const undo = () => within(section()).getByRole('button', { name: 'Desfazer' })
    const models = () => [stepModel('Vídeo').value, stepModel('Contexto').value, stepModel('Escrita').value]

    it('não há mais "Voltar aos recomendados"', async () => {
      await open()
      expect(within(section()).queryByRole('button', { name: 'Voltar aos recomendados' })).not.toBeInTheDocument()
    })

    it('com todos os passos já nos recomendados, "Usar recomendados" não é oferecido: só "Já nos recomendados", desligado', async () => {
      await open()
      expect(within(section()).queryByRole('button', { name: 'Usar recomendados' })).not.toBeInTheDocument()
      expect(within(section()).queryByRole('button', { name: 'Desfazer' })).not.toBeInTheDocument()
      expect(within(section()).getByRole('button', { name: 'Já nos recomendados' })).toBeDisabled()
    })

    it('os passos abrem nos modelos salvos da pessoa, e "Usar recomendados" os troca todos de uma vez', async () => {
      await open({ made: { at: '2026-11-05T10:00:00.000Z', parts: ['resumo'], model: GEMINI.uid, analyze: 'transcricao', steps: { video: LUNA.uid, context: DEEPSEEK.uid } } })
      expect(models()).toEqual([LUNA.uid, DEEPSEEK.uid, GEMINI.uid])
      expect(within(section()).queryByRole('button', { name: 'Já nos recomendados' })).not.toBeInTheDocument()
      expect(use()).toBeEnabled()
      fireEvent.click(use())
      expect(models()).toEqual([GEMINI.uid, LUNA.uid, LUNA.uid])
      expect(writer().value).toBe(LUNA.uid)
      expect(step('Vídeo')).toHaveTextContent('recomendado · nota 9')
      expect(step('Contexto')).toHaveTextContent('recomendado · nota 8')
      expect(step('Escrita')).toHaveTextContent('recomendado · nota 8')
    })

    it('depois de usar, aparece "Desfazer", que põe de volta exatamente os modelos de antes', async () => {
      await open({ made: { at: '2026-11-05T10:00:00.000Z', parts: ['resumo'], model: GEMINI.uid, analyze: 'transcricao', steps: { video: LUNA.uid, context: DEEPSEEK.uid } } })
      fireEvent.click(use())
      expect(within(section()).queryByRole('button', { name: 'Usar recomendados' })).not.toBeInTheDocument()
      fireEvent.click(undo())
      expect(models()).toEqual([LUNA.uid, DEEPSEEK.uid, GEMINI.uid])
      expect(writer().value).toBe(GEMINI.uid)
      expect(within(section()).queryByRole('button', { name: 'Desfazer' })).not.toBeInTheDocument()
      expect(use()).toBeEnabled()
    })

    it('"Desfazer" devolve também o que veio por padrão: sem a pessoa ter escolhido, a geração vai como se nada tivesse acontecido', async () => {
      await open()
      reveal()
      setStep('Contexto', DEEPSEEK.uid)
      fireEvent.click(use())
      expect(stepModel('Contexto').value).toBe(LUNA.uid)
      fireEvent.click(undo())
      expect(models()).toEqual([GEMINI.uid, DEEPSEEK.uid, LUNA.uid])
      go()
      expect(generateAta).toHaveBeenCalledWith('e', ['resumo'], undefined, { model: LUNA.uid, context: DEEPSEEK.uid }, { folderId: 'aurora' }, '', undefined, 'transcricao')
    })

    it('"Usar recomendados" também vale para o que a pessoa trocou à mão, e vai para a geração', async () => {
      await open()
      reveal()
      setStep('Vídeo', LUNA.uid)
      setStep('Contexto', DEEPSEEK.uid)
      setStep('Escrita', GEMINI.uid)
      fireEvent.click(use())
      expect(models()).toEqual([GEMINI.uid, LUNA.uid, LUNA.uid])
      go()
      expect(generateAta).toHaveBeenCalledWith('e', ['resumo'], undefined, { model: LUNA.uid, write: LUNA.uid, video: GEMINI.uid, context: LUNA.uid }, { folderId: 'aurora' }, '', undefined, 'transcricao')
    })

    it('trocar um passo à mão depois de usar tira o "Desfazer": o botão volta a "Usar recomendados"', async () => {
      await open({ made: { at: '2026-11-05T10:00:00.000Z', parts: ['resumo'], model: GEMINI.uid, analyze: 'transcricao', steps: { context: DEEPSEEK.uid } } })
      fireEvent.click(use())
      setStep('Contexto', NEW.uid)
      expect(within(section()).queryByRole('button', { name: 'Desfazer' })).not.toBeInTheDocument()
      expect(use()).toBeEnabled()
    })

    it('trocar o "Modelo da IA" depois de usar também tira o "Desfazer"', async () => {
      await open({ made: { at: '2026-11-05T10:00:00.000Z', parts: ['resumo'], model: GEMINI.uid, analyze: 'transcricao', steps: { context: DEEPSEEK.uid } } })
      fireEvent.click(use())
      fireEvent.change(writer(), { target: { value: GEMINI.uid } })
      expect(within(section()).queryByRole('button', { name: 'Desfazer' })).not.toBeInTheDocument()
      expect(use()).toBeEnabled()
    })
  })

  it('a Escrita e o "Modelo da IA" são a mesma escolha', async () => {
    await open()
    reveal()
    setStep('Escrita', GEMINI.uid)
    expect(writer().value).toBe(GEMINI.uid)
    fireEvent.change(writer(), { target: { value: LUNA.uid } })
    expect(stepModel('Escrita').value).toBe(LUNA.uid)
  })

  describe('a caixa "o modelo de vídeo também escreve o documento"', () => {
    const BOX = 'O modelo de vídeo (Gemini 3.8 Flash · OpenRouter) também escreve o documento'

    it('na Ata não existe: cada passo tem o seu modelo', async () => {
      await open()
      expect(screen.queryByLabelText(/também escreve o documento/)).not.toBeInTheDocument()
    })

    it.each([
      ['Aula', 'lesson'],
      ['Explicação', 'explanation'],
    ])('numa %s de um vídeo volta como era: marcada, o modelo de vídeo escreve e o "Modelo da IA" fica desligado', async (name, agent) => {
      await open()
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${name}`) }))
      const box = screen.getByLabelText(BOX)
      expect(box).not.toBeChecked()
      expect(writer()).toBeEnabled()
      fireEvent.click(box)
      expect(box).toBeChecked()
      expect(writer()).toBeDisabled()
      go()
      expect(generateFromNote).toHaveBeenCalledTimes(1)
      expect(generateFromNote.mock.calls[0].slice(0, 3)).toEqual(['e', agent, GEMINI.uid])
      expect(generateAta).not.toHaveBeenCalled()
    })

    it('numa Aula, sem marcar, escreve o "Modelo da IA" de sempre', async () => {
      await open()
      fireEvent.click(screen.getByRole('radio', { name: /^Aula/ }))
      go()
      expect(generateFromNote.mock.calls[0].slice(0, 3)).toEqual(['e', 'lesson', LUNA.uid])
    })

    it('numa entrada de áudio a Aula também oferece a caixa, como antes', async () => {
      await open({}, withTranscript(entrada('e', 'a.webm', AUDIO)))
      fireEvent.click(screen.getByRole('radio', { name: /^Aula/ }))
      expect(screen.getByLabelText(BOX)).toBeInTheDocument()
    })
  })

  it('sem trocar nada, vai o que foi mostrado: só o modelo da escrita e o passo a passo, como o padrão de hoje', async () => {
    await open()
    go()
    expect(generateAta).toHaveBeenCalledWith('e', ['resumo'], undefined, { model: LUNA.uid }, { folderId: 'aurora' }, '', undefined, 'transcricao')
  })

  it('os modelos escolhidos vão para a geração, passo a passo', async () => {
    await open()
    reveal()
    setStep('Vídeo', LUNA.uid)
    setStep('Contexto', DEEPSEEK.uid)
    setStep('Escrita', GEMINI.uid)
    go()
    expect(generateAta).toHaveBeenCalledWith('e', ['resumo'], undefined, { model: GEMINI.uid, write: GEMINI.uid, video: LUNA.uid, context: DEEPSEEK.uid }, { folderId: 'aurora' }, '', undefined, 'transcricao')
  })

  it('começa nos modelos da última Ata desta entrada ("Gerar de novo")', async () => {
    await open({ made: { at: '2026-11-05T10:00:00.000Z', parts: ['resumo'], model: GEMINI.uid, analyze: 'transcricao', steps: { video: LUNA.uid, context: DEEPSEEK.uid } } })
    reveal()
    expect(stepModel('Vídeo').value).toBe(LUNA.uid)
    expect(stepModel('Contexto').value).toBe(DEEPSEEK.uid)
    expect(stepModel('Escrita').value).toBe(GEMINI.uid)
    expect(step('Contexto')).toHaveTextContent('nota 6 neste passo')
    go()
    expect(generateAta.mock.calls[0][3]).toEqual({ model: GEMINI.uid, write: GEMINI.uid, video: LUNA.uid, context: DEEPSEEK.uid })
  })

  it('uma Ata antiga feita com "o modelo de vídeo também escreve" volta com ele no Contexto e na Escrita', async () => {
    await open({ made: { at: '2026-11-05T10:00:00.000Z', parts: ['resumo'], model: GEMINI.uid, everyStep: true } })
    reveal()
    expect(stepModel('Contexto').value).toBe(GEMINI.uid)
    expect(stepModel('Escrita').value).toBe(GEMINI.uid)
  })

  it('abre já aberta quando algum passo começa abaixo de 8, para o aviso não ficar escondido', async () => {
    await open({ made: { at: '2026-11-05T10:00:00.000Z', parts: ['resumo'], steps: { context: DEEPSEEK.uid } } })
    expect(within(section()).getByRole('button', { name: /^Modelos por passo/ })).toHaveAttribute('aria-expanded', 'true')
    expect(step('Contexto')).toHaveTextContent('Pode piorar a ata')
  })

  it('fechada por padrão quando tudo está no recomendado', async () => {
    await open()
    expect(within(section()).getByRole('button', { name: /^Modelos por passo/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'Vídeo' })).not.toBeInTheDocument()
  })
})

describe('gerar de verdade: a nota é filha da entrada', () => {
  const WRITTEN = JSON.stringify({ markdown: { elements: [{ type: 'heading', level: 1, text: 'Juros' }, { type: 'paragraph', text: 'O montante cresce sobre si mesmo.' }], diagrams: [] } })
  const PAGE = 'Title: Guia de juros\n\nMarkdown Content:\n# Juros\n\nO montante cresce.'
  let calls: CapturedRequest[]

  function provider(request: CapturedRequest): Response {
    if (request.url.startsWith('https://r.jina.ai/')) return new Response(PAGE)
    const system = systemPromptOf(request)
    if (system === PROMPTS.LESSON_PROMPT || system === PROMPTS.EXPLANATION_PROMPT) return openAiStream(WRITTEN)
    return openAiStream('{"tags":[]}')
  }

  const fileOf = (id: string | null | undefined) => useLibraryStore.getState().files.find(file => file.id === id)
  const sent = () => calls.filter(call => systemPromptOf(call) === PROMPTS.LESSON_PROMPT || systemPromptOf(call) === PROMPTS.EXPLANATION_PROMPT).map(userContentOf).join('\n')

  beforeEach(() => {
    installBlobShim()
    calls = installFetch(provider).calls
  })

  function withWriter() {
    useLibraryStore.setState(state => ({ index: { ...state.index, settings: { ...state.index.settings, ai: { provider: 'custom', baseUrl: 'https://api.exemplo.dev/v1', apiKey: 'k', model: 'default' } } } }))
  }

  it('Aula de um texto colado: sai do conteúdo da entrada, filha dela e na pasta escolhida', async () => {
    seed([entrada('texto', 'Texto colado', PASTED, { kept: 'registro' })], { texto: 'A inflação de serviços segue acima da média.' })
    withWriter()
    const id = await useJobsStore.getState().generateFromNote('texto', 'lesson', null, { folderId: 'trabalho' }, '')
    expect(fileOf(id)).toMatchObject({ parentFileId: 'texto', type: 'class', folderId: 'trabalho', name: 'Aula: Texto colado' })
    await waitFor(() => expect(fileOf(id)?.status).toBe('ready'))
    expect(sent()).toContain('A inflação de serviços')
    expect(fileOf('texto')?.folderId).toBe('aurora')
  })

  it('aceita Explicação', async () => {
    seed([entrada('texto', 'Texto colado', PASTED, { kept: 'registro' })], { texto: 'A inflação de serviços segue acima da média.' })
    withWriter()
    const id = await useJobsStore.getState().generateFromNote('texto', 'explanation', null, { folderId: 'aurora' }, '')
    expect(fileOf(id)).toMatchObject({ parentFileId: 'texto', type: 'explanation', name: 'Explicação: Texto colado' })
    await waitFor(() => expect(fileOf(id)?.status).toBe('ready'))
  })

  it('um link é lido de novo', async () => {
    seed([entrada('link', 'Guia', LINK, { kept: 'registro' })])
    withWriter()
    const id = await useJobsStore.getState().generateFromNote('link', 'lesson', null, { folderId: 'aurora' }, '')
    expect(fileOf(id)).toMatchObject({ parentFileId: 'link', type: 'class' })
    await waitFor(() => expect(fileOf(id)?.status).toBe('ready'))
    expect(calls.some(call => call.url.startsWith('https://r.jina.ai/'))).toBe(true)
    expect(sent()).toContain('O montante cresce.')
  })

  it('um link fora do ar não cria nota e o motivo aparece', async () => {
    installFetch(request => (request.url.startsWith('https://r.jina.ai/') ? new Response('fora', { status: 500 }) : provider(request)))
    seed([entrada('link', 'Guia', LINK, { kept: 'registro' })])
    withWriter()
    expect(await useJobsStore.getState().generateFromNote('link', 'lesson', null, { folderId: 'aurora' }, '')).toBeNull()
    expect(useLibraryStore.getState().files.filter(file => file.parentFileId === 'link')).toHaveLength(0)
    const failed = useJobsStore.getState().jobs.find(job => job.fileId === 'link' && job.status === 'error')
    expect(failed?.error).toBeTruthy()
  })

  it('um tema vai como o próprio tema', async () => {
    seed([entrada('tema', 'Tema: orçamento', TOPIC, { kept: 'registro' })])
    withWriter()
    const id = await useJobsStore.getState().generateFromNote('tema', 'explanation', null, { folderId: 'aurora' }, '')
    await waitFor(() => expect(fileOf(id)?.status).toBe('ready'))
    expect(sent()).toContain('Orçamento base zero')
  })

  it('um documento guardado é aberto de novo', async () => {
    const source = new File(['O contrato vale por dois anos.'], 'contrato.txt', { type: 'text/plain' })
    seed([entrada('doc', 'Contrato', { input: 'file', name: 'contrato.txt', mime: 'text/plain', storage: 'drive', storedFileId: 'drv-doc' })], {}, [], { 'drv-doc': source })
    withWriter()
    const id = await useJobsStore.getState().generateFromNote('doc', 'lesson', null, { folderId: 'aurora' }, '')
    await waitFor(() => expect(fileOf(id)?.status).toBe('ready'))
    expect(sent()).toContain('O contrato vale por dois anos.')
  })

  it('sem nada para ler, não cria nota e diz por quê', async () => {
    seed([entrada('doc', 'Contrato', noFile(PDF), { kept: 'registro' })])
    withWriter()
    expect(await useJobsStore.getState().generateFromNote('doc', 'lesson', null, { folderId: 'aurora' }, '')).toBeNull()
    expect(useLibraryStore.getState().files.filter(file => file.parentFileId === 'doc')).toHaveLength(0)
    expect(useJobsStore.getState().jobs.find(job => job.fileId === 'doc')).toMatchObject({ status: 'error', error: expect.stringContaining('não tem') })
  })

  it('enquanto a nota é escrita ela aparece gerando, e pronta vira link', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => (release = resolve))
    installFetch(async request => {
      await held
      return provider(request)
    })
    seed([entrada('texto', 'Texto colado', PASTED, { kept: 'registro' })], { texto: 'A inflação de serviços segue acima da média.' })
    withWriter()
    renderEntry('texto')
    let id: string | null = null
    await act(async () => {
      id = await useJobsStore.getState().generateFromNote('texto', 'lesson', null, { folderId: 'aurora' }, '')
    })
    const tree = within(card('O que nasceu daqui'))
    expect(await tree.findByText('gerando…')).toBeInTheDocument()
    expect(fileOf(id)?.status).toBe('generating')
    await act(async () => release())
    await waitFor(() => expect(tree.getByRole('link', { name: 'Aula: Texto colado' })).toBeInTheDocument())
    expect(tree.queryByText('gerando…')).not.toBeInTheDocument()
  })
})

describe('rotas', () => {
  function Reader() {
    return <ReaderWorkspace route={useViewRoute()} />
  }
  function Columns() {
    return <ColumnsWorkspace route={useViewRoute()} />
  }
  function Commands() {
    return <CommandsWorkspace route={useViewRoute()} />
  }
  function Focus() {
    return <FocusWorkspace route={useViewRoute()} />
  }

  function renderAt(path: string, Layout: () => React.ReactNode = Reader) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/entrada/:fileId" element={<Layout />} />
          <Route path="/arquivo/:fileId" element={<Layout />} />
          <Route path="*" element={<Layout />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  beforeEach(() => seed([entrada('video', 'Reunião de kickoff.mp4', VIDEO), ...family('video')]))

  it('os caminhos combinados', () => {
    expect(paths.entries).toBe('/entradas')
    expect(paths.entry('abc')).toBe('/entrada/abc')
  })

  it.each([
    ['leitor', Reader],
    ['colunas', Columns],
    ['comandos', Commands],
    ['foco', Focus],
  ])('no layout %s, /entrada/<id> abre a página e /entradas abre a lista', (_name, Layout) => {
    const first = renderAt('/entrada/video', Layout)
    expect(screen.getByRole('region', { name: 'O que nasceu daqui' })).toBeInTheDocument()
    first.unmount()
    renderAt('/entradas', Layout)
    expect(screen.getByRole('table', { name: 'Entradas' })).toBeInTheDocument()
  })

  it('/arquivo/<id de uma entrada> também abre a página da entrada, porque todos os links usam paths.file', () => {
    renderAt('/arquivo/video')
    expect(screen.getByRole('region', { name: 'O que nasceu daqui' })).toBeInTheDocument()
  })

  it('/arquivo/<id de uma nota> continua sendo o leitor', async () => {
    renderAt('/arquivo/ata')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Ata do kickoff' })).toBeInTheDocument())
    expect(screen.queryByRole('region', { name: 'O que nasceu daqui' })).not.toBeInTheDocument()
  })
})
