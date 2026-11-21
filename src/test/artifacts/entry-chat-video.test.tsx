import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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

import { TutorDialog } from '@/components/dialogs/TutorDialog'
import { type CapturedRequest, installFetch, openAiStream } from '@/test/ai/fake-provider'
import { chatEntry, seedConversations } from '@/test/artifacts/entry-chat-helpers'

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
  installFetch((_request: CapturedRequest) => openAiStream('Foi o Rafael, em 01:40.'))
})

afterEach(() => {
  URL.createObjectURL = created
  URL.revokeObjectURL = revoked ?? (() => undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const dialog = () => screen.getByRole('dialog', { name: /^Chat:/ })
const player = () => screen.findByRole('region', { name: 'Player da gravação' })

describe('Chat de um vídeo: o player fica ao lado da conversa', () => {
  it('duas colunas: o vídeo de um lado e a conversa do outro, com o player fora da coluna da conversa', async () => {
    const { entry } = await chatEntry({ kept, media: 'video' })
    render(<TutorDialog fileId={entry} chat />)
    const region = await player()
    const split = dialog().querySelector('.tutor-split')!
    expect(split).not.toBeNull()
    const media = split.querySelector(':scope > .tutor-media')!
    const chat = split.querySelector(':scope > .tutor-chat')!
    expect(media).toContainElement(region)
    expect(chat).not.toContainElement(region)
    // the video comes first: on the left on a desktop, on top on a phone
    expect(split.firstElementChild).toBe(media)
    expect(within(chat as HTMLElement).getByRole('list', { name: 'Conversa do chat' })).toBeInTheDocument()
    expect(within(chat as HTMLElement).getByRole('textbox', { name: 'Sua pergunta ou resposta' })).toBeInTheDocument()
    expect(region.querySelector('video')).not.toBeNull()
  })

  it('o player do vídeo vem grande na coluna (encaixado), não na barra pequena de antes', async () => {
    const { entry } = await chatEntry({ kept, media: 'video' })
    render(<TutorDialog fileId={entry} chat />)
    const region = await player()
    expect(region.querySelector('.mplayer-box')).toHaveAttribute('data-docked', 'true')
  })

  it('a janela cresce para o tamanho largo quando há vídeo', async () => {
    const { entry } = await chatEntry({ kept, media: 'video' })
    render(<TutorDialog fileId={entry} chat />)
    await player()
    expect(dialog().style.width).toBe('min(1200px, 100%)')
  })

  it('clicar na hora da resposta toca o vídeo do lado, sem fechar nem sair da conversa', async () => {
    const { entry } = await chatEntry({ kept, media: 'video' })
    render(<TutorDialog fileId={entry} chat />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: 'Quem pediu mais prazo?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    const reply = await screen.findByTestId('reply')
    const region = await player()
    await waitFor(() => expect(region.querySelector('video')).toHaveAttribute('src', 'blob:reuniao'))
    fireEvent.click(reply.querySelector('a[href="#t=100"]')!)
    expect((region.querySelector('video') as HTMLMediaElement).currentTime).toBe(100)
    expect(play).toHaveBeenCalled()
    expect(dialog()).toBeInTheDocument()
  })

  it('a lista de conversas aparece na coluna da conversa, o vídeo continua na tela', async () => {
    const { entry } = await chatEntry({ kept, media: 'video' })
    await seedConversations(entry, [{ id: 'c1', turns: [{ who: 'você', text: 'Qual o prazo?' }, { who: 'tutor', text: 'Março.' }], updatedAt: '2026-11-05T12:00:00.000Z', scope: 'chat' }])
    render(<TutorDialog fileId={entry} chat />)
    const region = await player()
    fireEvent.click(screen.getByRole('button', { name: /^Conversas/ }))
    const chat = dialog().querySelector('.tutor-split > .tutor-chat')!
    expect(within(chat as HTMLElement).getByRole('list', { name: 'Conversas do chat' })).toBeInTheDocument()
    expect(region).toBeInTheDocument()
  })
})

describe('Chat de um áudio ou de uma entrada sem mídia', () => {
  it('áudio: continua a barra pequena embaixo da conversa, numa coluna só', async () => {
    const { entry } = await chatEntry({ kept, media: 'audio' })
    render(<TutorDialog fileId={entry} chat />)
    const region = await player()
    expect(dialog().querySelector('.tutor-split')).toBeNull()
    expect(region.querySelector('audio')).not.toBeNull()
    expect(region.querySelector('.mplayer-box')).not.toHaveAttribute('data-docked')
    expect(dialog().style.width).toBe('')
    const talk = screen.getByRole('list', { name: 'Conversa do chat' })
    expect(talk.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('sem mídia guardada: sem player e sem colunas', async () => {
    const { entry } = await chatEntry({ kept, media: 'none' })
    render(<TutorDialog fileId={entry} chat />)
    expect(screen.queryByRole('region', { name: 'Player da gravação' })).not.toBeInTheDocument()
    expect(dialog().querySelector('.tutor-split')).toBeNull()
  })
})
