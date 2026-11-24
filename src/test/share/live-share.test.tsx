// O link ao vivo de quem usa a estrutura do app (spec 003, história 7): nada passa pelo share-worker, nada é copiado nem enviado de
// novo; o link é do próprio app e quem o abre vê a entrada como ela está agora, com todas as notas que nasceram dela.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'

import type { FileSidecar } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { EntryPage } from '@/components/reader/EntryPage'
import { defaultIndex } from '@/lib/defaults'
import { env } from '@/lib/env'
import { mapMeta } from '@/lib/storage/app-repository'
import { useSharedRoute } from '@/pages/shared'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

import { CONTENTS, ENTRY_NAME, entryFamily, MAP, memoryRepository, reunioes } from './entry-family'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const API = 'https://api.test'
const LINK_ID = 'AoVivoAoVivoAoVivoAoV1'
const CREATED = '2026-11-24T10:00:00Z'

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[]
let replies: Record<string, () => Response>
let sidecars: FileSidecar[]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const madeLink = { id: LINK_ID, itemId: 'e', kind: 'entrada', title: ENTRY_NAME, live: true, withExams: true, artifacts: ['mapa'], createdAt: CREATED }

/** What the App answers to whoever opens the link: the entrada and every note born of it, as they are now, without the Lixeira. */
function appLink() {
  const files = sidecars
    .filter(sidecar => !sidecar.meta.deletedAt)
    .map(sidecar => {
      const { meta } = sidecar
      const parts: Record<string, string> = { text: CONTENTS[meta.id] ?? '' }
      if (sidecar.recording || sidecar.transcript !== undefined) parts.transcript = JSON.stringify({ recording: sidecar.recording ?? null, transcript: sidecar.transcript ?? null })
      if (sidecar.questions.length) parts.exam = JSON.stringify({ questions: sidecar.questions, attempts: [] })
      // the App leaves home the cards, the Tutor and a map's conversation
      for (const artifact of sidecar.artifacts ?? []) if (artifact.kind === 'mapa') parts[`artifacts/${artifact.id}`] = JSON.stringify({ id: artifact.id, kind: 'mapa', name: artifact.name, diagram: artifact.diagram })
      return { id: meta.id, noteType: meta.type, name: meta.name, folderId: meta.folderId, parentFileId: meta.parentFileId, position: meta.position, meta: mapMeta(meta), createdAt: meta.created.at, updatedAt: meta.updated.at, parts, media: meta.id === 'e' ? { mime: 'video/mp4', bytes: 1000 } : null }
    })
  return { ...madeLink, owner: { name: 'Ana' }, folders: [], files }
}

beforeEach(() => {
  env.apiUrl = API
  env.shareWorkerUrl = 'https://share.test'
  env.sharedFilesUrl = 'https://files.test'
  env.turnstileSiteKey = '1x00000000000000000000AA'
  calls = []
  replies = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
      return replies[`${init.method ?? 'GET'} ${url}`]?.() ?? json({ error: 'not_found' }, 404)
    }),
  )
  window.turnstile = { render: vi.fn((_element, options) => (options.callback('turnstile-ok'), 'widget-1')), remove: vi.fn() }
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  // Ana's library kept in the App: the entrada and its family are all in the App
  sidecars = entryFamily().map(sidecar => ({ ...sidecar, meta: { ...sidecar.meta, place: 'app' as const, ...(sidecar.meta.id === 'e' ? { origin: { ...sidecar.meta.origin!, storage: 'drive' as const, storedFileId: 'app:e/m1' } } : {}) } }))
  const { repo } = memoryRepository(sidecars, { ...CONTENTS })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
  useLibraryStore.setState({ repo, accountId: 'google-1', appOn: true, ready: true, folders: [reunioes], files: sidecars.map(sidecar => sidecar.meta), index: defaultIndex(), opened: {}, openedAt: {}, sizes: {}, sharedView: null, localMedia: [] })
  useUiStore.setState({ overlay: null, toasts: [], menu: null })
})

