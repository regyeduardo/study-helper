import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CardsArtifact, FileSidecar, MapArtifact, MindNode, StudyCard } from '@/types/domain'
import {
  artifactsOf,
  decksOf,
  dueOfDecks,
  hasOldFields,
  migrated,
  newCardsArtifact,
  newMapArtifact,
  newTutorArtifact,
  placeholderName,
  removeArtifact,
  renameArtifact,
  summaryOf,
  withArtifact,
  withoutOldFields,
} from '@/lib/artifacts'
import { newFileMeta, newSidecar } from '@/lib/defaults'

const OLD_MAP: MindNode = { title: 'Limites', children: [{ title: 'Laterais', children: [{ title: 'Esquerda e direita', children: [] }] }, { title: 'Continuidade', children: [] }] }

function card(id: string, due: string, box = 0): StudyCard {
  return { id, front: `Frente ${id}`, back: `Verso ${id}`, box, due }
}

function note(fields: Partial<FileSidecar> = {}): FileSidecar {
  return { ...newSidecar(newFileMeta({ name: 'Limites', type: 'class' })), ...fields }
}

function map(name = 'Limites laterais'): MapArtifact {
  return newMapArtifact({ name, diagram: { form: 'radial', root: { id: 'r', text: 'Limites', children: [{ id: 'a', text: 'Laterais', children: [] }] } } })
}

describe('artifactsOf: o mapa e os cartões antigos viram artefatos', () => {
  it('turns the old single map into the first map, with the placeholder name until the AI names it', () => {
    const [made] = artifactsOf(note({ mindmap: OLD_MAP })) as MapArtifact[]
    expect(made).toMatchObject({ kind: 'mapa', name: 'Mapa mental', provisionalName: true, versions: [], chat: [] })
    expect(made.diagram.root.text).toBe('Limites')
    expect(made.diagram.root.children.map(child => child.text)).toEqual(['Laterais', 'Continuidade'])
  })

  it('turns the old cards into the first deck keeping the review progress', () => {
    const cards = [card('c1', '2026-10-01', 3), card('c2', '2026-12-01', 1)]
    const [deck] = artifactsOf(note({ cards })) as CardsArtifact[]
    expect(deck).toMatchObject({ kind: 'cartoes', name: 'Cartões', provisionalName: true })
    expect(deck.cards).toEqual(cards)
  })

  it('gives the migrated ones the same id on every device, so two devices do not make two copies', () => {
    const sidecar = note({ mindmap: OLD_MAP, cards: [card('c1', '2026-10-01')] })
    const ids = artifactsOf(sidecar).map(item => item.id)
    expect(artifactsOf(structuredClone(sidecar)).map(item => item.id)).toEqual(ids)
    expect(new Set(ids).size).toBe(2)
  })

  it('does not migrate again what is already in the list', () => {
    const sidecar = migrated(note({ mindmap: OLD_MAP, cards: [card('c1', '2026-10-01')] }))
    expect(sidecar.artifacts).toHaveLength(2)
    expect(artifactsOf(sidecar)).toHaveLength(2)
  })

  it('a note with nothing old and no artifacts has none', () => {
    expect(artifactsOf(note())).toEqual([])
  })
})

describe('migrated and withoutOldFields: new written before old cleared', () => {
  it('migrated keeps the old fields and writes the new list and the summary', () => {
    const cards = [card('c1', '2026-10-01')]
    const sidecar = migrated(note({ mindmap: OLD_MAP, cards }))
    expect(sidecar.mindmap).toEqual(OLD_MAP)
    expect(sidecar.cards).toEqual(cards)
    expect(sidecar.meta.artifacts?.map(item => [item.kind, item.name])).toEqual([
      ['mapa', 'Mapa mental'],
      ['cartoes', 'Cartões'],
    ])
    expect(sidecar.meta.cardDue).toEqual(['2026-10-01'])
    expect(sidecar.meta.hasMindmap).toBe(true)
  })

  it('withoutOldFields only clears an old field already saved in the list', () => {
    const old = note({ mindmap: OLD_MAP, cards: [card('c1', '2026-10-01')] })
    expect(withoutOldFields(old)).toEqual(old)
    const cleared = withoutOldFields(migrated(old))
    expect(hasOldFields(cleared)).toBe(false)
    expect(cleared.artifacts).toHaveLength(2)
  })
})

