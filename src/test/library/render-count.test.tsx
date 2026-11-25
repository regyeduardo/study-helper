import '@/test/account/storage-shim'
import { describe, expect, it, vi } from 'vitest'
import { type ReactNode } from 'react'
import { act, render, renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { FileTableRow } from '@/components/library/FileRows'
import { useFileActions } from '@/components/library/use-file-actions'
import { newFileMeta } from '@/lib/defaults'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

// Spec 007 (T043, research R7, H11): uma pasta com 1.000 notas desenhava as 1.000 linhas a cada mudança em qualquer lugar (um aviso,
// uma nota guardada, o andamento de uma geração), porque cada linha assinava as stores inteiras. As ações leem as stores no clique,
// são o mesmo objeto entre desenhos, e as linhas são memorizadas.

// each table row asks this once per draw: counting it counts the draws of the rows
const counter = vi.hoisted(() => ({ rows: 0 }))
vi.mock('@/components/library/SyncLocal', async importOriginal => ({
  ...((await importOriginal()) as object),
  useIsLocal: () => {
    counter.rows++
    return false
  },
}))

const router = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>

describe('useFileActions', () => {
  it('não redesenha quando a biblioteca, a interface ou as gerações mudam, e dá sempre o mesmo objeto', () => {
    let draws = 0
    const { result } = renderHook(
      () => {
        draws++
        return useFileActions()
      },
      { wrapper: router },
    )
    const first = result.current
    act(() => {
      useUiStore.getState().toast('um aviso')
      useLibraryStore.setState({ files: [...useLibraryStore.getState().files] })
      useJobsStore.setState({ jobs: [...useJobsStore.getState().jobs] })
    })
    expect(draws).toBe(1)
    expect(result.current).toBe(first)
  })
})

describe('as linhas da tabela', () => {
  it('uma mudança fora da linha não a desenha de novo', () => {
    const files = Array.from({ length: 50 }, (_, index) => newFileMeta({ name: `Nota ${index}`, type: 'explanation', folderId: null }))
    counter.rows = 0
    function Table({ tick }: { tick: number }) {
      const actions = useFileActions()
      return (
        <table data-tick={tick}>
          <tbody>
            {files.map(file => (
              <FileTableRow key={file.id} file={file} narrow={false} selectable draggable={false} actions={actions} />
            ))}
          </tbody>
        </table>
      )
    }
    const view = render(<Table tick={0} />, { wrapper: router })
    const first = counter.rows
    expect(first).toBe(50)
    // the parent draws again (a toast, the filters, the selection of another row): the rows do not
    view.rerender(<Table tick={1} />)
    expect(counter.rows).toBe(first)
  })
})
