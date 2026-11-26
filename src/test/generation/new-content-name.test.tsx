// FR-021 (spec 005, 25/11): o nome que a pessoa dá em "Novo conteúdo" vira o nome da nota; um que já existe na pasta escolhida é
// recusado ali mesmo, dizendo qual, antes de gerar qualquer coisa.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { answer, FORTE, flowLibrary, renderAt } from '@/test/generation/flow-fixture'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Novo conteúdo: um nome que já existe na pasta', () => {
  it('avisa qual e não deixa gerar; outro nome libera', async () => {
    flowLibrary(answer)
    await useLibraryStore.getState().createFile({ name: 'Limites laterais', type: 'class', folderId: null }, '# antes')
    renderAt('/')
    act(() => useUiStore.getState().open({ kind: 'new' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo conteúdo' })
    fireEvent.change(within(dialog).getByLabelText('Link'), { target: { value: 'https://exemplo.com/limites' } })
    fireEvent.change(within(dialog).getByLabelText('Modelo da IA'), { target: { value: FORTE } })
    const name = within(dialog).getByLabelText('Nome (opcional)')
    fireEvent.change(name, { target: { value: 'limites laterais ' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Já existe uma nota chamada "Limites laterais" na Biblioteca. Escolha outro nome ou outra pasta.')
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByRole('button', { name: 'Gerar aula' })).toBeDisabled()
    fireEvent.change(name, { target: { value: 'Limites laterais, parte 2' } })
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Gerar aula' })).toBeEnabled()
  })
})
