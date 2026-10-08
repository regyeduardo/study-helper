import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { MeetingTabs } from '@/components/reader/MeetingTabs'
import { buildMinutes, renderMinutes } from '@/lib/generation/minutes'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { GenerationSession } from '@/lib/generation/session'
import { installFetch, llm7Settings, openAiStream, systemPromptOf, userContentOf } from '@/test/ai/fake-provider'
import type { RecordingData } from '@/types/domain'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 700, end: 705, text: 'E o preço, como fica?' },
    { speaker: 'speaker_0', start: 760, end: 768, text: 'Fica dois mil por mês, fechado com o fornecedor.' },
    { speaker: 'mic', start: 770, end: 772, text: 'Perfeito.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Marina', suggested: false },
  ],
  marks: [],
}

const decision = (extra: Record<string, unknown>) => ({ assunto: 'Preço', temas: [{ tema: 'Preço', pontos: [{ texto: 'O preço fica em dois mil por mês.', ...extra }] }], passos: [] })

function Minutes({ markdown }: { markdown: string }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' })
    root.innerHTML = markdown.replace(/\[([^\]]+)\]\((#t=\d+)\)/g, '<a href="$2">$1</a>')
  }, [markdown])
  return <div ref={host} data-testid="minutes" />
}

const play = vi.fn(async () => undefined)

beforeEach(() => {
  play.mockClear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('minutes items point to the moment of the speech', () => {
  it('a point whose quote is in the 12:40 speech gets a link to 12:40', () => {
    const markdown = renderMinutes(decision({ citacao: 'Fica dois mil por mês', hora: '12:40' }), recording)
    expect(markdown).toContain('- O preço fica em dois mil por mês. [▸ 12:40](#t=760)')
  })

  it('in a long speech the link goes to the sentence that was quoted, not to the start of the speech', () => {
    const long: RecordingData = { ...recording, blocks: [{ speaker: 'speaker_0', start: 100, end: 140, text: 'Primeiro a gente fala do prazo que ficou para março. Depois o preço fica em dois mil.' }] }
    expect(renderMinutes(decision({ citacao: 'o preço fica em dois mil', hora: '01:40' }), long)).toContain('[▸ 02:08](#t=128)')
  })

  it('finds the speech by the quote when the model gives no time or a time that does not exist', () => {
    expect(renderMinutes(decision({ citacao: 'Fica dois mil por mês, fechado' }), recording)).toContain('[▸ 12:40](#t=760)')
    expect(renderMinutes(decision({ citacao: 'Fica dois mil por mês', hora: '55:55' }), recording)).toContain('[▸ 12:40](#t=760)')
  })

  it('a quote that is in no speech gets no link, and without a recording nothing changes', () => {
    expect(renderMinutes(decision({ citacao: 'nunca foi dito', hora: '' }), recording)).toContain('- O preço fica em dois mil por mês.\n')
    expect(renderMinutes(decision({ citacao: 'Fica dois mil por mês', hora: '12:40' }))).toContain('- O preço fica em dois mil por mês.\n')
  })

  it('the minutes come by subject: each theme with its points, then the next steps', () => {
    const markdown = renderMinutes(
      {
        assunto: 'Preço do fornecedor',
        temas: [
          { tema: 'Preço', pontos: [{ texto: 'O preço fica em dois mil por mês.', citacao: 'Fica dois mil por mês', hora: '12:40' }, { texto: '  ' }] },
          { tema: 'Frete', pontos: [{ texto: 'Ninguém sabe quem paga o frete.', citacao: 'E o preço, como fica?', hora: '11:40' }] },
          { tema: 'Vazio', pontos: [] },
        ],
        passos: [
          { texto: 'Confirmar com o fornecedor', quem: 'Marina', quando: 'sexta', citacao: 'fechado com o fornecedor', hora: '12:40' },
          { texto: 'Pedir cotação de frete', quem: '', quando: '' },
        ],
      },
      recording,
    )
    expect(markdown).toBe(
      [
        '# Preço do fornecedor',
        '',
        '### Preço',
        '- O preço fica em dois mil por mês. [▸ 12:40](#t=760)',
        '',
        '### Frete',
        '- Ninguém sabe quem paga o frete. [▸ 11:40](#t=700)',
        '',
        '**Próximos passos**',
        '- [ ] Confirmar com o fornecedor — Marina · sexta [▸ 12:43](#t=763)',
        '- [ ] Pedir cotação de frete — sem dono · sem prazo',
        '',
      ].join('\n'),
    )
  })

  it('one piece of transcription is written in one call, reading every speech with who said it and when', async () => {
    const { calls } = installFetch(request =>
      systemPromptOf(request) === PROMPTS.MINUTES_EXTRACT_PROMPT ? openAiStream(JSON.stringify(decision({ citacao: 'Fica dois mil por mês', hora: '12:40' }))) : new Response('x', { status: 500 }),
    )
    const { markdown, subject } = await buildMinutes('', new GenerationSession(llm7Settings()), () => {}, recording)
    expect(calls).toHaveLength(1)
    expect(userContentOf(calls[0])).toBe('Você [11:40]: E o preço, como fica?\nMarina [12:40]: Fica dois mil por mês, fechado com o fornecedor.\nVocê [12:50]: Perfeito.\n')
    expect(PROMPTS.MINUTES_EXTRACT_PROMPT).toContain('"hora"')
    expect(PROMPTS.MINUTES_EXTRACT_PROMPT).toContain('"temas"')
    expect(subject).toBe('Preço')
    expect(markdown).toContain('[▸ 12:40](#t=760)')
  })
})

describe('clicking a minutes item', () => {
  const media = { url: 'blob:reuniao', available: true, video: false, request: async () => undefined }

  it('puts the player at 12:40, plays and shows the speech', () => {
    const markdown = renderMinutes(decision({ citacao: 'Fica dois mil por mês', hora: '12:40' }), recording)
    render(<MeetingTabs recording={recording} media={media} second={{ label: 'Ata', node: <Minutes markdown={markdown} /> }} />)
    expect(screen.getByRole('tab', { name: 'Ata' })).toHaveAttribute('aria-selected', 'true')
    const link = screen.getByTestId('minutes').shadowRoot!.querySelector('a')!
    expect(link.textContent).toBe('▸ 12:40')
    const click = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true })
    fireEvent(link, click)
    expect(click.defaultPrevented).toBe(true)
    expect(document.querySelector('audio')!.currentTime).toBe(760)
    expect(play).toHaveBeenCalledTimes(1)
    const now = screen.getByRole('button', { name: /Ver na transcrição/ })
    expect(now).toHaveTextContent('Marina')
    expect(now).toHaveTextContent('Fica dois mil por mês, fechado com o fornecedor.')
  })

  it('"ver na transcrição" opens the Transcrição tab on the speech being played', () => {
    const markdown = renderMinutes(decision({ citacao: 'Fica dois mil por mês', hora: '12:40' }), recording)
    render(<MeetingTabs recording={recording} media={media} second={{ label: 'Ata', node: <Minutes markdown={markdown} /> }} />)
    fireEvent(screen.getByTestId('minutes').shadowRoot!.querySelector('a')!, new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }))
    fireEvent.click(screen.getByRole('button', { name: /Ver na transcrição/ }))
    expect(screen.getByRole('tab', { name: 'Transcrição' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('listitem').map(block => block.getAttribute('aria-current'))).toEqual([null, 'true', null])
  })
})
