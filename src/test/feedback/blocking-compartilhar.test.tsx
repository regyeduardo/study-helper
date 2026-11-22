import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// the Worker never answers here: the test holds "Apagar" and lets it go
vi.mock('@/controllers/share.controller', async importOriginal => ({ ...(await importOriginal<typeof import('@/controllers/share.controller')>()), deleteShareController: vi.fn() }))

import type { ShareRecord, SharedFile, SharedItem } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { Overlays } from '@/components/dialogs/Overlays'
import { SharedBadge } from '@/components/library/SharedBadge'
import { SharingView } from '@/components/library/SharingLists'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { deleteShareController } from '@/controllers/share.controller'
import { env } from '@/lib/env'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useBlockingStore } from '@/stores/blocking'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { deferred, settle, slowLibrary, toastsNow } from '@/test/feedback/slow'

// Escolha F do dono (21/11/2026) em Compartilhar: importar, apagar um compartilhamento e abrir o Compartilhar de uma pasta grande
// travam o app na janela do meio, do clique até o fim, com "3 de 12" quando passa por várias notas.

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const DAY = 24 * 3600_000

const flush = () => act(async () => await Promise.resolve())
const shown = () => act(async () => vi.advanceTimersByTime(350))
const windowNamed = (name: string) => screen.getByRole('alertdialog', { name })
const noWindow = () => expect(screen.queryByRole('alertdialog')).toBeNull()
const store = () => useLibraryStore.getState()

let slow: ReturnType<typeof slowLibrary>

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useBlockingStore.setState({ ops: [] })
  slow = slowLibrary()
  env.shareWorkerUrl = 'https://share.test'
  env.sharedFilesUrl = 'https://files.test'
  window.turnstile = { render: (_element, options) => (options.callback('turnstile-ok'), 'widget-1'), remove: vi.fn() }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete window.turnstile
  if (store().sharedView) store().leaveShared()
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
})

function sharedNote(id: string, name: string, fields: Partial<SharedFile> = {}): SharedFile {
  return { id, name, folderId: 'p1', type: 'class', position: 0, description: '', tags: [], content: `# ${name}`, questions: [], highlights: [], ...fields }
}

describe('"Importar para a minha biblioteca"', () => {
  const link = (fields: Partial<SharedItem>): SharedItem => ({
    version: 2,
    id: 'LinkDaPastaCalculo01',
    kind: 'folder',
    title: 'Cálculo',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * DAY).toISOString(),
    folders: [{ id: 'p1', name: 'Cálculo', parentId: null, position: 0, isCourse: false, description: '' }],
    files: [sharedNote('f1', 'Aula 1'), sharedNote('f2', 'Aula 2'), sharedNote('f3', 'Aula 3')],
    ...fields,
  })
  const open = (item: SharedItem) => {
    store().enterShared(item, {})
    render(
      <MemoryRouter initialEntries={[`/shared/${item.id}`]}>
        <Routes>
          <Route path="/shared/:shareId" element={<SharedBadge />} />
          <Route path="*" element={<div>biblioteca</div>} />
        </Routes>
        <BlockingWindow />
      </MemoryRouter>,
    )
  }

  it('a janela fica do clique até a última nota ser copiada, contando "0 de 3" com a nota da vez', async () => {
    open(link({}))
    const release = slow.hold()
    fireEvent.click(screen.getByRole('button', { name: 'Importar para a minha biblioteca' }))
    await flush()
    await shown()
    expect(windowNamed('Importando para a sua biblioteca…')).toBeInTheDocument()

    // the folder is made; the first note waits for the Drive
    let again!: () => void
    await act(async () => {
      release()
      again = slow.hold()
      await settle()
    })
    const window_ = windowNamed('Importando para a sua biblioteca…')
    expect(window_).toHaveTextContent('Copiando as notas')
    expect(window_).toHaveTextContent('0 de 3')
    expect(window_).toHaveTextContent('Aula 1')

    await act(async () => {
      again()
      await settle()
    })
    noWindow()
    expect(store().files.map(file => file.name).sort()).toEqual(['Aula 1', 'Aula 2', 'Aula 3'])
    expect(toastsNow()).toContain('Importado para a sua biblioteca')
  })

  it('a mídia de uma entrada baixa dentro da janela, antes das notas', async () => {
    const download = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => download.promise),
    )
    const entry = sharedNote('f1', 'Reunião', {
      folderId: null,
      type: 'meeting',
      media: { url: 'https://share.test/media/x/f1', mime: 'video/mp4', size: 1000 },
      meta: { role: 'entrada', kept: 'arquivo', origin: { input: 'file', name: 'Reunião.mp4', mime: 'video/mp4', sizeBytes: 1000, storage: 'none' } },
    })
    open(link({ kind: 'entrada', title: 'Reunião', folders: [], files: [entry], mediaExpiresAt: new Date(Date.now() + 2 * DAY).toISOString() }))
    fireEvent.click(screen.getByRole('button', { name: 'Importar para a minha biblioteca' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Importar aqui' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Neste navegador' }))
    await flush()
    await shown()
    expect(windowNamed('Importando para a sua biblioteca…')).toHaveTextContent('Baixando a mídia')
    // nothing is made in the library until the media is in hand: the link is still open
    expect(store().sharedView).not.toBeNull()

    await act(async () => {
      download.resolve(new Response(new Uint8Array(1000), { headers: { 'Content-Length': '1000' } }))
      await settle()
      await settle()
    })
    noWindow()
    expect(store().files.map(file => file.name)).toEqual(['Reunião'])
  })

  it('não deu para importar: a janela fecha e o motivo aparece', async () => {
    open(link({}))
    slow.breakWith(new Error('Drive fora do ar'))
    fireEvent.click(screen.getByRole('button', { name: 'Importar para a minha biblioteca' }))
    await act(async () => {
      await settle()
    })
    expect(useBlockingStore.getState().ops).toHaveLength(0)
    expect(toastsNow()).toContain('Drive fora do ar')
  })
})

