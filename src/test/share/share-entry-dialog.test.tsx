import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FileSidecar, SharedFile } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { ItemMenu } from '@/components/library/ItemMenu'
import { EntryPage } from '@/components/reader/EntryPage'
import { defaultIndex } from '@/lib/defaults'
import { env } from '@/lib/env'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

import { CONTENTS, ENTRY_NAME, entryFamily, memoryRepository, reunioes } from './entry-family'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const SHARE_ID = 'JanelaJanelaJanelaJan1'
const AT = '2026-11-10T10:00:00.000Z'
const MEDIA_SIZE = 3 * 1024 * 1024

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

beforeEach(() => {
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
      const key = `${init.method ?? 'GET'} ${url}`
      const reply = replies[key] ?? replies[key.replace(/\?.*$/, '')]
      return reply ? reply() : new Response('not found', { status: 404 })
    }),
  )
  window.turnstile = { render: (_element, options) => (options.callback('turnstile-ok'), 'widget-1'), remove: vi.fn() }
  // the entry page plays the video kept in this browser
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:planejamento'), revokeObjectURL: vi.fn() })
  const video = new File([new Uint8Array(MEDIA_SIZE)], 'planejamento.mp4', { type: 'video/mp4' })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ getFileHandle: async () => ({ getFile: async () => video }) }) } })
  sidecars = entryFamily()
  const { repo } = memoryRepository(sidecars, { ...CONTENTS })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
  useLibraryStore.setState({
    repo,
    accountId: 'google-1',
    ready: true,
    folders: [reunioes],
    files: sidecars.map(sidecar => sidecar.meta),
    index: defaultIndex(),
    opened: {},
    openedAt: {},
    sizes: {},
    sharedView: null,
    localMedia: [{ storedName: 'planejamento.mp4', name: 'planejamento.mp4', mime: 'video/mp4', durationSeconds: 68 * 60, size: MEDIA_SIZE, createdAt: AT, fileIds: ['e'] }],
  })
  useUiStore.setState({ overlay: null, toasts: [], menu: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.turnstile
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

function openDialog() {
  return render(
    <MemoryRouter>
      <ShareDialog target="entrada" id="e" />
    </MemoryRouter>,
  )
}

const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement
const counter = () => screen.getByText(/itens vão/).closest('.sh-count')!.textContent

describe('de onde se abre', () => {
  it('"Compartilhar…" no menu da página da entrada abre a janela da entrada', () => {
    render(
      <MemoryRouter>
        <EntryPage fileId="e" />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compartilhar…' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'share', target: 'entrada', id: 'e' })
  })

  it('"Compartilhar" no menu do item: a entrada abre a janela da entrada, a nota continua a de hoje', () => {
    const menu = (id: string) => {
      useUiStore.setState({ menu: { kind: 'file', id, x: 0, y: 0 } })
      const view = render(
        <MemoryRouter>
          <ItemMenu />
        </MemoryRouter>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Compartilhar' }))
      view.unmount()
      return useUiStore.getState().overlay
    }
    expect(menu('e')).toEqual({ kind: 'share', target: 'entrada', id: 'e' })
    expect(menu('ata')).toEqual({ kind: 'share', target: 'file', id: 'ata' })
  })
})

describe('janela de compartilhar uma entrada', () => {
  it('a árvore da família com uma caixa por item: tudo marcado, menos cartões e conversas do Tutor; a transcrição vai sempre, sem caixa', async () => {
    openDialog()
    expect(screen.getByRole('dialog', { name: `Compartilhar entrada · ${ENTRY_NAME}` })).toBeInTheDocument()
    const tree = await screen.findByRole('group', { name: 'O que vai no link' })
    expect(within(tree).getAllByRole('checkbox')).toHaveLength(7)
    expect(box('Mídia').checked).toBe(true)
    expect(box('Ata').checked).toBe(true)
    expect(box('Portal novo').checked).toBe(true)
    expect(box('Cartões da reunião').checked).toBe(false)
    expect(box('Aula').checked).toBe(true)
    expect(box('Explicação: contratos').checked).toBe(true)
    expect(box('Dúvidas sobre contratos').checked).toBe(false)
    expect(within(tree).getByText('Transcrição')).toBeInTheDocument()
    expect(within(tree).getByText(/vai sempre/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Transcrição/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Nota apagada/ })).not.toBeInTheDocument()
    expect(within(tree).getByText('· vídeo de 1 h 08')).toBeInTheDocument()
    expect(within(tree).getByText(formatBytes(MEDIA_SIZE))).toBeInTheDocument()
    expect(screen.getByText('Desmarcar uma nota tira as filhas e os artefatos dela')).toBeInTheDocument()
    expect(counter()).toBe('5 de 7 itens vão')
  })

  it('sem nada embaixo das notas, a regra de desmarcar não aparece', async () => {
    useLibraryStore.setState(state => ({ files: state.files.filter(file => file.id === 'e' || file.id === 'aula') }))
    openDialog()
    const tree = await screen.findByRole('group', { name: 'O que vai no link' })
    expect(within(tree).getByRole('checkbox', { name: 'Aula' })).toBeChecked()
    expect(screen.queryByText('Desmarcar uma nota tira as filhas e os artefatos dela')).not.toBeInTheDocument()
  })

  it('desmarcar uma nota tira as filhas e os artefatos dela; marcar uma filha traz a mãe de volta', async () => {
    openDialog()
    await screen.findByRole('group', { name: 'O que vai no link' })
    fireEvent.click(box('Aula'))
    expect(box('Explicação: contratos').checked).toBe(false)
    expect(counter()).toBe('3 de 7 itens vão')
    fireEvent.click(box('Dúvidas sobre contratos'))
    expect(box('Explicação: contratos').checked).toBe(true)
    expect(box('Aula').checked).toBe(true)
    expect(counter()).toBe('6 de 7 itens vão')
  })

  it('mantém os campos de hoje: o aviso de 3 dias, o tamanho, a frase da mídia e a verificação anti-robô; sem "Levar as provas"', async () => {
    openDialog()
    expect(screen.getByText('Quem tiver o link pode ler, sem entrar em conta. O link vale por 3 dias e mostra a versão de agora.')).toBeInTheDocument()
    const size = screen.getByLabelText('Tamanho')
    await waitFor(() => expect(within(size).getByText(formatBytes(MEDIA_SIZE))).toBeInTheDocument())
    expect(within(size).getByText('Texto')).toBeInTheDocument()
    expect(screen.getByText(/A gravação vai junto/)).toBeInTheDocument()
    expect(screen.getByLabelText('Verificação anti-robô')).toBeInTheDocument()
    expect(screen.queryByText('Levar as provas')).not.toBeInTheDocument()
    fireEvent.click(box('Mídia'))
    expect(within(size).queryByText('Mídia')).not.toBeInTheDocument()
    expect(screen.queryByText(/A gravação vai junto/)).not.toBeInTheDocument()
  })

  it('o que chega ao Worker tem só o escolhido, e a mídia sobe para a entrada', async () => {
    const base = `https://share.test/shares/${SHARE_ID}/media/e`
    replies['POST https://share.test/shares'] = () => json({ id: SHARE_ID, createdAt: AT, expiresAt: '2026-11-13T10:00:00.000Z', mediaExpiresAt: '2026-11-13T10:00:00.000Z', bytes: 500 }, 201)
    replies[`POST ${base}`] = () => json({ uploadId: 'up-1' }, 201)
    replies[`PUT ${base}/1`] = () => json({ partNumber: 1, etag: 'e1' })
    replies[`POST ${base}/done`] = () => json({ key: `shared-media/${SHARE_ID}/e`, mime: 'video/mp4', size: MEDIA_SIZE })
    openDialog()
    await screen.findByRole('group', { name: 'O que vai no link' })
    fireEvent.click(box('Aula'))
    const share = screen.getByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    await screen.findByDisplayValue(new RegExp(`/s/${SHARE_ID}$`))
    expect(screen.getByRole('dialog', { name: `Compartilhar entrada · ${ENTRY_NAME}` })).toBeInTheDocument()
    const sent = calls.find(call => call.url === 'https://share.test/shares')!.body as { share: { kind: string; files: SharedFile[] } }
    expect(sent.share.kind).toBe('entrada')
    expect(sent.share.files.map(file => file.name)).toEqual([ENTRY_NAME, 'Ata'])
    expect(JSON.stringify(sent)).not.toMatch(/Explicação|Cartões da reunião/)
    expect(calls.filter(call => call.method === 'PUT').map(call => call.url)).toEqual([`${base}/1?uploadId=up-1`])
    expect(useLibraryStore.getState().index.shares[0]).toMatchObject({ id: SHARE_ID, kind: 'entrada', itemId: 'e', title: ENTRY_NAME, bytes: 500 + MEDIA_SIZE })
  })

  it('com a mídia desmarcada, nada sobe além do texto', async () => {
    replies['POST https://share.test/shares'] = () => json({ id: SHARE_ID, createdAt: AT, expiresAt: '2026-11-13T10:00:00.000Z', bytes: 500 }, 201)
    openDialog()
    await screen.findByRole('group', { name: 'O que vai no link' })
    fireEvent.click(box('Mídia'))
    expect(counter()).toBe('4 de 7 itens vão')
    const share = screen.getByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    await screen.findByDisplayValue(new RegExp(`/s/${SHARE_ID}$`))
    expect(calls.filter(call => call.url.includes('/media/'))).toEqual([])
    const sent = calls.find(call => call.url === 'https://share.test/shares')!.body as { share: { files: SharedFile[] } }
    expect(sent.share.files[0].meta?.kept).toBe('registro')
  })
})
