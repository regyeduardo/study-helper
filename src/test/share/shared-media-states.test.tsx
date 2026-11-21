// A página do link diz o que aconteceu com a mídia (subindo, vencida, não enviada) e deixa baixar quando ela existe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'

import type { FileSidecar, SharedItem } from '@/types/domain'
import { EntryPage } from '@/components/reader/EntryPage'
import { defaultIndex } from '@/lib/defaults'
import { env } from '@/lib/env'
import { buildEntryShareContent } from '@/lib/share'
import { choiceOf, defaultChoice, entryShareTree } from '@/lib/share-entry'
import { sharedPoll, useSharedRoute } from '@/pages/shared'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

import { CONTENTS, ENTRY_NAME, entryFamily, memoryRepository } from './entry-family'

const SHARE_ID = 'EstadosMidiaEstados1'
const MEDIA_URL = `https://share.test/media/${SHARE_ID}/e`
const SIZE = 1000
const DAY = 24 * 3600_000

type MediaFiles = { media?: { mime: string; size: number }; pendingMedia?: { mime: string; size: number } }

let sidecars: FileSidecar[]
let replies: Record<string, () => Response | Promise<Response>>
let manifest: () => Record<string, unknown>

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function content(kept: 'arquivo' | 'registro' = 'arquivo'): Promise<SharedItem> {
  const metas = sidecars.map(sidecar => sidecar.meta)
  const open = async (id: string) => ({ content: CONTENTS[id] ?? '', sidecar: sidecars.find(sidecar => sidecar.meta.id === id)! })
  const tree = entryShareTree(metas, 'e')
  const made = await buildEntryShareContent('e', metas, open, choiceOf(tree, defaultChoice(tree, true)))
  // an old link keeps the "só registro" mark the sharer's entrada had, even with the media in it
  const files = made.files.map(file => (file.id === 'e' ? { ...file, meta: { ...file.meta, kept } } : file))
  return { ...made, files, version: 2, id: SHARE_ID, createdAt: new Date(Date.now() - 3600_000).toISOString(), expiresAt: new Date(Date.now() + 2 * DAY).toISOString(), mediaExpiresAt: new Date(Date.now() + 2 * DAY).toISOString() }
}

/** The link as the Worker keeps it, with the entrada's media in the state asked for. */
function serve(item: SharedItem, media: MediaFiles, fields: Record<string, unknown> = {}) {
  const url = (path: string) => `GET https://files.test/shared/${item.id}/${encodeURIComponent(path)}`
  const pathOf = (name: string) => name.replace(/[\\/]/g, '-')
  manifest = () => ({ version: 2, id: item.id, kind: item.kind, title: item.title, createdAt: item.createdAt, expiresAt: item.expiresAt, mediaExpiresAt: item.mediaExpiresAt, ...fields, folders: [], files: item.files.map(file => ({ id: file.id, path: pathOf(file.name), ...(file.id === 'e' ? media : {}) })) })
  replies[url('share.json')] = () => json(manifest())
  for (const file of item.files) {
    replies[url(`${pathOf(file.name)}.md`)] = () => new Response(file.content)
    const meta = { ...file.meta, id: file.id, name: file.name, folderId: file.folderId, type: file.type, position: file.position, description: file.description, tags: file.tags }
    replies[url(`${pathOf(file.name)}.json`)] = () => json({ meta, questions: file.questions, attempts: [], highlights: file.highlights, ...(file.transcript !== undefined ? { transcript: file.transcript } : {}), ...(file.recording ? { recording: file.recording } : {}), ...(file.artifacts ? { artifacts: file.artifacts } : {}) })
  }
}

const READY: MediaFiles = { media: { mime: 'video/mp4', size: SIZE } }
const PENDING: MediaFiles = { pendingMedia: { mime: 'video/mp4', size: SIZE } }

beforeEach(() => {
  env.shareWorkerUrl = 'https://share.test'
  env.sharedFilesUrl = 'https://files.test'
  sidecars = entryFamily()
  replies = {}
  sharedPoll.ms = 25
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => replies[`${init.method ?? 'GET'} ${String(input)}`]?.() ?? new Response('not found', { status: 404 })),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id, reconnectId: null })
  useLibraryStore.setState({ repo: memoryRepository().repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, sizes: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ overlay: null, toasts: [] })
})

