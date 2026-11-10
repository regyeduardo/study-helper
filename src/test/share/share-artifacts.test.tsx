import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'

import type { CardsArtifact, MapArtifact, SharedFile, SharedItem, TutorArtifact } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { artifactsOf } from '@/lib/artifacts'
import { env } from '@/lib/env'
import { today } from '@/lib/generation/cards'
import { mapToMermaid } from '@/lib/generation/map-render'
import { importSharedItem, sharedLibrary } from '@/lib/share'
import { LocalRepository } from '@/lib/storage/local-repository'
import { SharedStatus, useSharedRoute } from '@/pages/shared'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

import { installMemoryStorage } from '../storage/fake-drive'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const AT = '2026-11-01T10:00:00.000Z'
const SHARE_ID = 'ArtefatosArtefatos0001'

const MAP: MapArtifact = {
  id: 'mapa-1',
  kind: 'mapa',
  name: 'Decisões do reajuste',
  createdAt: AT,
  updatedAt: AT,
  diagram: { form: 'arvore', root: { id: 'r', text: 'Reajuste', children: [{ id: 'a', text: 'Índice: IPCA', children: [] }] } },
  versions: [{ form: 'radial', root: { id: 'r', text: 'Versão antiga do mapa', children: [] } }],
  chat: [
    { who: 'você', text: 'Pergunta secreta do mapa', at: AT },
    { who: 'ia', text: 'Resposta do chat do mapa', at: AT, changed: ['a'] },
  ],
  highlight: ['a'],
}

const DECK: CardsArtifact = { id: 'baralho-1', kind: 'cartoes', name: 'Datas do reajuste', createdAt: AT, updatedAt: AT, cards: [{ id: 'c1', front: 'Quando reajusta?', back: 'Em março.', box: 4, due: '2026-12-24' }] }

