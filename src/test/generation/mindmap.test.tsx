import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { MindMapDialog } from '@/components/dialogs/MindMapDialog'
import { useLibraryStore } from '@/stores/library'
import { installFetch, openAiStream } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const MAP = {
  centro: 'Limites',
  ramos: [
    { titulo: 'Laterais', filhos: [{ titulo: 'Esquerda e direita', filhos: [] }] },
    { titulo: 'Continuidade', filhos: [] },
    { titulo: '', filhos: [] },
  ],
}

beforeEach(() => {
  installFetch(() => openAiStream(JSON.stringify(MAP)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Mapa mental', () => {
  it('draws the map of the note, keeps it in the note and opens it again without calling the AI', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const { unmount } = render(<MindMapDialog fileId={id} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fazer o mapa mental' }))
    const map = await screen.findByRole('tree', { name: 'Mapa mental' })
    expect(within(map).getByText('Limites')).toBeInTheDocument()
    expect(within(map).getByText('Esquerda e direita')).toBeInTheDocument()
    expect(within(map).getAllByRole('listitem')).toHaveLength(3)
    await waitFor(() => expect(memory.sidecars.get(id)?.mindmap?.children).toHaveLength(2))
    expect(useLibraryStore.getState().files.find(file => file.id === id)?.hasMindmap).toBe(true)
    unmount()
    installFetch(() => new Response('não devia chamar', { status: 500 }))
    render(<MindMapDialog fileId={id} />)
    expect(await screen.findByText('Esquerda e direita')).toBeInTheDocument()
  })
})