afterEach(() => {
  useLibraryStore.getState().leaveShared()
  sharedPoll.ms = 5000
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function SharedPage() {
  const { shareId = '' } = useParams()
  const route = useSharedRoute(shareId)
  if (route.view === 'entry' && route.fileId) return <EntryPage fileId={route.fileId} />
  return <div>abrindo</div>
}

async function openLink() {
  render(
    <MemoryRouter initialEntries={[`/shared/${SHARE_ID}`]}>
      <Routes>
        <Route path="/shared/:shareId" element={<SharedPage />} />
      </Routes>
    </MemoryRouter>,
  )
  return within(await screen.findByRole('region', { name: 'Original' }))
}

describe('a mídia ainda está subindo, venceu ou não foi enviada: a página diz qual', () => {
  it('subindo: o aviso fala em quem compartilhou ainda enviar, sem player nem "Baixar"', async () => {
    serve(await content(), PENDING)
    const original = await openLink()
    expect(await original.findByText(/A mídia ainda está sendo enviada por quem compartilhou/)).toBeInTheDocument()
    expect(original.queryByRole('button', { name: /^Baixar/ })).not.toBeInTheDocument()
    expect(original.queryByRole('region', { name: 'Player da gravação' })).not.toBeInTheDocument()
  })

  it('subindo e depois pronta: a página confere de novo sozinha e passa a mostrar o player e o "Baixar"', async () => {
    serve(await content(), PENDING)
    const original = await openLink()
    await original.findByText(/A mídia ainda está sendo enviada/)
    serve(await content(), READY)
    expect(await original.findByRole('button', { name: 'Baixar' })).toBeInTheDocument()
    expect(original.getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
    expect(original.queryByText(/ainda está sendo enviada/)).not.toBeInTheDocument()
  })

  it('para de conferir quando a mídia já está lá', async () => {
    serve(await content(), READY)
    await openLink()
    const reads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('share.json')).length
    const before = reads()
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(reads()).toBe(before)
  })

  it('vencida: diz que a mídia expirou (fica 3 dias), sem "Baixar"', async () => {
    const item = { ...(await content()), mediaExpiresAt: new Date(Date.now() - 1000).toISOString() }
    serve(item, READY)
    const original = await openLink()
    expect(await original.findByText('A mídia deste compartilhamento expirou (fica 3 dias).')).toBeInTheDocument()
    expect(original.queryByRole('button', { name: /^Baixar/ })).not.toBeInTheDocument()
  })

  it('não enviada (o envio falhou): diz que quem compartilhou não enviou a mídia', async () => {
    serve(await content(), {})
    const original = await openLink()
    expect(await original.findByText(/não está disponível neste aparelho: quem compartilhou não enviou a mídia/)).toBeInTheDocument()
    expect(original.queryByRole('button', { name: /^Baixar/ })).not.toBeInTheDocument()
  })

  it('quem compartilhou escolheu só o registro: continua dizendo que o arquivo não foi copiado', async () => {
    serve(await content('registro'), {})
    const original = await openLink()
    expect(await original.findByText(/Guardado só como registro: o arquivo não foi copiado/)).toBeInTheDocument()
  })
})

describe('"Baixar" quando a mídia existe', () => {
  it('um link antigo marcado "só o registro" mas com a mídia no link mostra o player e o "Baixar"', async () => {
    serve(await content('registro'), READY)
    const original = await openLink()
    expect(await original.findByRole('button', { name: 'Baixar' })).toBeInTheDocument()
    expect(original.getByRole('region', { name: 'Player da gravação' })).toBeInTheDocument()
  })

  it('se a mídia expirou ou não terminou de subir enquanto a pessoa estava na página, o aviso diz o motivo', async () => {
    serve(await content(), READY)
    const original = await openLink()
    const download = await original.findByRole('button', { name: 'Baixar' })
    const answers: [() => Response | Promise<Response>, string][] = [
      [() => new Response('{}', { status: 410 }), 'A mídia deste compartilhamento expirou (fica 3 dias).'],
      [() => new Response('{}', { status: 404 }), 'A mídia ainda não terminou de subir, ou quem compartilhou a apagou.'],
      [() => Promise.reject(new TypeError('Failed to fetch')), 'Sem conexão com o serviço de compartilhamento. Confira a internet e tente de novo.'],
    ]
    for (const [reply, text] of answers) {
      replies[`GET ${MEDIA_URL}`] = reply
      useUiStore.setState({ toasts: [] })
      fireEvent.click(download)
      await waitFor(() => expect(useUiStore.getState().toasts.map(toast => toast.text)).toEqual([text]))
      await waitFor(() => expect(download).toBeEnabled())
    }
  })

  it('a entrada da página é a de quem compartilhou, com o nome do original', async () => {
    serve(await content(), READY)
    await openLink()
    expect(screen.getByRole('heading', { level: 1, name: ENTRY_NAME })).toBeInTheDocument()
  })
})

describe('o painel de informações da nota no link', () => {
  it('só oferece "Baixar a mídia" quando ela está no link e dentro do prazo', async () => {
    const { InfoPanel } = await import('@/components/reader/Inspector')
    const item = await content()
    const entry = item.files.find(file => file.id === 'e')!
    const withMedia = (fields: Partial<SharedItem>, file: Partial<typeof entry>): SharedItem => ({ ...item, ...fields, files: item.files.map(one => (one.id === 'e' ? { ...one, ...file } : one)) })
    const cases: [SharedItem, boolean][] = [
      [withMedia({}, { media: { url: MEDIA_URL, mime: 'video/mp4', size: SIZE } }), true],
      [withMedia({ mediaExpiresAt: new Date(Date.now() - 1000).toISOString() }, { media: { url: MEDIA_URL, mime: 'video/mp4', size: SIZE } }), false],
      [withMedia({}, { mediaPending: { mime: 'video/mp4', size: SIZE } }), false],
    ]
    for (const [shared, button] of cases) {
      useLibraryStore.getState().enterShared(shared, {})
      const view = render(
        <MemoryRouter>
          <InfoPanel fileId="e" />
        </MemoryRouter>,
      )
      expect(Boolean(screen.queryByRole('button', { name: /Baixar a mídia/ }))).toBe(button)
      view.unmount()
      useLibraryStore.getState().leaveShared()
    }
  })
})
