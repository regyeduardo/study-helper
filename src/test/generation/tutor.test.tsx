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

const talk = () => within(screen.getByRole('list', { name: 'Conversa com o tutor' })).queryAllByRole('listitem').map(item => item.textContent)

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
