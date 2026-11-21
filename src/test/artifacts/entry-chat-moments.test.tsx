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
import { momentLinks, momentPieces } from '@/lib/generation/moment-links'
import { type CapturedRequest, installFetch, openAiStream } from '@/test/ai/fake-provider'
import { chatEntry } from '@/test/artifacts/entry-chat-helpers'

const NB = ' '
/** The play link as the Ata writes it. */
const link = (label: string, at: number) => `[▸${NB}${label}](#t=${at})`

describe('o horário citado vira link em qualquer forma de escrever', () => {
  it('"[01:40]" e "[1:02:03]" entre colchetes continuam virando link', () => {
    expect(momentLinks('Foi o Rafael, em [01:40].')).toBe(`Foi o Rafael, em ${link('01:40', 100)}.`)
    expect(momentLinks('Lá pelo fim [1:02:03]')).toBe(`Lá pelo fim ${link('1:02:03', 3723)}`)
  })

  it('sem colchetes: "em 01:40", "aos 1:02:03" e "(12:05)"', () => {
    expect(momentLinks('Isso foi dito em 01:40 pelo Rafael.')).toBe(`Isso foi dito em ${link('01:40', 100)} pelo Rafael.`)
    expect(momentLinks('Fechou aos 1:02:03.')).toBe(`Fechou aos ${link('1:02:03', 3723)}.`)
    expect(momentLinks('O prazo mudou (12:05) de novo.')).toBe(`O prazo mudou (${link('12:05', 725)}) de novo.`)
    expect(momentLinks('01:40 abre a conversa')).toBe(`${link('01:40', 100)} abre a conversa`)
  })

  it('faixa "01:40–02:10": os dois lados viram link, com travessão, hífen ou espaços', () => {
    expect(momentLinks('Veja 01:40–02:10.')).toBe(`Veja ${link('01:40', 100)}–${link('02:10', 130)}.`)
    expect(momentLinks('Veja 01:40-02:10.')).toBe(`Veja ${link('01:40', 100)}-${link('02:10', 130)}.`)
    expect(momentLinks('Veja 01:40 – 02:10.')).toBe(`Veja ${link('01:40', 100)} – ${link('02:10', 130)}.`)
  })

  it('faixa entre colchetes: os colchetes saem, os dois lados viram link', () => {
    expect(momentLinks('Veja [01:40–02:10].')).toBe(`Veja ${link('01:40', 100)}–${link('02:10', 130)}.`)
  })

  it('vários horários na mesma linha', () => {
    expect(momentLinks('Em 00:12 e em 01:40, e de novo [00:12].')).toBe(`Em ${link('00:12', 12)} e em ${link('01:40', 100)}, e de novo ${link('00:12', 12)}.`)
  })

  it('nunca dentro de bloco de código nem de código na linha', () => {
    expect(momentLinks('```\nem 01:40 [01:40]\n```\nem 00:05')).toBe(`\`\`\`\nem 01:40 [01:40]\n\`\`\`\nem ${link('00:05', 5)}`)
    expect(momentLinks('~~~\n01:40\n~~~\n01:40')).toBe(`~~~\n01:40\n~~~\n${link('01:40', 100)}`)
    expect(momentLinks('Use `01:40` ou 01:41.')).toBe(`Use \`01:40\` ou ${link('01:41', 101)}.`)
  })

  it('o que já é link, endereço e tag ficam como estão', () => {
    expect(momentLinks('[▸ 01:40](#t=100) e [01:40](#t=100)')).toBe('[▸ 01:40](#t=100) e [01:40](#t=100)')
    expect(momentLinks('[Ata de 01:40](https://exemplo.dev/a)')).toBe('[Ata de 01:40](https://exemplo.dev/a)')
    expect(momentLinks('https://exemplo.dev/video?t=01:40 e <https://exemplo.dev/01:40>')).toBe('https://exemplo.dev/video?t=01:40 e <https://exemplo.dev/01:40>')
  })

  it('hora impossível e número que não é horário ficam como texto', () => {
    expect(momentLinks('[01:75]')).toBe('[01:75]')
    expect(momentLinks('em 01:75')).toBe('em 01:75')
    expect(momentLinks('versão 3.01:40 e razão 12:123 e 1:234')).toBe('versão 3.01:40 e razão 12:123 e 1:234')
    expect(momentLinks('1:75:10 e 1:02:75')).toBe('1:75:10 e 1:02:75')
  })

  it('depois do fim da mídia não vira link; o resto da frase continua', () => {
    expect(momentLinks('Em 01:40 e em 12:05.', 300)).toBe(`Em ${link('01:40', 100)} e em 12:05.`)
    expect(momentLinks('Em [12:05].', 300)).toBe('Em [12:05].')
    expect(momentLinks('Fim em 05:00.', 300)).toBe(`Fim em ${link('05:00', 300)}.`)
    expect(momentLinks('Em 12:05.')).toBe(`Em ${link('12:05', 725)}.`)
  })

  it('faixa que passa do fim: só o lado de dentro vira link', () => {
    expect(momentLinks('Veja 04:50–06:00.', 300)).toBe(`Veja ${link('04:50', 290)}–06:00.`)
  })

  it('para a fala da pessoa, os pedaços: texto e horários', () => {
    expect(momentPieces('volta no 01:40 e no 12:05', 300)).toEqual(['volta no ', { at: 100 }, ' e no 12:05'])
    expect(momentPieces('sem horário')).toEqual(['sem horário'])
    expect(momentPieces('01:40–02:10')).toEqual([{ at: 100 }, '–', { at: 130 }])
  })
})

