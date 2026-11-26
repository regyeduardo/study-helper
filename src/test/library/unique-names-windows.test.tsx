// FR-021 (spec 005, 25/11): nas janelas onde a pessoa renomeia ou muda de pasta direto no campo (a ordem das aulas, o painel de
// propriedades), um nome que já existe ali é recusado dizendo qual, e o campo volta ao que era.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { OrderDialog } from '@/components/dialogs/MoreDialogs'
import { useViewRoute } from '@/hooks/use-view-route'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { LocalRepository } from '@/lib/storage/local-repository'
import { CommandsWorkspace } from '@/pages/workspace/container/commands'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { installMemoryStorage } from '@/test/storage/fake-drive'

let repo: LocalRepository

async function seed(folders: FolderMeta[], files: FileMeta[]) {
  for (const folder of folders) await repo.saveFolder(folder)
  for (const file of files) await repo.saveFile(newSidecar(file), '# texto')
  useLibraryStore.setState({ repo, sharedView: null, ready: true, folders, files, opened: {}, openedAt: {}, sizes: {} })
}

const lesson = (name: string, folderId: string, position: number) => newFileMeta({ name, type: 'class', folderId, position })
const lastToast = () => useUiStore.getState().toasts.at(-1)?.text
const fileNow = (id: string) => useLibraryStore.getState().files.find(file => file.id === id)!

beforeEach(async () => {
  installMemoryStorage()
  repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
  await repo.load()
  useUiStore.setState({ overlay: null, toasts: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a ordem das aulas', () => {
  const curso = newFolderMeta({ name: 'Inglês', isCourse: true })
  const m1 = newFolderMeta({ name: 'Módulo 1', parentId: curso.id, position: 0 })
  const m2 = newFolderMeta({ name: 'Módulo 2', parentId: curso.id, position: 1 })

  it('renomear uma aula para o nome de outra ali: avisa qual e o campo volta', async () => {
    const a = lesson('Aula 1', curso.id, 0)
    const b = lesson('Aula 2', curso.id, 1)
    await seed([curso, m1, m2], [a, b])
    render(<OrderDialog folderId={curso.id} />)
    const field = screen.getAllByLabelText('Nome da aula')[1] as HTMLInputElement
    fireEvent.change(field, { target: { value: 'aula 1' } })
    fireEvent.blur(field)
    await waitFor(() => expect(lastToast()).toBe('Já existe uma nota chamada "Aula 1" em Inglês.'))
    expect(field.value).toBe('Aula 2')
    expect(fileNow(b.id).name).toBe('Aula 2')
  })

  it('renomear um módulo para o nome de outro: avisa qual e o campo volta', async () => {
    await seed([curso, m1, m2], [])
    render(<OrderDialog folderId={curso.id} />)
    const field = screen.getAllByLabelText('Nome do módulo')[1] as HTMLInputElement
    fireEvent.change(field, { target: { value: 'módulo 1' } })
    fireEvent.blur(field)
    await waitFor(() => expect(lastToast()).toBe('Já existe uma pasta chamada "Módulo 1" em Inglês.'))
    expect(field.value).toBe('Módulo 2')
    expect(useLibraryStore.getState().folders.find(folder => folder.id === m2.id)?.name).toBe('Módulo 2')
  })

  it('levar uma aula para um módulo que já tem uma de mesmo nome: avisa qual e ela fica', async () => {
    const solta = lesson('Aula 1', curso.id, 0)
    await seed([curso, m1, m2], [solta, lesson('Aula 1', m1.id, 0)])
    render(<OrderDialog folderId={curso.id} />)
    fireEvent.change(screen.getAllByLabelText('Mover para o módulo')[0], { target: { value: m1.id } })
    await waitFor(() => expect(lastToast()).toBe('Não deu para mover: Já existe uma nota chamada "Aula 1" em Módulo 1.'))
    expect(fileNow(solta.id).folderId).toBe(curso.id)
  })

  it('um nome livre muda como antes', async () => {
    const a = lesson('Aula 1', curso.id, 0)
    await seed([curso, m1, m2], [a])
    render(<OrderDialog folderId={curso.id} />)
    const field = screen.getByLabelText('Nome da aula') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Aula de abertura' } })
    fireEvent.blur(field)
    await waitFor(() => expect(fileNow(a.id).name).toBe('Aula de abertura'))
  })
})

describe('o painel de propriedades', () => {
  function Commands() {
    return <CommandsWorkspace route={useViewRoute()} />
  }

  it('mudar a pasta para uma que já tem uma nota de mesmo nome: avisa qual e a nota fica', async () => {
    const vp6 = newFolderMeta({ name: 'VP6' })
    const nota = newFileMeta({ name: 'Resumo', type: 'reading', folderId: null })
    await seed([vp6], [nota, newFileMeta({ name: 'resumo', type: 'reading', folderId: vp6.id })])
    render(
      <MemoryRouter initialEntries={[`/arquivo/${nota.id}`]}>
        <Routes>
          <Route path="/arquivo/:fileId" element={<Commands />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.change(await screen.findByRole('combobox', { name: 'Pasta' }), { target: { value: vp6.id } })
    await waitFor(() => expect(lastToast()).toBe('Não deu para mover: Já existe uma nota chamada "resumo" em VP6.'))
    expect(fileNow(nota.id).folderId).toBeNull()
  })
})
