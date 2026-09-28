import { create } from 'zustand'

import type { Meters } from '@/lib/recording/miniplayer'

export const INTEGRATION_URL = 'ws://127.0.0.1:47811'
export const INTEGRATION_SAMPLE_RATE = 48000
const RELEASE = 'https://github.com/regyeduardo/study-helper/releases/download/desktop-latest'
export const INTEGRATION_DOWNLOADS = {
  linux: `${RELEASE}/study-helper-audio-x86_64.AppImage`,
  windows: `${RELEASE}/study-helper-audio.exe`,
}

export type IntegrationOs = keyof typeof INTEGRATION_DOWNLOADS
export type IntegrationSource = { kind: 'system' } | { kind: 'window'; pid: number } | { kind: 'none' }

export interface IntegrationWindow {
  id: string
  title: string
  app: string
  pid: number
}

export interface IntegrationDevice {
  id: string
  label: string
}

export interface IntegrationSourceChoice {
  source?: IntegrationSource
  microphone?: string | null
  label?: string
}

export interface IntegrationHello {
  version: string
  os: string
}

type Reply =
  | ({ type: 'hello' } & IntegrationHello)
  | { type: 'sources'; listing: 'windows' | 'programs'; windows: IntegrationWindow[] }
  | { type: 'started'; source: IntegrationSource }
  | { type: 'microphones'; microphones: IntegrationDevice[] }
  | { type: 'stopped' }
  | { type: 'error'; message: string }

export function integrationOsOf(agent: string = navigator.userAgent): IntegrationOs | null {
  if (/Android|iPhone|iPad|CrOS/.test(agent)) return null
  if (/Windows/.test(agent)) return 'windows'
  if (/Linux|X11/.test(agent)) return 'linux'
  return null
}

export function integrationSourceKey(source: IntegrationSource): string {
  return source.kind === 'window' ? `pid:${source.pid}` : source.kind
}

export function integrationSourceOf(key: string): IntegrationSource {
  if (key.startsWith('pid:')) return { kind: 'window', pid: Number(key.slice(4)) }
  return key === 'system' ? { kind: 'system' } : { kind: 'none' }
}

export class IntegrationLink {
  onFrame: ((channel: number, samples: Float32Array) => void) | null = null
  private waiting: ((reply: Reply) => void)[] = []

  private constructor(private readonly socket: WebSocket) {
    socket.binaryType = 'arraybuffer'
    socket.onmessage = event => {
      if (typeof event.data === 'string') {
        this.waiting.shift()?.(JSON.parse(event.data) as Reply)
        return
      }
      const data = event.data as ArrayBuffer
      if (data.byteLength < 5) return
      this.onFrame?.(new Uint8Array(data, 0, 1)[0], new Float32Array(data.slice(1)))
    }
    socket.onclose = () => {
      for (const resolve of this.waiting.splice(0)) resolve({ type: 'error', message: 'A integração fechou a conexão.' })
    }
  }

