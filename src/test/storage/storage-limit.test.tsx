import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FileSidecar } from '@/types/domain'
import { StorageLimitDialog } from '@/components/dialogs/MoreDialogs'
import { Overlays } from '@/components/dialogs/Overlays'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { DEFAULT_STORAGE_LIMIT_BYTES, defaultIndex, newFileMeta, newSidecar } from '@/lib/defaults'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { bytesOf, StorageLimitError } from '@/lib/storage/repository'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

import { FakeDrive, installMemoryStorage, uniqueAccount } from './fake-drive'

const token = vi.fn(async () => 'tok')
let drive: FakeDrive

function sidecarNamed(name: string): FileSidecar {
  return newSidecar(newFileMeta({ name, type: 'reading' }))
}

function growthOf(sidecar: FileSidecar, content: string): number {
  return bytesOf(content) + bytesOf(JSON.stringify(sidecar, null, 2))
}

async function driveWithLimit(account: string, limit: (usedBytes: number) => number): Promise<DriveRepository> {
  await new DriveRepository(account, token).load()
  const first = new DriveRepository(account, token)
  const snapshot = await first.load()
  const used = (await first.usage()).appBytes
  await first.saveIndex({ ...snapshot.index, settings: { ...snapshot.index.settings, storageLimitBytes: limit(used) } })
  const repo = new DriveRepository(account, token)
  await repo.load()
  return repo
}

function googleAccount() {
  return { id: 'google-1', kind: 'google' as const, name: 'Ana Souza', email: 'ana@example.com', picture: '' }
}

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('limite de armazenamento no perfil Local', () => {
  it('confere antes de gravar, bloqueia e diz quanto falta', async () => {
    const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
    const { index } = await repo.load()
    await repo.saveIndex({ ...index, settings: { ...index.settings, storageLimitBytes: 100 } })
    const sidecar = sidecarNamed('Grande')
    const content = 'x'.repeat(300)

    const failure = await repo.saveFile(sidecar, content).catch(error => error)

    expect(failure).toBeInstanceOf(StorageLimitError)
    const used = 2
    expect((failure as StorageLimitError).missingBytes).toBe(used + 300 - 100)
    expect((failure as StorageLimitError).message).toContain(`faltam ${formatBytes(202)}`)
    expect((await repo.load()).files).toEqual([])
    expect(await repo.readContent(sidecar.meta.id)).toBe('')
  })

  it('fontes grandes também são barradas', async () => {
    const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
    const { index } = await repo.load()
    await repo.saveIndex({ ...index, settings: { ...index.settings, storageLimitBytes: 10 } })
    await expect(repo.putSource('f', new Blob(['y'.repeat(50)]))).rejects.toBeInstanceOf(StorageLimitError)
  })

  it('diminuir uma nota nunca é barrado', async () => {
    const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
    const { index } = await repo.load()
    const sidecar = sidecarNamed('Nota')
    await repo.saveFile(sidecar, 'z'.repeat(500))
    await repo.saveIndex({ ...index, settings: { ...index.settings, storageLimitBytes: 50 } })
    await expect(repo.saveFile(sidecar, 'z')).resolves.toBeTruthy()
    expect(await repo.readContent(sidecar.meta.id)).toBe('z')
  })
})