describe('withArtifact: create, update, replace', () => {
  it('keeps several maps in one note', () => {
    const one = map('Limites laterais')
    const two = map('Continuidade')
    const sidecar = withArtifact(withArtifact(note(), one), two)
    expect(artifactsOf(sidecar).map(item => item.name)).toEqual(['Limites laterais', 'Continuidade'])
    expect(sidecar.meta.artifacts?.map(item => item.id)).toEqual([one.id, two.id])
    expect(sidecar.meta.hasMindmap).toBe(true)
  })

  it('an artifact with a known id is updated in place', () => {
    const one = map('Limites laterais')
    const two = map('Continuidade')
    const sidecar = withArtifact(withArtifact(withArtifact(note(), one), two), { ...one, chat: [{ who: 'você', text: 'oi', at: '2026-11-06T00:00:00.000Z' }] })
    expect(artifactsOf(sidecar).map(item => item.id)).toEqual([one.id, two.id])
    expect((artifactsOf(sidecar)[0] as MapArtifact).chat).toHaveLength(1)
  })

  it('replace ("Substituir este") takes the place and the id of the old one; create ("Criar outro") adds', () => {
    const one = map('Limites laterais')
    const two = map('Continuidade')
    const base = withArtifact(withArtifact(note(), one), two)
    const again = map('Limites de novo')
    const replaced = withArtifact(base, again, one.id)
    expect(artifactsOf(replaced).map(item => [item.id, item.name])).toEqual([
      [one.id, 'Limites de novo'],
      [two.id, 'Continuidade'],
    ])
    expect(artifactsOf(withArtifact(base, again)).map(item => item.name)).toEqual(['Limites laterais', 'Continuidade', 'Limites de novo'])
  })

  it('a placeholder name never overwrites a name already given', () => {
    const named = newCardsArtifact({ name: 'Datas da Revolução', cards: [card('c1', '2026-10-01')] })
    const stale = { ...named, name: placeholderName('cartoes'), provisionalName: true, cards: [card('c1', '2026-10-09', 1)] }
    const [deck] = artifactsOf(withArtifact(withArtifact(note(), named), stale)) as CardsArtifact[]
    expect(deck.name).toBe('Datas da Revolução')
    expect(deck.provisionalName).toBeFalsy()
    expect(deck.cards[0].due).toBe('2026-10-09')
  })

  it('writes on top of a note not migrated yet without losing the old map or cards', () => {
    const sidecar = withArtifact(note({ mindmap: OLD_MAP, cards: [card('c1', '2026-10-01')] }), map('Novo'))
    expect(artifactsOf(sidecar).map(item => item.kind)).toEqual(['mapa', 'cartoes', 'mapa'])
    expect(sidecar.cards).toHaveLength(1)
  })
})

describe('rename and remove keep the summary in sync', () => {
  it('rename changes the name, ends the placeholder and updates the summary', () => {
    const sidecar = migrated(note({ mindmap: OLD_MAP }))
    const [old] = artifactsOf(sidecar)
    const renamed = renameArtifact(sidecar, old.id, '  Limites e continuidade ')
    expect(artifactsOf(renamed)[0]).toMatchObject({ name: 'Limites e continuidade', provisionalName: false })
    expect(renamed.meta.artifacts?.[0].name).toBe('Limites e continuidade')
    expect(renameArtifact(sidecar, old.id, '   ')).toBe(sidecar)
    expect(renameArtifact(sidecar, 'outro', 'Nome')).toBe(sidecar)
  })

  it('remove takes the artifact, its summary, its due dates and the map flag', () => {
    const deck = newCardsArtifact({ name: 'Conceitos', cards: [card('c1', '2026-10-01')] })
    const one = map()
    const sidecar = withArtifact(withArtifact(note(), deck), one)
    const without = removeArtifact(removeArtifact(sidecar, one.id), deck.id)
    expect(without.artifacts).toEqual([])
    expect(without.meta).toMatchObject({ artifacts: [], cardDue: [], hasMindmap: false })
  })
})

