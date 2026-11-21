// T119 (FR-073, SC-014), revisto na 003 (história 10): a pasta lista as notas de todos os tipos, uma por linha; o que era entrada é nota do seu tipo.
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, renderHook, screen, within } from '@testing-library/react'

import type { FileMeta, FolderMeta, SourceMeta } from '@/types/domain'
import { useLibraryView } from '@/hooks/use-library-view'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, FOLDERS, renderAt, seedLibrary } from '@/test/library/explorer-fixture'

const COLADO: SourceMeta = { input: 'text', name: 'texto colado', storage: 'none' }
const PDF: SourceMeta = { input: 'file', name: 'limites.pdf', mime: 'application/pdf', storage: 'drive', storedFileId: 'drv' }

const note = (id: string, name: string, folderId: string | null, extra: Partial<FileMeta> = {}): FileMeta => ({ ...FILES[3], id, name, folderId, tags: [], mastery: null, ...extra })
const entrada = (id: string, name: string, folderId: string | null, origin: SourceMeta): FileMeta => note(id, name, folderId, { role: 'entrada', kept: 'registro', origin })

/** Cálculo I gets a pasted-text entrada with its Ata, a nota filha of "Limites…" and an Aula of a PDF that lives in Física II. */
const FAMILY = [
  entrada('colado', 'texto colado', 'calc', COLADO),
  note('ata-colado', 'Ata do texto colado', 'calc', { type: 'meeting', parentFileId: 'colado' }),
  note('filha', 'Exercícios resolvidos de limites', 'calc', { type: 'explanation', parentFileId: 'limites' }),
  entrada('pdf', 'limites.pdf', 'fis', PDF),
  note('aula-pdf', 'Aula do PDF de limites', 'calc', { type: 'class', parentFileId: 'pdf' }),
]

const ONLY_ENTRIES: FolderMeta = { ...FOLDERS[3], id: 'gravacoes', name: 'Gravações', parentId: null, position: 2 }

beforeEach(() => {
  seedLibrary()
  useLibraryStore.setState(state => ({ files: [...state.files, ...FAMILY, entrada('so-video', 'Reunião de segunda', 'gravacoes', { input: 'file', name: 'r.mp4', mime: 'video/mp4', storage: 'none' })], folders: [...state.folders, ONLY_ENTRIES] }))
  useUiStore.setState({ selection: new Set(), query: '', tag: null, lowMastery: false })
})

const table = () => screen.getByRole('table', { name: 'Notas e pastas' })
const fileRows = () => within(table()).getAllByRole('row').filter(row => row.dataset.fileId)
const rowOf = (id: string) => fileRows().find(row => row.dataset.fileId === id)!
const headers = () => within(table()).getAllByRole('columnheader').map(header => header.textContent?.trim())
const group = (name: string) => screen.getByRole('group', { name })
const optionNames = (name: string) => within(group(name)).getAllByRole('checkbox').map(box => box.getAttribute('aria-label')?.split(',')[0])

