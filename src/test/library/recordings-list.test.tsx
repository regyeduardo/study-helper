// História 10 (003): a tela "Entradas" virou "Gravações", com o mesmo desenho, só com o que o app gravou (FR-050).
import { beforeEach, describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'

import type { FileMeta, SourceMeta } from '@/types/domain'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, renderAt, seedLibrary } from '@/test/library/explorer-fixture'

const at = (iso: string) => ({ at: iso, deviceId: 'local', deviceName: 'Este computador' })

function item(id: string, name: string, origin: SourceMeta, extra: Partial<FileMeta> = {}): FileMeta {
  return { ...FILES[0], id, name, folderId: 'calc', tags: [], mastery: null, origin, kept: 'registro', created: at('2026-11-10T12:00:00Z'), updated: at('2026-11-10T12:00:00Z'), ...extra }
}

const RECORDED = item('rec-new', 'Reunião de kickoff', { input: 'recording', name: 'kickoff.webm', mime: 'video/webm', durationSeconds: 600, storage: 'none' }, { type: 'video' })
// a library from before: the recording is still an item with role entrada, read as is
const OLD_RECORDED = item('rec-old', 'Gravação da aula 3.webm', { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', storage: 'none' }, { type: 'reading', role: 'entrada' })
const SENT_VIDEO = item('sent', 'aula-enviada.mp4', { input: 'file', name: 'aula-enviada.mp4', mime: 'video/mp4', storage: 'none' }, { type: 'video' })
const PDF = item('pdf', 'Contrato.pdf', { input: 'file', name: 'contrato.pdf', mime: 'application/pdf', storage: 'none' }, { type: 'pdf' })
const OLD_LINK = item('link', 'Guia de juros', { input: 'url', name: 'Guia de juros', url: 'https://exemplo.com/juros', storage: 'none' }, { type: 'reading', role: 'entrada' })
const TRASHED = item('rec-gone', 'Gravação apagada', { input: 'recording', name: 'x.webm', mime: 'audio/webm', storage: 'none' }, { type: 'audio', deletedAt: '2026-11-11T10:00:00Z' })

const table = () => screen.getByRole('table', { name: 'Gravações' })
const names = () => within(table()).getAllByRole('row').slice(1).map(row => row.getAttribute('aria-label'))

beforeEach(() => {
  seedLibrary()
  useUiStore.setState({ selection: new Set(), query: '' })
  useLibraryStore.setState(state => ({ files: [...state.files, RECORDED, OLD_RECORDED, SENT_VIDEO, PDF, OLD_LINK, TRASHED] }))
})

describe('Gravações', () => {
  it('lista só as notas de mídia que o app gravou, inclusive as da biblioteca antiga', () => {
    renderAt('/gravacoes')
    expect(names()).toEqual(expect.arrayContaining(['Reunião de kickoff', 'Gravação da aula 3.webm']))
    expect(names()).toHaveLength(2)
  })

  it('um vídeo enviado, um PDF e um link não aparecem ali', () => {
    renderAt('/gravacoes')
    for (const name of ['aula-enviada.mp4', 'Contrato.pdf', 'Guia de juros', 'Gravação apagada']) expect(names()).not.toContain(name)
  })

  it('o endereço antigo /entradas abre a mesma tela', () => {
    renderAt('/entradas')
    expect(names()).toHaveLength(2)
  })

  it('a barra lateral diz "Gravações", com a contagem, no lugar de "Entradas"', () => {
    renderAt('/gravacoes')
    const nav = screen.getByRole('navigation')
    const button = within(nav).getByRole('button', { name: /^Gravações/ })
    expect(button).toHaveAttribute('aria-current', 'true')
    expect(button).toHaveTextContent('2')
    expect(within(nav).queryByRole('button', { name: /^Entradas/ })).toBeNull()
    expect(screen.queryByText(/entrada/i)).toBeNull()
  })

  it('o "Tipo" do painel oferece só Vídeo e Áudio: uma gravação nunca é PDF, link ou texto', () => {
    renderAt('/gravacoes')
    const panel = screen.getByRole('complementary', { name: 'Filtros' })
    const kinds = within(within(panel).getByRole('group', { name: 'Tipo' })).getAllByRole('checkbox').map(box => box.getAttribute('aria-label')?.split(',')[0])
    expect(kinds).toEqual(['Vídeo', 'Áudio'])
  })

  it('sem gravações, diz o que aparece aqui e oferece gravar', () => {
    useLibraryStore.setState({ files: [...FILES, SENT_VIDEO, PDF, TRASHED] })
    renderAt('/gravacoes')
    expect(screen.queryByRole('table', { name: 'Gravações' })).toBeNull()
    expect(screen.getByText('Nenhuma gravação ainda')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Gravar/ }).length).toBeGreaterThan(1)
  })
})