describe('decks and due dates', () => {
  const first = newCardsArtifact({ name: 'Conceitos', cards: [card('a1', '2026-10-01'), card('a2', '2026-12-01')] })
  const second = newCardsArtifact({ name: 'Datas', cards: [card('b1', '2026-10-02')] })
  const list = [first, map(), second]

  it('cardDue keeps the due dates of every deck', () => {
    expect(dueOfDecks(list)).toEqual(['2026-10-01', '2026-12-01', '2026-10-02'])
  })

  it('decksOf gives every deck, or only the one asked for', () => {
    expect(decksOf(list).map(item => item.name)).toEqual(['Conceitos', 'Datas'])
    expect(decksOf(list, second.id).map(item => item.name)).toEqual(['Datas'])
    expect(decksOf(list, 'sumiu')).toEqual([])
  })
})

describe('names, summaries and factories', () => {
  it('placeholders say what the artifact is', () => {
    expect([placeholderName('mapa'), placeholderName('cartoes'), placeholderName('tutor')]).toEqual(['Mapa mental', 'Cartões', 'Conversa'])
  })

  it('a factory with a name keeps it and is not provisional', () => {
    expect(newCardsArtifact({ name: 'Datas', cards: [], made: { model: 'm', at: 'x' } })).toMatchObject({ name: 'Datas', made: { model: 'm' } })
    expect(newCardsArtifact({ name: 'Datas', cards: [] }).provisionalName).toBeUndefined()
  })

  it('a conversation is named by its first question', () => {
    expect(newTutorArtifact({ turns: [{ who: 'você', text: 'Quando o limite **não** existe?' }] })).toMatchObject({ kind: 'tutor', name: 'Quando o limite não existe?' })
  })

  it('summaryOf has what the library needs and nothing more', () => {
    const one = map()
    expect(summaryOf(one)).toEqual({ id: one.id, kind: 'mapa', name: one.name, updatedAt: one.updatedAt })
  })
})

describe('fallback name when the AI gives none (FR-002)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 7, 9, 5))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a new artifact without a name is "<Tipo> · dd/mm hh:mm", still provisional so the AI can name it on a later open', () => {
    expect(newMapArtifact({ name: null, diagram: map().diagram })).toMatchObject({ name: 'Mapa mental · 07/11 09:05', provisionalName: true })
    expect(newMapArtifact({ name: '  ', diagram: map().diagram }).name).toBe('Mapa mental · 07/11 09:05')
    expect(newCardsArtifact({ cards: [] })).toMatchObject({ kind: 'cartoes', name: 'Cartões · 07/11 09:05', provisionalName: true })
    expect(newTutorArtifact({ turns: [] })).toMatchObject({ name: 'Conversa · 07/11 09:05', provisionalName: true })
  })

  it('the old map and deck keep "Mapa mental" and "Cartões" until they are named', () => {
    expect(artifactsOf(note({ mindmap: OLD_MAP, cards: [card('c1', '2026-10-01')] })).map(item => [item.name, item.provisionalName])).toEqual([
      ['Mapa mental', true],
      ['Cartões', true],
    ])
  })

  it('a fallback name is replaced by a rename, never the other way round', () => {
    const named = withArtifact(note(), newMapArtifact({ name: 'Limites laterais', diagram: map().diagram }))
    const [first] = artifactsOf(named)
    const stale = { ...first, ...newMapArtifact({ diagram: map().diagram }), id: first.id }
    expect(artifactsOf(withArtifact(named, stale))[0].name).toBe('Limites laterais')
    expect(artifactsOf(renameArtifact(withArtifact(note(), stale), first.id, 'Continuidade'))[0]).toMatchObject({ name: 'Continuidade', provisionalName: false })
  })
})
