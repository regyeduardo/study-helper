import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useEffect } from 'react'

import type { RecordingData, SourceMeta } from '@/types/domain'
import { ExamDialog, FolderExamDialog } from '@/components/dialogs/ExamDialog'
import { MindMapDialog } from '@/components/dialogs/MindMapDialog'
import { TutorDialog } from '@/components/dialogs/TutorDialog'
import { NoteParts } from '@/components/reader/Details'
import { EntryPage } from '@/components/reader/EntryPage'
import { InspectorBody } from '@/components/reader/Inspector'
import { MediaPlayer, type MeetingMedia, useMeetingMedia } from '@/components/reader/MediaPlayer'
import { usePlayback } from '@/components/reader/use-playback'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { newMapArtifact } from '@/lib/artifacts'
import { env } from '@/lib/env'
import { AppRepository } from '@/lib/storage/app-repository'
import { renameSpeakerOnClick } from '@/lib/transcription/rename-everywhere'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'
import { chatEntry, seedConversations } from '@/test/artifacts/entry-chat-helpers'
import { deferred, settle, slowLibrary, toastsNow } from '@/test/feedback/slow'

// Escolha F do dono (21/11/2026) no Leitor: cada clique que espera o Drive trava o app na janela do meio, do clique até o fim,
// com a contagem quando passa por várias notas, e o motivo na janela quando falha.

const flush = () => act(async () => await Promise.resolve())
const shown = () => act(async () => vi.advanceTimersByTime(350))
const windowNamed = (name: string) => screen.getByRole('alertdialog', { name })
const noWindow = () => expect(screen.queryByRole('alertdialog')).toBeNull()
const titles = () => useBlockingStore.getState().ops.map(op => op.title)
const REAL = useLibraryStore.getState()
const DRIVE_AUDIO: SourceMeta = { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', sizeBytes: 2048, storage: 'drive', storedFileId: 'drv-1' }
const APP_AUDIO: SourceMeta = { ...DRIVE_AUDIO, storedFileId: 'app:n1/m1' }
const objectUrls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useBlockingStore.setState({ ops: [] })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  URL.createObjectURL = () => 'blob:aula3'
  URL.revokeObjectURL = () => undefined
})
afterEach(() => {
  // the player lets go of its object URL when it leaves the page: before the stub goes
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  URL.createObjectURL = objectUrls.create
  URL.revokeObjectURL = objectUrls.revoke
  useLibraryStore.setState({ removeMedia: REAL.removeMedia, renameArtifact: REAL.renameArtifact, deleteArtifact: REAL.deleteArtifact })
})

const store = () => useLibraryStore.getState()
const confirmOverlay = () => useUiStore.getState().overlay as Extract<Overlay, { kind: 'confirm' }>

