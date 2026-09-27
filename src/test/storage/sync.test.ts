import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'

import type { DeviceRecord } from '@/types/domain'
import { currentDevice } from '@/lib/device'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import { useLibraryStore } from '@/stores/library'
import { isOnline, ONLINE_WINDOW_MS, SYNC_INTERVAL_MS, useSyncStore } from '@/stores/sync'
import { agoText } from '@/utils/format'

import { FakeDrive, installMemoryStorage, uniqueAccount } from './fake-drive'

const token = vi.fn(async () => 'tok')
const realSyncNow = useSyncStore.getState().syncNow
let drive: FakeDrive

function device(lastSeen: string): DeviceRecord {
  return { id: 'd', name: 'X', lastSeen, accountId: 'a' }
}

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
  useSyncStore.setState({ syncNow: realSyncNow, busy: false, devices: [], usage: null, lastSyncAt: null, error: null })
})

afterEach(() => {
  useSyncStore.getState().stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useLibraryStore.setState({ repo: null })
})

describe('intervalo de sincronização', () => {
  it('é de 5 minutos e roda na hora ao começar', async () => {
    expect(SYNC_INTERVAL_MS).toBe(5 * 60 * 1000)
    vi.useFakeTimers()
    const syncNow = vi.fn(async () => undefined)
    useLibraryStore.setState({ repo: new DriveRepository(uniqueAccount(), token) })
    useSyncStore.setState({ syncNow })
    useSyncStore.getState().start()
    expect(syncNow).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS - 1)
    expect(syncNow).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(syncNow).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 2)
    expect(syncNow).toHaveBeenCalledTimes(4)
    useSyncStore.getState().stop()
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 3)
    expect(syncNow).toHaveBeenCalledTimes(4)
  })

  it('perfil Local não fica sincronizando de 5 em 5 minutos', async () => {
    vi.useFakeTimers()
    const syncNow = vi.fn(async () => undefined)
    useLibraryStore.setState({ repo: new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`) })
    useSyncStore.setState({ syncNow })
    useSyncStore.getState().start()
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 3)
    expect(syncNow).not.toHaveBeenCalled()
    expect(useSyncStore.getState().lastSyncAt).not.toBeNull()
  })

  it('reiniciar não duplica o timer', async () => {
    vi.useFakeTimers()
    const syncNow = vi.fn(async () => undefined)
    useLibraryStore.setState({ repo: new DriveRepository(uniqueAccount(), token) })
    useSyncStore.setState({ syncNow })
    useSyncStore.getState().start()
    useSyncStore.getState().start()
    syncNow.mockClear()
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS)
    expect(syncNow).toHaveBeenCalledTimes(1)
  })
})

describe('isOnline: logado = visto nos últimos 10 minutos', () => {
  const now = Date.parse('2026-05-05T12:00:00.000Z')

  it('usa janela de 10 minutos', () => {
    expect(ONLINE_WINDOW_MS).toBe(10 * 60 * 1000)
    expect(isOnline(device('2026-05-05T12:00:00.000Z'), now)).toBe(true)
    expect(isOnline(device('2026-05-05T11:51:00.000Z'), now)).toBe(true)
    expect(isOnline(device('2026-05-05T11:50:00.000Z'), now)).toBe(true)
    expect(isOnline(device('2026-05-05T11:49:59.000Z'), now)).toBe(false)
    expect(isOnline(device('2026-05-04T12:00:00.000Z'), now)).toBe(false)
  })
})

describe('agoText ("Atualizado há N min")', () => {
  const now = Date.parse('2026-05-05T12:00:00.000Z')

  it('formata minutos, horas e dias', () => {
    expect(agoText(null, now)).toBe('nunca')
    expect(agoText(now - 20_000, now)).toBe('agora')
    expect(agoText(now - 60_000, now)).toBe('há 1 min')
    expect(agoText(now - 7 * 60_000, now)).toBe('há 7 min')
    expect(agoText('2026-05-05T11:15:00.000Z', now)).toBe('há 45 min')
    expect(agoText(now - 3 * 3600_000, now)).toBe('há 3 h')
    expect(agoText(now - 24 * 3600_000, now)).toBe('há 1 dia')
    expect(agoText(now - 3 * 24 * 3600_000, now)).toBe('há 3 dias')
  })
})

describe('syncNow com o Drive', () => {
  it('marca presença deste navegador em devices/, lista os aparelhos e guarda o uso', async () => {
    const account = uniqueAccount()
    await useLibraryStore.getState().connect(account, token)
    const devicesFolder = drive.one('devices')
    drive.add({
      name: 'velho.json',
      parents: [devicesFolder.id],
      content: JSON.stringify({ id: 'velho', name: 'Firefox · Windows', lastSeen: '2025-01-01T00:00:00.000Z', accountId: account }),
      appProperties: { shKind: 'device', shId: 'velho' },
      modifiedTime: '2025-01-01T00:00:00.000Z',
    })

    await useSyncStore.getState().syncNow()

    const state = useSyncStore.getState()
    expect(state.error).toBeNull()
    expect(state.lastSyncAt).not.toBeNull()
    const me = currentDevice()
    const mine = drive.one('device', me.id)
    expect(drive.pathOf(mine.id)).toBe(`.sync-study-helper/devices/${me.id}.json`)
    expect(JSON.parse(mine.content!)).toMatchObject({ id: me.id, name: me.name, accountId: account })
    const byId = Object.fromEntries(state.devices.map(item => [item.id, item]))
    expect(Object.keys(byId).sort()).toEqual([me.id, 'velho'].sort())
    expect(byId.velho).toMatchObject({ name: 'Firefox · Windows', lastSeen: '2025-01-01T00:00:00.000Z' })
    expect(isOnline(byId.velho)).toBe(false)
    expect(byId[me.id].lastSeen).toBe(mine.modifiedTime)
    expect(state.usage).toMatchObject({ cloudUsedBytes: 5368709120, cloudTotalBytes: 16106127360 })
  })

  it('traz de volta o .md editado no Drive e descarta a versão aberta', async () => {
    await useLibraryStore.getState().connect(uniqueAccount(), token)
    const meta = await useLibraryStore.getState().createFile({ name: 'Aula', type: 'class' }, 'versão app')
    await useLibraryStore.getState().openFile(meta.id)
    drive.editContent(drive.one('md', meta.id).id, 'versão Drive')

    await useSyncStore.getState().syncNow()

    expect(useLibraryStore.getState().opened[meta.id]).toBeUndefined()
    expect((await useLibraryStore.getState().openFile(meta.id)).content).toBe('versão Drive')
  })

  it('erro do Drive vira mensagem e não trava a próxima sincronização', async () => {
    await useLibraryStore.getState().connect(uniqueAccount(), token)
    drive.queuedStatuses = [500]
    await useSyncStore.getState().syncNow()
    expect(useSyncStore.getState().error).toMatch(/Google Drive/)
    expect(useSyncStore.getState().busy).toBe(false)
    await useSyncStore.getState().syncNow()
    expect(useSyncStore.getState().error).toBeNull()
  })
})
