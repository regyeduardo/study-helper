import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { useLibraryStore } from '@/stores/library'
import { settle, slowLibrary } from '@/test/feedback/slow'

// Opening a note from the Drive takes a moment. Until the file is there the page says so, with the spinner,
// and never offers what only makes sense with the file open ("Transcrever agora").

let slow: ReturnType<typeof slowLibrary>

const show = (fileId: string) =>
  render(
    <MemoryRouter>
      <DocumentBody fileId={fileId} />
    </MemoryRouter>,
  )

beforeEach(() => {
  slow = slowLibrary()
})

describe('abrir uma nota que vem do Drive', () => {
  it('nota de texto: mostra "Abrindo a nota…" com o ícone girando; depois, o texto', async () => {
    const note = await useLibraryStore.getState().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites\n\nTexto da nota.')
    useLibraryStore.setState({ opened: {} })
    const release = slow.hold()
    show(note.id)

    const loading = screen.getByRole('status', { name: /Abrindo a nota/ })
    expect(loading.querySelector('.spinning')).not.toBeNull()
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()

    await act(async () => {
      release()
      await settle()
    })
    expect(screen.queryByRole('status', { name: /Abrindo a nota/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown')).toHaveTextContent('Texto da nota.')
  })

  it('nota de mídia: não oferece "Transcrever agora" enquanto o arquivo não abriu', async () => {
    const origin = { input: 'file' as const, name: 'aula.mp3', mime: 'audio/mpeg', durationSeconds: 60, storage: 'drive' as const, storedFileId: 'drv-1', expiresAt: null }
    const note = await useLibraryStore.getState().createFile({ name: 'Aula gravada', type: 'reading', status: 'ready', folderId: null, origin }, '')
    useLibraryStore.setState({ opened: {} })
    const release = slow.hold()
    show(note.id)

    expect(screen.getByRole('status', { name: /Abrindo a nota/ }).querySelector('.spinning')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Transcrever agora/ })).not.toBeInTheDocument()

    await act(async () => {
      release()
      await settle()
    })
    expect(screen.queryByRole('status', { name: /Abrindo a nota/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Transcrever agora/ })).toBeInTheDocument()
  })

  it('se o arquivo não abre, o motivo aparece e a rodinha some', async () => {
    const note = await useLibraryStore.getState().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites')
    useLibraryStore.setState({ opened: {} })
    slow.breakWith(new Error('Drive fora do ar'))
    show(note.id)
    await act(async () => {
      await settle()
    })
    expect(screen.getByText('Drive fora do ar')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /Abrindo a nota/ })).not.toBeInTheDocument()
  })
})
