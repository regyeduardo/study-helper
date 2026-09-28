import { create } from 'zustand'

import { addLocalMedia } from '@/lib/recording/media-library'
import { type CaptureMode, type LiveCapture, MeetingRecorder, type RecordingResult } from '@/lib/recording/recorder'
import { useUiStore } from '@/stores/ui'

interface RecorderState {
  active: boolean
  seconds: number
  mode: CaptureMode | null
  live: LiveCapture | null
  floating: boolean
  result: RecordingResult | null
  error: string | null
  start(mode: CaptureMode, computerAudio?: string): Promise<void>
  finish(): void
  cancel(): void
  clearResult(): void
  reopen(result: RecordingResult): void
  openFloating(): Promise<boolean>
}

let recorder: MeetingRecorder | null = null

export const useRecorderStore = create<RecorderState>(set => ({
  active: false,
  seconds: 0,
  mode: null,
  live: null,
  floating: false,
  result: null,
  error: null,

  start: async (mode, computerAudio) => {
    set({ error: null, seconds: 0, result: null, live: null })
    recorder = new MeetingRecorder({
      onLive: live => set({ live }),
      onFloating: floating => set({ floating }),
      onTick: seconds => set({ seconds }),
      onFinished: result => {
        set({ active: false, result, mode: null, live: null, floating: false })
        void addLocalMedia({ storedName: result.storedName, name: result.file.name, mime: result.mime || result.file.type, durationSeconds: result.durationSeconds, size: result.file.size, createdAt: new Date().toISOString(), fileIds: [] })
      },
      onCancelled: () => {
        set({ active: false, mode: null, live: null })
        useUiStore.getState().toast('Gravação descartada')
      },
      onError: message => set({ active: false, error: message, mode: null, live: null }),
    })
    try {
      await recorder.start(mode, computerAudio)
      set({ active: true, mode })
    } catch (error) {
      set({ active: false, mode: null, live: null, error: error instanceof Error ? error.message : 'O navegador não deixou gravar.' })
      throw error
    }
  },
  finish: () => recorder?.finish(),
  cancel: () => recorder?.cancel(),
  clearResult: () => set({ result: null }),
  reopen: result => set({ result }),
  openFloating: async () => (recorder ? recorder.openFloating() : false),
}))
