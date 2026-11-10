import { describe, expect, it } from 'vitest'

import type { FileSidecar, MapArtifact } from '@/types/domain'
import { newCardsArtifact, newMapArtifact, withArtifact } from '@/lib/artifacts'
import { newFileMeta, newSidecar } from '@/lib/defaults'
import { applyFieldChoices, mergeSidecar } from '@/lib/sync/merge'

function map(name: string): MapArtifact {
  return newMapArtifact({ name, diagram: { form: 'radial', root: { id: 'r', text: name, children: [] } } })
}

function deck(name: string, due: string) {
  return newCardsArtifact({ name, cards: [{ id: `${name}-1`, front: 'f', back: 'b', box: 0, due }] })
}

function base(): FileSidecar {
  return withArtifact(newSidecar(newFileMeta({ name: 'Limites', type: 'class' })), map('Comum'))
}

describe('mergeSidecar with artifacts from two devices', () => {
  it('keeps the artifacts each device made, and the summary, due dates and map flag of both', () => {
    const start = base()
    const mine = withArtifact(start, map('Meu mapa'))
    const theirs = withArtifact(start, deck('Cartões dele', '2026-10-01'))
    const { merged, conflicts } = mergeSidecar(start, mine, theirs)
    expect(conflicts).toEqual([])
    expect(merged.artifacts?.map(item => item.name)).toEqual(['Comum', 'Meu mapa', 'Cartões dele'])
    expect(merged.meta.artifacts?.map(item => item.name)).toEqual(['Comum', 'Meu mapa', 'Cartões dele'])
    expect(merged.meta.cardDue).toEqual(['2026-10-01'])
    expect(merged.meta.hasMindmap).toBe(true)
  })

  it('an artifact deleted on one device and untouched on the other stays deleted', () => {
    const start = base()
    const shared = start.artifacts![0]
    const mine = { ...start, artifacts: [], meta: { ...start.meta, artifacts: [] } }
    const theirs = withArtifact(start, map('Novo dele'))
    const { merged } = mergeSidecar(start, mine, theirs)
    expect(merged.artifacts?.map(item => item.name)).toEqual(['Novo dele'])
    expect(merged.artifacts?.some(item => item.id === shared.id)).toBe(false)
  })

  it('the same artifact changed on both devices is a conflict, and the choice also fixes the summary', () => {
    const start = base()
    const shared = start.artifacts![0] as MapArtifact
    const mine = withArtifact(start, { ...shared, name: 'Nome meu' })
    const theirs = withArtifact(start, { ...shared, name: 'Nome dele' })
    const { merged, conflicts } = mergeSidecar(start, mine, theirs)
    expect(conflicts.map(item => [item.path, item.label])).toEqual([[`artifacts.${shared.id}`, 'Mapa mental: Nome meu']])
    const resolved = applyFieldChoices(merged, conflicts, { [`artifacts.${shared.id}`]: 'theirs' })
    expect(resolved.artifacts?.[0].name).toBe('Nome dele')
    expect(resolved.meta.artifacts?.[0].name).toBe('Nome dele')
  })

  it('a device that does not know artifacts yet does not erase them', () => {
    const start = newSidecar(newFileMeta({ name: 'Limites', type: 'class' }))
    const mine = withArtifact(start, map('Meu mapa'))
    const theirs = { ...start, meta: { ...start.meta, description: 'dele' } }
    const { merged, conflicts } = mergeSidecar(start, mine, theirs)
    expect(conflicts).toEqual([])
    expect(merged.artifacts?.map(item => item.name)).toEqual(['Meu mapa'])
    expect(merged.meta).toMatchObject({ description: 'dele', hasMindmap: true })
  })

  it('a note without artifacts on either side stays without them', () => {
    const start = newSidecar(newFileMeta({ name: 'Limites', type: 'class' }))
    expect(mergeSidecar(start, start, start).merged.artifacts).toBeUndefined()
  })
})
