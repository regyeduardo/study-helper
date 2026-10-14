import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { TagSuggestion } from '@/components/reader/TagSuggestion'
import { defaultIndex } from '@/lib/defaults'
import { suggestTags } from '@/lib/generation/tags'
import type { GenerationSession } from '@/lib/generation/session'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import type { FileSidecar } from '@/types/domain'

beforeEach(() => {
  const repo = { kind: 'local', accountId: 'local', readContent: async () => '', readSidecar: async () => ({}), saveFile: async (sidecar: FileSidecar) => sidecar, saveIndex: async () => undefined, fileSizes: async () => ({}) } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, sharedView: null })
})

describe('tags suggested after generating', () => {
  it('the agent gets the tags already in use and returns up to 4 clean ones', async () => {
    const session = { chat: vi.fn(async () => '{"etiquetas": ["Limites", "#continuidade", "prova 2", "limites", "a", "b"]}') } as unknown as GenerationSession
    expect(await suggestTags('Texto sobre limites.', ['limites', 'prova-2'], session)).toEqual(['limites', 'continuidade', 'prova-2', 'a'])
    expect(vi.mocked(session.chat).mock.calls[0][0]).toContain('Etiquetas que a pessoa já usa: limites, prova-2')
  })

  it('the strip toggles each tag, Aceitar saves the chosen ones and Ignorar just goes away', async () => {
    const meta = await useLibraryStore.getState().createFile({ name: 'Aula', type: 'class', status: 'ready', folderId: null }, 'texto')
    await useLibraryStore.getState().updateFile(meta.id, { tags: ['calculo'], suggestedTags: ['limites', 'continuidade', 'prova-2'] })
    const current = () => useLibraryStore.getState().files.find(file => file.id === meta.id)!
    const { rerender } = render(<TagSuggestion meta={current()} />)
    const strip = screen.getByRole('region', { name: 'Etiquetas sugeridas' })
    fireEvent.click(within(strip).getByRole('button', { name: 'prova-2' }))
    expect(within(strip).getByRole('button', { name: 'prova-2' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(within(strip).getByRole('button', { name: 'Aceitar' }))
    await waitFor(() => expect(current().tags).toEqual(['calculo', 'limites', 'continuidade']))
    expect(current().suggestedTags).toEqual([])
    rerender(<TagSuggestion meta={current()} />)
    expect(screen.queryByRole('region', { name: 'Etiquetas sugeridas' })).not.toBeInTheDocument()
    await useLibraryStore.getState().updateFile(meta.id, { suggestedTags: ['outra'] })
    rerender(<TagSuggestion meta={current()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ignorar' }))
    await waitFor(() => expect(current().suggestedTags).toEqual([]))
    expect(current().tags).toEqual(['calculo', 'limites', 'continuidade'])
  })
})
