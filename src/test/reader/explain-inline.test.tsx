import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

import { ExplainDialog } from '@/components/dialogs/MoreDialogs'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { Toasts } from '@/components/ui/Toasts'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { installFetch, jsonResponse, openAiStream } from '@/test/ai/fake-provider'
import { studyLibrary } from '@/test/generation/study-fixture'

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('explicar um trecho sem sair do documento', () => {
  it('fica no documento, mostra "gerando" no trecho e no fim avisa com "Abrir explicação"', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    installFetch(async request => {
      if (request.url.endsWith('gh-viewer/css.json')) return jsonResponse([])
      await gate
      return openAiStream('# Limite lateral\n\nÉ o valor do qual a função se aproxima por um lado.')
    })
    studyLibrary()
    const source = await useLibraryStore.getState().createFile({ name: 'Limites', type: 'class', status: 'ready', folderId: null }, '# Limites\n\nSe os laterais diferem, o limite não existe.')
    useUiStore.setState({ overlay: { kind: 'explain', fileId: source.id, excerpt: 'laterais' } })
    render(
      <MemoryRouter initialEntries={[paths.file(source.id)]}>
        <DocumentBody fileId={source.id} />
        <ExplainDialog fileId={source.id} excerpt="laterais" />
        <Toasts />
        <Where />
      </MemoryRouter>,
    )
    await waitFor(() => expect(document.querySelector('[data-testid="github-viewer"]')?.shadowRoot?.textContent).toContain('laterais'))

    fireEvent.click(screen.getByRole('button', { name: /Gerar explicação/ }))

    await waitFor(() => expect(useLibraryStore.getState().files.some(file => file.sourceExcerpt === 'laterais')).toBe(true))
    expect(screen.getByTestId('where')).toHaveTextContent(paths.file(source.id))
    const explanation = useLibraryStore.getState().files.find(file => file.sourceExcerpt === 'laterais')!
    expect(explanation.name.startsWith('Explicação: ')).toBe(true)

    // Enquanto gera: carregando ao lado do trecho, dentro do texto.
    await waitFor(() => {
      const root = document.querySelector('[data-testid="github-viewer"]')?.shadowRoot
      expect(root?.querySelector('.ex-loading')?.textContent).toContain('gerando explicação')
    })

    release()
    const open = await screen.findByRole('button', { name: 'Abrir explicação' }, { timeout: 3000 })
    expect(screen.getByTestId('where')).toHaveTextContent(paths.file(source.id))
    await waitFor(() => expect(useLibraryStore.getState().files.find(file => file.id === explanation.id)?.name.startsWith('Explicação: ')).toBe(true))
    expect(open).toBeInTheDocument()
  })
})