describe('"Apagar" um compartilhamento', () => {
  const share: ShareRecord = { id: 'LinkDaPastaCalculo01', kind: 'folder', itemId: 'p1', title: 'Cálculo', bytes: 2048, withExams: false, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 2 * DAY).toISOString() }

  it('a janela "Apagando o compartilhamento…" fica até o Worker responder; depois a linha some', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
    useLibraryStore.setState({ index: { ...store().index, shares: [share] } })
    const answer = deferred()
    vi.mocked(deleteShareController).mockReturnValueOnce(answer.promise)
    render(
      <MemoryRouter>
        <SharingView view="shares" />
        <Overlays />
        <BlockingWindow />
      </MemoryRouter>,
    )
    fireEvent.click(within(screen.getByLabelText('Compartilhamento: Cálculo')).getByRole('button', { name: 'Apagar' }))
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Apagar o compartilhamento?' })).getByRole('button', { name: 'Apagar' }))
    await flush()
    await shown()
    expect(windowNamed('Apagando o compartilhamento…')).toBeInTheDocument()
    expect(screen.getByLabelText('Compartilhamento: Cálculo')).toBeInTheDocument()

    await act(async () => {
      answer.resolve()
      await settle()
    })
    noWindow()
    expect(screen.queryByLabelText('Compartilhamento: Cálculo')).toBeNull()
    expect(toastsNow()).toContain('Compartilhamento apagado')
  })
})

describe('Abrir "Compartilhar" de uma pasta grande', () => {
  it('a janela "Lendo as notas" conta "1 de 3" enquanto lê o que vai no link, e some quando o tamanho aparece', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
    const folder = await store().createFolder({ name: 'Cálculo' })
    for (const name of ['Aula 1', 'Aula 2', 'Aula 3']) await store().createFile({ name, type: 'class', status: 'ready', folderId: folder.id }, `# ${name}`)
    // nothing in memory: each note is a trip to the Drive
    useLibraryStore.setState({ opened: {} })
    const release = slow.hold()
    render(
      <MemoryRouter>
        <ShareDialog target="folder" id={folder.id} />
        <BlockingWindow />
      </MemoryRouter>,
    )
    await flush()
    await shown()
    let window_ = windowNamed('Preparando o compartilhamento…')
    expect(window_).toHaveTextContent('Lendo as notas')
    expect(window_).toHaveTextContent('0 de 3')

    let again!: () => void
    await act(async () => {
      release()
      again = slow.hold()
      await settle()
    })
    window_ = windowNamed('Preparando o compartilhamento…')
    expect(window_).toHaveTextContent('1 de 3')
    expect(window_).toHaveTextContent('Aula 2')

    await act(async () => {
      again()
      await settle()
    })
    noWindow()
  })
})
