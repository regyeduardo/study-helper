import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

import type { CardsArtifact, FileSidecar, MapArtifact, MindNode, StudyCard } from '@/types/domain'
import { newCardsArtifact, newMapArtifact } from '@/lib/artifacts'
import { dueCount } from '@/lib/generation/cards'
import { NAME_PROMPT } from '@/lib/generation/artifact-name'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'
import { type CapturedRequest, installFetch, openAiStream, systemPromptOf } from '@/test/ai/fake-provider'
import { studyLibrary, studyNote } from '@/test/generation/study-fixture'

const OLD_MAP: MindNode = { title: 'Limites', children: [{ title: 'Laterais', children: [] }, { title: 'Continuidade', children: [] }] }
const OLD_CARDS: StudyCard[] = [
  { id: 'c1', front: 'Quando o limite não existe?', back: 'Quando os laterais diferem.', box: 3, due: '2026-10-01' },
  { id: 'c2', front: 'O que a continuidade exige?', back: 'Limite igual ao valor.', box: 1, due: '2999-01-01' },
]

const library = () => useLibraryStore.getState()
const metaOf = (id: string) => library().files.find(file => file.id === id)!

function diagram(text: string): MapArtifact['diagram'] {
  return { form: 'radial', root: { id: 'r', text, children: [{ id: 'a', text: `${text} 1`, children: [] }] } }
}

/** A note saved by the app before artifacts existed; the next open reads it from the repository. */
async function oldNote(fields: Partial<FileSidecar> = { mindmap: OLD_MAP, cards: OLD_CARDS }) {
  const memory = studyLibrary()
  const id = await studyNote()
  const sidecar = memory.sidecars.get(id)!
  memory.sidecars.set(id, { ...sidecar, ...fields, meta: { ...sidecar.meta, cardDue: fields.cards?.map(card => card.due), hasMindmap: Boolean(fields.mindmap) } })
  useLibraryStore.setState({ opened: {} })
  const repo = library().repo!
  const saves: FileSidecar[] = []
  const save = repo.saveFile.bind(repo)
  repo.saveFile = async (next, content) => {
    saves.push(structuredClone(next))
    return save(next, content)
  }
  return { id, memory, saves, repo, save }
}

function noAi() {
  useLibraryStore.setState(state => ({ index: { ...state.index, settings: defaultIndex().settings } }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openFile migrates the old map and cards once', () => {
  it('writes the new list first, then clears the old fields, keeping the review progress', async () => {
    const { id, memory, saves } = await oldNote()
    noAi()
    await library().openFile(id)
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[0].artifacts?.map(item => item.kind)).toEqual(['mapa', 'cartoes'])
    expect(saves[0].mindmap).toEqual(OLD_MAP)
    expect(saves[0].cards).toEqual(OLD_CARDS)
    expect(saves[1].mindmap).toBeUndefined()
    expect(saves[1].cards).toBeUndefined()
    const stored = memory.sidecars.get(id)!
    expect((stored.artifacts![1] as CardsArtifact).cards).toEqual(OLD_CARDS)
    expect(stored.artifacts!.map(item => [item.name, item.provisionalName])).toEqual([
      ['Mapa mental', true],
      ['Cartões', true],
    ])
    expect(metaOf(id).artifacts?.map(item => item.name)).toEqual(['Mapa mental', 'Cartões'])
    expect(metaOf(id).cardDue).toEqual(['2026-10-01', '2999-01-01'])
    expect(metaOf(id).hasMindmap).toBe(true)
    expect(library().opened[id].sidecar.artifacts).toHaveLength(2)
  })

  it('does not stamp the note as edited by the user', async () => {
    const { id, memory } = await oldNote()
    noAi()
    const before = memory.sidecars.get(id)!.meta.updated
    await library().openFile(id)
    await waitFor(() => expect(memory.sidecars.get(id)?.cards).toBeUndefined())
    expect(memory.sidecars.get(id)!.meta.updated).toEqual(before)
  })

  it('opening again writes nothing', async () => {
    const { id, saves } = await oldNote()
    noAi()
    await library().openFile(id)
    await waitFor(() => expect(saves).toHaveLength(2))
    useLibraryStore.setState({ opened: {} })
    await library().openFile(id)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(saves).toHaveLength(2)
  })

  it('when the new list cannot be written the old fields stay, and the next open tries again', async () => {
    const { id, memory, repo, save } = await oldNote()
    noAi()
    repo.saveFile = async () => {
      throw new Error('sem rede')
    }
    await library().openFile(id)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(memory.sidecars.get(id)).toMatchObject({ mindmap: OLD_MAP, cards: OLD_CARDS })
    expect(memory.sidecars.get(id)?.artifacts).toBeUndefined()
    repo.saveFile = save
    useLibraryStore.setState({ opened: {} })
    await library().openFile(id)
    await waitFor(() => expect(memory.sidecars.get(id)?.cards).toBeUndefined())
    expect(memory.sidecars.get(id)?.artifacts).toHaveLength(2)
  })

  it('when only the clearing fails, the next open clears without migrating twice', async () => {
    const { id, memory, repo, save } = await oldNote()
    noAi()
    let count = 0
    repo.saveFile = async (next, content) => {
      if (++count === 2) throw new Error('sem rede')
      return save(next, content)
    }
    await library().openFile(id)
    await waitFor(() => expect(count).toBe(2))
    expect(memory.sidecars.get(id)).toMatchObject({ mindmap: OLD_MAP, cards: OLD_CARDS })
    expect(memory.sidecars.get(id)?.artifacts).toHaveLength(2)
    useLibraryStore.setState({ opened: {} })
    await library().openFile(id)
    await waitFor(() => expect(memory.sidecars.get(id)?.cards).toBeUndefined())
    expect(memory.sidecars.get(id)?.artifacts).toHaveLength(2)
  })
})

