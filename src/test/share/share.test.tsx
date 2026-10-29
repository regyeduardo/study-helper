import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'

import type { MeetingDocument, SharedFile, SharedItem, SharedLink, StoredQuestion } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { Overlays } from '@/components/dialogs/Overlays'
import { SharedBadge } from '@/components/library/SharedBadge'
import { SharingView } from '@/components/library/SharingLists'
import { env } from '@/lib/env'
import { buildShareContent, importSharedItem, readSharedAttempts, saveSharedAttempt, shareBytes } from '@/lib/share'
import { MEDIA_PART_BYTES } from '@/controllers/share.controller'
import { LocalRepository } from '@/lib/storage/local-repository'
import { mergeKept } from '@/lib/sync/merge'
import { SharedStatus, useSharedRoute } from '@/pages/shared'
import type { ViewRoute } from '@/hooks/use-view-route'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

import { installMemoryStorage } from '../storage/fake-drive'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }

const QUESTION: StoredQuestion = { storedId: 'q1', tipo: 'unica', enunciado: 'Quanto é 2 + 2?', alternativas: { A: '3', B: '4' }, correta: 'B', explicacao: 'Soma.' }

const ATA: MeetingDocument = { id: 'ata-1', kind: 'ata', parts: ['resumo'], markdown: '## Resumo\n\nFechamos a curva de vendas.\n\n![quadro](imagens/quadro-1.png)', images: [{ name: 'quadro-1.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }], createdAt: '2026-09-28T12:00:00.000Z', models: { ata: 'modelo' } }

interface Call {
  url: string
  method: string
  body: unknown
  authorization: string
}

let calls: Call[]
let replies: Record<string, () => Response | Promise<Response>>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function openLibrary() {
  const repo = new LocalRepository(`study-helper-share-test-${crypto.randomUUID()}`)
  const snapshot = await repo.load()
  useLibraryStore.setState({ repo, index: snapshot.index, folders: [], files: [], opened: {}, ready: true, loadError: null })
}

function useGoogle() {
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
}

async function noteWithExam() {
  const library = useLibraryStore.getState()
  const meta = await library.createFile({ name: 'Frações', type: 'class' }, '# Frações\n\nMetade é 1/2.')
  await library.setQuestions(meta.id, [QUESTION])
  await library.recordAttempt(meta.id, { total: 1, correct: 1, answers: [{ questionId: 'q1', answer: 'B', score: 1, certainty: 3 }] })
  await library.saveHighlight(meta.id, { id: 'h1', kind: 'highlight', quote: 'Metade', text: 'minha nota', color: 'yellow', startOffset: null, endOffset: null, createdAt: '', updatedAt: '' })
  return useLibraryStore.getState().files.find(file => file.id === meta.id)!
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
      const headers = (init.headers ?? {}) as Record<string, string>
      calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body instanceof Blob ? { size: init.body.size } : null, authorization: headers.Authorization ?? '' })
      const key = `${init.method ?? 'GET'} ${url}`
      const reply = replies[key] ?? replies[key.replace(/\?.*$/, '')]
      if (reply) return reply()
      return new Response('not found', { status: 404 })
    }),
  )
  window.turnstile = { render: (_element, options) => (options.callback('turnstile-ok'), 'widget-1'), remove: vi.fn() }
  useUiStore.setState({ overlay: null, toasts: [] })
  await openLibrary()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete window.turnstile
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

