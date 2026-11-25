// Spec 007, história 4 (T113, FR-039): a cópia (mídia no Google Drive ou em Local) de quem usa a estrutura dura o que a pessoa escolheu,
// 1, 3 ou 7 dias; o share-worker recebe os dias. Sem a escolha (quem não usa a estrutura), vai como antes, sem `days`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createShareController, updateShareController } from '@/controllers/share.controller'
import { env } from '@/lib/env'

let bodies: Record<string, unknown>[]

beforeEach(() => {
  env.shareWorkerUrl = 'https://share.test'
  bodies = []
  vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit = {}) => {
    bodies.push(JSON.parse(String(init.body ?? '{}')))
    return new Response(JSON.stringify({ id: 'c1', createdAt: 'x', expiresAt: 'y', mediaExpiresAt: 'y', bytes: 1, media: [] }), { status: 201, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const content = { kind: 'file', title: 'Nota', folders: [], files: [] } as never
const token = async () => 'tok'

describe('a cópia com prazo', () => {
  it('manda os dias escolhidos ao criar e ao atualizar', async () => {
    await createShareController(token, 'ok', content, [], 7)
    await updateShareController(token, 'c1', 'ok', content, [], 1)
    expect(bodies.map(body => body.days)).toEqual([7, 1])
  })

  it('sem escolha, vai como antes, sem dias', async () => {
    await createShareController(token, 'ok', content)
    expect(bodies[0]).not.toHaveProperty('days')
  })
})
