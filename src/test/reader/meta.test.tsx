import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { DocumentHead } from '@/components/reader/DocumentArticle'
import { useLibraryStore } from '@/stores/library'
import { studyLibrary } from '@/test/generation/study-fixture'

async function noteMeta() {
  studyLibrary()
  const folder = await useLibraryStore.getState().createFolder({ name: 'Cálculo' })
  const created = await useLibraryStore.getState().createFile(
    { name: 'Limites', type: 'class', status: 'ready', folderId: folder.id, tags: ['limites', 'prova'], origin: { input: 'youtube', name: 'aula', storage: 'none' } },
    '# Limites\n\ntexto',
  )
  await useLibraryStore.getState().updateFile(created.id, { readingMinutes: 7, mastery: 64 })
  return useLibraryStore.getState().files.find(file => file.id === created.id)!
}

describe('linha de informações do documento', () => {
  it('mostra tipo · minutos · domínio e um "Detalhes" que abre pasta, origem e tags', async () => {
    const meta = await noteMeta()
    const { container } = render(
      <MemoryRouter>
        <DocumentHead meta={meta} onInfo={() => undefined} />
      </MemoryRouter>,
    )
    const line = container.querySelector('.doc-meta') as HTMLElement
    expect(line.textContent).toMatch(/·\s*7 min\s*·/)
    expect(line.textContent).toContain('64%')
    expect(line.textContent).not.toContain('min de leitura')
    expect(screen.queryByText('Cálculo')).not.toBeInTheDocument()
    expect(screen.queryByText(/YouTube/)).not.toBeInTheDocument()
    expect(screen.queryByText(/#?prova$/)).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /Detalhes/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByText('Pasta')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cálculo' })).toBeInTheDocument()
    expect(screen.getByText('Origem')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'YouTube' })).toBeInTheDocument()
    expect(screen.getByText('Tags')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '#prova' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Ocultar/ }))
    expect(screen.queryByText('Pasta')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Detalhes/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
