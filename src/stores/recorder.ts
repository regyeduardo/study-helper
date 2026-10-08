import { create } from 'zustand'

import type { RecordingMark } from '@/types/domain'
import { newId } from '@/lib/ids'
import { addLocalMedia } from '@/lib/recording/media-library'
import type { IntegrationCapture, IntegrationSourceChoice } from '@/lib/recording/integration'
import { type CaptureMode, type LiveCapture, MeetingRecorder, type RecordingResult, type StartOptions } from '@/lib/recording/recorder'
import { useUiStore } from '@/stores/ui'

export type ResultPlace = 'window' | 'dialog'

interface RecorderState {
  active: boolean
  seconds: number
  mode: CaptureMode | null
  live: LiveCapture | null
  floating: Window | null
  result: RecordingResult | null
  resultPlace: ResultPlace
  error: string | null
  marks: RecordingMark[]
  mark(): void
  annotate(text: string): void
  setScreen(on: boolean): Promise<void>
  switchScreen(): Promise<void>
  start(mode: CaptureMode, computerAudio?: string, options?: StartOptions): Promise<void>
  startIntegration(capture: IntegrationCapture, options?: StartOptions): Promise<void>
  finish(): void
  cancel(): void
  pause(): void
  resume(): void
  setEnabled(kind: 'microphone' | 'source', on: boolean): void
  switchMicrophone(id: string | null): Promise<void>
  switchComputerInput(choice: string): Promise<void>
  reshare(): Promise<void>
  switchIntegrationSource(choice: IntegrationSourceChoice): Promise<void>
  clearResult(): void
  reopen(result: RecordingResult): void
  openFloating(): Promise<boolean>
}

let recorder: MeetingRecorder | null = null
let destination: RecordingResult['destination'] = 'none'

function createRecorder(set: (patch: Partial<RecorderState>) => void, get: () => RecorderState): MeetingRecorder {
  return new MeetingRecorder({
    onLive: live => set({ live }),
    onFloating: floating => set({ floating }),
    onTick: seconds => set({ seconds }),
    onFinished: result => {
      set({ active: false, result: { ...result, marks: get().marks, destination }, resultPlace: 'window', mode: null, live: null })
      void addLocalMedia({ storedName: result.storedName, name: result.file.name, mime: result.mime || result.file.type, durationSeconds: result.durationSeconds, size: result.file.size, createdAt: new Date().toISOString(), fileIds: [] })
    },
    onCancelled: () => {
      set({ active: false, mode: null, live: null, floating: null })
      useUiStore.getState().toast('Gravação descartada')
    },
    onError: message => {
      get().floating?.close()
      set({ active: false, error: message, mode: null, live: null, floating: null })
    },
  })
}

const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

export const useRecorderStore = create<RecorderState>((set, get) => ({
  active: false,
  seconds: 0,
  mode: null,
  live: null,
  floating: null,
  result: null,
  resultPlace: 'dialog',
  error: null,
  marks: [],

  mark: () => set({ marks: [...get().marks, { id: newId(), kind: 'mark', at: recorder?.position() ?? get().seconds, text: '' }] }),
  annotate: text => set({ marks: [...get().marks, { id: newId(), kind: 'note', at: recorder?.position() ?? get().seconds, text }] }),
  setScreen: async on => {
    await recorder?.setScreen(on)
  },
  switchScreen: async () => {
    await recorder?.switchScreen()
  },

  start: async (mode, computerAudio, options) => {
    set({ error: null, seconds: 0, result: null, live: null, marks: [] })
    recorder = createRecorder(set, get)
    destination = options?.destination ?? 'none'
    try {
      await recorder.start(mode, computerAudio, options)
      set({ active: true, mode })
    } catch (error) {
      set({ active: false, mode: null, live: null, error: failure(error, 'O navegador não deixou gravar.') })
      throw error
    }
  },
  startIntegration: async (capture, options) => {
    set({ error: null, seconds: 0, result: null, live: null, marks: [] })
    recorder = createRecorder(set, get)
    destination = options?.destination ?? 'none'
    try {
      await recorder.startIntegration(capture, options)
      set({ active: true, mode: 'integration' })
    } catch (error) {
      set({ active: false, mode: null, live: null, error: failure(error, 'Não deu para gravar pela integração.') })
      throw error
    }
  },
  finish: () => recorder?.finish(),
  cancel: () => recorder?.cancel(),
  pause: () => recorder?.pause(),
  resume: () => recorder?.resume(),
  setEnabled: (kind, on) => recorder?.setEnabled(kind, on),
  switchMicrophone: async id => {
    await recorder?.switchMicrophone(id)
  },
  switchComputerInput: async choice => {
    await recorder?.switchComputerInput(choice)
  },
  reshare: async () => {
    await recorder?.reshare()
  },
  switchIntegrationSource: async choice => {
    await recorder?.switchIntegrationSource(choice)
  },
  clearResult: () => {
    get().floating?.close()
    set({ result: null, floating: null })
  },
  reopen: result => set({ result, resultPlace: 'dialog' }),
  openFloating: async () => (recorder ? recorder.openFloating() : false),
}))
