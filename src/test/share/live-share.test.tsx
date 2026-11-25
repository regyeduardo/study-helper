// O link ao vivo de quem usa a estrutura do app (spec 003, história 7): nada passa pelo share-worker, nada é copiado nem enviado de
// novo; o link é do próprio app e quem o abre vê a entrada como ela está agora, com todas as notas que nasceram dela.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'

import type { FileSidecar } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { SharingView } from '@/components/library/SharingLists'
import { EntryPage } from '@/components/reader/EntryPage'
import { defaultIndex } from '@/lib/defaults'
import { env } from '@/lib/env'
import { mapMeta } from '@/lib/storage/app-repository'
import { SharedStatus, useSharedRoute } from '@/pages/shared'
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
    expect(calls.find(call => call.method === 'POST')).toEqual({ url: `${API}/v1/shares`, method: 'POST', body: { item: 'e', kind: 'entrada', withExams: true, artifacts: ['mapa'], expiresIn: 'never' } })
    expect(workerCalls()).toEqual([])
    // spec 007 (FR-032): Permanente comes chosen, and the dialog says it
    expect(screen.getByText(/Permanente: vale até você parar/)).toBeInTheDocument()
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

// spec 007, história 4 (T109, T113, T115): o prazo do link (1, 3, 7 dias ou Permanente), "Mudar prazo" no mesmo endereço, o endereço
// que agentes leem, a cópia sem Permanente e o link vencido dizendo que venceu
describe('o prazo do link', () => {
  const url = `${API}/s/${LINK_ID}`

  it('Permanente vem marcado; escolher 1 dia manda o prazo, e o link copiado é o endereço que agentes leem', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString()
    replies[`POST ${API}/v1/shares`] = () => json({ ...madeLink, expiresIn: '1d', expiresAt: tomorrow, expired: false, url }, 201)
    openDialog()
    await screen.findByRole('button', { name: 'Compartilhar' })
    const row = screen.getByRole('radiogroup', { name: 'Prazo do link' })
    expect(within(row).getByRole('radio', { name: 'Permanente' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(row).getByRole('radio', { name: '1 dia' }))
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }))
    const link = (await screen.findByLabelText('Link público, só para leitura')) as HTMLInputElement
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ expiresIn: '1d' })
    expect(link.value).toBe(url)
    expect(screen.getByText(/vence amanhã às/)).toBeInTheDocument()
  })

  it('já compartilhado: "Mudar prazo" vale na hora, no mesmo endereço', async () => {
    replies[`GET ${API}/v1/shares?item=e`] = () => json({ ...madeLink, expiresIn: 'never', expiresAt: null, expired: false, url })
    const inAWeek = new Date(Date.now() + 7 * 24 * 3600_000).toISOString()
    replies[`PATCH ${API}/v1/shares/${LINK_ID}`] = () => json({ ...madeLink, expiresIn: '7d', expiresAt: inAWeek, expired: false, url })
    openDialog()
    expect(await screen.findByText(/Permanente: vale até você parar/)).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Prazo do link' })).getByRole('radio', { name: '7 dias' }))
    await waitFor(() => expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expiresIn: '7d' }))
    expect(await screen.findByText(/vence em/)).toBeInTheDocument()
    expect((screen.getByLabelText('Link público, só para leitura') as HTMLInputElement).value).toBe(url)
  })

  it('o link vencido diz que venceu, sem nada do item', async () => {
    replies[`GET ${API}/v1/shared/${LINK_ID}`] = () => json({ error: 'link_expired' }, 410)
    function Page() {
      const { shareId = '' } = useParams()
      const route = useSharedRoute(shareId)
      return route.view === 'shared' && route.unavailable ? <SharedStatus unavailable /> : <p>abrindo</p>
    }
    render(
      <MemoryRouter initialEntries={[`/shared/${LINK_ID}`]}>
        <Routes>
          <Route path="/shared/:shareId" element={<Page />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Este link venceu')).toBeInTheDocument()
    expect(screen.getByText('Peça um link novo a quem compartilhou.')).toBeInTheDocument()
  })
})

describe('a lista de compartilhamentos (T111)', () => {
  it('traz os links da conta com o prazo, "Mudar prazo" e o vencido dizendo que venceu', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString()
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString()
    replies[`GET ${API}/v1/shares`] = () =>
      json({
        links: [
          { ...madeLink, id: 'L1', title: 'Reunião de planejamento', expiresIn: '1d', expiresAt: tomorrow, expired: false, url: `${API}/s/L1` },
          { ...madeLink, id: 'L2', itemId: 'f', kind: 'file', title: 'Nota velha', expiresIn: '1d', expiresAt: yesterday, expired: true, url: `${API}/s/L2` },
        ],
      })
    render(
      <MemoryRouter>
        <SharingView view="shares" />
      </MemoryRouter>,
    )
    const first = await screen.findByRole('generic', { name: 'Compartilhamento: Reunião de planejamento' })
    expect(within(first).getByText(/ao vivo · vence amanhã às/)).toBeInTheDocument()
    expect(within(first).getByRole('link', { name: `${API}/s/L1` })).toBeInTheDocument()
    fireEvent.click(within(first).getByRole('button', { name: 'Mudar prazo' }))
    expect(useUiStore.getState().overlay).toMatchObject({ kind: 'share', id: 'e' })
    const old = await screen.findByRole('generic', { name: 'Compartilhamento: Nota velha' })
    expect(within(old).getByText('Link expirado')).toBeInTheDocument()
    expect(within(old).getByRole('button', { name: 'Mudar prazo' })).toBeInTheDocument()
  })
})
