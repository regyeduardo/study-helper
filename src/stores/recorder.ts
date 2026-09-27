import { create } from 'zustand'

import { type CaptureMode, discardRecording, MeetingRecorder, type RecordingResult } from '@/lib/recording/recorder'
import { useUiStore } from '@/stores/ui'

interface RecorderState {
  active: boolean
  seconds: number
  mode: CaptureMode | null
  result: RecordingResult | null
  error: string | null
  start(mode: CaptureMode): Promise<void>
  finish(): void
  cancel(): void
  clearResult(): void
}

let recorder: MeetingRecorder | null = null

export const useRecorderStore = create<RecorderState>((set, get) => ({
  active: false,
  seconds: 0,
  mode: null,
  result: null,
  error: null,

  start: async mode => {
    set({ error: null, seconds: 0, result: null })
    recorder = new MeetingRecorder({
      onTick: seconds => set({ seconds }),
      onFinished: result => set({ active: false, result, mode: null }),
      onCancelled: () => {
        set({ active: false, mode: null })
        useUiStore.getState().toast('Gravação descartada')
      },
      onError: message => set({ active: false, error: message, mode: null }),
    })
    try {
      await recorder.start(mode)
      set({ active: true, mode })
    } catch (error) {
      set({ active: false, mode: null, error: error instanceof Error ? error.message : 'O navegador não deixou gravar.' })
      throw error
    }
  },
  finish: () => recorder?.finish(),
  cancel: () => recorder?.cancel(),
  clearResult: () => {
    const storedName = get().result?.storedName
    set({ result: null })
    if (storedName) void discardRecording(storedName)
  },
}))