describe('the AI names provisional artifacts when the note opens', () => {
  it('replaces the placeholders by the names the AI gives', async () => {
    const asked: string[] = []
    const { id, memory } = await oldNote()
    installFetch((request: CapturedRequest) => {
      asked.push(systemPromptOf(request))
      return openAiStream(JSON.stringify({ nome: asked.length === 1 ? 'Limites e continuidade' : 'Quando o limite existe' }))
    })
    await library().openFile(id)
    await waitFor(() => expect(metaOf(id).artifacts?.map(item => item.name)).toEqual(['Limites e continuidade', 'Quando o limite existe']))
    expect(asked).toEqual([NAME_PROMPT, NAME_PROMPT])
    expect(memory.sidecars.get(id)!.artifacts!.every(item => item.provisionalName === false)).toBe(true)
  })

  it('keeps the placeholder silently when the AI fails, and tries again on a later open', async () => {
    const { id, memory } = await oldNote({ mindmap: OLD_MAP })
    const { calls } = installFetch(() => new Response('fora do ar', { status: 500 }))
    await library().openFile(id)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await waitFor(() => expect(memory.sidecars.get(id)?.mindmap).toBeUndefined())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(memory.sidecars.get(id)!.artifacts![0]).toMatchObject({ name: 'Mapa mental', provisionalName: true })
    installFetch(() => openAiStream('{"nome": "Limites laterais"}'))
    useLibraryStore.setState({ opened: {} })
    await library().openFile(id)
    await waitFor(() => expect(memory.sidecars.get(id)!.artifacts![0]).toMatchObject({ name: 'Limites laterais', provisionalName: false }))
  })

  it('a map saved without a name gets the fallback name, and the AI names it on a later open', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const map = await library().saveArtifact(id, newMapArtifact({ diagram: diagram('Limites') }))
    expect(map).toMatchObject({ name: expect.stringMatching(/^Mapa mental · \d{2}\/\d{2} \d{2}:\d{2}$/), provisionalName: true })
    installFetch(() => openAiStream('{"nome": "Limites laterais"}'))
    useLibraryStore.setState({ opened: {} })
    await library().openFile(id)
    await waitFor(() => expect(memory.sidecars.get(id)!.artifacts![0]).toMatchObject({ name: 'Limites laterais', provisionalName: false }))
  })

  it('without an AI configured nothing is asked', async () => {
    const { id, memory } = await oldNote()
    noAi()
    const { calls } = installFetch(() => openAiStream('{"nome": "x"}'))
    await library().openFile(id)
    await waitFor(() => expect(memory.sidecars.get(id)?.cards).toBeUndefined())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(0)
  })
})

