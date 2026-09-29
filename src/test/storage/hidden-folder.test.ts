import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { DriveRepository, INDEX_NAME } from '@/lib/storage/drive-repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'

import { FakeDrive, type FakeFile, installMemoryStorage, readBlob, uniqueAccount } from './fake-drive'

let drive: FakeDrive
const token = vi.fn(async (_options?: { force?: boolean }) => 'tok')

async function seedVisible(accountId: string) {
  const repo = new DriveRepository(accountId, token, 'drive')
  const snapshot = await repo.load()
  const folder = newFolderMeta({ name: 'Faculdade', parentId: null })
  await repo.saveFolder(folder)
  const loose = newSidecar(newFileMeta({ name: 'Solta', type: 'reading' }))
  await repo.saveFile(loose, '# Solta\n\ntexto solto')
  const meeting = newSidecar(newFileMeta({ name: 'Reunião', type: 'meeting', folderId: folder.id }))
  const stored = await repo.putSource(meeting.meta.id, new Blob(['bytes da gravação']), 'reuniao.webm')
  meeting.meta.origin = { input: 'recording', name: 'reuniao.webm', storage: 'drive', storedFileId: stored.ref, expiresAt: null }
  meeting.transcript = 'Falante 1: oi'
  await repo.saveFile(meeting, '# Ata\n\ndecidimos maio')
  await repo.saveIndex({ ...snapshot.index, settings: { ...snapshot.index.settings, timezone: 'America/Manaus' }, tags: ['prova'] })
  await repo.heartbeat({ id: 'pc-casa', name: 'PC de casa', kind: 'desktop', browser: 'Firefox', lastSeen: '2026-09-28T10:00:00.000Z' } as never)
  return { folder, loose, meeting }
}

