import '@/test/account/storage-shim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

import { ligarMedidas, medidas } from '@/lib/perf'
import { medirAcoes } from '@/lib/perf-actions'
import { LIBRARY_OPS, useLibraryStore } from '@/stores/library'

// Marcas das operações da biblioteca (spec 007, T015): num ponto só, as ações da store, do começo da ação ao quadro pintado depois
// dela. Uma ação que chama outra da mesma operação mede uma vez só, de fora a fora.

const frame = () => vi.advanceTimersByTimeAsync(40)

interface Fake {
  rename(id: string, name: string): Promise<void>
  trashMany(ids: string[]): Promise<void>
  trashOne(id: string): Promise<void>
  open(id: string): Promise<{ type: string }>
  plain(): number
}

function fakeStore() {
  return create<Fake>((_set, get) => ({
    rename: async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
    },
    trashMany: async ids => {
      for (const id of ids) await get().trashOne(id)
    },
    trashOne: async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
    },
    open: async id => ({ type: id === 'pdf' ? 'pdf' : 'video' }),
    plain: () => 7,
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  ligarMedidas(true)
})
afterEach(() => {
  vi.useRealTimers()
  ligarMedidas(false)
})

describe('medirAcoes', () => {
  it('mede a ação do começo ao quadro depois do fim', async () => {
    const store = fakeStore()
    medirAcoes(store, { rename: 'renomear' })
    const done = store.getState().rename('a', 'b')
    await vi.advanceTimersByTimeAsync(200)
    await done
    await frame()
    expect(medidas()).toEqual([expect.objectContaining({ op: 'renomear' })])
    expect(medidas()[0].ms).toBeGreaterThanOrEqual(200)
  })

  it('ação dentro de ação da mesma operação mede uma vez, de fora a fora', async () => {
    const store = fakeStore()
    medirAcoes(store, { trashMany: 'apagar', trashOne: 'apagar' })
    const done = store.getState().trashMany(['a', 'b', 'c'])
    await vi.advanceTimersByTimeAsync(300)
    await done
    await frame()
    expect(medidas().map(medida => medida.op)).toEqual(['apagar'])
    expect(medidas()[0].ms).toBeGreaterThanOrEqual(300)
  })

  it('a operação pode depender do resultado (o tipo da nota aberta)', async () => {
    const store = fakeStore()
    medirAcoes(store, { open: { result: (out: { type: string }) => (out.type === 'pdf' ? 'abrir-nota-pdf' : 'abrir-nota-midia') } })
    await store.getState().open('pdf')
    await store.getState().open('video')
    await frame()
    expect(medidas().map(medida => medida.op)).toEqual(['abrir-nota-pdf', 'abrir-nota-midia'])
  })

  it('uma falha também fecha a medida, e o erro chega a quem chamou', async () => {
    const store = create<{ fail(): Promise<void> }>(() => ({ fail: async () => Promise.reject(new Error('recusado')) }))
    medirAcoes(store, { fail: 'mover' })
    await expect(store.getState().fail()).rejects.toThrow('recusado')
    await frame()
    expect(medidas().map(medida => medida.op)).toEqual(['mover'])
  })

  it('o que não está no mapa fica como era', () => {
    const store = fakeStore()
    const plain = store.getState().plain
    medirAcoes(store, { rename: 'renomear' })
    expect(store.getState().plain).toBe(plain)
  })
})

describe('a biblioteca de verdade', () => {
  it('mede criar, renomear, mover, apagar, restaurar, guardar e abrir nota', () => {
    const marked = Object.fromEntries(Object.entries(LIBRARY_OPS).map(([action, op]) => [action, typeof op === 'string' ? op : 'pelo resultado']))
    expect(marked).toMatchObject({
      createFile: 'criar',
      createFolder: 'criar',
      moveFiles: 'mover',
      trashFiles: 'apagar',
      trashFolder: 'apagar',
      restoreFile: 'restaurar',
      restoreFolder: 'restaurar',
      saveContent: 'guardar-texto',
      openFile: 'pelo resultado',
      updateFile: 'pelo resultado',
      updateFolder: 'pelo resultado',
    })
    const state = useLibraryStore.getState() as unknown as Record<string, { medida?: unknown }>
    for (const action of Object.keys(LIBRARY_OPS)) expect(state[action].medida, action).toBeDefined()
  })
})
