import { vi } from 'vitest'

import type { IntegrationWindow } from '@/lib/recording/integration'

export class FakeSocket {
  static instances: FakeSocket[] = []
  static available = false
  static replies: Record<string, unknown> = {}
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  readonly sent: Record<string, unknown>[] = []
  readonly close = vi.fn(() => this.onclose?.())

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
    queueMicrotask(() => (FakeSocket.available ? this.onopen?.() : this.onerror?.()))
  }

  send(text: string): void {
    const request = JSON.parse(text) as { type: string }
    this.sent.push(request)
    const reply = FakeSocket.replies[request.type]
    if (reply) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }))
  }

  frame(channel: number, samples: number[]): void {
    const buffer = new ArrayBuffer(1 + samples.length * 4)
    const view = new DataView(buffer)
    view.setUint8(0, channel)
    samples.forEach((sample, index) => view.setFloat32(1 + index * 4, sample, true))
    this.onmessage?.({ data: buffer })
  }
}

export function installIntegration(options: { available: boolean; windows?: IntegrationWindow[]; listing?: 'windows' | 'programs' }): void {
  FakeSocket.instances = []
  FakeSocket.available = options.available
  FakeSocket.replies = {
    hello: { type: 'hello', version: '0.1.0', os: 'linux' },
    sources: { type: 'sources', listing: options.listing ?? 'windows', windows: options.windows ?? [] },
    microphones: { type: 'microphones', microphones: [{ id: 'alsa_input.usb-headset', label: 'Headset USB' }] },
    start: { type: 'started', source: { kind: 'system' } },
    stop: { type: 'stopped' },
  }
  vi.stubGlobal('WebSocket', FakeSocket)
}
