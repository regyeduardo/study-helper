import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { Settings, TranscriptionEngine } from '@/types/domain'
import { FreeMinutes } from '@/components/dialogs/FreeMinutes'
import { LimitedAiNotice } from '@/components/dialogs/LimitedAiNotice'
import { SettingsDialog } from '@/components/dialogs/SettingsDialog'
import { useFreeMinutes } from '@/hooks/use-free-minutes'
import { defaultIndex, defaultSettings } from '@/lib/defaults'
import { env } from '@/lib/env'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { LocalRepository } from '@/lib/storage/local-repository'
import type { Repository } from '@/lib/storage/repository'
import { transcribe } from '@/lib/transcription'
import { NotEnoughFreeMinutesError } from '@/lib/transcription/free'
import { LOCAL_ACCOUNT, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const WORKER = 'https://free.test'
const GOOGLE = { id: 'g-1', kind: 'google' as const, name: 'Ana Souza', email: 'ana@example.com', picture: '', token: { accessToken: 'google-token', expiresAt: Date.now() + 3600_000 } }
const loud = (seconds: number) => new Float32Array(Math.round(seconds * 16000)).fill(0.3)
const silence = (seconds: number) => new Float32Array(Math.round(seconds * 16000))

let decodedSamples: Float32Array = loud(3)
let remainingSeconds = 0
let posted: number[] = []
let balanceCalls = 0

class FakeOfflineAudioContext {
  destination = {}
  decodeAudioData = async () => ({ duration: decodedSamples.length / 16000 })
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => {} }
  }
  startRendering = async () => ({ getChannelData: () => decodedSamples })
}

function joined(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const audio = () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Blob

function installWorker() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer google-token')
      if (url === `${WORKER}/balance`) {
        balanceCalls++
        return new Response(JSON.stringify({ remaining_seconds: remainingSeconds }))
      }
      const file = (init.body as FormData).get('audio') as Blob
      const seconds = (file.size - 44) / 32000
      posted.push(seconds)
      remainingSeconds -= seconds
      return new Response(JSON.stringify({ text: 'olá', segments: [{ start: 0, end: 1, text: ' olá ' }], remaining_seconds: remainingSeconds }))
    }),
  )
}

function useSettings(engine: TranscriptionEngine, ai: Partial<Settings['ai']> = {}) {
  const saveIndex = vi.fn(async () => undefined)
  const settings = { ...defaultSettings(), ai: { ...defaultSettings().ai, ...ai }, transcription: { ...defaultSettings().transcription, engine, separateSpeakers: false } }
  useLibraryStore.setState({ repo: { saveIndex } as unknown as Repository, index: { ...defaultIndex(), settings } })
}

function Probe({ blob }: { blob: Blob | null }) {
  return <FreeMinutes check={useFreeMinutes(blob)} />
}