describe('diálogo de compartilhar', () => {
  it('no perfil Local pede para entrar com o Google', async () => {
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    const note = await noteWithExam()
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    expect(screen.getByText('Entre com o Google para compartilhar.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Compartilhar$/ })).not.toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('mostra o tamanho, sem cota do dia, com "Levar as provas" desmarcado', async () => {
    useGoogle()
    const note = await noteWithExam()
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    const expected = shareBytes(await buildShareContent({ kind: 'file', id: note.id }, useLibraryStore.getState().folders, useLibraryStore.getState().files, useLibraryStore.getState().openFile, false))
    const box = screen.getByLabelText('Tamanho')
    await waitFor(() => expect(within(box).getByText(formatBytes(expected))).toBeInTheDocument())
    expect(screen.queryByText('Hoje ainda dá')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Levar as provas/ })).toHaveAttribute('aria-checked', 'false')
    expect(calls.some(call => call.url.endsWith('/quota'))).toBe(false)
  })

  it('sem marcar, a prova não vai; marcando, vão as questões; destaques vão, tentativas nunca', async () => {
    useGoogle()
    const note = await noteWithExam()
    let created = 0
    replies['POST https://share.test/shares'] = () => json({ id: `AbCdEfGhIjKlMnOpQrStU${++created}`, createdAt: '2026-09-28T12:00:00.000Z', expiresAt: '2026-10-01T12:00:00.000Z', bytes: 300 }, 201)
    const first = render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    await screen.findByDisplayValue(/\/shared\/AbCdEfGhIjKlMnOpQrStU1$/)
    const plain = calls.find(call => call.method === 'POST')!.body as { turnstileToken: string; share: { files: { questions: unknown[] }[] } }
    expect(plain.turnstileToken).toBe('turnstile-ok')
    expect(plain.share.files[0].questions).toEqual([])
    first.unmount()

    calls = []
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('checkbox', { name: /Levar as provas/ }))
    const again = screen.getByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(again).toBeEnabled())
    fireEvent.click(again)
    await screen.findByDisplayValue(/\/shared\//)
    const sent = calls.find(call => call.method === 'POST')!.body as { share: unknown }
    expect((sent.share as { files: { questions: unknown[] }[] }).files[0].questions).toEqual([QUESTION])
    const text = JSON.stringify(sent)
    expect(text).not.toMatch(/attempts|"mastery":\d|certainty/)
    expect(text).toContain('minha nota')
    expect(useLibraryStore.getState().index.shares.map(item => item.withExams)).toEqual([true, false])
  })

  it('a Ata da nota vai junto no link, com as imagens; nota sem Ata segue igual', async () => {
    useGoogle()
    const library = useLibraryStore.getState()
    const meeting = await library.createFile({ name: 'Curva de vendas', type: 'meeting' }, '# Reunião')
    await library.updateSidecar(meeting.id, sidecar => ({ ...sidecar, documents: [ATA] }))
    replies['POST https://share.test/shares'] = () => json({ id: 'AtaAtaAtaAtaAtaAtaAta1', createdAt: '2026-09-28T12:00:00.000Z', expiresAt: '2026-10-01T12:00:00.000Z', bytes: 300 }, 201)
    render(<MemoryRouter><ShareDialog target="file" id={meeting.id} /></MemoryRouter>)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    await screen.findByDisplayValue(/\/shared\/AtaAtaAtaAtaAtaAtaAta1$/)
    const sent = calls.find(call => call.method === 'POST')!.body as { share: { files: SharedFile[] } }
    expect(sent.share.files[0].documents).toEqual([ATA])
    const plain = await noteWithExam()
    const content = await buildShareContent({ kind: 'file', id: plain.id }, useLibraryStore.getState().folders, useLibraryStore.getState().files, useLibraryStore.getState().openFile, false)
    expect(content.files[0]).not.toHaveProperty('documents')
  })

  it('nota antiga com "Você": o link leva o nome de quem compartilha, na fala e no texto, sem mexer no que é dito', async () => {
    const library = useLibraryStore.getState()
    const note = await library.createFile({ name: 'Reunião antiga', type: 'reading' }, 'Você [00:30]: Você vai fazer ainda?\nFalante 1 [00:32]: Tá.')
    await library.updateSidecar(note.id, sidecar => ({ ...sidecar, recording: { blocks: [{ speaker: 'mic', start: 30, end: 31, text: 'Você vai fazer ainda?' }, { speaker: 'speaker_0', start: 32, end: 33, text: 'Tá.' }], speakers: [{ id: 'mic', name: 'Você', suggested: false }, { id: 'speaker_0', name: 'Falante 1', suggested: false }], marks: [] } }))
    const content = await buildShareContent({ kind: 'file', id: note.id }, useLibraryStore.getState().folders, useLibraryStore.getState().files, useLibraryStore.getState().openFile, false, 'Regy Niles')
    expect(content.files[0].recording!.speakers[0]).toMatchObject({ id: 'mic', name: 'Regy Niles' })
    expect(content.files[0].content).toBe('Regy Niles [00:30]: Você vai fazer ainda?\nFalante 1 [00:32]: Tá.')
  })

  it('uma nota grande compartilha sem limite de tamanho', async () => {
    useGoogle()
    const note = await useLibraryStore.getState().createFile({ name: 'Apostila', type: 'reading' }, `# Apostila\n\n${'texto longo '.repeat(200_000)}`)
    replies['POST https://share.test/shares'] = () => json({ id: 'GrandeGrandeGrandeGran1', createdAt: '2026-09-28T12:00:00.000Z', expiresAt: '2026-10-01T12:00:00.000Z', bytes: 2_400_000 }, 201)
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    expect(screen.queryByText(/limite/)).not.toBeInTheDocument()
    fireEvent.click(share)
    await screen.findByDisplayValue(/\/shared\/GrandeGrandeGrandeGran1$/)
    expect(useLibraryStore.getState().index.shares[0].bytes).toBe(2_400_000)
  })

  it('a recusa do Worker aparece', async () => {
    useGoogle()
    const note = await noteWithExam()
    replies['POST https://share.test/shares'] = () => json({ error: 'turnstile_failed' }, 403)
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    expect(await screen.findByText('A verificação anti-robô não passou. Tente de novo.')).toBeInTheDocument()
    expect(useLibraryStore.getState().index.shares).toEqual([])
  })

  it('uma nota com gravação nas Mídias leva a mídia em partes, mostrando o progresso', async () => {
    useGoogle()
    const note = await useLibraryStore.getState().createFile({ name: 'Reunião', type: 'meeting' }, '# Ata')
    const size = 2 * MEDIA_PART_BYTES + 1024 * 1024
    const audio = new File([new Uint8Array(size)], 'Reunião.webm', { type: 'audio/webm' })
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ getFileHandle: async () => ({ getFile: async () => audio }) }) } })
    useLibraryStore.setState({ localMedia: [{ storedName: 'gravacao-1.webm', name: 'Reunião.webm', mime: 'audio/webm', durationSeconds: 60, size, createdAt: '', fileIds: [note.id] }] })
    const id = 'MidiaMidiaMidiaMidia01'
    const base = `https://share.test/shares/${id}/media/${note.id}`
    let release = () => undefined as void
    replies['POST https://share.test/shares'] = () => json({ id, createdAt: '2026-09-28T12:00:00.000Z', expiresAt: '2026-10-01T12:00:00.000Z', mediaExpiresAt: '2026-10-01T12:00:00.000Z', bytes: 300 }, 201)
    replies[`POST ${base}`] = () => json({ uploadId: 'up-1' }, 201)
    for (const part of [1, 2, 3]) replies[`PUT ${base}/${part}`] = () => (part === 2 ? new Promise<Response>(resolve => (release = () => resolve(json({ partNumber: 2, etag: 'e2' })))) : json({ partNumber: part, etag: `e${part}` }))
    replies[`POST ${base}/done`] = () => json({ key: `shared-media/${id}/${note.id}`, mime: 'audio/webm', size })
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    await waitFor(() => expect(within(screen.getByLabelText('Tamanho')).getByText(formatBytes(size))).toBeInTheDocument())
    expect(screen.getByText(/A mídia fica disponível por 3 dias/)).toBeInTheDocument()
    const share = screen.getByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    const bar = await screen.findByRole('progressbar', { name: 'Enviando a mídia' })
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '48'))
    expect(screen.getByText('Enviando a mídia (Reunião.webm): 48%')).toBeInTheDocument()
    release()
    await screen.findByDisplayValue(new RegExp(`/shared/${id}$`))
    const puts = calls.filter(call => call.method === 'PUT')
    expect(puts.map(call => call.url)).toEqual([1, 2, 3].map(part => `${base}/${part}?uploadId=up-1`))
    expect(puts.map(call => (call.body as { size: number }).size)).toEqual([MEDIA_PART_BYTES, MEDIA_PART_BYTES, 1024 * 1024])
    expect(calls.find(call => call.url === base)?.body).toEqual({ mime: 'audio/webm' })
    expect(calls.find(call => call.url === `${base}/done`)?.body).toEqual({ uploadId: 'up-1', parts: [1, 2, 3].map(part => ({ partNumber: part, etag: `e${part}` })) })
    expect(useLibraryStore.getState().index.shares[0].bytes).toBe(300 + size)
  })
})

