import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const kept = vi.hoisted(() => new Map<string, File>())

vi.mock('@/lib/recording/media-library', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/recording/media-library')>()),
  readLocalMedia: vi.fn(async (item: { fileIds: string[] }) => kept.get(item.fileIds[0])!),
}))
// the reply as plain links: the real viewer draws it in a shadow root
vi.mock('@/components/reader/GithubMarkdownView', async importOriginal => ({
  ...(await importOriginal<typeof import('@/components/reader/GithubMarkdownView')>()),
  default: ({ markdown }: { markdown: string }) => <div data-testid="reply" dangerouslySetInnerHTML={{ __html: markdown.replace(/\[([^\]]+)\]\((#t=\d+)\)/g, '<a href="$2">$1</a>') }} />,
}))

import type { RecordingData } from '@/types/domain'
import { TutorDialog } from '@/components/dialogs/TutorDialog'
import { momentLinks } from '@/lib/generation/moment-links'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream } from '@/test/ai/fake-provider'
import { studyLibrary } from '@/test/generation/study-fixture'

const NB = ' '

describe('horário da resposta vira link que toca o trecho', () => {
  it('"[01:40]" e "[1:02:03]" viram "▸ hora" que toca daquele segundo', () => {
    expect(momentLinks('Foi o Rafael, em [01:40].')).toBe(`Foi o Rafael, em [▸${NB}01:40](#t=100).`)
    expect(momentLinks('Lá pelo fim [1:02:03]')).toBe(`Lá pelo fim [▸${NB}1:02:03](#t=3723)`)
  })

  it('o que já é link, hora impossível e bloco de código ficam como estão', () => {
    expect(momentLinks('[▸ 01:40](#t=100) e [01:40](#t=100)')).toBe('[▸ 01:40](#t=100) e [01:40](#t=100)')
    expect(momentLinks('[01:75]')).toBe('[01:75]')
    expect(momentLinks('```\n[01:40]\n```\n[00:05]')).toBe(`\`\`\`\n[01:40]\n\`\`\`\n[▸${NB}00:05](#t=5)`)
  })
})

const RECORDING: RecordingData = {
  blocks: [
    { speaker: 's1', start: 12, end: 20, text: 'O prazo do portal novo é março.' },
    { speaker: 's2', start: 100, end: 110, text: 'O fornecedor pediu mais duas semanas.' },
  ],
  speakers: [
    { id: 's1', name: 'Marina', suggested: false },
    { id: 's2', name: 'Rafael', suggested: false },
  ],
  marks: [],
}

const play = vi.fn(async () => undefined)
const created = URL.createObjectURL
const revoked = URL.revokeObjectURL

beforeEach(() => {
  kept.clear()
  play.mockClear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  URL.createObjectURL = vi.fn(() => 'blob:reuniao')
  URL.revokeObjectURL = vi.fn()
  installFetch((_request: CapturedRequest) => openAiStream('Foi o Rafael, em [01:40].'))
})

afterEach(() => {
  URL.createObjectURL = created
  URL.revokeObjectURL = revoked ?? (() => undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** An entrada with its recording and the audio kept in this browser, and the Ata born of it. */
async function meeting(withMedia = true) {
  studyLibrary()
  const library = useLibraryStore.getState()
  const entry = await library.createFile({ name: 'Reunião de kickoff.webm', type: 'reading', role: 'entrada', folderId: null, origin: { input: 'recording', name: 'Reunião de kickoff.webm', mime: 'audio/webm', storage: 'none' } }, 'texto corrido')
  await library.updateSidecar(entry.id, sidecar => ({ ...sidecar, recording: RECORDING }))
  const ata = await library.createFile({ name: 'Ata do kickoff', type: 'meeting', parentFileId: entry.id, folderId: null }, '# Ata\n\nPrazo do portal: março.')
  if (withMedia) {
    kept.set(entry.id, new File(['som'], 'Reunião de kickoff.webm', { type: 'audio/webm' }))
    useLibraryStore.setState({ localMedia: [{ storedName: 'envio-1', name: 'Reunião de kickoff.webm', mime: 'audio/webm', durationSeconds: 300, size: 3, createdAt: '', fileIds: [entry.id] }] })
  }
  return { entry: entry.id, ata: ata.id }
}

async function ask(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  return screen.findByTestId('reply')
}

describe('clicar na hora toca o trecho exato', () => {
  it('no Chat da mídia: toca a mídia da entrada a partir daquele segundo, sem sair da conversa', async () => {
    const { entry } = await meeting()
    render(<TutorDialog fileId={entry} chat />)
    const reply = await ask('Quem pediu mais prazo?')
    const player = await screen.findByRole('region', { name: 'Player da gravação' })
    await waitFor(() => expect(player.querySelector('audio, video')).toHaveAttribute('src', 'blob:reuniao'))
    fireEvent.click(reply.querySelector('a[href="#t=100"]')!)
    expect((player.querySelector('audio, video') as HTMLMediaElement).currentTime).toBe(100)
    expect(play).toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Chat: Reunião de kickoff.webm' })).toBeInTheDocument()
  })

  it('no Tutor de uma nota nascida da gravação: toca a mídia da entrada de onde ela nasceu', async () => {
    const { ata } = await meeting()
    render(<TutorDialog fileId={ata} />)
    const reply = await ask('Quem pediu mais prazo?')
    const player = await screen.findByRole('region', { name: 'Player da gravação' })
    await waitFor(() => expect(player.querySelector('audio, video')).toHaveAttribute('src', 'blob:reuniao'))
    fireEvent.click(reply.querySelector('a[href="#t=100"]')!)
    expect((player.querySelector('audio, video') as HTMLMediaElement).currentTime).toBe(100)
  })

  it('sem mídia para tocar: a hora fica como texto e não há player', async () => {
    const { entry } = await meeting(false)
    render(<TutorDialog fileId={entry} chat />)
    const reply = await ask('Quem pediu mais prazo?')
    expect(reply.textContent).toBe('Foi o Rafael, em [01:40].')
    expect(reply.querySelector('a')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Player da gravação' })).not.toBeInTheDocument()
  })
})
