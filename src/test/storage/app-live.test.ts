// Entrega 4 (spec 003, SC-004): uma mudança em outro aparelho chega em até 10 s. O canal ao vivo avisa na hora; sem ele, o app
// pergunta a cada 15 s até o canal voltar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({ mockEnv: { apiUrl: 'https://api.example.test' } }))
vi.mock('@/lib/env', () => ({ env: mockEnv }))

import { openLive } from '@/lib/storage/app-live'

class FakeSocket {
  static all: FakeSocket[] = []
  sent: string[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  hear(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('canal ao vivo', () => {
  it('abre em /v1/live, diz o que já tem e avisa quando o mapa muda', () => {
    const onMap = vi.fn()
    const onSpace = vi.fn()
    const stop = openLive({ seq: () => 7, onMap, onSpace })
    const socket = FakeSocket.all[0]
    expect(socket.url).toBe('wss://api.example.test/v1/live')
    socket.open()
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'hello', seq: 7 })
    socket.hear({ type: 'map', seq: 9 })
    expect(onMap).toHaveBeenCalledTimes(1)
    socket.hear({ type: 'space', notes: 1, media: 2, reserved: 0 })
    expect(onSpace).toHaveBeenCalledWith({ notes: 1, media: 2, reserved: 0 })
    stop()
  })

  it('sem o canal, pergunta a cada 15 s e volta a abrir o canal', () => {
    const onMap = vi.fn()
    const stop = openLive({ seq: () => 0, onMap })
    FakeSocket.all[0].close()
    vi.advanceTimersByTime(15_000)
    expect(onMap).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15_000)
    expect(onMap).toHaveBeenCalledTimes(2)
    // and it tries the channel again
    expect(FakeSocket.all.length).toBeGreaterThan(1)
    FakeSocket.all.at(-1)!.open()
    vi.advanceTimersByTime(60_000)
    expect(onMap).toHaveBeenCalledTimes(2)
    stop()
  })

  it('parar fecha o canal e não abre de novo', () => {
    const stop = openLive({ seq: () => 0, onMap: vi.fn() })
    stop()
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(FakeSocket.all[0].readyState).toBe(3)
  })
})
