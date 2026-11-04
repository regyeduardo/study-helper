import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { TutorDialog } from '@/components/dialogs/TutorDialog'
import { PROMPTS } from '@/lib/generation/prompts.data'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const inputs: string[] = []

function userText(request: CapturedRequest): string {
  const messages = (request.body?.messages ?? []) as { role: string; content: string }[]
  return messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
}

beforeEach(() => {
  inputs.length = 0
  installFetch((request: CapturedRequest) => {
    expect(systemPromptOf(request)).toBe(PROMPTS.TUTOR_PROMPT)
    const text = userText(request)
    inputs.push(text)
    if (text.includes('Modo: testar') && !text.includes('Pessoa:')) return openAiStream('Quando o limite não existe?')
    if (text.includes('Modo: testar')) return openAiStream('Certo! Próxima: o que a continuidade exige?')
    return openAiStream('Quando os laterais diferem, o limite não existe.')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const talk = () =>
  within(screen.getByRole('list', { name: 'Conversa com o tutor' }))
    .queryAllByRole('listitem')
    .map(item => {
      const rich = item.querySelector('[data-testid="github-viewer"]')?.shadowRoot?.querySelector('article, .markdown-body')
      return rich ? `${item.querySelector('b')?.textContent}${rich.textContent?.trim()}` : item.textContent
    })

describe('Tutor', () => {
  it('answers a doubt using the note', async () => {
    studyLibrary()
    const id = await studyNote()
    render(<TutorDialog fileId={id} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: 'Quando o limite não existe?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(talk()).toEqual(['VocêQuando o limite não existe?', 'TutorQuando os laterais diferem, o limite não existe.']))
    expect(inputs[0]).toContain('Modo: perguntar')
    expect(inputs[0]).toContain('Se os laterais diferem, o limite não existe.')
  })

  it('in test mode it asks first and then corrects the answer', async () => {
    studyLibrary()
    const id = await studyNote()
    render(<TutorDialog fileId={id} />)
    fireEvent.click(screen.getByRole('button', { name: 'Testar o que sei' }))
    await waitFor(() => expect(talk()).toEqual(['TutorQuando o limite não existe?']))
    fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: 'Quando os laterais são diferentes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    await waitFor(() => expect(talk().at(-1)).toBe('TutorCerto! Próxima: o que a continuidade exige?'))
    expect(inputs.at(-1)).toContain('Tutor: Quando o limite não existe?\nPessoa: Quando os laterais são diferentes')
  })

  it('offers the microphone only when the browser can listen', async () => {
    studyLibrary()
    const id = await studyNote()
    const { unmount } = render(<TutorDialog fileId={id} />)
    expect(screen.queryByRole('button', { name: 'Falar' })).not.toBeInTheDocument()
    unmount()
    vi.stubGlobal('webkitSpeechRecognition', class {
      start() {}
      stop() {}
    })
    render(<TutorDialog fileId={id} />)
    expect(screen.getByRole('button', { name: 'Falar' })).toBeInTheDocument()
  })
})

const RICH = [
  '## Passo a passo',
  '',
  'Use **sempre** o [guia](#passo-a-passo):',
  '',
  '- primeiro item',
  '- segundo item',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '> [!TIP]',
  '> Revise antes da prova.',
  '',
  '- [ ] fazer exercício',
  '',
  '```ts',
  'const total = 1 + 1',
  '```',
  '',
  '```mermaid',
  'flowchart TD',
  'A-->B',
  '```',
].join('\n')

async function askRich(question = 'Me mostra') {
  installFetch(() => openAiStream(RICH))
  studyLibrary()
  const id = await studyNote()
  render(<TutorDialog fileId={id} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Sua pergunta ou resposta' }), { target: { value: question } })
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
  let root: ShadowRoot | null = null
  await waitFor(() => {
    const items = within(screen.getByRole('list', { name: 'Conversa com o tutor' })).queryAllByRole('listitem')
    root = items.at(-1)?.querySelector('[data-testid="github-viewer"]')?.shadowRoot ?? null
    expect(root?.querySelector('h2')).toBeTruthy()
  })
  return root as unknown as ShadowRoot
}

describe('Tutor com texto rico', () => {
  it('renders code blocks with highlighting and no raw fences', async () => {
    const root = await askRich()
    expect(root.querySelector('pre')?.textContent).toContain('const total = 1 + 1')
    expect(root.textContent).not.toContain('```')
  })

  it('copies the code like in the note', async () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const root = await askRich()
    fireEvent.click(root.querySelector('button[aria-label="Copiar o código"]') as Element)
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('const total = 1 + 1'))
  })

  it('draws mermaid as a diagram instead of text', async () => {
    const root = await askRich()
    expect(root.querySelector('iframe')).toBeTruthy()
    expect(root.textContent).not.toContain('flowchart TD')
  })

  it('renders lists, tables, bold and links', async () => {
    const root = await askRich()
    expect(root.querySelectorAll('li').length).toBeGreaterThanOrEqual(2)
    expect(root.querySelector('table td')?.textContent).toBe('1')
    expect(root.querySelector('strong')?.textContent).toBe('sempre')
    expect(root.querySelector('a[href="#passo-a-passo"]')).toBeTruthy()
  })

  it('renders alerts and checklists', async () => {
    const root = await askRich()
    expect(root.querySelector('.markdown-alert-tip')?.textContent).toContain('Revise antes da prova.')
    expect(root.querySelector('input[type="checkbox"]')).toBeTruthy()
  })

  it('renders headings without the explain bulb', async () => {
    const root = await askRich()
    fireEvent.pointerOver(root.querySelector('h2') as Element)
    expect(root.querySelector('h2')?.textContent).toContain('Passo a passo')
    expect(document.querySelector('.heading-explain')).toBeNull()
  })

  it('keeps the question exactly as typed', async () => {
    await askRich('o que é **x**?')
    const items = within(screen.getByRole('list', { name: 'Conversa com o tutor' })).queryAllByRole('listitem')
    expect(items[0].textContent).toBe('Vocêo que é **x**?')
  })

  it('has no read aloud option', async () => {
    const speak = vi.fn()
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn() })
    await askRich()
    expect(screen.queryByText('Ler em voz alta')).not.toBeInTheDocument()
    expect(speak).not.toHaveBeenCalled()
  })

  it('lets the AI format instead of writing for voice', () => {
    expect(PROMPTS.TUTOR_PROMPT).not.toContain('voz alta')
    expect(PROMPTS.TUTOR_PROMPT).toMatch(/markdown/i)
  })
})