describe('saveArtifact, renameArtifact, deleteArtifact', () => {
  it('keeps several maps in a note and the summary in the library', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const one = await library().saveArtifact(id, newMapArtifact({ name: 'Limites', diagram: diagram('Limites') }))
    const two = await library().saveArtifact(id, newMapArtifact({ name: 'Continuidade', diagram: diagram('Continuidade') }))
    expect(memory.sidecars.get(id)!.artifacts!.map(item => item.id)).toEqual([one.id, two.id])
    expect(metaOf(id).artifacts?.map(item => item.name)).toEqual(['Limites', 'Continuidade'])
    expect(metaOf(id).hasMindmap).toBe(true)
  })

  it('replace keeps the place and the id; create adds another', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const one = await library().saveArtifact(id, newMapArtifact({ name: 'Limites', diagram: diagram('Limites') }))
    const again = await library().saveArtifact(id, newMapArtifact({ name: 'Limites de novo', diagram: diagram('Outro') }), one.id)
    expect(again.id).toBe(one.id)
    expect(memory.sidecars.get(id)!.artifacts!.map(item => item.name)).toEqual(['Limites de novo'])
    await library().saveArtifact(id, newMapArtifact({ name: 'Mais um', diagram: diagram('Mais') }))
    expect(metaOf(id).artifacts?.map(item => item.name)).toEqual(['Limites de novo', 'Mais um'])
  })

  it('replace ("Substituir este") keeps the id and starts the new map with no conversation and no versions', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const one = (await library().saveArtifact(id, newMapArtifact({ name: 'Limites', diagram: diagram('Limites') }))) as MapArtifact
    const chat: MapArtifact['chat'] = [
      { who: 'você', text: 'Junte os dois ramos', at: '2026-11-07T10:00:00.000Z' },
      { who: 'ia', text: 'Juntei.', at: '2026-11-07T10:00:05.000Z', changed: ['a'] },
    ]
    const talked: MapArtifact = { ...one, diagram: diagram('Limites juntos'), versions: [one.diagram], chat, highlight: ['a'] }
    await library().saveArtifact(id, talked)
    expect((memory.sidecars.get(id)!.artifacts![0] as MapArtifact).chat).toHaveLength(2)
    const replaced = await library().saveArtifact(id, { ...talked, diagram: diagram('Outro') }, one.id)
    const stored = memory.sidecars.get(id)!.artifacts as MapArtifact[]
    expect(replaced.id).toBe(one.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: one.id, diagram: diagram('Outro'), chat: [], versions: [] })
    expect(stored[0].highlight).toBeUndefined()
  })

  it('rename and delete keep the summary, the due dates and the map flag in sync', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    const map = await library().saveArtifact(id, newMapArtifact({ diagram: diagram('Limites') }))
    const deck = await library().saveArtifact(id, newCardsArtifact({ name: 'Conceitos', cards: OLD_CARDS }))
    await library().renameArtifact(id, map.id, 'Mapa dos limites')
    expect(metaOf(id).artifacts?.map(item => item.name)).toEqual(['Mapa dos limites', 'Conceitos'])
    expect(memory.sidecars.get(id)!.artifacts![0]).toMatchObject({ name: 'Mapa dos limites', provisionalName: false })
    await library().deleteArtifact(id, map.id)
    expect(metaOf(id).artifacts?.map(item => item.id)).toEqual([deck.id])
    expect(metaOf(id).hasMindmap).toBe(false)
    await library().deleteArtifact(id, deck.id)
    expect(metaOf(id)).toMatchObject({ artifacts: [], cardDue: [], hasMindmap: false })
  })

  it('cardDue has the due dates of every deck, so the library counts all of them', async () => {
    studyLibrary()
    const id = await studyNote()
    await library().saveArtifact(id, newCardsArtifact({ name: 'Conceitos', cards: OLD_CARDS }))
    await library().saveArtifact(id, newCardsArtifact({ name: 'Datas', cards: [{ id: 'd1', front: 'f', back: 'b', box: 0, due: '2026-10-05' }] }))
    expect(metaOf(id).cardDue).toEqual(['2026-10-01', '2999-01-01', '2026-10-05'])
    expect(dueCount(metaOf(id).cardDue, '2026-11-06')).toBe(2)
  })

  it('writes done at the same time do not lose each other', async () => {
    const memory = studyLibrary()
    const id = await studyNote()
    await Promise.all([1, 2, 3].map(n => library().saveArtifact(id, newMapArtifact({ name: `Mapa ${n}`, diagram: diagram(`M${n}`) }))))
    expect(memory.sidecars.get(id)!.artifacts!.map(item => item.name)).toEqual(['Mapa 1', 'Mapa 2', 'Mapa 3'])
  })
})
