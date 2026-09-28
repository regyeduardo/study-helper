import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteModel, installedModels, storageBreakdown } from '@/lib/storage/installed-models'

vi.mock('@/lib/recording/media-library', () => ({ listLocalMedia: async () => [{ size: 5_000 }, { size: 3_000 }] }))

class FakeCache {
  readonly entries = new Map<string, number>()
  async keys() {
    return [...this.entries.keys()].map(url => ({ url }))
  }
  async match(request: { url: string }) {
    const size = this.entries.get(request.url)
    return size === undefined ? undefined : new Response(new Uint8Array(size), { headers: { 'content-length': String(size) } })
  }
  async delete(request: { url: string }) {
    return this.entries.delete(request.url)
  }
}

let stores: Map<string, FakeCache>

function putParakeet(key: string, bytes: number): Promise<void> {
  return new Promise(resolve => {
    const request = indexedDB.open('parakeet-cache-db', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('file-store')
    request.onsuccess = () => {
      const transaction = request.result.transaction('file-store', 'readwrite')
      transaction.objectStore('file-store').put(new Uint8Array(bytes).buffer, key)
      transaction.oncomplete = () => {
        request.result.close()
        resolve()
      }
    }
  })
}

beforeEach(() => {
  stores = new Map()
  vi.stubGlobal('caches', {
    has: async (name: string) => stores.has(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new FakeCache())
      return stores.get(name)!
    },
    delete: async (name: string) => stores.delete(name),
  })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 100_000 }) } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  indexedDB.deleteDatabase('parakeet-cache-db')
})

describe('installed models', () => {
  it('measures Whisper, Parakeet and the speaker models, and lists only what was downloaded', async () => {
    expect(await installedModels()).toEqual([])
    const transformers = new FakeCache()
    transformers.entries.set('https://huggingface.co/onnx-community/whisper-small/resolve/main/onnx/encoder_model.onnx', 40_000)
    transformers.entries.set('https://huggingface.co/other/model/resolve/main/model.onnx', 999)
    stores.set('transformers-cache', transformers)
    const speakers = new FakeCache()
    speakers.entries.set('https://huggingface.co/csukuangfj/model.onnx', 7_000)
    stores.set('study-helper-models', speakers)
    await putParakeet('encoder', 20_000)
    expect(await installedModels()).toEqual([
      { id: 'whisper', name: 'Whisper', bytes: 40_000 },
      { id: 'parakeet', name: 'Parakeet', bytes: 20_000 },
      { id: 'speakers', name: 'Separação de quem falou', bytes: 7_000 },
    ])
  })

  it('splits what the app takes into models, recordings and the rest', async () => {
    const transformers = new FakeCache()
    transformers.entries.set('https://huggingface.co/onnx-community/whisper-small/resolve/main/x.onnx', 60_000)
    stores.set('transformers-cache', transformers)
    expect(await storageBreakdown()).toEqual({ models: [{ id: 'whisper', name: 'Whisper', bytes: 60_000 }], mediaBytes: 8_000, appBytes: 32_000, totalBytes: 100_000 })
  })

  it('never shows a total smaller than the parts, when the browser reports it late', async () => {
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 1_000 }) } })
    const transformers = new FakeCache()
    transformers.entries.set('https://huggingface.co/onnx-community/whisper-small/resolve/main/x.onnx', 60_000)
    stores.set('transformers-cache', transformers)
    expect(await storageBreakdown()).toMatchObject({ mediaBytes: 8_000, appBytes: 0, totalBytes: 68_000 })
  })

  it('deletes only the chosen model', async () => {
    const transformers = new FakeCache()
    transformers.entries.set('https://huggingface.co/onnx-community/whisper-small/resolve/main/x.onnx', 60_000)
    transformers.entries.set('https://huggingface.co/other/model/resolve/main/model.onnx', 999)
    stores.set('transformers-cache', transformers)
    await putParakeet('encoder', 20_000)
    await deleteModel('whisper')
    expect([...transformers.entries.keys()]).toEqual(['https://huggingface.co/other/model/resolve/main/model.onnx'])
    expect((await installedModels()).map(model => model.id)).toEqual(['parakeet'])
    await deleteModel('parakeet')
    expect(await installedModels()).toEqual([])
  })
})