beforeEach(() => {
  installMemoryStorage()
  env.transcriptionWorkerUrl = WORKER
  decodedSamples = loud(3)
  remainingSeconds = 1800
  posted = []
  balanceCalls = 0
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  useAccountStore.setState({ accounts: [LOCAL_ACCOUNT, GOOGLE], activeId: GOOGLE.id, reconnectId: null })
  useUiStore.setState({ overlay: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useLibraryStore.setState({ repo: null })
})

describe('free minutes: only speech counts', () => {
  it('sends only the speech and checks the balance against it, not the full length', async () => {
    installWorker()
    decodedSamples = joined(loud(60), silence(120))
    remainingSeconds = 100
    const outcome = await transcribe(audio(), { ...defaultSettings().transcription, engine: 'free', separateSpeakers: false })
    expect(outcome.text).toContain('olá')
    expect(outcome.durationSeconds).toBe(180)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toBeGreaterThan(60)
    expect(posted[0]).toBeLessThan(62)
    expect(remainingSeconds).toBeCloseTo(100 - posted[0], 5)
  })

  it('speech longer than the balance sends nothing and says how much is missing', async () => {
    installWorker()
    decodedSamples = joined(loud(150), silence(30))
    remainingSeconds = 90
    const call = transcribe(audio(), { ...defaultSettings().transcription, engine: 'free', separateSpeakers: false })
    await expect(call).rejects.toBeInstanceOf(NotEnoughFreeMinutesError)
    await expect(transcribe(audio(), { ...defaultSettings().transcription, engine: 'free', separateSpeakers: false })).rejects.toThrow('Falta 1 minuto hoje e o áudio tem 3 minutos de fala.')
    expect(balanceCalls).toBe(2)
    expect(posted).toHaveLength(0)
  })

  it('Perfil Local never reaches the worker', async () => {
    installWorker()
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    await expect(transcribe(audio(), { ...defaultSettings().transcription, engine: 'free', separateSpeakers: false })).rejects.toThrow('Entre com o Google e ganhe 30 minutos grátis por dia.')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('free minutes on screen', () => {
  it('audio longer than the balance shows the two ways out and never calls the worker to transcribe', async () => {
    installWorker()
    useSettings('free')
    decodedSamples = loud(120)
    remainingSeconds = 60
    render(<Probe blob={audio()} />)
    const alert = await screen.findByRole('alert', { name: 'Minutos grátis' })
    expect(alert).toHaveTextContent('Falta 1 minuto hoje e o áudio tem 2 minutos de fala.')
    expect(posted).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Transcrever no navegador (Whisper)' }))
    expect(useLibraryStore.getState().index.settings.transcription.engine).toBe('whisper')
  })

  it('the Groq way out switches to Groq and opens where the key goes', async () => {
    installWorker()
    useSettings('free')
    decodedSamples = loud(120)
    remainingSeconds = 0
    render(<Probe blob={audio()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Usar chave grátis da Groq' }))
    expect(useLibraryStore.getState().index.settings.transcription.engine).toBe('groq')
    expect(useUiStore.getState().overlay).toEqual({ kind: 'settings', tab: 'transcription' })
    expect(posted).toHaveLength(0)
  })

  it('audio within the balance shows what is left and the speech length', async () => {
    installWorker()
    useSettings('free')
    decodedSamples = joined(loud(100), silence(600))
    remainingSeconds = 25 * 60
    render(<Probe blob={audio()} />)
    await waitFor(() => expect(screen.getByRole('status', { name: 'Minutos grátis' })).toHaveTextContent('Hoje restam 25 minutos grátis. Este áudio tem 2 minutos de fala; só a fala conta.'))
  })

  it('Configurações › transcrição shows today’s balance for a Google account', async () => {
    installWorker()
    useSettings('free')
    remainingSeconds = 17 * 60 + 30
    render(<SettingsDialog initial="transcription" />)
    expect(screen.getByRole('radio', { name: /Grátis \(30 min\/dia\)/ })).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(screen.getByRole('status', { name: 'Minutos grátis' })).toHaveTextContent('Hoje restam 17 minutos grátis.'))
  })

  it('Perfil Local shows the invitation and hides the free engine', () => {
    installWorker()
    useAccountStore.setState({ activeId: LOCAL_ACCOUNT.id })
    useSettings('whisper')
    render(<SettingsDialog initial="transcription" />)
    expect(screen.getByRole('note', { name: 'Minutos grátis' })).toHaveTextContent('Entre com o Google e ganhe 30 minutos grátis por dia')
    expect(screen.queryByRole('radio', { name: /Grátis \(30 min\/dia\)/ })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('free engine as the default', () => {
  let drive: FakeDrive
  const token = vi.fn(async (_options?: { force?: boolean }) => 'tok')

  beforeEach(() => {
    drive = new FakeDrive().install()
    drive.appDataGranted = true
  })

  it('a Google account whose library is created now starts on the free engine', async () => {
    await useLibraryStore.getState().connect(uniqueAccount(), token)
    expect(useLibraryStore.getState().index.settings.transcription.engine).toBe('free')
  })

  it('an account that already has a library keeps the saved engine', async () => {
    const account = uniqueAccount()
    const repo = new DriveRepository(account, token, 'appDataFolder')
    const snapshot = await repo.load()
    await repo.saveIndex({ ...snapshot.index, settings: { ...snapshot.index.settings, transcription: { ...snapshot.index.settings.transcription, engine: 'parakeet' } } })
    await useLibraryStore.getState().connect(account, token)
    expect(useLibraryStore.getState().index.settings.transcription.engine).toBe('parakeet')
  })

  it('an old library without a saved engine stays on Whisper instead of being migrated', async () => {
    const account = uniqueAccount()
    const repo = new DriveRepository(account, token, 'appDataFolder')
    await repo.load()
    drive.editContent(drive.one('index').id, JSON.stringify({ version: 1, settings: { timezone: 'UTC' }, tags: [], activities: [], updated: defaultIndex().updated }))
    await useLibraryStore.getState().connect(account, token)
    expect(useLibraryStore.getState().index.settings.transcription.engine).toBe('whisper')
  })

  it('a library moved from the visible folder keeps its engine', async () => {
    drive.appDataGranted = false
    const account = uniqueAccount()
    const visible = new DriveRepository(account, token, 'drive')
    const snapshot = await visible.load()
    await visible.saveIndex({ ...snapshot.index, settings: { ...snapshot.index.settings, transcription: { ...snapshot.index.settings.transcription, engine: 'groq' } } })
    drive.appDataGranted = true
    await useLibraryStore.getState().connect(account, token)
    expect((useLibraryStore.getState().repo as DriveRepository).space).toBe('appDataFolder')
    expect(useLibraryStore.getState().index.settings.transcription.engine).toBe('groq')
  })

  it('Perfil Local keeps Whisper', async () => {
    const snapshot = await new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`).load()
    expect(snapshot.index.settings.transcription.engine).toBe('whisper')
  })
})

describe('Gemini recommendation in the limited AI notice', () => {
  it('shows the numbered steps while the factory OVHcloud AI is in use', () => {
    useSettings('whisper')
    render(<LimitedAiNotice />)
    const steps = screen.getByRole('list', { name: 'Como criar a chave grátis do Gemini' })
    expect(screen.getByRole('note', { name: 'IA limitada' })).toHaveTextContent('Recomendado: use o Google Gemini, que também é grátis.')
    expect(steps.querySelectorAll('li')).toHaveLength(4)
    expect(steps).toHaveTextContent('Create API key')
    expect(steps).toHaveTextContent('Configurações › Inteligência artificial, escolha Google Gemini, cole a chave em Chave da API e clique em Testar e salvar')
    expect(screen.getByRole('link', { name: 'aistudio.google.com/apikey' })).toHaveAttribute('href', 'https://aistudio.google.com/apikey')
    fireEvent.click(screen.getByRole('button', { name: 'Configurar IA' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'settings', tab: 'ai' })
  })

  it('disappears once another AI is saved', async () => {
    useSettings('whisper')
    const { container } = render(<LimitedAiNotice />)
    expect(container).not.toBeEmptyDOMElement()
    useSettings('whisper', { provider: 'gemini', apiKey: 'chave-gemini', model: 'gemini-3.5-flash-lite' })
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