async function connect(accountId: string) {
  await useLibraryStore.getState().connect(accountId, token)
  return useLibraryStore.getState()
}

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pasta oculta do Drive', () => {
  it('uma conta nova já nasce na pasta oculta, sem nada visível no Drive', async () => {
    drive.appDataGranted = true
    const state = await connect(uniqueAccount())
    expect(state.loadError).toBeNull()
    expect(state.hiddenPending).toBe(false)
    expect((state.repo as DriveRepository).space).toBe('appDataFolder')
    expect(drive.visibleFiles()).toHaveLength(0)
    expect(drive.hiddenFiles().some(file => file.name === INDEX_NAME)).toBe(true)
  })

  it('uma conta nova que só deu a permissão da pasta oculta abre sem erro', async () => {
    drive.appDataGranted = true
    drive.driveFileGranted = false
    const state = await connect(uniqueAccount())
    expect(state.loadError).toBeNull()
    expect(state.hiddenWarning).toBeNull()
    expect((state.repo as DriveRepository).space).toBe('appDataFolder')
  })

  it('sem a permissão, segue sincronizando na pasta visível e pede para autorizar', async () => {
    const accountId = uniqueAccount()
    await seedVisible(accountId)
    const state = await connect(accountId)
    expect(state.hiddenPending).toBe(true)
    expect((state.repo as DriveRepository).space).toBe('drive')
    expect(state.files.map(file => file.name).sort()).toEqual(['Reunião', 'Solta'])
    expect(drive.hiddenFiles()).toHaveLength(0)
  })

  it('com a permissão, copia tudo para a oculta, confere, apaga a visível e ao recarregar está tudo igual', async () => {
    const accountId = uniqueAccount()
    const seeded = await seedVisible(accountId)
    const visibleBefore = drive.visibleFiles().length
    expect(visibleBefore).toBeGreaterThan(8)
    drive.appDataGranted = true

    const state = await connect(accountId)
    expect(state.loadError).toBeNull()
    expect(state.hiddenWarning).toBeNull()
    expect((state.repo as DriveRepository).space).toBe('appDataFolder')
    expect(drive.visibleFiles()).toHaveLength(0)
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ kind: 'sync', status: 'done', message: 'Tudo na pasta oculta do Drive' })

    const reloaded = await connect(accountId)
    expect(reloaded.files.map(file => file.name).sort()).toEqual(['Reunião', 'Solta'])
    expect(reloaded.folders.map(folder => folder.name)).toEqual(['Faculdade'])
    expect(reloaded.files.find(file => file.name === 'Reunião')!.folderId).toBe(seeded.folder.id)
    expect(reloaded.index.settings.timezone).toBe('America/Manaus')
    expect(reloaded.index.tags).toEqual(['prova'])
    const opened = await useLibraryStore.getState().openFile(seeded.meeting.meta.id)
    expect(opened.content).toBe('# Ata\n\ndecidimos maio')
    expect(opened.sidecar.transcript).toBe('Falante 1: oi')
    const ref = opened.sidecar.meta.origin!.storedFileId!
    expect(ref).not.toBe(seeded.meeting.meta.origin!.storedFileId)
    expect(await readBlob(await reloaded.repo!.getSource(ref))).toBe('bytes da gravação')
    expect((await (reloaded.repo as DriveRepository).listDevices()).map(device => device.name)).toEqual(['PC de casa'])
    expect(useJobsStore.getState().jobs.filter(job => job.kind === 'sync')).toHaveLength(1)
  })

  it('uma sincronização atrasada com o repositório antigo não recria a pasta visível depois da mudança', async () => {
    const accountId = uniqueAccount()
    await seedVisible(accountId)
    const stale = new DriveRepository(accountId, token, 'drive')
    await stale.load()
    drive.appDataGranted = true
    await connect(accountId)
    expect(drive.visibleFiles()).toHaveLength(0)
    await expect(stale.load()).rejects.toThrow('mudou para a pasta oculta')
    expect(drive.visibleFiles()).toHaveLength(0)
  })

  it('uma pasta visível recriada vazia não esconde as notas que já estão na oculta', async () => {
    const accountId = uniqueAccount()
    await seedVisible(accountId)
    drive.appDataGranted = true
    await connect(accountId)
    const emptyVisible = new DriveRepository(uniqueAccount(), token, 'drive')
    await emptyVisible.load()
    expect(drive.visibleFiles().length).toBeGreaterThan(0)
    const state = await connect(accountId)
    expect(state.hiddenWarning).toBeNull()
    expect((state.repo as DriveRepository).space).toBe('appDataFolder')
    expect(state.files.map(file => file.name).sort()).toEqual(['Reunião', 'Solta'])
    expect(drive.visibleFiles()).toHaveLength(0)
  })

  it('com duas pastas visíveis, muda as duas, mantém a configuração da primeira e não perde as notas da segunda', async () => {
    const accountId = uniqueAccount()
    await seedVisible(accountId)
    const second = await drive.fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', body: JSON.stringify({ name: '.sync-study-helper', mimeType: 'application/vnd.google-apps.folder', appProperties: { shKind: 'root', shId: 'root' } }) }).then(response => response.json() as Promise<{ id: string }>)
    await drive.fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', body: JSON.stringify({ name: 'Extra', mimeType: 'application/vnd.google-apps.folder', parents: [second.id], appProperties: { shKind: 'folder', shId: 'pasta-extra' } }) })
    drive.appDataGranted = true
    const state = await connect(accountId)
    expect(state.hiddenWarning).toBeNull()
    expect(drive.visibleFiles()).toHaveLength(0)
    expect(state.index.settings.timezone).toBe('America/Manaus')
    expect(state.folders.map(folder => folder.name).sort()).toEqual(['Extra', 'Faculdade'])
    expect(state.files.map(file => file.name).sort()).toEqual(['Reunião', 'Solta'])
  })

  it('se a cópia não bater, não apaga nada e continua na pasta visível', async () => {
    const accountId = uniqueAccount()
    await seedVisible(accountId)
    drive.appDataGranted = true
    const add = drive.add.bind(drive)
    drive.add = (fields: Partial<FakeFile> & { name: string }) => {
      const file = add(fields)
      if (file.space === 'appDataFolder' && file.appProperties?.shKind === 'md') file.content = `${file.content} (estragado)`
      return file
    }
    const state = await connect(accountId)
    expect((state.repo as DriveRepository).space).toBe('drive')
    expect(state.hiddenWarning).toMatch(/não bateu .*texto de/)
    expect(drive.root()).toBeDefined()
    expect(state.files.map(file => file.name).sort()).toEqual(['Reunião', 'Solta'])
    expect(useJobsStore.getState().jobs[0]).toMatchObject({ kind: 'sync', status: 'error' })
  })

  it('uma queda no meio da cópia não apaga nada, e a próxima vez completa a mudança', async () => {
    const accountId = uniqueAccount()
    await seedVisible(accountId)
    drive.appDataGranted = true
    const add = drive.add.bind(drive)
    let broken = true
    drive.add = (fields: Partial<FakeFile> & { name: string }) => {
      if (broken && fields.appProperties?.shKind === 'source' && fields.parents?.some(parent => drive.files.get(parent)?.space === 'appDataFolder')) throw new Error('rede caiu')
      return add(fields)
    }
    const first = await connect(accountId)
    expect((first.repo as DriveRepository).space).toBe('drive')
    expect(first.hiddenWarning).toMatch(/parou/)
    expect(drive.root()).toBeDefined()

    broken = false
    const second = await connect(accountId)
    expect(second.hiddenWarning).toBeNull()
    expect((second.repo as DriveRepository).space).toBe('appDataFolder')
    expect(drive.visibleFiles()).toHaveLength(0)
    expect(second.files.map(file => file.name).sort()).toEqual(['Reunião', 'Solta'])
    expect(drive.hiddenFiles().filter(file => file.appProperties?.shKind === 'md')).toHaveLength(2)
  })
})
