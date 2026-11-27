// Spec 007 (T047, medida do celular de 26/11): apagar e mover uma nota passavam de 1 s no celular, quase tudo o React atualizando as
// 120 linhas da pasta. Dentro de cada linha, o "Só neste navegador", o "O que nasceu", a contagem da família e o selo da mãe assinavam a
// lista inteira de notas: qualquer nota mudada redesenhava todas as linhas. Agora cada um assina só o que mostra.
import '@/test/account/storage-shim'
import { beforeEach, expect, it } from 'vitest'
import { Profiler, type ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FileMeta } from '@/types/domain'
import { FileTableRow } from '@/components/library/FileRows'
import { useFileActions } from '@/components/library/use-file-actions'
import { defaultIndex, newFileMeta } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'

const router = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>

// n0 is the mother of n1 and n2; the rows of n0 and n3 show "O que nasceu" in a column of their own
const FILES: FileMeta[] = Array.from({ length: 30 }, (_, index) =>
  newFileMeta({ id: `n${index}`, name: `Nota ${index}`, type: 'explanation', folderId: null, parentFileId: index === 1 || index === 2 ? 'n0' : null }),
)

let draws: Map<string, number>

/** The table as the folder draws it, but fixed: only what each row asks of the store can draw it again. */
function Table() {
  const actions = useFileActions()
  return (
    <table>
      <tbody>
        {FILES.map(file => (
          <Profiler key={file.id} id={file.id} onRender={id => draws.set(id, (draws.get(id) ?? 0) + 1)}>
            <FileTableRow file={file} born={file.id === 'n0' || file.id === 'n3'} narrow={false} selectable draggable={false} actions={actions} />
          </Profiler>
        ))}
      </tbody>
    </table>
  )
}

const change = (edit: (files: FileMeta[]) => FileMeta[]) => act(() => useLibraryStore.setState(state => ({ files: edit(state.files) })))

beforeEach(() => {
  useLibraryStore.setState({ repo: null, accountId: 'local', ready: true, folders: [], files: FILES, index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  draws = new Map()
  render(<Table />, { wrapper: router })
  expect(screen.getAllByText('de: Nota 0')).toHaveLength(2)
  draws.clear()
})

it('apagar ou renomear uma nota não redesenha as outras linhas (só a dela)', () => {
  change(files => files.map(file => (file.id === 'n7' ? { ...file, name: 'Nota sete', deletedAt: '2026-11-26T12:00:00Z' } : file)))
  change(files => files.filter(file => file.id !== 'n9'))
  expect([...draws.keys()].sort()).toEqual(['n7', 'n9'])
})

it('um filho novo redesenha só a linha da mãe, que conta mais um', () => {
  change(files => [...files, newFileMeta({ id: 'filho', name: 'Filho novo', type: 'explanation', folderId: null, parentFileId: 'n3' })])
  expect([...draws.keys()]).toEqual(['n3'])
  expect(screen.getByText('1 nota')).toBeInTheDocument()
})

it('a mãe renomeada redesenha a linha dela e as dos filhos, com o nome novo no selo', () => {
  change(files => files.map(file => (file.id === 'n0' ? { ...file, name: 'Reunião mãe' } : file)))
  expect([...draws.keys()].sort()).toEqual(['n0', 'n1', 'n2'])
  expect(screen.getAllByText('de: Reunião mãe')).toHaveLength(2)
})