const play = vi.fn(async () => undefined)
const created = URL.createObjectURL
const revoked = URL.revokeObjectURL
let reply = ''

beforeEach(() => {
  kept.clear()
  play.mockClear()
  reply = 'Foi o Rafael, em 01:40.'
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  URL.createObjectURL = vi.fn(() => 'blob:reuniao')
  URL.revokeObjectURL = vi.fn()
  installFetch((_request: CapturedRequest) => openAiStream(reply))
})

afterEach(() => {
  URL.createObjectURL = created
  URL.revokeObjectURL = revoked ?? (() => undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function ask(question: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  return screen.findByTestId('reply')
}

const talk = () => screen.getByRole('list', { name: 'Conversa do chat' })

describe('no Chat, o horário sem colchetes também toca o trecho', () => {
  it('a resposta com "em 01:40" (sem colchetes) tem link que toca a mídia daquele segundo', async () => {
    const { entry } = await chatEntry({ kept })
    render(<TutorDialog fileId={entry} chat />)
    const answer = await ask('Quem pediu mais prazo?')
    const player = await screen.findByRole('region', { name: 'Player da gravação' })
    await waitFor(() => expect(player.querySelector('audio, video')).toHaveAttribute('src', 'blob:reuniao'))
    fireEvent.click(answer.querySelector('a[href="#t=100"]')!)
    expect((player.querySelector('audio, video') as HTMLMediaElement).currentTime).toBe(100)
    expect(play).toHaveBeenCalled()
  })

  it('horário depois do fim da mídia (5 min) fica como texto; o de dentro vira link', async () => {
    reply = 'Foi em 01:40 e de novo aos 12:05.'
    const { entry } = await chatEntry({ kept, seconds: 300 })
    render(<TutorDialog fileId={entry} chat />)
    const answer = await ask('Quando foi?')
    expect(answer.querySelectorAll('a')).toHaveLength(1)
    expect(answer.querySelector('a')).toHaveAttribute('href', '#t=100')
    expect(answer.textContent).toContain('12:05')
  })

  it('sem o tamanho guardado, vale o do próprio player quando ele carrega', async () => {
    reply = 'Foi em 01:40 e de novo aos 05:00.'
    const { entry } = await chatEntry({ kept, seconds: 0 })
    render(<TutorDialog fileId={entry} chat />)
    const player = await screen.findByRole('region', { name: 'Player da gravação' })
    const element = player.querySelector('audio, video') as HTMLMediaElement
    Object.defineProperty(element, 'duration', { configurable: true, get: () => 200 })
    fireEvent(element, new Event('durationchange'))
    const answer = await ask('Quando foi?')
    expect(answer.querySelectorAll('a')).toHaveLength(1)
    expect(answer.querySelector('a')).toHaveAttribute('href', '#t=100')
  })

  it('o que a pessoa digita também vira link: "volta no 01:40" toca daquele segundo', async () => {
    const { entry } = await chatEntry({ kept })
    render(<TutorDialog fileId={entry} chat />)
    await ask('O que foi dito no 01:40 e no 12:05?')
    const player = await screen.findByRole('region', { name: 'Player da gravação' })
    await waitFor(() => expect(player.querySelector('audio, video')).toHaveAttribute('src', 'blob:reuniao'))
    const mine = within(talk()).getAllByRole('listitem')[0]
    const links = within(mine).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveTextContent('01:40')
    expect(mine.textContent).toContain('12:05')
    fireEvent.click(links[0])
    expect((player.querySelector('audio, video') as HTMLMediaElement).currentTime).toBe(100)
    expect(screen.getByRole('dialog', { name: /^Chat:/ })).toBeInTheDocument()
  })

  it('sem mídia para tocar a fala da pessoa fica só texto', async () => {
    const { entry } = await chatEntry({ kept, media: 'none' })
    render(<TutorDialog fileId={entry} chat />)
    await ask('O que foi dito no 01:40?')
    const mine = within(talk()).getAllByRole('listitem')[0]
    expect(within(mine).queryByRole('link')).not.toBeInTheDocument()
    expect(mine.textContent).toContain('01:40')
  })
})
