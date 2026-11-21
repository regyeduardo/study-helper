// O mesmo link recebe a versão de agora (e os arquivos que entraram), a mídia que já subiu não sobe de novo, e o link feito nunca se perde.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { ShareRecord } from '@/types/domain'
import { ShareDialog } from '@/components/dialogs/ShareDialog'
import { env } from '@/lib/env'
import { LocalRepository } from '@/lib/storage/local-repository'
import { type Account, LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { dateTime } from '@/utils/format'

import { installMemoryStorage } from '../storage/fake-drive'

const GOOGLE: Account = { id: 'google-1', kind: 'google', name: 'Ana', email: 'ana@example.com', picture: '', token: { accessToken: 'at-1', expiresAt: Date.now() + 3600_000 } }
const DAY = 24 * 3600_000
const OLD = 'LinkAntigoLinkAntigo12'
const NEW = 'LinkNovoLinkNovoLink10'
const SIZE = 5 * 1024
const CREATED = new Date(Date.now() - DAY).toISOString()

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[]
let replies: Record<string, () => Response | Promise<Response>>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const created = (id = NEW, extra: object = {}) => json({ id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3 * DAY).toISOString(), mediaExpiresAt: new Date(Date.now() + 3 * DAY).toISOString(), bytes: 300, ...extra }, 201)
const updated = (media: { fileId: string; mime: string; size: number }[] = [], extra: object = {}) => json({ id: OLD, createdAt: CREATED, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3 * DAY).toISOString(), mediaExpiresAt: new Date(Date.now() + 3 * DAY).toISOString(), bytes: 400, media, ...extra })

const callsTo = (method: string, part: string) => calls.filter(call => call.method === method && call.url.includes(part))
const uploads = () => calls.filter(call => /\/media\//.test(call.url) && call.method !== 'GET')

function recordOf(itemId: string, fields: Partial<ShareRecord> = {}): ShareRecord {
  return { id: OLD, kind: 'file', itemId, title: 'Reunião', bytes: 300, withExams: false, createdAt: CREATED, expiresAt: new Date(Date.now() + 2 * DAY).toISOString(), ...fields }
}

/** A recorded note whose audio is in this browser (like the Mídias of the app). */
async function noteWithAudio(name = 'Reunião') {
  const meta = await useLibraryStore.getState().createFile({ name, type: 'meeting' }, `# ${name}`)
  return meta
}

function installAudio(notes: { id: string }[]) {
  const audio = new File([new Uint8Array(SIZE)], 'Reunião.m4a', { type: 'audio/mp4' })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({ getFileHandle: async () => ({ getFile: async () => audio }) }) } })
  useLibraryStore.setState({ localMedia: notes.map((note, index) => ({ storedName: `gravacao-${index}.m4a`, name: `Reunião ${index + 1}.m4a`, mime: 'audio/mp4', durationSeconds: 60, size: SIZE, createdAt: '', fileIds: [note.id] })) })
}

function stubUploads(shareId: string, fileId: string) {
  const base = `https://share.test/shares/${shareId}/media/${fileId}`
  replies[`POST ${base}`] = () => json({ uploadId: 'up-1' }, 201)
  replies[`PUT ${base}/1`] = () => json({ partNumber: 1, etag: 'e1' })
  replies[`POST ${base}/done`] = () => json({ key: `shared-media/${shareId}/${fileId}`, mime: 'audio/mp4', size: SIZE })
  return base
}

function open(target: 'file' | 'entrada' | 'folder', id: string) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ShareDialog target={target} id={id} />} />
        <Route path="/compartilhados" element={<div>lista de compartilhados</div>} />
      </Routes>
    </MemoryRouter>,
  )
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
      const method = init.method ?? 'GET'
      calls.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body instanceof Blob ? { size: init.body.size } : null })
      const reply = replies[`${method} ${url}`] ?? replies[`${method} ${url.replace(/\?.*$/, '')}`]
      return reply ? reply() : new Response('not found', { status: 404 })
    }),
  )
  window.turnstile = { render: (_element, options) => (options.callback('turnstile-ok'), 'widget-1'), remove: vi.fn() }
  useUiStore.setState({ overlay: null, toasts: [] })
  const repo = new LocalRepository(`study-helper-share-update-${crypto.randomUUID()}`)
  const snapshot = await repo.load()
  useLibraryStore.setState({ repo, index: snapshot.index, folders: [], files: [], opened: {}, ready: true, loadError: null, localMedia: [] })
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.turnstile
  useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
})

