import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The level of what stays of the source, in the window of Novo conteúdo (T052, FR-023, FR-055). The store side is in keep-level.test.tsx.

vi.mock('@/lib/transcription', () => ({ ENGINES: [], transcribe: vi.fn() }))

import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { type NewContentRequest, useJobsStore } from '@/stores/jobs'
import { useSyncStore } from '@/stores/sync'
import { installBlobShim } from '@/test/imports/blob-shim'

installBlobShim()

const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana Souza', email: 'ana@example.com', picture: '', token: { accessToken: 'a', expiresAt: Date.now() + 3600_000 } }
const LEVELS = ['Sem rastro', 'Só o registro', 'Registro e arquivo']

const startNewContent = vi.fn(async (_request: NewContentRequest) => null)

function fileOf(name: string, type: string): File {
  return new File(['hello world'], name, { type })
}

function open() {
  render(
    <MemoryRouter>
      <NewContentDialog />
    </MemoryRouter>,
  )
}

const levels = () => within(screen.getByRole('radiogroup', { name: 'O que guardar da fonte' }))
const where = () => screen.queryByRole('radiogroup', { name: 'Onde guardar o arquivo' })
const names = (group: ReturnType<typeof within>) => group.getAllByRole('radio').map((radio: HTMLElement) => radio.querySelector('b')!.textContent)
const checked = (group: ReturnType<typeof within>) => group.getAllByRole('radio').find((radio: HTMLElement) => radio.getAttribute('aria-checked') === 'true')?.querySelector('b')?.textContent

async function withFile(file: File) {
  open()
  fireEvent.click(screen.getByRole('button', { name: /Arquivo/ }))
  fireEvent.change(document.getElementById('nc-file') as HTMLInputElement, { target: { files: [file] } })
  await screen.findByRole('radiogroup', { name: 'O que guardar da fonte' })
}

async function sent(button: string): Promise<NewContentRequest> {
  fireEvent.click(screen.getByRole('button', { name: button }))
  await waitFor(() => expect(startNewContent).toHaveBeenCalled())
  return startNewContent.mock.calls[0][0]
}

beforeEach(() => {
  startNewContent.mockClear()
  useJobsStore.setState({ jobs: [], startNewContent })
  useSyncStore.setState({ usage: null })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
})

describe('o nível com que cada tipo começa', () => {
  it('um link oferece os três níveis e começa em "Só o registro", sem perguntar onde guardar', () => {
    open()
    expect(names(levels())).toEqual(LEVELS)
    expect(checked(levels())).toBe('Só o registro')
    expect(levels().getByText('Fica só a nota.')).toBeInTheDocument()
    expect(where()).toBeNull()
  })

  it('texto e tema começam em "Só o registro"', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Texto' }))
    expect(checked(levels())).toBe('Só o registro')
    fireEvent.click(screen.getByRole('button', { name: 'Tema' }))
    expect(names(levels())).toEqual(LEVELS)
    expect(checked(levels())).toBe('Só o registro')
  })

  it('sem arquivo, "Registro e arquivo" não dá para escolher', () => {
    open()
    fireEvent.click(levels().getByText('Registro e arquivo'))
    expect(checked(levels())).toBe('Só o registro')
    expect(where()).toBeNull()
  })

  it('uma mídia começa em "Registro e arquivo" e mostra onde guardar', async () => {
    await withFile(fileOf('aula.mp4', 'video/mp4'))
    await waitFor(() => expect(checked(levels())).toBe('Registro e arquivo'))
    expect(names(levels())).toEqual(LEVELS)
    expect(within(where()!).getByText('Só neste computador')).toBeInTheDocument()
  })

  it('um documento, com o Drive, começa em "Registro e arquivo" no Drive', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    await withFile(fileOf('notas.txt', 'text/plain'))
    expect(checked(levels())).toBe('Registro e arquivo')
    expect(names(within(where()!))).toEqual(['Google Drive'])
    expect(checked(within(where()!))).toBe('Google Drive')
  })

  it('um documento, sem o Drive, não tem onde guardar o arquivo: começa em "Só o registro" e diz por quê', async () => {
    await withFile(fileOf('notas.txt', 'text/plain'))
    expect(checked(levels())).toBe('Só o registro')
    expect(levels().getByText('Entre com o Google para guardar no Drive.')).toBeInTheDocument()
    fireEvent.click(levels().getByText('Registro e arquivo'))
    expect(checked(levels())).toBe('Só o registro')
    expect(where()).toBeNull()
  })
})

