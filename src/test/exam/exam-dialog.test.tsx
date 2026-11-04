import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ExamDialog } from '@/components/dialogs/ExamDialog'
import { installFetch, openAiStream } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Prova de uma nota', () => {
  it('abrir não pede nada à IA; só gera quando a pessoa clica em gerar', async () => {
    const { calls } = installFetch(() => openAiStream('{"questoes":[]}'))
    studyLibrary()
    const id = await studyNote()
    render(<ExamDialog fileId={id} />)
    const generate = await screen.findByRole('button', { name: /Gerar a prova/ })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls).toHaveLength(0)
    fireEvent.click(generate)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  })
})
