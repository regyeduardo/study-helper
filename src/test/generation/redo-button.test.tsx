// T146: any note written by the AI has a visible "Refazer…" in its head, with the same model and instruction preselected.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { course, fileOf, FORTE, flowLibrary, renderAt, textSource } from '@/test/generation/flow-fixture'

afterEach(() => {
  vi.unstubAllGlobals()
})

const redoButton = () => screen.findByRole('button', { name: 'Refazer…' })
const page = (id: string) => renderAt(paths.file(id), <DocumentBody fileId={id} />)

async function madeFrom(agent: 'lesson' | 'meeting' | 'explanation', instruction = ''): Promise<{ source: string; id: string }> {
  const source = await textSource()
  const id = (await useJobsStore.getState().generateFromNote(source, agent, FORTE, { folderId: null }, instruction))!
  await waitFor(() => expect(fileOf(id).status).toBe('ready'))
  return { source, id }
}

describe('"Refazer…" no cabeçalho da nota', () => {
  it('Aula feita de uma nota de texto: abre "Gerar de novo a Aula" com o modelo e a instrução de antes, substituindo', async () => {
    flowLibrary()
    const { source, id } = await madeFrom('lesson', 'foque nos exemplos')
    page(id)
    fireEvent.click(await redoButton())
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate', fileId: source, agent: 'lesson', again: id })
    const dialog = screen.getByRole('dialog', { name: 'Gerar de novo a Aula' })
    expect(within(dialog).getByLabelText('Modelo da IA')).toHaveValue(FORTE)
    expect(within(dialog).getByLabelText('Instrução extra para a IA (opcional)')).toHaveValue('foque nos exemplos')
    expect(within(dialog).getByRole('radio', { name: /Substituir esta nota/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('Ata em texto, filha de uma entrada: abre "Gerar de novo a Ata"', async () => {
    flowLibrary()
    const { source, id } = await madeFrom('meeting')
    page(id)
    fireEvent.click(await redoButton())
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate', fileId: source, agent: 'meeting', again: id })
    expect(screen.getByRole('dialog', { name: 'Gerar de novo a Ata' })).toBeInTheDocument()
  })

  it('Explicação: abre "Gerar de novo a Explicação"', async () => {
    flowLibrary()
    const { source, id } = await madeFrom('explanation')
    page(id)
    fireEvent.click(await redoButton())
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate', fileId: source, agent: 'explanation', again: id })
    expect(screen.getByRole('dialog', { name: 'Gerar de novo a Explicação' })).toBeInTheDocument()
  })

  it('Ata de uma gravação: abre a janela da Ata de novo, com as partes de antes', async () => {
    flowLibrary()
    const entry = await useLibraryStore.getState().createFile({ name: 'Reunião', role: 'entrada', kept: 'registro', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'Reunião.webm', mime: 'audio/webm', durationSeconds: 8, storage: 'none' } }, '')
    const ata = await useLibraryStore.getState().createFile({ name: 'Ata: Reunião', type: 'meeting', status: 'ready', folderId: null, parentFileId: entry.id, origin: { input: 'text', name: 'Reunião', storage: 'none' }, made: { parts: ['resumo', 'tarefas'], model: FORTE, at: '2026-11-01T10:00:00.000Z' } }, '# Ata')
    page(ata.id)
    fireEvent.click(await redoButton())
    expect(useUiStore.getState().overlay).toEqual({ kind: 'ata-parts', fileId: entry.id, again: ata.id })
    expect(screen.getByRole('dialog', { name: 'Gerar de novo a Ata' })).toBeInTheDocument()
  })

  it('Aula de curso já escrita: abre "Refazer a Aula", com a escolha do modelo', async () => {
    flowLibrary()
    const { ids } = await course(['Aula 1'])
    await useLibraryStore.getState().saveContent(ids[0], '# Aula 1', { status: 'ready', pendingExcerpt: null, made: { model: FORTE, at: '2026-11-01T10:00:00.000Z' } })
    page(ids[0])
    fireEvent.click(await redoButton())
    expect(useUiStore.getState().overlay).toMatchObject({ kind: 'pending', fileId: ids[0] })
    const dialog = screen.getByRole('dialog', { name: 'Refazer a Aula' })
    expect(within(dialog).getByLabelText('Modelo da IA')).toHaveValue(FORTE)
  })

  it('uma nota só guardada para ler não tem "Refazer…"', async () => {
    flowLibrary()
    const id = await textSource()
    page(id)
    await screen.findByText(/Se os laterais diferem/)
    expect(screen.queryByRole('button', { name: 'Refazer…' })).not.toBeInTheDocument()
  })

  it('num link compartilhado não aparece', async () => {
    flowLibrary()
    const { id } = await madeFrom('lesson')
    useLibraryStore.setState({ sharedView: { item: { id: 's', name: 's', folders: [], files: [] }, rootId: null } as never })
    page(id)
    await screen.findByTestId('markdown')
    expect(screen.queryByRole('button', { name: 'Refazer…' })).not.toBeInTheDocument()
  })
})