describe('a pasta mostra as notas de todos os tipos, uma por linha (003, SC-014)', () => {
  it('o que era entrada é linha, como nota do seu tipo, e nenhuma nota fica recuada embaixo de outra', () => {
    renderAt('/biblioteca/calc')
    // by name, as the table sorts: the nota filha is in its place in the alphabet, not under its mother
    expect(fileRows().map(row => row.dataset.fileId)).toEqual(['ata-colado', 'aula-pdf', 'derivadas-video', 'derivadas', 'filha', 'limites', 'monitoria', 'colado'])
    for (const row of fileRows()) {
      expect(row).not.toHaveClass('fam-nested')
      expect(row.dataset.depth ?? '0').toBe('0')
      expect(row.getAttribute('style') ?? '').not.toContain('--fam-depth')
    }
    expect(rowOf('colado')).toHaveTextContent('Texto')
  })

  it('não há as abas "Tudo / Entradas / Notas" nem a coluna "O que nasceu"', () => {
    renderAt('/biblioteca/calc')
    expect(screen.queryByRole('group', { name: 'Mostrar' })).toBeNull()
    expect(headers()).toEqual(['', 'Nome', 'Criado', 'Atualizado', ''])
    expect(table()).not.toHaveTextContent('Nada ainda')
  })

  it('a nota leva à sua entrada, ou à nota mãe, em 1 clique, mesmo com as duas na mesma pasta', () => {
    renderAt('/biblioteca/calc')
    expect(within(rowOf('ata-colado')).getByRole('link', { name: 'de: texto colado' })).toHaveAttribute('href', '/arquivo/colado')
    expect(within(rowOf('aula-pdf')).getByRole('link', { name: 'de: limites.pdf' })).toHaveAttribute('href', '/arquivo/pdf')
    expect(within(rowOf('filha')).getByRole('link', { name: 'de: Limites laterais e continuidade' })).toHaveAttribute('href', '/arquivo/limites')
  })

  it('uma pasta só com um vídeo enviado mostra o vídeo como nota, sem aviso de "só entradas"', () => {
    renderAt('/biblioteca/gravacoes')
    expect(screen.getByRole('row', { name: 'Reunião de segunda' })).toHaveTextContent('Vídeo')
    expect(screen.queryByText(/entrada/i)).toBeNull()
  })

  it('as outras telas (Colunas, Comandos, Foco) também listam as notas de todos os tipos da pasta', () => {
    const { result } = renderHook(() => useLibraryView('folder', 'calc'))
    expect(result.current.files.map(file => file.id)).toContain('colado')
    expect(result.current.files.map(file => file.id)).toContain('ata-colado')
  })
})

describe('na pasta, "Tipo" é o tipo da nota, de todos os tipos; "O que gerou" fica em Gravações (003)', () => {
  it('a pasta filtra pelo tipo da nota, inclusive Vídeo, PDF e Texto, com a contagem de cada um', () => {
    renderAt('/biblioteca/calc')
    expect(optionNames('Tipo')).toEqual(['Ata', 'Aula', 'Explicação', 'Leitura', 'Nota', 'Vídeo', 'Áudio', 'PDF', 'Link', 'Texto', 'Tema', 'Outro arquivo'])
    expect(within(group('Tipo')).getByRole('checkbox', { name: 'Texto, 1 item' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'O que gerou' })).toBeNull()
    expect(within(group('Tipo')).getByRole('checkbox', { name: 'Leitura, 2 itens' })).toBeInTheDocument()
    expect(within(group('Tipo')).getByRole('checkbox', { name: 'Nota, 2 itens' })).toBeInTheDocument()
    fireEvent.click(within(group('Tipo')).getByRole('checkbox', { name: /^Aula\b/ }))
    expect(fileRows().map(row => row.dataset.fileId)).toEqual(['aula-pdf'])
    expect(group('Filtros ativos')).toHaveTextContent(/Tipo\s*aula/)
  })

  it('"Gravações" tem o tipo da gravação e "O que gerou"', () => {
    const recorded = note('gravada', 'Reunião gravada', 'calc', { type: 'video', kept: 'registro', origin: { input: 'recording', name: 'g.webm', mime: 'video/webm', storage: 'none' } })
    useLibraryStore.setState(state => ({ files: [...state.files, recorded] }))
    renderAt('/gravacoes')
    expect(optionNames('Tipo')).toEqual(expect.arrayContaining(['Vídeo', 'Áudio']))
    expect(optionNames('Tipo')).not.toContain('Explicação')
    expect(optionNames('O que gerou')).toEqual(expect.arrayContaining(['Ata', 'Aula', 'Nada ainda']))
  })

  it('o tipo escolhido em "Gravações" não esvazia a pasta', () => {
    useUiStore.getState().setFilters({ ...useUiStore.getState().filters, kinds: ['video'] })
    renderAt('/biblioteca/calc')
    expect(fileRows()).toHaveLength(8)
    expect(screen.queryByRole('group', { name: 'Filtros ativos' })).toBeNull()
  })
})