describe('Tocar a mídia guardada', () => {
  function Player({ fileId }: { fileId: string }) {
    const meta = useLibraryStore(state => state.files.find(file => file.id === fileId) ?? null)
    const media = useMeetingMedia(meta)
    const playback = usePlayback(media)
    return <MediaPlayer player={playback.player} media={media} onTime={() => undefined} onPlayFrom={playback.playFrom} />
  }

  // streaming (pedido do dono: "Sim, um streaming"): só o que ainda baixa inteiro trava na janela
  it('a do App toca na hora, aos pedaços, do endereço da API: sem "Baixando a mídia…" e sem baixar inteira', async () => {
    const slow = slowLibrary()
    const meta = await store().createFile({ name: 'Aula 3', type: 'class', folderId: null, origin: APP_AUDIO }, '')
    const getSource = vi.spyOn(AppRepository.prototype, 'getSource')
    useLibraryStore.setState({ repo: new AppRepository('acc1') })
    render(
      <>
        <Player fileId={meta.id} />
        <BlockingWindow />
      </>,
    )
    await act(settle)
    const audio = document.querySelector('audio')!
    expect(audio).toHaveAttribute('src', `${env.apiUrl}/v1/media/n1/m1`)
    expect(audio).toHaveAttribute('crossorigin', 'use-credentials')
    fireEvent.click(screen.getByRole('button', { name: 'Tocar' }))
    await shown()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    expect(titles()).toEqual([])
    noWindow()
    expect(getSource).not.toHaveBeenCalled()
    expect(slow.repo.readContent).not.toHaveBeenCalled()
  })

  it('a do Drive, com o service worker do app, toca de /media-stream/<id>: sem a janela', async () => {
    const slow = slowLibrary()
    const getSource = vi.fn()
    const streamSource = vi.fn(async (ref: string) => `/media-stream/${ref}`)
    Object.assign(slow.repo, { getSource, streamSource })
    const meta = await store().createFile({ name: 'Aula 3', type: 'class', folderId: null, origin: DRIVE_AUDIO }, '')
    render(
      <>
        <Player fileId={meta.id} />
        <BlockingWindow />
      </>,
    )
    await act(settle)
    expect(streamSource).toHaveBeenCalledWith('drv-1')
    expect(document.querySelector('audio')).toHaveAttribute('src', '/media-stream/drv-1')
    fireEvent.click(screen.getByRole('button', { name: 'Tocar' }))
    await shown()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    noWindow()
    expect(getSource).not.toHaveBeenCalled()
  })

  it('"Tocar" antes de o endereço chegar espera por ele e toca: não baixa a mídia inteira', async () => {
    const slow = slowLibrary()
    const address = deferred<string | null>()
    const getSource = vi.fn()
    Object.assign(slow.repo, { getSource, streamSource: () => address.promise })
    const meta = await store().createFile({ name: 'Aula 3', type: 'class', folderId: null, origin: DRIVE_AUDIO }, '')
    render(
      <>
        <Player fileId={meta.id} />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Tocar' }))
    await flush()
    expect(titles()).toEqual([])
    await act(async () => {
      address.resolve('/media-stream/drv-1')
      await settle()
    })
    expect(document.querySelector('audio')).toHaveAttribute('src', '/media-stream/drv-1')
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    expect(getSource).not.toHaveBeenCalled()
    noWindow()
  })

  it('uma tela que pede a mídia ao abrir (começar de um momento) também toca aos pedaços, sem baixar inteira', async () => {
    const slow = slowLibrary()
    const getSource = vi.fn()
    Object.assign(slow.repo, { getSource, streamSource: async (ref: string) => `/media-stream/${ref}` })
    const meta = await store().createFile({ name: 'Aula 3', type: 'class', folderId: null, origin: DRIVE_AUDIO }, '')
    // like the transcription tabs: a child asks for the media in its first effect, before the player's own effects
    function Opener({ media }: { media: MeetingMedia }) {
      useEffect(() => void media.request(), [])
      return null
    }
    function Page() {
      const media = useMeetingMedia(useLibraryStore(state => state.files.find(file => file.id === meta.id) ?? null))
      return (
        <>
          <Opener media={media} />
          <MediaPlayer player={{ current: null }} media={media} onTime={() => undefined} onPlayFrom={() => undefined} />
        </>
      )
    }
    render(
      <>
        <Page />
        <BlockingWindow />
      </>,
    )
    await act(settle)
    expect(document.querySelector('audio')).toHaveAttribute('src', '/media-stream/drv-1')
    expect(getSource).not.toHaveBeenCalled()
    expect(titles()).toEqual([])
  })

  it('a do Drive num navegador sem o worker do app (Firefox antigo, recarga forçada) ainda baixa inteira: trava com "Baixando a mídia…" e a barra que corre até a mídia chegar; então ela toca', async () => {
    const slow = slowLibrary()
    const source = deferred<Blob>()
    const getSource = vi.fn(() => source.promise)
    Object.assign(slow.repo, { getSource })
    const meta = await store().createFile({ name: 'Aula 3', type: 'class', folderId: null, origin: DRIVE_AUDIO }, '')
    render(
      <>
        <Player fileId={meta.id} />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Tocar' }))
    await flush()
    expect(getSource).toHaveBeenCalledWith('drv-1')
    expect(titles()).toEqual(['Baixando a mídia…'])
    await shown()
    expect(windowNamed('Baixando a mídia…')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    await act(async () => {
      source.resolve(new Blob(['som'], { type: 'audio/webm' }))
      await settle()
    })
    noWindow()
    expect(document.querySelector('audio')).toHaveAttribute('src', 'blob:aula3')
  })
})

describe('Trocar o nome de quem fala', () => {
  const RECORDING: RecordingData = {
    blocks: [
      { speaker: 's1', start: 12, end: 20, text: 'O prazo do portal novo é março.' },
      { speaker: 's2', start: 100, end: 110, text: 'O fornecedor pediu mais duas semanas.' },
    ],
    speakers: [
      { id: 's1', name: 'Marina', suggested: false },
      { id: 's2', name: 'Falante 2', suggested: true },
    ],
    marks: [],
  }

  /** The media note, its Ata and the Ata's Explicação: three notes that show the voice. */
  async function meeting() {
    const media = await store().createFile({ name: 'Reunião de kickoff', type: 'audio', folderId: null, origin: { input: 'recording', name: 'kickoff.webm', mime: 'audio/webm', storage: 'none' } }, '')
    await store().updateSidecar(media.id, sidecar => ({ ...sidecar, recording: RECORDING, transcript: 'texto antigo' }))
    const ata = await store().createFile({ name: 'Ata: Reunião de kickoff', type: 'meeting', parentFileId: media.id, folderId: null }, '- Falante 2 pediu mais duas semanas.')
    const explanation = await store().createFile({ name: 'Explicação: prazo', type: 'explanation', parentFileId: ata.id, folderId: null }, 'Quem pediu prazo foi Falante 2.')
    return { media: media.id, ata: ata.id, explanation: explanation.id }
  }

  it('"Trocando o nome em 3 notas…" com a contagem nota a nota, até a última', async () => {
    const slow = slowLibrary()
    const { media, explanation } = await meeting()
    render(<BlockingWindow />)
    const counts: string[] = []
    const stop = useBlockingStore.subscribe(state => {
      const op = state.ops[0]
      if (op?.total) counts.push(`${op.done ?? 0} de ${op.total}`)
    })
    const release = slow.hold()
    const result = renameSpeakerOnClick(media, 's2', 'Rafael')
    await shown()
    expect(windowNamed('Trocando o nome em 3 notas…')).toHaveTextContent('0 de 3')
    await act(async () => {
      release()
      await result
    })
    stop()
    expect(counts).toEqual(expect.arrayContaining(['1 de 3', '2 de 3', '3 de 3']))
    expect(slow.contents.get(explanation)).toBe('Quem pediu prazo foi Rafael.')
    noWindow()
  })

  it('confirmar o nome sugerido regrava só a nota: "Trocando o nome em 1 nota…"', async () => {
    const slow = slowLibrary()
    const { media } = await meeting()
    render(<BlockingWindow />)
    const release = slow.hold()
    const result = renameSpeakerOnClick(media, 's2', 'Falante 2')
    await shown()
    expect(windowNamed('Trocando o nome em 1 nota…')).toBeInTheDocument()
    await act(async () => {
      release()
      await result
    })
    noWindow()
  })

  it('uma falha não some: a janela fica com o motivo', async () => {
    const slow = slowLibrary()
    const { media } = await meeting()
    render(<BlockingWindow />)
    slow.breakWith(new Error('O Drive não respondeu.'))
    await act(async () => {
      await expect(renameSpeakerOnClick(media, 's2', 'Rafael')).resolves.toBe(false)
    })
    expect(windowNamed('Trocando o nome em 3 notas…')).toHaveTextContent('O Drive não respondeu.')
  })
})

describe('"Apagar só a mídia…" da entrada', () => {
  async function entryPage(removeMedia: () => Promise<void>) {
    slowLibrary()
    const entry = await store().createFile({ name: 'Reunião.webm', type: 'reading', role: 'entrada', kept: 'arquivo', folderId: null, origin: DRIVE_AUDIO }, '')
    useLibraryStore.setState({ removeMedia: vi.fn(removeMedia) })
    render(
      <>
        <MemoryRouter>
          <EntryPage fileId={entry.id} />
        </MemoryRouter>
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apagar só a mídia…' }))
    return confirmOverlay()
  }

  it('trava com "Apagando a mídia…" até o Drive responder, e um aviso diz o fim', async () => {
    const gate = deferred()
    const confirm = await entryPage(() => gate.promise)
    void confirm.onConfirm()
    await shown()
    expect(windowNamed('Apagando a mídia…')).toBeInTheDocument()
    await act(async () => {
      gate.resolve()
      await settle()
    })
    noWindow()
    expect(toastsNow()).toContain('Mídia apagada; a nota continua')
  })

  it('uma falha aparece na janela, sem o aviso de pronto', async () => {
    const confirm = await entryPage(async () => {
      throw new Error('O Drive não respondeu.')
    })
    await act(async () => await confirm.onConfirm())
    expect(windowNamed('Apagando a mídia…')).toHaveTextContent('O Drive não respondeu.')
    expect(toastsNow()).not.toContain('Mídia apagada; a nota continua')
  })
})

describe('"Apagar" em Partes da nota', () => {
  async function parts() {
    const slow = slowLibrary()
    const meta = await store().createFile({ name: 'Aula 3', type: 'class', folderId: null, origin: DRIVE_AUDIO }, '')
    render(
      <>
        <NoteParts meta={meta} />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Apagar só a mídia' }))
    return slow
  }

  it('trava com "Apagando a mídia…" até gravar, e então o aviso', async () => {
    const slow = await parts()
    const release = slow.hold()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    await shown()
    expect(windowNamed('Apagando a mídia…')).toBeInTheDocument()
    await act(async () => {
      release()
      await settle()
    })
    noWindow()
    expect(toastsNow()).toContain('Parte apagada; a nota continua')
  })

  it('uma falha aparece na janela', async () => {
    const slow = await parts()
    slow.breakWith(new Error('O Drive não respondeu.'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
      await settle()
    })
    expect(windowNamed('Apagando a mídia…')).toHaveTextContent('O Drive não respondeu.')
    expect(toastsNow()).not.toContain('Parte apagada; a nota continua')
  })
})

describe('Desta nota: renomear e apagar um artefato', () => {
  async function withMap() {
    slowLibrary()
    const note = await store().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites')
    await store().saveArtifact(note.id, newMapArtifact({ name: 'Mapa dos limites', diagram: { form: 'arvore', root: { id: 'r', text: 'Limites', children: [] } } }))
    render(
      <>
        <InspectorBody fileId={note.id} tab="mine" />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Opções de Mapa dos limites' }))
  }

  it('Renomear trava com "Renomeando “Mapa dos limites”…" até gravar', async () => {
    const gate = deferred()
    await withMap()
    useLibraryStore.setState({ renameArtifact: vi.fn(() => gate.promise) })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renomear' }))
    const field = screen.getByRole('textbox', { name: 'Novo nome' })
    fireEvent.change(field, { target: { value: 'Mapa novo' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await shown()
    expect(windowNamed('Renomeando “Mapa dos limites”…')).toBeInTheDocument()
    await act(async () => {
      gate.resolve()
      await settle()
    })
    noWindow()
  })

  it('Apagar trava com "Apagando “Mapa dos limites”…" até o Drive responder', async () => {
    const gate = deferred()
    await withMap()
    useLibraryStore.setState({ deleteArtifact: vi.fn(() => gate.promise) })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apagar' }))
    void confirmOverlay().onConfirm()
    await shown()
    expect(windowNamed('Apagando “Mapa dos limites”…')).toBeInTheDocument()
    await act(async () => {
      gate.resolve()
      await settle()
    })
    noWindow()
    expect(toastsNow()).toContain('“Mapa dos limites” saiu da nota')
  })
})

describe('Conversas do Tutor (Chat da entrada)', () => {
  async function chatList() {
    const { entry } = await chatEntry({ media: 'none', kept: new Map() })
    await seedConversations(entry, [{ id: 'c-prazo', turns: [{ who: 'você', text: 'Qual o prazo do portal?' }, { who: 'tutor', text: 'Março.' }], updatedAt: '2026-11-05T12:00:00.000Z', scope: 'chat' }])
    render(
      <>
        <TutorDialog fileId={entry} chat />
        <BlockingWindow />
      </>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /^Conversas/ })).toHaveTextContent('1'))
    fireEvent.click(screen.getByRole('button', { name: /^Conversas/ }))
  }

  it('renomear trava com "Renomeando “Qual o prazo do portal?”…" até gravar', async () => {
    await chatList()
    const gate = deferred()
    useLibraryStore.setState({ renameArtifact: vi.fn(() => gate.promise) })
    fireEvent.click(screen.getByRole('button', { name: 'Renomear “Qual o prazo do portal?”' }))
    const field = screen.getByRole('textbox', { name: 'Novo nome' })
    fireEvent.change(field, { target: { value: 'Prazo do portal' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await shown()
    expect(windowNamed('Renomeando “Qual o prazo do portal?”…')).toBeInTheDocument()
    await act(async () => {
      gate.resolve()
      await settle()
    })
    noWindow()
  })

  it('apagar trava com "Apagando “Qual o prazo do portal?”…" até o Drive responder', async () => {
    await chatList()
    const gate = deferred()
    useLibraryStore.setState({ deleteArtifact: vi.fn(() => gate.promise) })
    fireEvent.click(screen.getByRole('button', { name: 'Apagar “Qual o prazo do portal?”' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Apagar “Qual o prazo do portal?”' })).getByRole('button', { name: 'Apagar' }))
    await shown()
    expect(windowNamed('Apagando “Qual o prazo do portal?”…')).toBeInTheDocument()
    await act(async () => {
      gate.resolve()
      await settle()
    })
    noWindow()
  })
})

describe('Renomear o mapa', () => {
  it('trava com "Renomeando o mapa…" até gravar', async () => {
    slowLibrary()
    const note = await store().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites')
    const map = await store().saveArtifact(note.id, newMapArtifact({ name: 'Mapa dos limites', diagram: { form: 'arvore', root: { id: 'r', text: 'Limites', children: [] } } }))
    render(
      <>
        <MindMapDialog fileId={note.id} mapId={map.id} />
        <BlockingWindow />
      </>,
    )
    const gate = deferred()
    useLibraryStore.setState({ renameArtifact: vi.fn(() => gate.promise) })
    fireEvent.click(await screen.findByRole('button', { name: 'Renomear o mapa' }))
    const field = screen.getByRole('textbox', { name: 'Nome do mapa' })
    fireEvent.change(field, { target: { value: 'Mapa novo' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await shown()
    expect(windowNamed('Renomeando o mapa…')).toBeInTheDocument()
    await act(async () => {
      gate.resolve()
      await settle()
    })
    noWindow()
  })
})

describe('Prova', () => {
  async function notes(count: number) {
    const slow = slowLibrary()
    const ids: string[] = []
    for (let index = 1; index <= count; index++) ids.push((await store().createFile({ name: `Nota ${index}`, type: 'class', status: 'ready', folderId: null }, `# Nota ${index}`)).id)
    // nothing read yet: opening goes to the Drive
    useLibraryStore.setState({ opened: {} })
    return { slow, ids }
  }

  it('abrir a prova de uma nota diz "Abrindo a prova…", não "Escrevendo e conferindo as questões"', async () => {
    const { slow, ids } = await notes(1)
    const release = slow.hold()
    render(
      <>
        <ExamDialog fileId={ids[0]} />
        <BlockingWindow />
      </>,
    )
    await shown()
    expect(windowNamed('Abrindo a prova…')).toBeInTheDocument()
    expect(screen.queryByText(/Escrevendo e conferindo/)).toBeNull()
    await act(async () => {
      release()
      await settle()
    })
    noWindow()
    expect(screen.getByRole('button', { name: 'Gerar a prova' })).toBeInTheDocument()
  })

  it('abrir a prova que falha mostra o motivo e fecha a janela da prova', async () => {
    const { slow, ids } = await notes(1)
    useUiStore.getState().open({ kind: 'exam', fileId: ids[0] })
    slow.breakWith(new Error('O Drive não respondeu.'))
    render(
      <>
        <ExamDialog fileId={ids[0]} />
        <BlockingWindow />
      </>,
    )
    await act(async () => await settle())
    expect(windowNamed('Abrindo a prova…')).toHaveTextContent('O Drive não respondeu.')
    expect(useUiStore.getState().overlay).toBeNull()
  })

  it('Prova da seleção: "Lendo as notas" com a contagem até juntar as questões', async () => {
    const { slow, ids } = await notes(3)
    const release = slow.hold()
    render(
      <>
        <FolderExamDialog folderId={null} fileIds={ids} />
        <BlockingWindow />
      </>,
    )
    await shown()
    const window_ = windowNamed('Juntando as questões…')
    expect(window_).toHaveTextContent('Lendo as notas')
    expect(window_).toHaveTextContent('0 de 3')
    await act(async () => {
      release()
      await settle()
    })
    noWindow()
    expect(screen.getByText(/Nenhum arquivo daqui tem prova ainda/)).toBeInTheDocument()
  })

  it('uma leitura que falha não deixa a tela presa: o motivo na janela e a prova fecha', async () => {
    const { slow, ids } = await notes(3)
    useUiStore.getState().open({ kind: 'folder-exam', folderId: null, fileIds: ids })
    slow.breakWith(new Error('O Drive não respondeu.'))
    render(
      <>
        <FolderExamDialog folderId={null} fileIds={ids} />
        <BlockingWindow />
      </>,
    )
    await act(async () => await settle())
    expect(windowNamed('Juntando as questões…')).toHaveTextContent('O Drive não respondeu.')
    expect(useUiStore.getState().overlay).toBeNull()
  })
})
