// História 9 (spec 003, FR-055, FR-056, SC-018, opções S1 e T): "Só neste navegador" e o "Sincronizar".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { AwayMark, LocalMark, SyncLocalBanner, SyncLocalDialog } from '@/components/library/SyncLocal'
import { useFilterSource } from '@/hooks/use-library-view'
import { CombinedRepository } from '@/lib/storage/combined-repository'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { usePlacesStore } from '@/stores/places'
import { useUiStore } from '@/stores/ui'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const library = () => useLibraryStore.getState()

let account: string

function google(id: string): Account {
  return { id, kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
}

/** Rascunhos (Local) with 2 notes, one note kept alone in Local inside Faculdade (Drive), and a note in the Drive. */
async function seed() {
  await library().connect(account, token)
  const rascunhos = await library().createFolder({ name: 'Rascunhos', place: 'local' })
  await library().createFile({ name: 'Ideias soltas', type: 'class', folderId: rascunhos.id }, 'ideias')
  await library().createFile({ name: 'Esboço do TCC', type: 'class', folderId: rascunhos.id }, 'tcc')
  const faculdade = await library().createFolder({ name: 'Faculdade' })
  const experimento = await library().createFile({ name: 'Experimento de queda livre', type: 'class', folderId: faculdade.id, place: 'local' }, 'g')
  const lista = await library().createFile({ name: 'Lista 3', type: 'class', folderId: faculdade.id }, 'lista')
  return { rascunhos, faculdade, experimento, lista }
}

const side = (id: string) => (library().repo as CombinedRepository).sideOf(id)
const inRouter = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>)

beforeEach(() => {
  installMemoryStorage()
  new FakeDrive().install()
  account = uniqueAccount()
  useUiStore.setState({ overlay: null, toasts: [] })
  usePlacesStore.setState({ running: false, progress: null, failed: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, google(account)], activeId: account, reconnectId: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

describe('a faixa "Sincronizar" na biblioteca', () => {
  it('aparece enquanto há algo só neste navegador, com quantas notas, o espaço e o risco; "Sincronizar" abre a janela', async () => {
    await seed()
    inRouter(<SyncLocalBanner />)
    const banner = screen.getByRole('region', { name: 'Só neste navegador' })
    expect(banner).toHaveTextContent(/3 notas estão só neste navegador \(.+\)\. Limpar os dados do navegador apaga elas\./)
    fireEvent.click(within(banner).getByRole('button', { name: 'Sincronizar' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'sync-local' })
  })

  it('na página de uma nota em Local, fala só dela; numa nota do Drive, não aparece', async () => {
    const { experimento, lista } = await seed()
    const { unmount } = inRouter(<SyncLocalBanner fileId={experimento.id} />)
    expect(screen.getByRole('region', { name: 'Só neste navegador' })).toHaveTextContent('Esta nota está só neste navegador.')
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'sync-local', ids: [experimento.id] })
    unmount()
    inRouter(<SyncLocalBanner fileId={lista.id} />)
    expect(screen.queryByRole('region', { name: 'Só neste navegador' })).not.toBeInTheDocument()
  })

  it('sem nada em Local, não aparece', async () => {
    await library().connect(account, token)
    await library().createFile({ name: 'Lista 3', type: 'class', folderId: null }, 'lista')
    inRouter(<SyncLocalBanner />)
    expect(screen.queryByRole('region', { name: 'Só neste navegador' })).not.toBeInTheDocument()
  })

  it('cada item em Local mostra "Só neste navegador" na lista', async () => {
    const { rascunhos, lista } = await seed()
    inRouter(
      <>
        <LocalMark id={rascunhos.id} />
        <span data-testid="lista">
          <LocalMark id={lista.id} />
        </span>
      </>,
    )
    expect(screen.getByText('Só neste navegador')).toBeInTheDocument()
    expect(screen.getByTestId('lista')).toBeEmptyDOMElement()
  })
})

describe('nota do Drive cuja pasta está em Local noutro navegador', () => {
  it('diz "A pasta dela está em outro navegador"; neste navegador, onde a pasta existe, não diz nada', async () => {
    const { rascunhos } = await seed()
    const { rerender } = inRouter(<AwayMark awayId="pasta-de-outro-navegador" />)
    expect(screen.getByText('A pasta dela está em outro navegador')).toBeInTheDocument()
    rerender(
      <MemoryRouter>
        <AwayMark awayId={rascunhos.id} />
      </MemoryRouter>,
    )
    expect(screen.queryByText('A pasta dela está em outro navegador')).not.toBeInTheDocument()
  })
})

describe('o filtro "Guardado"', () => {
  it('"Só neste navegador" conta as notas em Local, não só as mídias deste navegador', async () => {
    const { experimento, lista } = await seed()
    const { result } = renderHook(() => useFilterSource())
    expect(result.current.localMedia).toContain(experimento.id)
    expect(result.current.localMedia).not.toContain(lista.id)
  })
})

describe('a janela do "Sincronizar"', () => {
  it('diz o que está só aqui, o destino (Drive; App desligado) e quais vão, todos marcados', async () => {
    await seed()
    inRouter(<SyncLocalDialog />)
    expect(screen.getByText(/3 notas em 2 pastas estão só neste navegador/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Google Drive/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /App · desligado/ })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /^Rascunhos/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Faculdade › Experimento de queda livre/ })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Sincronizar 3 notas' })).toBeEnabled()
  })

  it('desmarcar um item tira as notas dele da conta', async () => {
    await seed()
    inRouter(<SyncLocalDialog />)
    fireEvent.click(screen.getByRole('checkbox', { name: /^Rascunhos/ }))
    expect(screen.getByRole('button', { name: 'Sincronizar 1 nota' })).toBeEnabled()
  })

  it('sincroniza de verdade: depois, nada está só neste navegador e outro aparelho vê tudo', async () => {
    const { rascunhos, experimento } = await seed()
    inRouter(<SyncLocalDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar 3 notas' }))
    expect(await screen.findByText('Pronto: 3 notas no Google Drive.')).toBeInTheDocument()
    expect(side(rascunhos.id)).toBe('drive')
    expect(side(experimento.id)).toBe('drive')
    const other = new CombinedRepository(new DriveRepository(account, token, 'drive'), new LocalRepository(`study-helper-local-${account}-b`, account))
    const seen = await other.load()
    expect(seen.files.map(file => file.name).sort()).toEqual(['Esboço do TCC', 'Experimento de queda livre', 'Ideias soltas', 'Lista 3'])
    // the folder of the note that went alone keeps following its folder now: no own choice is left behind
    await waitFor(() => expect(library().files.find(file => file.id === experimento.id)?.place).toBeUndefined())
  })
})