describe('onde guardar só aparece em "Registro e arquivo"', () => {
  it('trocar para "Só o registro" ou "Sem rastro" esconde onde guardar', async () => {
    await withFile(fileOf('aula.mp4', 'video/mp4'))
    await waitFor(() => expect(where()).not.toBeNull())
    fireEvent.click(levels().getByText('Só o registro'))
    expect(where()).toBeNull()
    fireEvent.click(levels().getByText('Sem rastro'))
    expect(where()).toBeNull()
    fireEvent.click(levels().getByText('Registro e arquivo'))
    expect(where()).not.toBeNull()
  })
})

describe('Ata', () => {
  it('de uma gravação de reunião, começa em "Só o registro" e não oferece "Sem rastro"', async () => {
    await withFile(fileOf('Reunião 28-10.mp4', 'video/mp4'))
    await waitFor(() => expect(screen.getByRole('radio', { name: /Ata de reunião/ })).toHaveAttribute('aria-checked', 'true'))
    expect(names(levels())).toEqual(['Só o registro', 'Registro e arquivo'])
    expect(checked(levels())).toBe('Só o registro')
    expect(where()).toBeNull()
  })

  it('"Sem rastro" escolhido antes vira "Só o registro" ao escolher a Ata, e é o que vai no pedido', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'https://exemplo.com/reuniao' } })
    fireEvent.click(levels().getByText('Sem rastro'))
    fireEvent.click(screen.getByRole('radio', { name: /Ata de reunião/ }))
    expect(names(levels())).toEqual(['Só o registro', 'Registro e arquivo'])
    expect(checked(levels())).toBe('Só o registro')
    expect(await sent('Gerar ata')).toMatchObject({ agent: 'meeting', keep: 'registro', storage: 'none' })
  })
})

describe('o pedido leva o nível escolhido', () => {
  it('link com "Sem rastro"', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'https://exemplo.com/fotossintese' } })
    fireEvent.click(levels().getByText('Sem rastro'))
    expect(await sent('Gerar aula')).toMatchObject({ keep: 'sem-rastro', storage: 'none' })
  })

  it('tema no nível de partida', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Tema' }))
    fireEvent.change(screen.getByLabelText('Tema'), { target: { value: 'Buracos negros' } })
    expect(await sent('Gerar explicação')).toMatchObject({ keep: 'registro', storage: 'none' })
  })

  it('documento com "Registro e arquivo" leva o lugar escolhido', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    await withFile(fileOf('notas.txt', 'text/plain'))
    expect(await sent('Gerar aula')).toMatchObject({ keep: 'arquivo', storage: 'drive' })
  })

  it('o lugar só vai com "Registro e arquivo"', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id })
    await withFile(fileOf('notas.txt', 'text/plain'))
    fireEvent.click(levels().getByText('Só o registro'))
    expect(await sent('Gerar aula')).toMatchObject({ keep: 'registro', storage: 'none' })
  })

  it('mídia com "Registro e arquivo" neste computador', async () => {
    await withFile(fileOf('aula.mp4', 'video/mp4'))
    await waitFor(() => expect(within(where()!).getByText('Só neste computador')).toBeInTheDocument())
    expect(await sent('Gerar aula')).toMatchObject({ keep: 'arquivo', storage: 'none' })
  })
})