function sharedItem(fields: Partial<SharedItem> = {}): SharedItem {
  return {
    version: 1,
    id: 'ShareIdShareIdShareId12',
    kind: 'folder',
    title: 'Curso de frações',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
    folders: [
      { id: 'root', name: 'Curso de frações', parentId: null, position: 0, isCourse: true, description: 'curso' },
      { id: 'mod', name: 'Módulo 1', parentId: 'root', position: 0, isCourse: false, description: '' },
    ],
    files: [
      { id: 'a', name: 'Aula 1', folderId: 'mod', type: 'class', position: 0, description: '', tags: ['mat'], content: '# Aula 1\n\nTexto da aula 1.', questions: [QUESTION], highlights: [] },
      { id: 'b', name: 'Aula 2', folderId: 'root', type: 'class', position: 1, description: '', tags: [], content: '# Aula 2', questions: [], highlights: [] },
    ],
    ...fields,
  }
}

function serve(item: SharedItem) {
  const url = (path: string) => `GET https://files.test/shared/${item.id}/${path.split('/').map(encodeURIComponent).join('/')}`
  const folderPaths = new Map<string, string>()
  const pathOf = (id: string): string => {
    const folder = item.folders.find(entry => entry.id === id)!
    return folderPaths.get(id) ?? folderPaths.set(id, `${folder.parentId ? pathOf(folder.parentId) : ''}${folder.name}/`).get(id)!
  }
  const folders = item.folders.map(folder => ({ id: folder.id, path: pathOf(folder.id) }))
  const files = item.files.map(file => ({ id: file.id, path: `${file.folderId ? pathOf(file.folderId) : ''}${file.name}` }))
  replies[url('share.json')] = () => json({ version: 2, id: item.id, kind: item.kind, title: item.title, createdAt: item.createdAt, expiresAt: item.expiresAt, folders, files })
  for (const folder of item.folders) replies[url(`${pathOf(folder.id)}.folder.json`)] = () => json(folder)
  item.files.forEach((file, index) => {
    replies[url(`${files[index].path}.md`)] = () => new Response(file.content)
    replies[url(`${files[index].path}.json`)] = () => json({ meta: { id: file.id, name: file.name, folderId: file.folderId, type: file.type, position: file.position, description: file.description, tags: file.tags }, questions: file.questions, attempts: [], highlights: file.highlights })
  })
}