afterEach(() => {
  useLibraryStore.getState().leaveShared()
  useLibraryStore.setState({ appOn: false })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.turnstile
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

function openDialog(target: 'entrada' | 'file' = 'entrada', id = 'e') {
  return render(
    <MemoryRouter>
      <ShareDialog target={target} id={id} />
    </MemoryRouter>,
  )
}

const workerCalls = () => calls.filter(call => call.url.startsWith('https://share.test') || call.url.startsWith('https://files.test'))

describe('compartilhar uma entrada guardada no App', () => {
  it('sai o link do próprio app, sem o worker, sem verificação anti-robô, sem reenviar a mídia nem ler as notas', async () => {
    replies[`POST ${API}/v1/shares`] = () => json(madeLink, 201)
    openDialog()
    const share = await screen.findByRole('button', { name: 'Compartilhar' })
    expect(screen.getByText(/como ela está agora/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(window.turnstile!.render).not.toHaveBeenCalled()
    fireEvent.click(share)
    const link = (await screen.findByLabelText('Link público, só para leitura')) as HTMLInputElement
    expect(link.value).toBe(`${window.location.origin}${env.basePath.replace(/\/$/, '')}/shared/${LINK_ID}`)
    expect(calls.find(call => call.method === 'POST')).toEqual({ url: `${API}/v1/shares`, method: 'POST', body: { item: 'e', kind: 'entrada', withExams: true, artifacts: ['mapa'] } })
    expect(workerCalls()).toEqual([])
    expect(screen.getByText(/não vence/)).toBeInTheDocument()
    await waitFor(() => expect(useLibraryStore.getState().index.shares).toEqual([expect.objectContaining({ id: LINK_ID, itemId: 'e', kind: 'entrada', live: true })]))
  })

  it('já compartilhada, em qualquer aparelho: mostra o mesmo link e deixa parar de compartilhar', async () => {
    replies[`GET ${API}/v1/shares?item=e`] = () => json(madeLink)
    replies[`DELETE ${API}/v1/shares/${LINK_ID}`] = () => json({ ok: true })
    openDialog()
    expect(await screen.findByText('Já compartilhado')).toBeInTheDocument()
    expect((screen.getByLabelText('Link público, só para leitura') as HTMLInputElement).value).toMatch(new RegExp(`/shared/${LINK_ID}$`))
    expect(screen.queryByRole('button', { name: 'Atualizar o link' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Parar de compartilhar' }))
    await waitFor(() => expect(calls.some(call => call.method === 'DELETE' && call.url === `${API}/v1/shares/${LINK_ID}`)).toBe(true))
    expect(workerCalls()).toEqual([])
  })
})

describe('quem não usa a estrutura do app continua como está', () => {
  it('sem a estrutura, a janela é a de hoje (worker, verificação e a árvore do que vai)', async () => {
    useLibraryStore.setState({ appOn: false })
    openDialog()
    expect(await screen.findByText(/itens vão/)).toBeInTheDocument()
    expect(window.turnstile!.render).toHaveBeenCalled()
    expect(calls.some(call => call.url.startsWith(`${API}/v1/shares`))).toBe(false)
  })

  it('com a estrutura, mas uma nota da família fora do App, também', async () => {
    useLibraryStore.setState({ files: sidecars.map(sidecar => (sidecar.meta.id === 'aula' ? { ...sidecar.meta, place: 'drive' as const } : sidecar.meta)) })
    openDialog()
    expect(await screen.findByText(/itens vão/)).toBeInTheDocument()
    expect(calls.some(call => call.url.startsWith(`${API}/v1/shares`))).toBe(false)
  })
})

function SharedPage() {
  const { shareId = '' } = useParams()
  const route = useSharedRoute(shareId)
  if (route.view === 'entry' && route.fileId) return <EntryPage fileId={route.fileId} />
  if (route.view === 'shared') return <div>{route.unavailable ? 'indisponível' : 'abrindo'}</div>
  return <div>{`nota ${route.fileId}`}</div>
}

function renderLink() {
  return render(
    <MemoryRouter initialEntries={[`/shared/${LINK_ID}`]}>
      <Routes>
        <Route path="/shared/:shareId" element={<SharedPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('quem tem o link vê a entrada', () => {
  beforeEach(() => {
    // whoever opens the link: another person, without Ana's library
    useLibraryStore.setState({ appOn: false, folders: [], files: [], index: defaultIndex() })
  })

  it('a página da entrada com a mídia do App e todas as notas que nasceram dela, sem passar pelo worker', async () => {
    replies[`GET ${API}/v1/shared/${LINK_ID}`] = () => json(appLink())
    renderLink()
    expect(await screen.findByRole('heading', { level: 1, name: ENTRY_NAME })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Original' })).getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    const family = screen.getByRole('region', { name: 'O que nasceu daqui' })
    expect(await within(family).findByRole('link', { name: 'Ata' })).toBeInTheDocument()
    expect(within(family).getByRole('link', { name: 'Aula' })).toBeInTheDocument()
    expect(within(family).getByText(MAP.name)).toBeInTheDocument()
    expect(within(family).queryByText('Cartões da reunião')).not.toBeInTheDocument()
    const item = useLibraryStore.getState().sharedView!.item
    expect(item.live).toBe(true)
    expect(item.files.map(file => file.id).sort()).toEqual(['ata', 'aula', 'e', 'exp'])
    expect(item.files.find(file => file.id === 'e')!.media).toEqual({ url: `${API}/v1/shared/${LINK_ID}/media/e`, mime: 'video/mp4', size: 1000 })
    // the page's own badge: a live link has no days left
    expect(screen.getAllByLabelText('Compartilhado')[0]).toHaveTextContent('compartilhado · só leitura · ao vivo')
    expect(workerCalls()).toEqual([])
  })

  it('um link parado diz que o item está indisponível, sem procurar no worker', async () => {
    replies[`GET ${API}/v1/shared/${LINK_ID}`] = () => json({ error: 'share_stopped' }, 410)
    renderLink()
    expect(await screen.findByText('indisponível')).toBeInTheDocument()
    expect(workerCalls()).toEqual([])
  })
})
