import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FileMeta, FileSidecar, FolderMeta, RecordingData, RecordingMark } from '@/types/domain'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { EntryPage } from '@/components/reader/EntryPage'
import { MediaPlayer, type MeetingMedia } from '@/components/reader/MediaPlayer'
import { MeetingTabs } from '@/components/reader/MeetingTabs'
import { defaultIndex, newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import type { LocalMedia } from '@/lib/recording/media-library'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const video: MeetingMedia = { url: 'blob:aula', available: true, video: true, request: async () => undefined }
const audio: MeetingMedia = { url: 'blob:aula', available: true, video: false, request: async () => undefined }

const play = vi.fn(async () => undefined)
const pause = vi.fn()
const onPlayFrom = vi.fn()
const onTime = vi.fn()
const onMark = vi.fn()

function renderPlayer(media: MeetingMedia, withMark = true) {
  const ref = createRef<HTMLMediaElement>()
  const view = render(
    <>
      <MediaPlayer player={ref} media={media} onTime={onTime} onPlayFrom={onPlayFrom} onMark={withMark ? onMark : undefined} />
      <input aria-label="Campo da página" />
    </>,
  )
  const element = document.querySelector('video, audio') as HTMLMediaElement
  Object.defineProperty(element, 'duration', { configurable: true, value: 100 })
  fireEvent.durationChange(element)
  return { ...view, element, region: screen.getByRole('region', { name: 'Player da gravação' }) }
}

const button = (name: string) => screen.getByRole('button', { name })
const maybeButton = (name: string) => screen.queryByRole('button', { name })

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const mock of [play, pause, onPlayFrom, onTime, onMark]) mock.mockClear()
})

describe('the mark button of the player', () => {
  it('without onMark there is no button and the B key does nothing', () => {
    const { element, region } = renderPlayer(audio, false)
    element.currentTime = 12
    expect(maybeButton('Marcar este momento')).not.toBeInTheDocument()
    fireEvent.keyDown(button('Tocar'), { key: 'b' })
    fireEvent.keyDown(region, { key: 'B' })
    expect(onMark).not.toHaveBeenCalled()
  })

  it('"Marcar este momento" marks where the media is, without playing or pausing it', () => {
    const { element } = renderPlayer(audio)
    element.currentTime = 42
    fireEvent.click(button('Marcar este momento'))
    expect(onMark).toHaveBeenCalledTimes(1)
    expect(onMark).toHaveBeenCalledWith(42)
    expect(play).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
    expect(button('Marcar este momento')).toHaveAttribute('title', 'Marcar este momento (B)')
  })

  it('marks a moment of a video that is playing, to a tenth of a second', () => {
    const { element } = renderPlayer(video)
    element.currentTime = 12.34
    fireEvent.play(element)
    fireEvent.timeUpdate(element)
    fireEvent.click(button('Marcar este momento'))
    expect(onMark).toHaveBeenCalledWith(12.3)
  })

  it('the B key, with the focus in the player, marks the moment (capital too)', () => {
    const { element, region } = renderPlayer(audio)
    element.currentTime = 30
    const play = button('Tocar')
    play.focus()
    fireEvent.keyDown(play, { key: 'b' })
    expect(onMark).toHaveBeenLastCalledWith(30)
    element.currentTime = 31
    fireEvent.keyDown(region, { key: 'B' })
    expect(onMark).toHaveBeenLastCalledWith(31)
    expect(onMark).toHaveBeenCalledTimes(2)
    // on the bar of the position, too
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Posição na gravação' }), { key: 'b' })
    expect(onMark).toHaveBeenCalledTimes(3)
  })

  it('B does not mark with Ctrl, Alt or Meta, nor while a field of the player keeps its keys', () => {
    const { element, region } = renderPlayer(audio)
    element.currentTime = 30
    fireEvent.keyDown(region, { key: 'b', ctrlKey: true })
    fireEvent.keyDown(region, { key: 'b', altKey: true })
    fireEvent.keyDown(region, { key: 'b', metaKey: true })
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Velocidade' }), { key: 'b' })
    expect(onMark).not.toHaveBeenCalled()
  })

  it('does not take the B typed in a field of the page', () => {
    renderPlayer(audio)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Campo da página' }), { key: 'b' })
    expect(onMark).not.toHaveBeenCalled()
  })

  it('the key B marks too on the open screen of a video, even with the focus out of the player', () => {
    const { element } = renderPlayer(video)
    fireEvent.click(button('Ampliar a tela'))
    element.currentTime = 77
    fireEvent.keyDown(document.body, { key: 'b' })
    expect(onMark).toHaveBeenCalledWith(77)
    expect(button('Marcar este momento')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Campo da página' }), { key: 'b' })
    expect(onMark).toHaveBeenCalledTimes(1)
  })

  it('waits for the media: with no file loaded yet it marks nothing', () => {
    renderPlayer({ ...audio, url: null })
    expect(button('Marcar este momento')).toBeDisabled()
    fireEvent.keyDown(button('Tocar'), { key: 'b' })
    expect(onMark).not.toHaveBeenCalled()
  })

  it('keeps the other keys and buttons as they were', () => {
    const { element } = renderPlayer(audio)
    element.currentTime = 10
    fireEvent.timeUpdate(element)
    fireEvent.keyDown(button('Tocar'), { key: 'k' })
    expect(onPlayFrom).toHaveBeenCalledWith(10)
    fireEvent.keyDown(button('Tocar'), { key: 'l' })
    expect(element.currentTime).toBe(20)
    expect(onMark).not.toHaveBeenCalled()
    expect(button('Voltar 10 segundos')).toBeInTheDocument()
    expect(button('Tirar o som')).toBeInTheDocument()
  })
})

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 20, text: 'Vamos começar.' },
    { speaker: 'speaker_0', start: 60, end: 70, text: 'O preço fica em dois mil.' },
    { speaker: 'mic', start: 80, end: 85, text: 'Fechado.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Marina', suggested: false },
  ],
  marks: [{ id: 'm1', kind: 'mark', at: 5, text: '' }],
}