describe('limite de armazenamento no Google Drive', () => {
  it('bloqueia antes de enviar ao Drive e diz quanto falta', async () => {
    const sidecar = sidecarNamed('Grande')
    const content = 'x'.repeat(2000)
    const needed = growthOf(sidecar, content)
    const repo = await driveWithLimit(uniqueAccount(), used => used + 100)
    const used = (await repo.usage()).appBytes
    const limit = (await repo.load()).index.settings.storageLimitBytes!
    drive.requests = []

    const failure = await repo.saveFile(sidecar, content).catch(error => error)

    expect(failure).toBeInstanceOf(StorageLimitError)
    expect((failure as StorageLimitError).neededBytes).toBe(needed)
    expect((failure as StorageLimitError).missingBytes).toBe(used + needed - limit)
    expect((failure as StorageLimitError).message).toContain(`faltam ${formatBytes(used + needed - limit)}`)
    expect(drive.requests.filter(request => request.method !== 'GET')).toEqual([])
    expect(drive.byApp('md', sidecar.meta.id)).toEqual([])
  })

  it('sem limite definido (antes de escolher na primeira conexão) não bloqueia', async () => {
    const repo = new DriveRepository(uniqueAccount(), token)
    const { index } = await repo.load()
    expect(index.settings.storageLimitBytes).toBeNull()
    await expect(repo.saveFile(sidecarNamed('Livre'), 'x'.repeat(5000))).resolves.toBeTruthy()
  })

  it('conta o que acabou de ser gravado na mesma sessão antes de liberar a próxima gravação', async () => {
    const first = sidecarNamed('Primeira')
    const second = sidecarNamed('Segunda')
    const content = 'x'.repeat(400)
    const growth = growthOf(first, content)
    const repo = await driveWithLimit(uniqueAccount(), used => used + Math.round(growth * 1.5) + 20)

    await repo.saveFile(first, content)
    await expect(repo.saveFile(second, content)).rejects.toBeInstanceOf(StorageLimitError)
  })

  it('informa o uso do app e o uso/total do Drive', async () => {
    drive.quota = { limit: '16106127360', usage: '5368709120' }
    const repo = new DriveRepository(uniqueAccount(), token)
    await repo.load()
    await repo.saveFile(sidecarNamed('Nota'), 'conteúdo')
    const fresh = new DriveRepository(repo.accountId, token)
    await fresh.load()
    const root = drive.root()!
    drive.add({ name: 'fora.bin', parents: [], content: 'q'.repeat(10_000) })

    const usage = await fresh.usage()

    const appFiles = [...drive.files.values()].filter(file => drive.pathOf(file.id).startsWith(root.name) && file.content !== undefined)
    const expected = appFiles.reduce((sum, file) => sum + new TextEncoder().encode(file.content!).length, 0)
    expect(usage.appBytes).toBe(expected)
    expect(usage.cloudUsedBytes).toBe(5368709120)
    expect(usage.cloudTotalBytes).toBe(16106127360)
    expect(usage.limitBytes).toBeNull()
  })
})

describe('limite padrão de 1 GB na primeira conexão', () => {
  beforeEach(async () => {
    const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
    const snapshot = await repo.load()
    useLibraryStore.setState({ repo, ready: true, loadError: null, index: snapshot.index })
    useUiStore.setState({ overlay: null })
  })

  afterEach(() => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
    useLibraryStore.setState({ repo: null })
    useUiStore.setState({ overlay: null })
  })

  it('o padrão sugerido é 1 GB', () => {
    expect(DEFAULT_STORAGE_LIMIT_BYTES).toBe(1024 * 1024 * 1024)
    expect(defaultIndex().settings.storageLimitBytes).toBeNull()
  })

  it('a janela da primeira conexão já vem com 1 GB e salva isso no índice', async () => {
    useUiStore.setState({ overlay: { kind: 'storage-limit' } })
    render(<StorageLimitDialog />)
    expect(screen.getByLabelText(/Limite: 1 GB/)).toHaveValue(String(DEFAULT_STORAGE_LIMIT_BYTES))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(useLibraryStore.getState().index.settings.storageLimitBytes).toBe(DEFAULT_STORAGE_LIMIT_BYTES))
    const repo = useLibraryStore.getState().repo!
    expect((await repo.load()).index.settings.storageLimitBytes).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
  })

  it('conta Google sem limite abre a pergunta do limite sozinha', async () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, googleAccount()], activeId: 'google-1' })
    render(
      <MemoryRouter>
        <Overlays />
      </MemoryRouter>,
    )
    await waitFor(() => expect(useUiStore.getState().overlay).toEqual({ kind: 'storage-limit' }))
    expect(await screen.findByText('Quanto o app pode usar do seu Drive?')).toBeInTheDocument()
  })

  it('perfil Local ou conta com limite já definido não pergunta', async () => {
    render(
      <MemoryRouter>
        <Overlays />
      </MemoryRouter>,
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(useUiStore.getState().overlay).toBeNull()
  })
})

describe('tela de Armazenamento mostra os números', () => {
  afterEach(() => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT], activeId: LOCAL_ACCOUNT.id })
    useSyncStore.setState({ usage: null })
  })

  it('mostra uso do app, limite e uso do Drive', () => {
    useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, googleAccount()], activeId: 'google-1' })
    useLibraryStore.setState({ repo: null, index: { ...defaultIndex(), settings: { ...defaultIndex().settings, storageLimitBytes: DEFAULT_STORAGE_LIMIT_BYTES } } })
    useSyncStore.setState({ usage: { appBytes: 3 * 1024 * 1024, limitBytes: DEFAULT_STORAGE_LIMIT_BYTES, cloudUsedBytes: 5368709120, cloudTotalBytes: 16106127360 } })
    render(<SettingsDialog initial="storage" />)
    expect(screen.getByText(`${formatBytes(3 * 1024 * 1024)} de ${formatBytes(DEFAULT_STORAGE_LIMIT_BYTES)}`)).toBeInTheDocument()
    expect(screen.getByText(`${formatBytes(5368709120)} de ${formatBytes(16106127360)} usados na conta · o app usa ${formatBytes(3 * 1024 * 1024)}`)).toBeInTheDocument()
  })
})