function SharedProbe({ onRoute }: { onRoute(route: ViewRoute): void }) {
  const { shareId = '' } = useParams()
  const route = useSharedRoute(shareId)
  onRoute(route)
  return <SharedStatus unavailable={Boolean(route.unavailable)} />
}

function renderLink(path: string) {
  const routes: ViewRoute[] = []
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/shared/:shareId" element={<SharedProbe onRoute={route => routes.push(route)} />} />
        <Route path="/shared/:shareId/arquivo/:fileId" element={<SharedProbe onRoute={route => routes.push(route)} />} />
      </Routes>
    </MemoryRouter>,
  )
  return { ...view, routes }
}

describe('página do link', () => {
  it('link apagado mostra "Item indisponível"', async () => {
    renderLink('/shared/ApagadoApagadoApagado1')
    expect(await screen.findByText('Item indisponível')).toBeInTheDocument()
    expect(calls[0].url).toBe('https://files.test/shared/ApagadoApagadoApagado1/share.json')
  })

  it('link expirado mostra "Item indisponível" e não entra em Compartilhado comigo', async () => {
    const item = sharedItem({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    serve(item)
    renderLink(`/shared/${item.id}`)
    expect(await screen.findByText('Item indisponível')).toBeInTheDocument()
    expect(useLibraryStore.getState().index.sharedWithMe).toEqual([])
  })
})

describe('abrir como a própria biblioteca, só leitura', () => {
  it('uma pasta abre na visão de pasta com todas as aulas no lugar da biblioteca, e volta ao sair', async () => {
    const own = await noteWithExam()
    const item = sharedItem()
    serve(item)
    const { routes, unmount } = renderLink(`/shared/${item.id}`)
    await waitFor(() => expect(useLibraryStore.getState().sharedView?.item.id).toBe(item.id))
    expect(routes.at(-1)).toMatchObject({ view: 'folder', folderId: 'root' })
    expect(useLibraryStore.getState().files.map(file => file.name).sort()).toEqual(['Aula 1', 'Aula 2'])
    expect(useLibraryStore.getState().folders.map(folder => folder.name).sort()).toEqual(['Curso de frações', 'Módulo 1'])
    expect(document.documentElement.dataset.shared).toBe('true')
    await waitFor(() => expect(useLibraryStore.getState().index.sharedWithMe.map(link => link.id)).toEqual([item.id]))
    unmount()
    expect(useLibraryStore.getState().sharedView).toBeNull()
    expect(useLibraryStore.getState().files.map(file => file.id)).toEqual([own.id])
    expect(document.documentElement.dataset.shared).toBeUndefined()
  })

  it('um arquivo abre direto na leitura', async () => {
    const item = sharedItem({ kind: 'file', title: 'Aula 1', folders: [], files: [{ ...sharedItem().files[0], folderId: null }] })
    serve(item)
    const { routes } = renderLink(`/shared/${item.id}`)
    await waitFor(() => expect(routes.at(-1)).toMatchObject({ view: 'doc', fileId: 'a' }))
    expect((await useLibraryStore.getState().openFile('a')).content).toBe('# Aula 1\n\nTexto da aula 1.')
  })

  it('nada se grava enquanto é compartilhado; a prova fica só no navegador', async () => {
    const item = sharedItem()
    serve(item)
    renderLink(`/shared/${item.id}`)
    await waitFor(() => expect(useLibraryStore.getState().sharedView).not.toBeNull())
    await expect(useLibraryStore.getState().updateFile('a', { name: 'mexi' })).rejects.toThrow('só leitura')
    await expect(useLibraryStore.getState().createFolder({ name: 'nova' })).rejects.toThrow('só leitura')
    await useLibraryStore.getState().recordAttempt('a', { total: 1, correct: 1, answers: [] })
    expect(readSharedAttempts(item.id).a).toHaveLength(1)
    expect(useLibraryStore.getState().files.find(file => file.id === 'a')?.mastery).toBe(100)
  })
})

describe('importar', () => {
  it('traz o curso inteiro com as pastas, as notas e as notas da prova feitas no navegador', async () => {
    const item = sharedItem()
    saveSharedAttempt(item.id, 'a', { total: 1, correct: 0, answers: [{ questionId: 'q1', answer: 'A', score: 0, certainty: null }] })
    const library = useLibraryStore.getState()
    const result = await importSharedItem(item, readSharedAttempts(item.id), { createFolder: library.createFolder, createFile: library.createFile, updateSidecar: library.updateSidecar })
    const { folders, files } = useLibraryStore.getState()
    const root = folders.find(folder => folder.id === result.folderId)!
    expect(root).toMatchObject({ name: 'Curso de frações', parentId: null, isCourse: true })
    const module = folders.find(folder => folder.parentId === root.id)!
    expect(module.name).toBe('Módulo 1')
    const first = files.find(file => file.name === 'Aula 1')!
    expect(first.folderId).toBe(module.id)
    expect(files.find(file => file.name === 'Aula 2')!.folderId).toBe(root.id)
    const opened = await useLibraryStore.getState().openFile(first.id)
    expect(opened.content).toBe('# Aula 1\n\nTexto da aula 1.')
    expect(opened.sidecar.questions).toEqual([QUESTION])
    expect(opened.sidecar.attempts).toHaveLength(1)
    expect(opened.sidecar.meta).toMatchObject({ questionCount: 1, mastery: 0 })
    expect(first.tags).toEqual(['mat'])
    expect(first.origin).toMatchObject({ input: 'shared', name: 'Curso de frações', url: expect.stringContaining(`/shared/${item.id}`) })
  })

  it('importa uma nota solta pelo selo de compartilhado: sai do modo só leitura e vira sua', async () => {
    const item = sharedItem({ kind: 'file', title: 'Aula 1', folders: [], files: [{ ...sharedItem().files[0], folderId: null }] })
    useLibraryStore.getState().enterShared(item, {})
    render(
      <MemoryRouter initialEntries={[`/shared/${item.id}`]}>
        <Routes>
          <Route path="/shared/:shareId" element={<SharedBadge />} />
          <Route path="*" element={<div>biblioteca</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Compartilhado')).toHaveTextContent('compartilhado · só leitura · faltam 2 dias')
    fireEvent.click(screen.getByRole('button', { name: 'Importar para a minha biblioteca' }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    expect(useLibraryStore.getState().sharedView).toBeNull()
    const [file] = useLibraryStore.getState().files
    expect(file).toMatchObject({ name: 'Aula 1', folderId: null, questionCount: 1, origin: { input: 'shared' } })
  })
})

describe('Compartilhado comigo', () => {
  it('some com o link quando ele expira', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
    const links: SharedLink[] = [
      { id: 'vivo', kind: 'file', title: 'Ainda vale', openedAt: '2026-09-28T10:00:00Z', expiresAt: '2026-09-29T12:00:00Z' },
      { id: 'velho', kind: 'folder', title: 'Já venceu', openedAt: '2026-09-25T10:00:00Z', expiresAt: '2026-09-28T11:00:00Z' },
    ]
    useLibraryStore.setState({ index: { ...useLibraryStore.getState().index, sharedWithMe: links } })
    const view = render(<MemoryRouter><SharingView view="sharedWithMe" /></MemoryRouter>)
    expect(screen.getByText('Ainda vale')).toBeInTheDocument()
    expect(screen.queryByText('Já venceu')).not.toBeInTheDocument()
    await waitFor(() => expect(useLibraryStore.getState().index.sharedWithMe.map(link => link.id)).toEqual(['vivo']))
    vi.setSystemTime(new Date('2026-09-29T12:00:01Z'))
    view.unmount()
    render(<MemoryRouter><SharingView view="sharedWithMe" /></MemoryRouter>)
    expect(screen.queryByText('Ainda vale')).not.toBeInTheDocument()
    expect(screen.getByText(/Nenhum link ativo/)).toBeInTheDocument()
    await act(async () => undefined)
    await waitFor(() => expect(useLibraryStore.getState().index.sharedWithMe).toEqual([]))
  })

  it('as duas listas sincronizam entre aparelhos sem ressuscitar o que foi apagado', () => {
    const base = [{ id: 'a' }, { id: 'b' }]
    const mine = [{ id: 'a' }, { id: 'c' }]
    const theirs = [{ id: 'a' }, { id: 'b' }, { id: 'd' }]
    expect(mergeKept(base, mine, theirs).map(item => item.id)).toEqual(['a', 'c', 'd'])
  })
})
