// História 10 (003): a pasta mostra todas as notas, cada uma com o seu tipo; o que era entrada é nota (FR-049).
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'

import type { FileMeta, SourceMeta } from '@/types/domain'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, renderAt, seedLibrary } from '@/test/library/explorer-fixture'

function item(id: string, name: string, extra: Partial<FileMeta> = {}): FileMeta {
  return { ...FILES[0], id, name, folderId: 'fis', tags: [], mastery: null, ...extra }
}

const source = (fields: Partial<SourceMeta> & Pick<SourceMeta, 'input'>): SourceMeta => ({ name: 'x', storage: 'none', ...fields })

// a library from before keeps role entrada; a note made now has its type
const VIDEO = item('video', 'Reunião de kickoff.mp4', { type: 'reading', role: 'entrada', kept: 'registro', origin: source({ input: 'file', name: 'kickoff.mp4', mime: 'video/mp4', durationSeconds: 600 }) })
const PDF = item('pdf', 'Contrato.pdf', { type: 'pdf', kept: 'registro', origin: source({ input: 'file', name: 'contrato.pdf', mime: 'application/pdf' }) })
const TEXT = item('texto', 'Texto colado · 06/11', { type: 'reading', role: 'entrada', kept: 'registro', origin: source({ input: 'text', mime: 'text/plain', sizeBytes: 120 }) })
const ATA = item('ata', 'Ata do kickoff', { type: 'meeting', parentFileId: 'video' })
const CLAUSES = item('clausulas', 'Cláusulas do contrato', { type: 'class', parentFileId: 'pdf' })
const ADDED = [VIDEO, PDF, TEXT, ATA, CLAUSES]

const rows = () => within(screen.getByRole('table', { name: 'Notas e pastas' })).getAllByRole('row').slice(1)
const rowOf = (name: string) => rows().find(row => row.getAttribute('aria-label') === name)!

beforeEach(() => {
  seedLibrary()
  const repo = useLibraryStore.getState().repo!
  const all = [...FILES, ...ADDED]
  const readSidecar = async (id: string) => ({ meta: all.find(file => file.id === id)!, highlights: [], questions: [], attempts: [] })
  useLibraryStore.setState({ files: all, repo: { ...repo, readSidecar, readContent: async () => '' } as Repository })
  useUiStore.setState({ selection: new Set(), query: '' })
})

describe('a pasta com notas de todos os tipos', () => {
  it('lista o que era entrada como nota, ao lado das notas escritas e das filhas', () => {
    renderAt('/biblioteca/fis')
    expect(rows().map(row => row.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Ondas', 'Reunião de kickoff.mp4', 'Contrato.pdf', 'Texto colado · 06/11', 'Ata do kickoff', 'Cláusulas do contrato']))
  })

  it('cada nota diz o seu tipo, e a de vídeo diz quantas notas nasceram dela', () => {
    renderAt('/biblioteca/fis')
    expect(rowOf('Reunião de kickoff.mp4')).toHaveTextContent('Vídeo · 10 min')
    expect(rowOf('Reunião de kickoff.mp4')).toHaveTextContent('1 nota')
    expect(rowOf('Contrato.pdf')).toHaveTextContent('PDF')
    expect(rowOf('Texto colado · 06/11')).toHaveTextContent('Texto')
    expect(screen.queryByText(/entrada/i)).toBeNull()
  })

  it('não tem mais o seletor "Entradas:"', () => {
    renderAt('/biblioteca/fis')
    expect(screen.queryByRole('combobox', { name: 'Entradas' })).toBeNull()
  })

  it('o "Tipo" da pasta oferece os tipos das notas de fonte', () => {
    renderAt('/biblioteca/fis')
    const panel = screen.getByRole('complementary', { name: 'Filtros' })
    for (const kind of ['Vídeo', 'PDF', 'Texto']) expect(within(panel).getByRole('checkbox', { name: new RegExp(`^${kind}\\b`) })).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('checkbox', { name: /^Vídeo\b/ }))
    expect(rows().map(row => row.getAttribute('aria-label'))).toEqual(['Reunião de kickoff.mp4'])
  })

  it('abrir a nota de vídeo abre a página especial dela, com as notas filhas', async () => {
    renderAt('/biblioteca/fis')
    fireEvent.click(rowOf('Reunião de kickoff.mp4'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Reunião de kickoff.mp4' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ata do kickoff' })).toBeInTheDocument()
    expect(screen.queryByText(/entrada/i)).toBeNull()
  })
})
