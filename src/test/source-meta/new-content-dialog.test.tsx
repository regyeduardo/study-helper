import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// "Novo conteúdo" of a link, a text or a topic: no choice of what to keep of the source, only one line saying it stays in the note.

vi.mock('@/lib/transcription', () => ({ ENGINES: [], transcribe: vi.fn() }))

import { NewContentDialog } from '@/components/dialogs/NewContentDialog'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { type NewContentRequest, useJobsStore } from '@/stores/jobs'
import { useSyncStore } from '@/stores/sync'
import { installBlobShim } from '@/test/imports/blob-shim'
import { YOUTUBE_URL } from '@/test/source-meta/fixture'

installBlobShim()

const startNewContent = vi.fn(async (_request: NewContentRequest) => null)

function open() {
  render(
    <MemoryRouter>
      <NewContentDialog />
    </MemoryRouter>,
  )
}

const levels = () => screen.queryByRole('radiogroup', { name: 'O que guardar da fonte' })

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

describe('link, texto e tema não perguntam o que guardar', () => {
  it('um link diz numa linha que fica guardado na nota', () => {
    open()
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'https://exemplo.com/fotossintese' } })
    expect(levels()).toBeNull()
    expect(screen.getByText('O link fica guardado na nota.')).toBeInTheDocument()
  })

  it('um texto e um tema também', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Texto' }))
    expect(levels()).toBeNull()
    expect(screen.getByText('O texto fica guardado na nota.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tema' }))
    expect(levels()).toBeNull()
    expect(screen.getByText('O tema fica guardado na nota.')).toBeInTheDocument()
  })

  it('o pedido de um link vai sem nível e sem lugar para guardar, também numa Ata', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'https://exemplo.com/reuniao' } })
    fireEvent.click(screen.getByRole('radio', { name: /Ata de reunião/ }))
    const request = await sent('Gerar ata')
    expect(request).toMatchObject({ agent: 'meeting', storage: 'none', input: { kind: 'link', url: 'https://exemplo.com/reuniao' } })
    expect(request.keep).toBeUndefined()
  })

  it('o pedido de um tema vai sem nível', async () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Tema' }))
    fireEvent.change(screen.getByLabelText('Tema'), { target: { value: 'Buracos negros' } })
    const request = await sent('Gerar explicação')
    expect(request.keep).toBeUndefined()
  })
})

describe('o YouTube continua como era', () => {
  it('um link do YouTube ainda oferece o que guardar da fonte', () => {
    open()
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: YOUTUBE_URL } })
    expect(levels()).not.toBeNull()
    expect(screen.queryByText('O link fica guardado na nota.')).not.toBeInTheDocument()
  })
})
