// Spec 007 (T041, research R7, FR-006): uma pasta com 1.000 notas desenhava as 1.000 linhas de uma vez (abrir a pasta: 1,2 s no
// computador e 5,8 s no celular na medida de antes). Agora desenha as primeiras 120 e o resto conforme a rolagem chega perto do fim,
// com "Mostrar mais" para o teclado e o leitor de tela; "Marcar todos" continua valendo para a pasta inteira.
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { Explorer } from '@/components/library/Explorer'
import { defaultIndex, newFileMeta, newFolderMeta } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

const CREATED = { at: '2026-11-24T12:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }

function library(count: number) {
  const folder = newFolderMeta({ id: 'grande', name: 'Pasta grande' })
  const files = Array.from({ length: count }, (_, index) => newFileMeta({ id: `n${index}`, name: `Nota ${String(index + 1).padStart(4, '0')}`, type: 'explanation', folderId: 'grande', created: CREATED, updated: CREATED }))
  const repo = { kind: 'local', accountId: 'local', fileSizes: async () => ({}), readContent: async () => '', saveIndex: async () => undefined } as unknown as Repository
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [folder], files, index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null, sizes: {} })
  useUiStore.setState({ menu: null, overlay: null, selection: new Set(), toasts: [], query: '' })
}

const rows = () => document.querySelectorAll('tr[aria-label^="Nota "]').length

beforeEach(() => library(1000))

describe('uma pasta com 1.000 notas', () => {
  it('desenha as primeiras 120, não as 1.000', { timeout: 30_000 }, () => {
    render(
      <MemoryRouter>
        <Explorer view="folder" folderId="grande" />
      </MemoryRouter>,
    )
    expect(rows()).toBe(120)
    expect(screen.getByText('Nota 0001')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Mostrar mais 120 de 880/ })).toBeInTheDocument()
  })

  it('mostra mais até o fim (o jsdom não rola: o botão faz o que a rolagem faz)', () => {
    library(400)
    render(
      <MemoryRouter>
        <Explorer view="folder" folderId="grande" />
      </MemoryRouter>,
    )
    for (const expected of [240, 360, 400]) {
      fireEvent.click(screen.getByRole('button', { name: /Mostrar mais/ }))
      expect(rows()).toBe(expected)
    }
    expect(screen.getByText('Nota 0400')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mostrar mais/ })).toBeNull()
  }, 30_000)

  it('"Marcar todos" marca a pasta inteira, não só o que está desenhado', { timeout: 30_000 }, () => {
    render(
      <MemoryRouter>
        <Explorer view="folder" folderId="grande" />
      </MemoryRouter>,
    )
    fireEvent.click(within(document.querySelector('thead')!).getByRole('checkbox', { name: 'Marcar todos' }))
    expect(useUiStore.getState().selection.size).toBe(1000)
  })

  it('uma pasta pequena desenha tudo, como antes', () => {
    library(150)
    render(
      <MemoryRouter>
        <Explorer view="folder" folderId="grande" />
      </MemoryRouter>,
    )
    expect(rows()).toBe(150)
    expect(screen.queryByRole('button', { name: /Mostrar mais/ })).toBeNull()
  })
})