describe('achar o link que já existe', () => {
  it('um link feito como "arquivo" vale para a mesma nota aberta como entrada (a migração fez dela uma entrada), e o contrário', async () => {
    const note = await noteWithAudio()
    await useLibraryStore.getState().saveShare(recordOf(note.id, { kind: 'file' }))
    const first = open('entrada', note.id)
    expect(await screen.findByText('Já compartilhado')).toBeInTheDocument()
    expect(screen.getByDisplayValue(`https://share.test/s/${OLD}`)).toBeInTheDocument()
    first.unmount()
    await useLibraryStore.getState().saveShare(recordOf(note.id, { kind: 'entrada' }))
    open('file', note.id)
    expect(await screen.findByText('Já compartilhado')).toBeInTheDocument()
  })

  it('"Ver compartilhados" fica ao lado de "Fechar" e leva à lista, fechando a janela', async () => {
    const note = await noteWithAudio()
    await useLibraryStore.getState().saveShare(recordOf(note.id))
    useUiStore.setState({ overlay: { kind: 'share', target: 'file', id: note.id } })
    open('file', note.id)
    await screen.findByText('Já compartilhado')
    expect(screen.getAllByRole('button', { name: 'Fechar' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Ver compartilhados' }))
    expect(await screen.findByText('lista de compartilhados')).toBeInTheDocument()
    expect(useUiStore.getState().overlay).toBeNull()
  })

  it('um link que o Worker já não tem (apagado em outro aparelho) não fica na janela como se valesse: o aviso diz e a lista se corrige', async () => {
    const note = await noteWithAudio()
    await useLibraryStore.getState().saveShare(recordOf(note.id))
    replies[`GET https://share.test/shares/${OLD}`] = () => json({ error: 'share_gone' }, 404)
    open('file', note.id)
    expect(await screen.findByText(/O link anterior foi apagado/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^Compartilhar$/ })).toBeInTheDocument()
    expect(screen.queryByText('Já compartilhado')).not.toBeInTheDocument()
    expect(useLibraryStore.getState().index.shares).toEqual([])
  })

  it('um Worker sem a rota de consulta (ainda não publicado) não muda nada: o link aparece como sempre', async () => {
    const note = await noteWithAudio()
    await useLibraryStore.getState().saveShare(recordOf(note.id))
    open('file', note.id)
    expect(await screen.findByText('Já compartilhado')).toBeInTheDocument()
    expect(useLibraryStore.getState().index.shares).toHaveLength(1)
  })

  it('diz se a mídia está no link: está, ou o envio não terminou', async () => {
    const note = await noteWithAudio()
    installAudio([note])
    await useLibraryStore.getState().saveShare(recordOf(note.id))
    const status = (media: object[]) => json({ id: OLD, kind: 'file', title: 'Reunião', createdAt: recordOf(note.id).createdAt, expiresAt: recordOf(note.id).expiresAt, mediaExpiresAt: recordOf(note.id).expiresAt, media, pending: [] })
    replies[`GET https://share.test/shares/${OLD}`] = () => status([{ fileId: note.id, mime: 'audio/mp4', size: SIZE }])
    const first = open('file', note.id)
    expect(await screen.findByText(/A mídia vai junto neste link e fica disponível até/)).toBeInTheDocument()
    first.unmount()
    replies[`GET https://share.test/shares/${OLD}`] = () => status([])
    open('file', note.id)
    expect(await screen.findByText(/A mídia não está neste link/)).toBeInTheDocument()
    expect(screen.getByText(/“Atualizar o link” envia de novo/)).toBeInTheDocument()
  })
})

describe('o link feito não se perde', () => {
  it('fica na lista de compartilhados enquanto a mídia ainda sobe: fechar a aba no meio não deixa um link sem registro', async () => {
    const note = await noteWithAudio()
    installAudio([note])
    const base = stubUploads(NEW, note.id)
    let release = () => undefined as void
    replies['POST https://share.test/shares'] = () => created()
    replies[`PUT ${base}/1`] = () => new Promise<Response>(resolve => (release = () => resolve(json({ partNumber: 1, etag: 'e1' }))))
    open('file', note.id)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    await screen.findByRole('progressbar', { name: 'Enviando a mídia' })
    expect(useLibraryStore.getState().index.shares.map(record => record.id)).toEqual([NEW])
    release()
    await screen.findByDisplayValue(`https://share.test/s/${NEW}`)
    // when it ends, the size of the media is in the record
    expect(useLibraryStore.getState().index.shares[0].bytes).toBe(300 + SIZE)
  })

  it('se a lista não puder ser guardada, o link criado continua na tela, com o aviso, e não aparece "falhou"', async () => {
    const note = await noteWithAudio()
    replies['POST https://share.test/shares'] = () => created()
    vi.spyOn(useLibraryStore.getState().repo!, 'saveIndex').mockRejectedValue(new Error('Drive fora do ar'))
    open('file', note.id)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    expect(await screen.findByDisplayValue(`https://share.test/s/${NEW}`)).toBeInTheDocument()
    expect(screen.getByText(/Não consegui guardar este link na lista de Compartilhados/)).toBeInTheDocument()
    expect(screen.queryByText('O compartilhamento falhou.')).not.toBeInTheDocument()
  })

  it('a mídia que vai subir é avisada ao Worker junto com o texto, para quem abrir o link saber que ela vem', async () => {
    const note = await noteWithAudio()
    installAudio([note])
    stubUploads(NEW, note.id)
    replies['POST https://share.test/shares'] = () => created()
    open('file', note.id)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    await screen.findByDisplayValue(`https://share.test/s/${NEW}`)
    expect(callsTo('POST', '/shares')[0].body).toMatchObject({ media: [{ fileId: note.id, mime: 'audio/mp4', size: SIZE }] })
  })
})

describe('o envio da mídia falhou', () => {
  it('o Worker é avisado de que a mídia não vem (o link para de dizer "subindo") e o aviso diz de qual nota', async () => {
    const note = await noteWithAudio()
    installAudio([note])
    const base = stubUploads(NEW, note.id)
    replies[`PUT ${base}/1`] = () => json({ error: 'boom' }, 500)
    replies[`DELETE ${base}`] = () => json({ cleared: true })
    replies['POST https://share.test/shares'] = () => created()
    open('file', note.id)
    const share = await screen.findByRole('button', { name: /^Compartilhar$/ })
    await waitFor(() => expect(share).toBeEnabled())
    fireEvent.click(share)
    expect(await screen.findByText(/Não consegui enviar a mídia de Reunião 1\.m4a/)).toBeInTheDocument()
    expect(callsTo('DELETE', `/shares/${NEW}/media/${note.id}`)).toHaveLength(1)
    expect(screen.getByDisplayValue(`https://share.test/s/${NEW}`)).toBeInTheDocument()
  })
})

describe('"Atualizar o link": o mesmo link com a versão de agora', () => {
  async function updateOf(note: { id: string }, record: Partial<ShareRecord> = {}) {
    await useLibraryStore.getState().saveShare(recordOf(note.id, record))
    open('file', note.id)
    fireEvent.click(await screen.findByRole('button', { name: 'Atualizar o link' }))
    const button = await screen.findByRole('button', { name: 'Atualizar o link' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
  }

  it('manda o texto para o mesmo link (sem criar outro), com o prazo novo e a data da atualização', async () => {
    const note = await noteWithAudio()
    replies[`PUT https://share.test/shares/${OLD}`] = () => updated()
    await updateOf(note)
    expect(await screen.findByDisplayValue(`https://share.test/s/${OLD}`)).toBeInTheDocument()
    expect(screen.getByText(/Link atualizado/)).toBeInTheDocument()
    expect(callsTo('POST', '/shares')).toHaveLength(0)
    const [put] = callsTo('PUT', `/shares/${OLD}`)
    expect(put.body).toMatchObject({ turnstileToken: 'turnstile-ok', share: { kind: 'file', title: 'Reunião' } })
    const shares = useLibraryStore.getState().index.shares
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ id: OLD, itemId: note.id, bytes: 400 })
    expect(Date.parse(shares[0].expiresAt)).toBeGreaterThan(Date.now() + 2.9 * DAY)
    expect(shares[0].updatedAt).toBeDefined()
    expect(shares[0].createdAt).toBe(recordOf(note.id).createdAt)
    const timeZone = useLibraryStore.getState().index.settings.timezone
    expect(screen.getByText(new RegExp(`Vale até ${dateTime(shares[0].expiresAt, timeZone)}`))).toBeInTheDocument()
  })

  it('a mídia que o Worker diz já ter não sobe de novo: nenhum envio, e o tamanho dela segue no registro', async () => {
    const note = await noteWithAudio()
    installAudio([note])
    replies[`PUT https://share.test/shares/${OLD}`] = () => updated([{ fileId: note.id, mime: 'audio/mp4', size: SIZE }])
    await updateOf(note)
    await screen.findByText(/Link atualizado/)
    expect(callsTo('PUT', `/shares/${OLD}`)[0].body).toMatchObject({ media: [{ fileId: note.id, mime: 'audio/mp4', size: SIZE }] })
    expect(uploads()).toEqual([])
    expect(useLibraryStore.getState().index.shares[0].bytes).toBe(400 + SIZE)
    expect(screen.queryByRole('progressbar', { name: 'Enviando a mídia' })).not.toBeInTheDocument()
  })

  it('a mídia que falta no link sobe para o mesmo link, e só ela', async () => {
    const note = await noteWithAudio()
    installAudio([note])
    const base = stubUploads(OLD, note.id)
    replies[`PUT https://share.test/shares/${OLD}`] = () => updated([])
    await updateOf(note)
    await screen.findByText(/Link atualizado/)
    expect(uploads().map(call => `${call.method} ${call.url.replace(/\?.*$/, '')}`)).toEqual([`POST ${base}`, `PUT ${base}/1`, `POST ${base}/done`])
    expect(useLibraryStore.getState().index.shares[0].bytes).toBe(400 + SIZE)
  })

  it('um arquivo que entrou numa pasta já compartilhada vai para o mesmo link, e a mídia dos que já estavam lá não sobe', async () => {
    const library = useLibraryStore.getState()
    const folder = await library.createFolder({ name: 'Reuniões' })
    const first = await library.createFile({ name: 'Primeira', type: 'meeting', folderId: folder.id }, '# Primeira')
    const second = await library.createFile({ name: 'Segunda', type: 'meeting', folderId: folder.id }, '# Segunda')
    installAudio([first, second])
    stubUploads(OLD, second.id)
    await library.saveShare(recordOf(folder.id, { kind: 'folder', title: 'Reuniões' }))
    replies[`PUT https://share.test/shares/${OLD}`] = () => updated([{ fileId: first.id, mime: 'audio/mp4', size: SIZE }])
    open('folder', folder.id)
    fireEvent.click(await screen.findByRole('button', { name: 'Atualizar o link' }))
    const button = await screen.findByRole('button', { name: 'Atualizar o link' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await screen.findByText(/Link atualizado/)
    const sent = uploads().map(call => call.url.replace(/\?.*$/, ''))
    expect(sent.every(url => url.includes(`/media/${second.id}`))).toBe(true)
    expect(sent).toHaveLength(3)
    const body = callsTo('PUT', `/shares/${OLD}`)[0].body as { share: { files: { id: string }[] } }
    expect(body.share.files.map(file => file.id).sort()).toEqual([first.id, second.id].sort())
    expect(useLibraryStore.getState().index.shares).toHaveLength(1)
  })

  it('o Worker ainda sem a rota nova: cria um link novo com a mesma verificação, avisa, e o antigo continua até vencer', async () => {
    const note = await noteWithAudio()
    replies['POST https://share.test/shares'] = () => created()
    await updateOf(note)
    expect(await screen.findByDisplayValue(`https://share.test/s/${NEW}`)).toBeInTheDocument()
    expect(screen.getByText(/ainda não atualiza o mesmo link, então criei um link novo/)).toBeInTheDocument()
    expect(callsTo('POST', '/shares')[0].body).toMatchObject({ turnstileToken: 'turnstile-ok' })
    expect(useLibraryStore.getState().index.shares.map(record => record.id)).toEqual([NEW, OLD])
  })

  it('o link já tinha sido apagado: cria um novo e tira o antigo da lista', async () => {
    const note = await noteWithAudio()
    replies[`PUT https://share.test/shares/${OLD}`] = () => json({ error: 'share_gone' }, 404)
    replies['POST https://share.test/shares'] = () => created()
    await updateOf(note)
    expect(await screen.findByDisplayValue(`https://share.test/s/${NEW}`)).toBeInTheDocument()
    expect(screen.getByText(/O link anterior tinha sido apagado, então criei um link novo/)).toBeInTheDocument()
    expect(useLibraryStore.getState().index.shares.map(record => record.id)).toEqual([NEW])
  })

  it('outra falha do Worker não vira um link novo sem querer: o erro aparece e o registro fica como estava', async () => {
    const note = await noteWithAudio()
    replies[`PUT https://share.test/shares/${OLD}`] = () => json({ error: 'boom' }, 500)
    await updateOf(note)
    expect(await screen.findByText('O compartilhamento falhou. Tente de novo.')).toBeInTheDocument()
    expect(callsTo('POST', '/shares')).toHaveLength(0)
    expect(useLibraryStore.getState().index.shares).toEqual([expect.objectContaining({ id: OLD, bytes: 300 })])
  })

  it('"Criar outro link" faz como antes: um link novo, e o antigo continua até vencer', async () => {
    const note = await noteWithAudio()
    await useLibraryStore.getState().saveShare(recordOf(note.id))
    replies['POST https://share.test/shares'] = () => created()
    open('file', note.id)
    fireEvent.click(await screen.findByRole('button', { name: 'Atualizar o link' }))
    const other = await screen.findByRole('button', { name: 'Criar outro link' })
    await waitFor(() => expect(other).toBeEnabled())
    fireEvent.click(other)
    expect(await screen.findByDisplayValue(`https://share.test/s/${NEW}`)).toBeInTheDocument()
    expect(callsTo('PUT', '/shares/')).toHaveLength(0)
    expect(useLibraryStore.getState().index.shares.map(record => record.id)).toEqual([NEW, OLD])
  })
})