function Note({ onMarks, extra }: { onMarks?(marks: RecordingMark[]): void; extra?: React.ReactNode }) {
  const [marks, setMarks] = useState(recording.marks)
  return <MeetingTabs recording={{ ...recording, marks }} media={audio} ata={extra} onMarks={onMarks && (next => (setMarks(next), onMarks(next)))} />
}

describe('marking a moment of a note with transcription', () => {
  it('the mark is created at the current time, empty, and opens for editing at its speech', () => {
    const saved = vi.fn()
    render(<Note onMarks={saved} />)
    const media = document.querySelector('audio')!
    media.currentTime = 65
    fireEvent.click(button('Marcar este momento'))
    expect(saved).toHaveBeenCalledTimes(1)
    const marks = saved.mock.calls[0][0] as RecordingMark[]
    expect(marks.map(mark => mark.at)).toEqual([5, 65])
    expect(marks[1]).toMatchObject({ kind: 'mark', at: 65, text: '' })
    const field = screen.getByRole('textbox', { name: 'Texto da anotação' })
    expect(field).toHaveFocus()
    expect(within(screen.getAllByRole('listitem')[1]).getByRole('textbox', { name: 'Texto da anotação' })).toBe(field)
    fireEvent.change(field, { target: { value: 'preço alto' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(saved).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'm1' }), expect.objectContaining({ kind: 'note', at: 65, text: 'preço alto' })])
    expect(screen.getByRole('note', { name: 'Anotação em 01:05' })).toHaveTextContent('preço alto')
  })

  it('the B key does the same, and a mark left empty stays as a flag', () => {
    const saved = vi.fn()
    render(<Note onMarks={saved} />)
    const media = document.querySelector('audio')!
    media.currentTime = 81
    const play = button('Tocar')
    play.focus()
    fireEvent.keyDown(play, { key: 'b' })
    const field = screen.getByRole('textbox', { name: 'Texto da anotação' })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('note', { name: 'Momento marcado em 01:21' })).toBeInTheDocument()
    expect(saved).toHaveBeenCalledTimes(1)
    expect((saved.mock.calls[0][0] as RecordingMark[]).at(-1)).toMatchObject({ kind: 'mark', at: 81, text: '' })
  })

  it('the speech marks are still there', () => {
    render(<Note onMarks={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: 'Marcar esta fala' })).toHaveLength(3)
  })

  it('from another tab, the new mark brings the transcription to the screen with the field open', () => {
    render(<Note onMarks={vi.fn()} extra={<p>Texto da Ata</p>} />)
    expect(screen.getByText('Texto da Ata')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Transcrição' })).not.toBeInTheDocument()
    document.querySelector('audio')!.currentTime = 70
    fireEvent.click(button('Marcar este momento'))
    expect(screen.getByRole('list', { name: 'Transcrição' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Texto da anotação' })).toBeInTheDocument()
  })

  it('a note that cannot be changed has no mark button', () => {
    render(<MeetingTabs recording={recording} media={audio} />)
    expect(maybeButton('Marcar este momento')).not.toBeInTheDocument()
    expect(maybeButton('Marcar esta fala')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// the library under the note and the entry page

const MB = 1024 * 1024
const day = (iso: string) => ({ at: iso, deviceId: 'd1', deviceName: 'Notebook' })
const CREATED = day('2026-11-03T12:00:00.000Z')
const SOUND = new File(['som da aula'], 'aula3.webm', { type: 'audio/webm' })
const AUDIO = { input: 'recording' as const, name: 'aula3.webm', mime: 'audio/webm', storage: 'none' as const }
const local = (id: string): LocalMedia => ({ storedName: 'a.webm', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 120, size: 2 * MB, createdAt: CREATED.at, fileIds: [id] })

let pasta: FolderMeta
let disk: Map<string, FileSidecar>

function seed(sidecars: FileSidecar[]) {
  disk = new Map(sidecars.map(sidecar => [sidecar.meta.id, sidecar]))
  const repo = {
    kind: 'local',
    accountId: 'local',
    readContent: async () => '',
    readSidecar: async (id: string) => disk.get(id)!,
    saveFile: async (saved: FileSidecar) => {
      disk.set(saved.meta.id, saved)
      return saved
    },
    saveIndex: async () => undefined,
    fileSizes: async () => ({}),
  } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [pasta], files: sidecars.map(item => item.meta), index: defaultIndex(), opened: {}, openedAt: {}, localMedia: sidecars.map(item => local(item.meta.id)), sharedView: null, sizes: {} })
}

function media(id: string, fields: Partial<FileMeta> = {}, extra: Partial<FileSidecar> = {}): FileSidecar {
  return { ...newSidecar(newFileMeta({ id, name: 'Aula 3', type: 'reading', role: 'entrada', kept: 'arquivo', origin: AUDIO, folderId: pasta.id, created: CREATED, updated: CREATED, ...fields })), ...extra }
}

const marksOnDisk = (id: string) => disk.get(id)?.recording?.marks

/** Seen through a link: read only, the notes come already open and the media comes from the link. */
function shared(id: string) {
  useLibraryStore.setState({
    sharedView: { item: { files: [{ id, media: { url: 'blob:midia', mime: 'audio/webm', size: 10 } }] } as never, rootId: null },
    opened: { [id]: { content: '', sidecar: disk.get(id)! } },
  })
}

/** The audio of the page, with its length known. */
async function loadedAudio(): Promise<HTMLAudioElement> {
  const element = await waitFor(() => {
    const found = document.querySelector('audio') as HTMLAudioElement | null
    expect(found).toHaveAttribute('src', 'blob:midia')
    return found!
  })
  Object.defineProperty(element, 'duration', { configurable: true, value: 120 })
  fireEvent.durationChange(element)
  return element
}

describe('marking a moment of a media note that has no transcription', () => {
  const createUrl = URL.createObjectURL
  const revokeUrl = URL.revokeObjectURL

  beforeEach(async () => {
    pasta = newFolderMeta({ id: 'pasta', name: 'Aulas' })
    URL.createObjectURL = vi.fn(() => 'blob:midia')
    URL.revokeObjectURL = vi.fn()
    const library = await import('@/lib/recording/media-library')
    vi.spyOn(library, 'readLocalMedia').mockResolvedValue(SOUND)
    useUiStore.setState({ overlay: null })
    useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  })

  afterEach(() => {
    cleanup()
    URL.createObjectURL = createUrl
    URL.revokeObjectURL = revokeUrl
  })

  const openNote = (id: string) =>
    render(
      <MemoryRouter>
        <DocumentBody fileId={id} />
      </MemoryRouter>,
    )

  it('creates the recording with no speech, saves the mark, and opens it for editing', async () => {
    seed([media('aula', { role: undefined })])
    openNote('aula')
    const element = await loadedAudio()
    element.currentTime = 30
    fireEvent.click(button('Marcar este momento'))
    const field = await screen.findByRole('textbox', { name: 'Texto da anotação' })
    await waitFor(() => expect(marksOnDisk('aula')).toHaveLength(1))
    expect(disk.get('aula')!.recording).toEqual({ blocks: [], speakers: [], marks: [expect.objectContaining({ kind: 'mark', at: 30, text: '' })] })
    fireEvent.change(field, { target: { value: 'refazer esta conta' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(marksOnDisk('aula')?.[0]).toMatchObject({ kind: 'note', at: 30, text: 'refazer esta conta' }))
    const list = screen.getByRole('region', { name: 'Momentos marcados' })
    expect(within(list).getByRole('note', { name: 'Anotação em 00:30' })).toHaveTextContent('refazer esta conta')
  })

  it('lists the marks, and a click on one plays from there; the media still offers to transcribe', async () => {
    const marks: RecordingMark[] = [
      { id: 'a', kind: 'mark', at: 65, text: '' },
      { id: 'b', kind: 'note', at: 20, text: 'definição' },
    ]
    seed([media('aula', { role: undefined }, { recording: { blocks: [], speakers: [], marks } })])
    openNote('aula')
    const element = await loadedAudio()
    const list = screen.getByRole('region', { name: 'Momentos marcados' })
    expect(within(list).getAllByRole('note')).toHaveLength(2)
    fireEvent.click(within(list).getByRole('button', { name: 'Tocar a partir de 01:05' }))
    expect(element.currentTime).toBe(65)
    expect(play).toHaveBeenCalledTimes(1)
    fireEvent.click(within(list).getByRole('button', { name: 'Tocar a partir de 00:20' }))
    expect(element.currentTime).toBe(20)
    expect(screen.getByRole('button', { name: /Transcrever agora/ })).toBeInTheDocument()
  })

  it('a mark can be edited and deleted from the list, and it stays so', async () => {
    seed([media('aula', { role: undefined }, { recording: { blocks: [], speakers: [], marks: [{ id: 'a', kind: 'mark', at: 65, text: '' }] } })])
    openNote('aula')
    await loadedAudio()
    fireEvent.click(screen.getByRole('button', { name: 'Editar a marcação de 01:05' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Texto da anotação' }), { target: { value: 'dúvida' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Texto da anotação' }), { key: 'Enter' })
    await waitFor(() => expect(marksOnDisk('aula')?.[0]).toMatchObject({ kind: 'note', text: 'dúvida' }))
    fireEvent.click(screen.getByRole('button', { name: 'Editar a anotação de 01:05' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apagar a anotação de 01:05' }))
    await waitFor(() => expect(marksOnDisk('aula')).toEqual([]))
    expect(screen.queryByRole('region', { name: 'Momentos marcados' })).not.toBeInTheDocument()
  })

  it('the B key marks too', async () => {
    seed([media('aula', { role: undefined })])
    openNote('aula')
    const element = await loadedAudio()
    element.currentTime = 44
    fireEvent.keyDown(button('Tocar'), { key: 'b' })
    await screen.findByRole('textbox', { name: 'Texto da anotação' })
    await waitFor(() => expect(marksOnDisk('aula')?.[0]).toMatchObject({ at: 44 }))
  })

  it('in a shared note the marks are listed and played, nothing else', async () => {
    seed([media('aula', { role: undefined }, { recording: { blocks: [], speakers: [], marks: [{ id: 'a', kind: 'note', at: 65, text: 'olhar' }] } })])
    shared('aula')
    openNote('aula')
    await waitFor(() => expect(document.querySelector('audio')).toBeInTheDocument())
    const list = await screen.findByRole('region', { name: 'Momentos marcados' })
    expect(within(list).getByRole('button', { name: 'Tocar a partir de 01:05' })).toBeInTheDocument()
    expect(maybeButton('Marcar este momento')).not.toBeInTheDocument()
    expect(maybeButton('Editar a anotação de 01:05')).not.toBeInTheDocument()
  })
})

describe('marking a moment on the entry page', () => {
  const createUrl = URL.createObjectURL
  const revokeUrl = URL.revokeObjectURL

  beforeEach(async () => {
    pasta = newFolderMeta({ id: 'pasta', name: 'Aulas' })
    URL.createObjectURL = vi.fn(() => 'blob:midia')
    URL.revokeObjectURL = vi.fn()
    const library = await import('@/lib/recording/media-library')
    vi.spyOn(library, 'readLocalMedia').mockResolvedValue(SOUND)
    useUiStore.setState({ overlay: null })
    useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  })

  afterEach(() => {
    cleanup()
    URL.createObjectURL = createUrl
    URL.revokeObjectURL = revokeUrl
  })

  const openEntry = (id: string) =>
    render(
      <MemoryRouter>
        <EntryPage fileId={id} />
      </MemoryRouter>,
    )
  const card = (name: string) => screen.getByRole('region', { name })

  it('without transcription: the button in the player makes the mark, saved in the entrada and listed in the transcription card', async () => {
    seed([media('e')])
    openEntry('e')
    const element = await loadedAudio()
    element.currentTime = 33
    fireEvent.click(within(card('Original')).getByRole('button', { name: 'Marcar este momento' }))
    const field = await within(card('Transcrição')).findByRole('textbox', { name: 'Texto da anotação' })
    expect(field).toHaveFocus()
    await waitFor(() => expect(disk.get('e')!.recording).toEqual({ blocks: [], speakers: [], marks: [expect.objectContaining({ kind: 'mark', at: 33, text: '' })] }))
    fireEvent.change(field, { target: { value: 'pergunta para o professor' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(marksOnDisk('e')?.[0]).toMatchObject({ kind: 'note', at: 33, text: 'pergunta para o professor' }))
    const list = within(card('Transcrição')).getByRole('region', { name: 'Momentos marcados' })
    expect(within(list).getByRole('note', { name: 'Anotação em 00:33' })).toHaveTextContent('pergunta para o professor')
    // the card still says it has no transcription, and offers it
    expect(within(card('Transcrição')).getByText('Sem transcrição ainda')).toBeInTheDocument()
  })

  it('the marks of an entrada without transcription are listed, and a click plays from there', async () => {
    seed([media('e', {}, { recording: { blocks: [], speakers: [], marks: [{ id: 'a', kind: 'note', at: 65, text: 'conceito novo' }, { id: 'b', kind: 'mark', at: 100, text: '' }] } })])
    openEntry('e')
    const element = await loadedAudio()
    const list = within(card('Transcrição')).getByRole('region', { name: 'Momentos marcados' })
    expect(within(list).getAllByRole('note')).toHaveLength(2)
    fireEvent.click(within(list).getByRole('button', { name: 'Tocar a partir de 01:05' }))
    expect(element.currentTime).toBe(65)
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('with a transcription: the mark opens inside its speech, and every speech can be marked too', async () => {
    seed([media('e', {}, { transcript: 'Você: Vamos começar.', recording })])
    openEntry('e')
    const element = await loadedAudio()
    await within(card('Transcrição')).findByText('O preço fica em dois mil.')
    expect(within(card('Transcrição')).getAllByRole('button', { name: 'Marcar esta fala' })).toHaveLength(3)
    element.currentTime = 66
    fireEvent.click(within(card('Original')).getByRole('button', { name: 'Marcar este momento' }))
    const field = await screen.findByRole('textbox', { name: 'Texto da anotação' })
    expect(within(within(card('Transcrição')).getAllByRole('listitem')[1]).getByRole('textbox', { name: 'Texto da anotação' })).toBe(field)
    await waitFor(() => expect(marksOnDisk('e')?.map(mark => mark.at)).toEqual([5, 66]))
    // the entrada does not grow a second list: its marks are inside the speeches
    expect(within(card('Transcrição')).queryByRole('region', { name: 'Momentos marcados' })).not.toBeInTheDocument()
  })

  it('a mark made on a speech is saved too', async () => {
    seed([media('e', {}, { transcript: 'Você: Vamos começar.', recording })])
    openEntry('e')
    await loadedAudio()
    fireEvent.click(within((await within(card('Transcrição')).findAllByRole('listitem'))[2]).getByRole('button', { name: 'Marcar esta fala' }))
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Texto da anotação' }), { key: 'Escape' })
    await waitFor(() => expect(marksOnDisk('e')?.map(mark => mark.at)).toEqual([5, 80]))
  })

  it('in a shared entrada the marks are listed and played, and nothing can be marked', async () => {
    seed([media('e', {}, { recording: { blocks: [], speakers: [], marks: [{ id: 'a', kind: 'note', at: 65, text: 'olhar' }] } })])
    shared('e')
    openEntry('e')
    const list = await within(card('Transcrição')).findByRole('region', { name: 'Momentos marcados' })
    expect(within(list).getByRole('button', { name: 'Tocar a partir de 01:05' })).toBeInTheDocument()
    expect(maybeButton('Marcar este momento')).not.toBeInTheDocument()
    expect(maybeButton('Editar a anotação de 01:05')).not.toBeInTheDocument()
  })
})
