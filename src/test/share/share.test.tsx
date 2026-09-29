import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { SharedItem, SharedLink, StoredQuestion } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { Overlays } from '@/components/dialogs/Overlays'
import { SharingView } from '@/components/library/SharingLists'
import { env } from '@/lib/env'
import { buildShareContent, importSharedItem, readSharedAttempts, saveSharedAttempt, shareBytes } from '@/lib/share'
import { LocalRepository } from '@/lib/storage/local-repository'
import { mergeKept } from '@/lib/sync/merge'
import SharedPage from '@/pages/shared'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

import { installMemoryStorage } from '../storage/fake-drive'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }

const QUESTION: StoredQuestion = { storedId: 'q1', tipo: 'unica', enunciado: 'Quanto é 2 + 2?', alternativas: { A: '3', B: '4' }, correta: 'B', explicacao: 'Soma.' }

interface Call {
  url: string
  method: string
  body: unknown
  authorization: string
}

let calls: Call[]
let replies: Record<string, () => Response>

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
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, authorization: headers.Authorization ?? '' })
      const key = `${init.method ?? 'GET'} ${url}`
      if (replies[key]) return replies[key]()
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

  it('mostra o tamanho e o que ainda dá hoje, com "Levar as provas" desmarcado', async () => {
    useGoogle()
    const note = await noteWithExam()
    replies['GET https://share.test/quota'] = () => json({ remaining: 250_000 })
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    const expected = shareBytes(await buildShareContent({ kind: 'file', id: note.id }, useLibraryStore.getState().folders, useLibraryStore.getState().files, useLibraryStore.getState().openFile, false))
    const box = screen.getByLabelText('Tamanho e cota')
    await waitFor(() => expect(within(box).getByText(formatBytes(expected))).toBeInTheDocument())
    expect(within(box).getByText(formatBytes(250_000))).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Levar as provas/ })).toHaveAttribute('aria-checked', 'false')
    expect(calls.find(call => call.url.endsWith('/quota'))?.authorization).toBe('Bearer at-1')
  })

  it('sem marcar, a prova não vai; marcando, vão só as questões, sem tentativas, notas nem destaques', async () => {
    useGoogle()
    const note = await noteWithExam()
    replies['GET https://share.test/quota'] = () => json({ remaining: 250_000 })
    let created = 0
    replies['POST https://share.test/shares'] = () => json({ id: `AbCdEfGhIjKlMnOpQrStU${++created}`, createdAt: '2026-09-28T12:00:00.000Z', expiresAt: '2026-10-01T12:00:00.000Z', bytes: 300, remaining: 1000 }, 201)
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
    expect(text).not.toMatch(/attempts|highlights|mastery|minha nota|certainty/)
    expect(useLibraryStore.getState().index.shares.map(item => item.withExams)).toEqual([true, false])
  })

  it('passando do que sobra hoje, mostra a recusa e não deixa compartilhar', async () => {
    useGoogle()
    const note = await noteWithExam()
    replies['GET https://share.test/quota'] = () => json({ remaining: 10 })
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    expect(await screen.findByText('Passa do limite de hoje: ainda dá para compartilhar 10 B.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Compartilhar$/ })).toBeDisabled()
  })

  it('a recusa do Worker aparece com o que ainda sobra', async () => {
    useGoogle()
    const note = await noteWithExam()
    replies['GET https://share.test/quota'] = () => json({ remaining: 250_000 })
    replies['POST https://share.test/shares'] = () => json({ error: 'ip_limit', remaining: 2048 }, 429)
    render(<MemoryRouter><ShareDialog target="file" id={note.id} /></MemoryRouter>)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    expect(await screen.findByText('Passou do limite de hoje desta rede: ainda dá para compartilhar 2 KB.')).toBeInTheDocument()
    expect(useLibraryStore.getState().index.shares).toEqual([])
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
      { id: 'a', name: 'Aula 1', folderId: 'mod', type: 'class', position: 0, description: '', tags: ['mat'], content: '# Aula 1\n\nTexto da aula 1.', questions: [QUESTION] },
      { id: 'b', name: 'Aula 2', folderId: 'root', type: 'class', position: 1, description: '', tags: [], content: '# Aula 2', questions: [] },
    ],
    ...fields,
  }
}

function renderLink(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/shared/${id}`]}>
      <Routes>
        <Route path="/shared/:shareId" element={<SharedPage />} />
        <Route path="*" element={<div>biblioteca</div>} />
      </Routes>
      <Overlays />
    </MemoryRouter>,
  )
}

describe('página do link', () => {
  it('link apagado mostra "Item indisponível"', async () => {
    renderLink('ApagadoApagadoApagado1')
    expect(await screen.findByText('Item indisponível')).toBeInTheDocument()
    expect(calls[0].url).toBe('https://files.test/shared/ApagadoApagadoApagado1.json')
  })

  it('link expirado mostra "Item indisponível" e não entra em Compartilhado comigo', async () => {
    const item = sharedItem({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    replies[`GET https://files.test/shared/${item.id}.json`] = () => json(item)
    renderLink(item.id)
    expect(await screen.findByText('Item indisponível')).toBeInTheDocument()
    expect(useLibraryStore.getState().index.sharedWithMe).toEqual([])
  })

  it('abre sem login, entra em Compartilhado comigo, e a prova fica só no navegador com aviso', async () => {
    const item = sharedItem()
    replies[`GET https://files.test/shared/${item.id}.json`] = () => json(item)
    renderLink(item.id)
    expect(await screen.findByRole('heading', { name: 'Curso de frações' })).toBeInTheDocument()
    await waitFor(() => expect(useLibraryStore.getState().index.sharedWithMe.map(link => link.id)).toEqual([item.id]))
    expect(screen.getByText(/As notas desta prova ficam só neste navegador/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Fazer a prova \(1 questão\)/ }))
    fireEvent.click(await screen.findByRole('button', { name: /\)\s*4$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Entregar' }))
    await screen.findByText('Resultado · Aula 1')
    expect(readSharedAttempts(item.id).a).toHaveLength(1)
    expect(useLibraryStore.getState().files).toEqual([])
    expect(await screen.findByLabelText('Suas notas neste navegador')).toHaveTextContent('Feita 1 vez · última: 100%')
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
  })

  it('importa uma nota solta para a raiz e pelo botão da página', async () => {
    const item = sharedItem({ kind: 'file', title: 'Aula 1', folders: [], files: [{ ...sharedItem().files[0], folderId: null }] })
    replies[`GET https://files.test/shared/${item.id}.json`] = () => json(item)
    renderLink(item.id)
    fireEvent.click(await screen.findByRole('button', { name: 'Importar para a minha biblioteca' }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
    const [file] = useLibraryStore.getState().files
    expect(file).toMatchObject({ name: 'Aula 1', folderId: null, questionCount: 1 })
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