  static open(timeoutMs = 1500): Promise<IntegrationLink | null> {
    return new Promise(resolve => {
      let socket: WebSocket
      try {
        socket = new WebSocket(INTEGRATION_URL)
      } catch {
        resolve(null)
        return
      }
      const timer = setTimeout(() => {
        socket.onopen = socket.onerror = null
        socket.close()
        resolve(null)
      }, timeoutMs)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve(new IntegrationLink(socket))
      }
      socket.onerror = () => {
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  private request<T extends Reply['type']>(message: object, expected: T): Promise<Extract<Reply, { type: T }>> {
    return new Promise((resolve, reject) => {
      this.waiting.push(reply => (reply.type === expected ? resolve(reply as Extract<Reply, { type: T }>) : reject(new Error(reply.type === 'error' ? reply.message : 'A integração respondeu outra coisa.'))))
      this.socket.send(JSON.stringify(message))
    })
  }

  hello(): Promise<IntegrationHello> {
    return this.request({ type: 'hello' }, 'hello')
  }

  sources(): Promise<{ listing: 'windows' | 'programs'; windows: IntegrationWindow[] }> {
    return this.request({ type: 'sources' }, 'sources')
  }

  microphones(): Promise<{ microphones: IntegrationDevice[] }> {
    return this.request({ type: 'microphones' }, 'microphones')
  }

  start(source: IntegrationSource, microphone: string | null = null): Promise<unknown> {
    return this.request({ type: 'start', source, microphone }, 'started')
  }

  stop(): Promise<unknown> {
    return this.request({ type: 'stop' }, 'stopped').catch(() => undefined)
  }

  close(): void {
    this.socket.close()
  }
}

interface IntegrationState {
  status: 'unknown' | 'checking' | 'connected' | 'missing'
  hello: IntegrationHello | null
  check(): Promise<boolean>
}

let latestCheck = 0

export const useIntegrationStore = create<IntegrationState>((set, get) => ({
  status: 'unknown',
  hello: null,
  check: async () => {
    const check = ++latestCheck
    if (get().status !== 'connected') set({ status: 'checking' })
    const link = await IntegrationLink.open()
    const hello = link ? await link.hello().catch(() => null) : null
    link?.close()
    if (check === latestCheck) set({ status: hello ? 'connected' : 'missing', hello })
    return Boolean(hello)
  },
}))

const FEED_PROCESSOR = `
class StudyHelperFeed extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = ${INTEGRATION_SAMPLE_RATE * 2}
    this.rings = [new Float32Array(this.size), new Float32Array(this.size)]
    this.write = [0, 0]
    this.read = [0, 0]
    this.port.onmessage = event => {
      const { channel, samples } = event.data
      const ring = this.rings[channel]
      if (!ring) return
      for (let i = 0; i < samples.length; i++) {
        ring[this.write[channel] % this.size] = samples[i]
        this.write[channel]++
      }
      if (this.write[channel] - this.read[channel] > this.size) this.read[channel] = this.write[channel] - this.size
    }
  }
  process(inputs, outputs) {
    for (let channel = 0; channel < 2; channel++) {
      const out = outputs[channel] && outputs[channel][0]
      if (!out) continue
      for (let i = 0; i < out.length; i++) {
        if (this.read[channel] < this.write[channel]) {
          out[i] = this.rings[channel][this.read[channel] % this.size]
          this.read[channel]++
        } else out[i] = 0
      }
    }
    return true
  }
}
registerProcessor('study-helper-feed', StudyHelperFeed)
`

export class IntegrationCapture {
  private stopped = false

  private constructor(
    private readonly link: IntegrationLink,
    readonly context: AudioContext,
    readonly microphone: AudioNode,
    readonly source: AudioNode,
    readonly meters: Meters,
    public label: string,
    public choice: { source: IntegrationSource; microphone: string | null },
  ) {}

  static async start(source: IntegrationSource, label: string, microphoneId: string | null = null): Promise<IntegrationCapture> {
    const link = await IntegrationLink.open()
    if (!link) throw new Error('A integração não respondeu. Confira se ela está aberta.')
    const context = new AudioContext({ sampleRate: INTEGRATION_SAMPLE_RATE })
    try {
      const url = URL.createObjectURL(new Blob([FEED_PROCESSOR], { type: 'text/javascript' }))
      await context.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      const feed = new AudioWorkletNode(context, 'study-helper-feed', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [1, 1] })
      const microphone = context.createGain()
      feed.connect(microphone, 0)
      const meter = (node: AudioNode) => {
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        node.connect(analyser)
        return analyser
      }
      const played = context.createGain()
      feed.connect(played, 1)
      const meters: Meters = { microphone: meter(microphone), computer: meter(played) }
      link.onFrame = (channel, samples) => feed.port.postMessage({ channel, samples }, [samples.buffer])
      await link.start(source, microphoneId)
      void context.resume().catch(() => undefined)
      return new IntegrationCapture(link, context, microphone, played, meters, label, { source, microphone: microphoneId })
    } catch (error) {
      link.close()
      void context.close().catch(() => undefined)
      throw error
    }
  }

  async switchTo(next: IntegrationSourceChoice): Promise<void> {
    const choice = { source: next.source ?? this.choice.source, microphone: next.microphone === undefined ? this.choice.microphone : next.microphone }
    await this.link.start(choice.source, choice.microphone)
    this.choice = choice
    if (next.label !== undefined) this.label = next.label
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.link.onFrame = null
    await this.link.stop()
    this.link.close()
    await this.context.close().catch(() => undefined)
  }
}