const TALK: TutorArtifact = {
  id: 'conversa-1',
  kind: 'tutor',
  name: 'Por que IPCA',
  createdAt: AT,
  updatedAt: AT,
  turns: [
    { who: 'você', text: 'Por que o IPCA?' },
    { who: 'tutor', text: 'Porque mede a inflação oficial.' },
  ],
}

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[]
let replies: Record<string, () => Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(async () => {
  installMemoryStorage()
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
      const reply = replies[`${init.method ?? 'GET'} ${url}`]
      return reply ? reply() : new Response('not found', { status: 404 })
    }),
  )
  window.turnstile = { render: (_element, options) => (options.callback('turnstile-ok'), 'widget-1'), remove: vi.fn() }
  useUiStore.setState({ overlay: null, toasts: [] })
  const repo = new LocalRepository(`study-helper-share-artifacts-${crypto.randomUUID()}`)
  const snapshot = await repo.load()
  useLibraryStore.setState({ repo, index: snapshot.index, folders: [], files: [], opened: {}, ready: true, loadError: null, sharedView: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.turnstile
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

async function noteWithArtifacts() {
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
  const library = useLibraryStore.getState()
  const meta = await library.createFile({ name: 'Reajuste', type: 'meeting' }, '# Reajuste\n\nO índice é o IPCA.')
  for (const artifact of [MAP, DECK, TALK]) await useLibraryStore.getState().saveArtifact(meta.id, artifact)
  return meta.id
}

/** Opens the dialog, clicks the given boxes, shares and gives back the note as it went to the Worker. */
async function shareWith(noteId: string, toggle: RegExp[] = []) {
  replies['POST https://share.test/shares'] = () => json({ id: SHARE_ID, createdAt: AT, expiresAt: '2026-11-04T10:00:00.000Z', bytes: 300 }, 201)
  render(
    <MemoryRouter>
      <ShareDialog target="file" id={noteId} />
    </MemoryRouter>,
  )
  for (const name of toggle) fireEvent.click(await screen.findByRole('checkbox', { name }))
  const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
  await waitFor(() => expect(share).toBeEnabled())
  fireEvent.click(share)
  await screen.findByDisplayValue(new RegExp(`/s/${SHARE_ID}$`))
  const sent = calls.find(call => call.method === 'POST')!.body as { share: { files: SharedFile[] } }
  return { file: sent.share.files[0], text: JSON.stringify(sent) }
}

const SHARED_MAP = { id: MAP.id, kind: 'mapa' as const, name: MAP.name, diagram: MAP.diagram, mermaid: mapToMermaid(MAP.diagram) }
const SHARED_DECK = { id: DECK.id, kind: 'cartoes' as const, name: DECK.name, cards: [{ id: 'c1', front: 'Quando reajusta?', back: 'Em março.' }] }
const SHARED_TALK = { id: TALK.id, kind: 'tutor' as const, name: TALK.name, turns: TALK.turns }

function sharedItem(artifacts?: SharedFile['artifacts'], meta?: SharedFile['meta']): SharedItem {
  return {
    version: 2,
    id: SHARE_ID,
    kind: 'file',
    title: 'Reajuste',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
    folders: [],
    files: [{ id: 'a', name: 'Reajuste', folderId: null, type: 'meeting', position: 0, description: '', tags: [], content: '# Reajuste', questions: [], highlights: [], ...(artifacts ? { artifacts } : {}), ...(meta ? { meta } : {}) }],
  }
}

describe('janela de compartilhar: uma caixa por tipo de artefato', () => {
  it('ao lado de "Levar as provas": mapas marcada, cartões e conversas do Tutor desmarcadas', async () => {
    const id = await noteWithArtifacts()
    render(
      <MemoryRouter>
        <ShareDialog target="file" id={id} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('checkbox', { name: /Levar os mapas/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: /Levar os cartões/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('checkbox', { name: /Levar as conversas do Tutor/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getAllByRole('checkbox').map(box => box.querySelector('b')?.textContent)).toEqual(['Levar as provas', 'Levar os mapas', 'Levar os cartões', 'Levar as conversas do Tutor'])
  })

  it('sem mexer, vai só o mapa, com o código Mermaid; a conversa, as versões e o destaque do mapa nunca vão', async () => {
    const { file, text } = await shareWith(await noteWithArtifacts())
    expect(file.artifacts).toEqual([SHARED_MAP])
    expect(SHARED_MAP.mermaid).not.toContain('pisca')
    expect(text).not.toMatch(/Pergunta secreta|Resposta do chat|Versão antiga|"chat"|"versions"|"highlight"/)
    expect(text).not.toMatch(/Datas do reajuste|Quando reajusta|Por que IPCA|Por que o IPCA/)
  })

  it('marcando cartões e conversas, eles vão; o progresso de revisão dos cartões não vai', async () => {
    const { file, text } = await shareWith(await noteWithArtifacts(), [/Levar os cartões/, /Levar as conversas do Tutor/])
    expect(file.artifacts).toEqual([SHARED_MAP, SHARED_DECK, SHARED_TALK])
    expect(text).not.toMatch(/2026-12-24|"box"|"due"|cardDue/)
  })

  it('desmarcando tudo, a nota vai como antes, sem o campo e sem o nome dos artefatos', async () => {
    const { file, text } = await shareWith(await noteWithArtifacts(), [/Levar os mapas/])
    expect(file).not.toHaveProperty('artifacts')
    expect(text).not.toMatch(/Decisões do reajuste|Datas do reajuste|Por que IPCA|hasMindmap/)
  })
})

function serve(item: SharedItem) {
  const url = (path: string) => `GET https://files.test/shared/${item.id}/${encodeURIComponent(path)}`
  const [file] = item.files
  replies[url('share.json')] = () => json({ version: 2, id: item.id, kind: item.kind, title: item.title, createdAt: item.createdAt, expiresAt: item.expiresAt, folders: [], files: [{ id: file.id, path: file.name }] })
  replies[url(`${file.name}.md`)] = () => new Response(file.content)
  replies[url(`${file.name}.json`)] = () => json({ meta: { id: file.id, name: file.name, folderId: null, type: file.type, position: 0, description: '', tags: [] }, questions: [], attempts: [], highlights: [], ...(file.artifacts ? { artifacts: file.artifacts } : {}) })
}

function SharedProbe() {
  const { shareId = '' } = useParams()
  const route = useSharedRoute(shareId)
  return <SharedStatus unavailable={Boolean(route.unavailable)} />
}

describe('abrir o link no app', () => {
  it('mostra os artefatos só para leitura: o mapa com o desenho e sem conversa, os cartões sem progresso', async () => {
    const item = sharedItem([SHARED_MAP, SHARED_DECK, SHARED_TALK])
    serve(item)
    render(
      <MemoryRouter initialEntries={[`/shared/${item.id}`]}>
        <Routes>
          <Route path="/shared/:shareId" element={<SharedProbe />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(useLibraryStore.getState().sharedView?.item.id).toBe(item.id))
    const meta = useLibraryStore.getState().files.find(file => file.id === 'a')!
    expect(meta.artifacts?.map(artifact => [artifact.kind, artifact.name])).toEqual([
      ['mapa', 'Decisões do reajuste'],
      ['cartoes', 'Datas do reajuste'],
      ['tutor', 'Por que IPCA'],
    ])
    expect(meta.hasMindmap).toBe(true)
    expect(meta.cardDue ?? []).toEqual([])
    const [map, deck, talk] = artifactsOf((await useLibraryStore.getState().openFile('a')).sidecar)
    expect(map).toMatchObject({ kind: 'mapa', name: 'Decisões do reajuste', diagram: MAP.diagram, chat: [], versions: [] })
    expect(map).not.toHaveProperty('highlight')
    expect(map).not.toHaveProperty('provisionalName')
    expect(deck).toMatchObject({ kind: 'cartoes', cards: [{ id: 'c1', front: 'Quando reajusta?', back: 'Em março.', box: 0 }] })
    expect(talk).toMatchObject({ kind: 'tutor', turns: TALK.turns })
    await expect(useLibraryStore.getState().saveArtifact('a', { ...MAP, name: 'mexi' })).rejects.toThrow('só leitura')
    expect(calls.every(call => call.url.startsWith('https://files.test/'))).toBe(true)
  })

  it('um link antigo, sem o campo, abre sem artefatos, mesmo se a nota de quem compartilhou tinha', () => {
    const old = sharedItem(undefined, { artifacts: [{ id: 'fantasma', kind: 'mapa', name: 'Mapa que não veio', updatedAt: AT }], hasMindmap: true, cardDue: ['2026-01-01'] })
    const shared = sharedLibrary(old, {})
    expect(shared.files[0].artifacts ?? []).toEqual([])
    expect(shared.files[0].hasMindmap ?? false).toBe(false)
    expect(shared.files[0].cardDue ?? []).toEqual([])
    expect(artifactsOf(shared.opened.a.sidecar)).toEqual([])
  })
})

describe('importar o link', () => {
  const actions = () => {
    const library = useLibraryStore.getState()
    return { createFolder: library.createFolder, createFile: library.createFile, updateSidecar: library.updateSidecar }
  }

  it('leva os artefatos; o mapa importado começa com a conversa vazia e os cartões, do zero', async () => {
    const withChat = { ...SHARED_MAP, chat: [{ who: 'você', text: 'Pergunta secreta do mapa', at: AT }], versions: MAP.versions, highlight: ['a'] }
    const result = await importSharedItem(sharedItem([withChat, SHARED_DECK, SHARED_TALK]), {}, actions())
    const meta = useLibraryStore.getState().files.find(file => file.id === result.fileId)!
    expect(meta.artifacts?.map(artifact => artifact.name)).toEqual(['Decisões do reajuste', 'Datas do reajuste', 'Por que IPCA'])
    expect(meta.hasMindmap).toBe(true)
    expect(meta.cardDue).toEqual([today()])
    const [map, deck, talk] = artifactsOf((await useLibraryStore.getState().openFile(meta.id)).sidecar)
    expect(map).toMatchObject({ id: 'mapa-1', kind: 'mapa', name: 'Decisões do reajuste', diagram: MAP.diagram, chat: [], versions: [] })
    expect(map).not.toHaveProperty('highlight')
    expect(map).not.toHaveProperty('mermaid')
    expect(deck).toMatchObject({ kind: 'cartoes', name: 'Datas do reajuste', cards: [{ id: 'c1', front: 'Quando reajusta?', back: 'Em março.', box: 0, due: today() }] })
    expect(talk).toMatchObject({ kind: 'tutor', name: 'Por que IPCA', turns: TALK.turns })
  })

  it('um link antigo, sem o campo, importa como antes', async () => {
    const result = await importSharedItem(sharedItem(), {}, actions())
    const opened = await useLibraryStore.getState().openFile(result.fileId!)
    expect(opened.content).toBe('# Reajuste')
    expect(artifactsOf(opened.sidecar)).toEqual([])
  })
})
