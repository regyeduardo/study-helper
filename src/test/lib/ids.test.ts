import { afterEach, describe, expect, it, vi } from 'vitest'

import { newId } from '@/lib/ids'

afterEach(() => vi.unstubAllGlobals())

describe('newId', () => {
  it('gera UUID v4 mesmo sem crypto.randomUUID (página aberta por http)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.map((_, index) => index * 17) })
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('não repete', () => {
    const ids = new Set(Array.from({ length: 1000 }, newId))
    expect(ids.size).toBe(1000)
  })
})
