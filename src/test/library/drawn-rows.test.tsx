// Spec 007 (T047, medida do celular de 26/11): abrir a pasta de 1.000 notas (120 linhas) e a tela Gravações (100 gravações) levavam
// cerca de 1 s no celular, quase tudo desenhando as linhas de uma vez. Agora a tabela desenha primeiro as 30 que enchem a tela e o
// resto logo depois do primeiro quadro; no fim fica o mesmo de antes (120 numa pasta longa, tudo numa curta), e "Mostrar mais" só
// aparece numa pasta longa, já com as 120, nunca no meio do caminho.
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FileMeta, SourceMeta } from '@/types/domain'
import { EntryList } from '@/components/library/EntryList'
import { Explorer } from '@/components/library/Explorer'
import { defaultIndex, newFileMeta, newFolderMeta } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const CREATED = { at: '2026-11-24T12:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }
const RECORDED: SourceMeta = { input: 'recording', name: 'reuniao.webm', mime: 'audio/webm', storage: 'none' }

const notes = (folderId: string, count: number, name = 'Nota'): FileMeta[] =>
  Array.from({ length: count }, (_, index) => newFileMeta({ id: `${folderId}-${index}`, name: `${name} ${String(index + 1).padStart(4, '0')}`, type: 'explanation', folderId, created: CREATED, updated: CREATED }))

function library(files: FileMeta[]) {
  const folders = [newFolderMeta({ id: 'grande', name: 'Pasta grande' }), newFolderMeta({ id: 'curta', name: 'Pasta curta' }), newFolderMeta({ id: 'reunioes', name: 'Reuniões' })]
  const repo = { kind: 'local', accountId: 'local', fileSizes: async () => ({}), readContent: async () => '', saveIndex: async () => undefined } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders, files, index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useUiStore.setState({ menu: null, overlay: null, selection: new Set(), toasts: [], query: '' })
}

const rows = (name = 'Nota') => document.querySelectorAll(`tr[aria-label^="${name} "]`).length
const more = () => screen.queryByRole('button', { name: /Mostrar mais/ })
const folder = (folderId: string) => (
  <MemoryRouter>
    <Explorer view="folder" folderId={folderId} />
  </MemoryRouter>
)

beforeEach(() => library([...notes('grande', 1000), ...notes('curta', 150)]))

describe('uma tabela longa desenha primeiro o que enche a tela', () => {
  it('a pasta de 1.000 notas mostra 30 no primeiro quadro e chega às 120 logo depois, e só então "Mostrar mais"', { timeout: 30_000 }, async () => {
    render(folder('grande'))
    expect(rows()).toBe(30)
    expect(screen.getByText('Nota 0001')).toBeInTheDocument()
    expect(more()).toBeNull()
    await waitFor(() => expect(rows()).toBe(120), { timeout: 10_000 })
    expect(screen.getByRole('button', { name: /Mostrar mais 120 de 880/ })).toBeInTheDocument()
  })

  it('uma pasta de 150 notas chega a todas, sem "Mostrar mais" no caminho', { timeout: 30_000 }, async () => {
    render(folder('curta'))
    expect(rows()).toBe(30)
    expect(more()).toBeNull()
    await waitFor(() => expect(rows()).toBe(150), { timeout: 10_000 })
    expect(more()).toBeNull()
  })

  it('outra pasta começa de novo pelas primeiras 30', { timeout: 30_000 }, async () => {
    const view = render(folder('grande'))
    await waitFor(() => expect(rows()).toBe(120), { timeout: 10_000 })
    view.rerender(folder('curta'))
    expect(rows()).toBe(30)
    await waitFor(() => expect(rows()).toBe(150), { timeout: 10_000 })
  })

  it('a tela Gravações mostra as primeiras 30 gravações e logo depois as 100', { timeout: 30_000 }, async () => {
    library(notes('reunioes', 100, 'Reunião').map(file => ({ ...file, type: 'audio', kept: 'registro', origin: RECORDED }) as FileMeta))
    render(
      <MemoryRouter>
        <EntryList />
      </MemoryRouter>,
    )
    expect(rows('Reunião')).toBe(30)
    await waitFor(() => expect(rows('Reunião')).toBe(100), { timeout: 10_000 })
  })
})
