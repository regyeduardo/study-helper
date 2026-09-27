import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'

import { fireEvent, render, screen, within } from '@testing-library/react'

import type { Activity, FileSidecar, StampedChange } from '@/types/domain'
import { ConflictDialog } from '@/components/dialogs/ConflictDialog'
import { defaultIndex, newFileMeta, newSidecar } from '@/lib/defaults'
import { DriveRepository } from '@/lib/storage/drive-repository'
import type { Conflict, TextConflict } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'

import { FakeDrive, installMemoryStorage, uniqueAccount } from './fake-drive'

let drive: FakeDrive
const token = vi.fn(async () => 'tok')

function stampOf(deviceName: string, at: string): StampedChange {
  return { at, deviceId: deviceName, deviceName }
}

function edited(sidecar: FileSidecar, deviceName: string, at: string, extra: Partial<FileSidecar> = {}): FileSidecar {
  return { ...sidecar, ...extra, meta: { ...sidecar.meta, updated: stampOf(deviceName, at) } }
}

async function twoDevices(content: string): Promise<{ a: DriveRepository; b: DriveRepository; sidecar: FileSidecar }> {
  const a = new DriveRepository(uniqueAccount('dev-a'), token)
  await a.load()
  const sidecar = newSidecar(newFileMeta({ name: 'Compartilhada', type: 'reading' }))
  await a.saveFile(sidecar, content)
  const b = new DriveRepository(uniqueAccount('dev-b'), token)
  await b.load()
  await b.readContent(sidecar.meta.id)
  await b.readSidecar(sidecar.meta.id)
  return { a, b, sidecar }
}

function activity(id: string, deviceId: string): Activity {
  return { id, kind: 'generate', label: id, origin: '', destination: '', fileId: null, status: 'done', detail: '', createdAt: '2026-01-01T00:00:00.000Z', finishedAt: null, deviceId }
}

