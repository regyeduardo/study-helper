import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { MapArtifact } from '@/types/domain'
import { ArtifactGenerateDialog } from '@/components/dialogs/ArtifactGenerateDialog'
import { MindMapDialog } from '@/components/dialogs/MindMapDialog'
import { latestOf } from '@/lib/artifacts'
import { INSTRUCTION_HEAD } from '@/lib/generation/instruction'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { installFetch, openAiStream, userContentOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

let made = 0

beforeEach(() => {
  made = 0
  installFetch(() => {
    made++
    return openAiStream(JSON.stringify({ nome: `Mapa ${made}`, forma: 'arvore', raiz: { texto: `Centro ${made}`, filhos: [{ texto: `Ramo ${made}`, marca: '📌', filhos: [] }] } }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The two windows of this flow, switched by the overlay as Overlays does. */
function Screen() {
  const overlay = useUiStore(state => state.overlay)
  if (overlay?.kind === 'generate-artifact') return <ArtifactGenerateDialog fileId={overlay.fileId} artifact={overlay.artifact} again={overlay.again} />
  if (overlay?.kind === 'mindmap') return <MindMapDialog fileId={overlay.fileId} mapId={overlay.artifactId} />
  return null
}

const maps = (memory: ReturnType<typeof studyLibrary>, id: string) => (memory.sidecars.get(id)?.artifacts ?? []) as MapArtifact[]

describe('MindMapDialog keeps maps as artifacts', () => {
  it('the first map offers the instruction (FR-003): it reaches the AI and stays in the map', async () => {
    const asked: string[] = []
    installFetch(request => {
      asked.push(userContentOf(request))
      return openAiStream(JSON.stringify({ nome: 'Decisões', forma: 'arvore', raiz: { texto: 'Centro', filhos: [{ texto: 'Ramo', filhos: [] }] } }))
    })
    const memory = studyLibrary()
    const id = await studyNote()
    useUiStore.getState().open({ kind: 'mindmap', fileId: id })
    render(<Screen />)
    fireEvent.change(await screen.findByLabelText('Instrução extra para a IA (opcional)'), { target: { value: 'só as decisões' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fazer o mapa mental' }))
    await waitFor(() => expect(maps(memory, id)).toHaveLength(1))
    expect(asked.some(text => text.endsWith(`${INSTRUCTION_HEAD}\n\nsó as decisões`))).toBe(true)
    expect(maps(memory, id)[0].made?.instruction).toBe('só as decisões')
  })

  it('making the map again creates another map and shows the latest', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    useUiStore.getState().open({ kind: 'mindmap', fileId: id })
    render(<Screen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Fazer o mapa mental' }))
    expect(await within(await screen.findByRole('list', { name: 'Itens do mapa' })).findByText('📌 Ramo 1')).toBeInTheDocument()
    // "Gerar de novo" goes to the generate window shared with the decks, which brings the new map back to this screen
    fireEvent.click(screen.getByRole('button', { name: 'Gerar de novo…' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'generate-artifact', fileId: id, artifact: 'mapa', again: maps(memory, id)[0].id })
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar' }))
    expect(await within(await screen.findByRole('list', { name: 'Itens do mapa' })).findByText('📌 Ramo 2')).toBeInTheDocument()
    await waitFor(() => expect(maps(memory, id).map(item => item.name)).toEqual(['Mapa 1', 'Mapa 2']))
    expect(maps(memory, id)[1]).toMatchObject({ kind: 'mapa', diagram: { form: 'arvore' }, versions: [], chat: [], made: { at: expect.any(String) } })
    expect(useLibraryStore.getState().files.find(file => file.id === id)?.artifacts?.map(item => item.name)).toEqual(['Mapa 1', 'Mapa 2'])
  })

  it('shows the old single map of a note saved before maps were artifacts', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const sidecar = memory.sidecars.get(id)!
    memory.sidecars.set(id, { ...sidecar, mindmap: { title: 'Limites', children: [{ title: 'Laterais', children: [] }] } })
    useLibraryStore.setState({ opened: {} })
    render(<MindMapDialog fileId={id} />)
    expect(await screen.findByText('Laterais')).toBeInTheDocument()
    await waitFor(() => expect(memory.sidecars.get(id)?.mindmap).toBeUndefined())
    expect(maps(memory, id)).toHaveLength(1)
  })

  it('latestOf picks the one changed last', () => {
    const at = (name: string, updatedAt: string) => ({ id: name, kind: 'mapa', name, updatedAt }) as unknown as MapArtifact
    expect(latestOf([at('a', '2026-11-02'), at('b', '2026-11-01')], 'mapa')?.name).toBe('a')
    expect(latestOf([], 'mapa')).toBeNull()
  })
})