beforeEach(() => {
  installMemoryStorage()
  drive = new FakeDrive().install()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('conflitos entre dois navegadores no Drive', () => {
  it('mudanças em lugares diferentes do .md se juntam sem perguntar', async () => {
    const { a, b, sidecar } = await twoDevices('um\ndois\ntrês\nquatro')
    const resolver = vi.fn()
    a.setConflictResolver(resolver)
    await b.saveFile(edited(sidecar, 'Device B', '2026-01-01T10:00:00.000Z'), 'UM\ndois\ntrês\nquatro')
    await a.saveFile(edited(sidecar, 'Device A', '2026-01-01T10:05:00.000Z'), 'um\ndois\ntrês\nQUATRO')
    expect(resolver).not.toHaveBeenCalled()
    expect(drive.one('md', sidecar.meta.id).content).toBe('UM\ndois\ntrês\nQUATRO')
  })

  it('mesmo trecho mudado dos dois lados pergunta com base, as duas versões e aparelho/hora de cada lado', async () => {
    const { a, b, sidecar } = await twoDevices('título\nmeio\nfim')
    let asked: Conflict | null = null
    a.setConflictResolver(async conflict => {
      asked = conflict
      return { ...(conflict as TextConflict), resolved: 'título\nmeio escolhido\nfim' }
    })
    await b.saveFile(edited(sidecar, 'Device B', '2026-01-01T10:00:00.000Z'), 'título\nmeio do B\nfim')
    const theirsTime = drive.one('md', sidecar.meta.id).modifiedTime
    await a.saveFile(edited(sidecar, 'Device A', '2026-01-01T10:05:00.000Z'), 'título\nmeio do A\nfim')

    const conflict = asked as unknown as TextConflict
    expect(conflict).toMatchObject({ kind: 'text', fileId: sidecar.meta.id, fileName: 'Compartilhada', base: 'título\nmeio\nfim', mine: 'título\nmeio do A\nfim', theirs: 'título\nmeio do B\nfim' })
    expect(conflict.mineStamp).toEqual({ at: '2026-01-01T10:05:00.000Z', deviceName: 'Device A' })
    expect(conflict.theirsStamp.at).toBe(theirsTime)
    expect(conflict.theirsStamp.deviceName).toBeTruthy()
    expect(drive.one('md', sidecar.meta.id).content).toBe('título\nmeio escolhido\nfim')
  })

  it('no conflito do .md, o outro lado mostra o aparelho que gravou (não um nome genérico)', async () => {
    const { a, b, sidecar } = await twoDevices('título\nmeio\nfim')
    const resolver = vi.fn(async (conflict: Conflict) => conflict)
    a.setConflictResolver(resolver)
    await b.saveFile(edited(sidecar, 'Device B', '2026-01-01T10:00:00.000Z'), 'título\nmeio do B\nfim')
    await a.saveFile(edited(sidecar, 'Device A', '2026-01-01T10:05:00.000Z'), 'título\nmeio do A\nfim')
    const conflict = resolver.mock.calls[0][0] as TextConflict
    expect(conflict.theirsStamp.deviceName).toBe('Device B')
  })

  it('provas e destaques feitos nos dois navegadores se somam no .json sem conflito', async () => {
    const { a, b, sidecar } = await twoDevices('texto')
    const resolver = vi.fn()
    a.setConflictResolver(resolver)
    b.setConflictResolver(resolver)
    const attemptB = { id: 'att-b', createdAt: '2026-01-01T10:00:00.000Z', deviceId: 'b', total: 1, correct: 1, answers: [] }
    const attemptA = { id: 'att-a', createdAt: '2026-01-01T10:01:00.000Z', deviceId: 'a', total: 1, correct: 0, answers: [] }
    await b.saveFile(edited(sidecar, 'Device B', '2026-01-01T10:00:00.000Z', { attempts: [attemptB] }))
    await a.saveFile(edited(sidecar, 'Device A', '2026-01-01T10:01:00.000Z', { attempts: [attemptA] }))
    expect(resolver).not.toHaveBeenCalled()
    const saved = JSON.parse(drive.one('sidecar', sidecar.meta.id).content!) as FileSidecar
    expect(saved.attempts.map(item => item.id).sort()).toEqual(['att-a', 'att-b'])
  })

  it('campo do .json mudado dos dois lados pergunta com aparelho e hora de cada lado', async () => {
    const { a, b, sidecar } = await twoDevices('texto')
    let asked: Conflict | null = null
    a.setConflictResolver(async conflict => {
      asked = conflict
      return conflict.kind === 'json' ? { ...conflict, fields: conflict.fields.map(field => ({ ...field, choice: 'theirs' as const })) } : conflict
    })
    await b.saveFile({ ...edited(sidecar, 'Device B', '2026-01-01T10:00:00.000Z'), meta: { ...sidecar.meta, description: 'do B', updated: stampOf('Device B', '2026-01-01T10:00:00.000Z') } })
    await a.saveFile({ ...edited(sidecar, 'Device A', '2026-01-01T10:05:00.000Z'), meta: { ...sidecar.meta, description: 'do A', updated: stampOf('Device A', '2026-01-01T10:05:00.000Z') } })
    expect(asked).toMatchObject({
      kind: 'json',
      fields: [{ path: 'meta.description', mine: 'do A', theirs: 'do B' }],
      mineStamp: { deviceName: 'Device A', at: '2026-01-01T10:05:00.000Z' },
      theirsStamp: { deviceName: 'Device B', at: '2026-01-01T10:00:00.000Z' },
    })
    expect((JSON.parse(drive.one('sidecar', sidecar.meta.id).content!) as FileSidecar).meta.description).toBe('do B')
  })

  it('atividades registradas nos dois navegadores se somam no study-helper.json', async () => {
    const a = new DriveRepository(uniqueAccount('dev-a'), token)
    const indexA = (await a.load()).index
    const b = new DriveRepository(uniqueAccount('dev-b'), token)
    const indexB = (await b.load()).index
    await b.saveIndex({ ...indexB, activities: [activity('act-b', 'b'), ...indexB.activities] })
    await a.saveIndex({ ...indexA, activities: [activity('act-a', 'a'), ...indexA.activities] })

    const saved = JSON.parse(drive.one('index').content!) as ReturnType<typeof defaultIndex>
    expect(saved.activities.map(item => item.id).sort()).toEqual(['act-a', 'act-b'])
  })
})

describe('store de sincronização: fila de conflitos', () => {
  it('o resolvedor do repositório entra na fila e só termina quando o usuário decide', async () => {
    const repo = new DriveRepository(uniqueAccount(), token)
    const setResolver = vi.spyOn(repo, 'setConflictResolver')
    useLibraryStore.setState({ repo })
    useSyncStore.setState({ syncNow: vi.fn(async () => undefined), conflicts: [] })
    useSyncStore.getState().start()
    useSyncStore.getState().stop()
    const resolver = setResolver.mock.calls[0][0]
    const conflict: TextConflict = { kind: 'text', fileId: 'f', fileName: 'n', base: 'a', mine: 'b', theirs: 'c', mineStamp: { at: '', deviceName: '' }, theirsStamp: { at: '', deviceName: '' } }
    const pending = resolver(conflict)
    expect(useSyncStore.getState().conflicts).toHaveLength(1)
    const { id } = useSyncStore.getState().conflicts[0]
    useSyncStore.getState().settleConflict(id, { ...conflict, resolved: 'final' })
    await expect(pending).resolves.toMatchObject({ resolved: 'final' })
    expect(useSyncStore.getState().conflicts).toEqual([])
    useLibraryStore.setState({ repo: null })
  })
})

describe('ConflictDialog: escolher trecho por trecho', () => {
  const conflict: TextConflict = {
    kind: 'text',
    fileId: 'f1',
    fileName: 'Resumo',
    base: ['topo', 'l2', 'l3', 'l4', 'l5', 'l6', 'alfa', 'l8', 'l9', 'l10', 'l11', 'l12', 'omega'].join('\n'),
    mine: ['topo', 'l2', 'l3', 'l4', 'l5', 'l6', 'alfa minha', 'l8', 'l9', 'l10', 'l11', 'l12', 'omega minha'].join('\n'),
    theirs: ['topo', 'l2', 'l3', 'l4', 'l5', 'l6', 'alfa dele', 'l8', 'l9', 'l10', 'l11', 'l12', 'omega dele'].join('\n'),
    mineStamp: { at: '2026-03-04T15:06:00.000Z', deviceName: 'Chrome · Linux' },
    theirsStamp: { at: '2026-03-04T16:07:00.000Z', deviceName: 'Safari · iPhone' },
  }

  function show() {
    const resolve = vi.fn()
    useLibraryStore.setState({ index: { ...defaultIndex(), settings: { ...defaultIndex().settings, timezone: 'UTC' } } })
    useSyncStore.setState({ conflicts: [{ id: 1, conflict, resolve }], conflictsHidden: false })
    render(<ConflictDialog />)
    return resolve
  }

  afterEach(() => {
    useSyncStore.setState({ conflicts: [] })
  })

  it('mostra só as diferenças e o aparelho e a hora de cada lado', () => {
    show()
    expect(screen.getByText('alfa minha')).toBeInTheDocument()
    expect(screen.getByText('alfa dele')).toBeInTheDocument()
    expect(screen.queryByText('topo')).not.toBeInTheDocument()
    expect(screen.getAllByText(/Chrome · Linux · 04\/03,? 15:06/)).toHaveLength(2)
    expect(screen.getAllByText(/Safari · iPhone · 04\/03,? 16:07/)).toHaveLength(2)
  })

  it('só junta depois de escolher todos os trechos e junta os pedaços escolhidos', () => {
    const resolve = show()
    const save = screen.getByRole('button', { name: 'Juntar e salvar' })
    const chunks = document.querySelectorAll('.chunk')
    expect(chunks).toHaveLength(2)
    fireEvent.click(within(chunks[0] as HTMLElement).getByRole('button', { name: 'Ficar com a minha' }))
    expect(save).toBeDisabled()
    fireEvent.click(within(chunks[1] as HTMLElement).getByRole('button', { name: 'Ficar com a outra' }))
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0].resolved).toBe(['topo', 'l2', 'l3', 'l4', 'l5', 'l6', 'alfa minha', 'l8', 'l9', 'l10', 'l11', 'l12', 'omega dele'].join('\n'))
  })

  it('"Manter as duas" guarda os dois lados do trecho', () => {
    const resolve = show()
    const chunks = document.querySelectorAll('.chunk')
    fireEvent.click(within(chunks[0] as HTMLElement).getByRole('button', { name: 'Manter as duas' }))
    fireEvent.click(within(chunks[1] as HTMLElement).getByRole('button', { name: 'Ficar com a minha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Juntar e salvar' }))
    expect(resolve.mock.calls[0][0].resolved).toContain('alfa minha\nalfa dele')
  })
})
