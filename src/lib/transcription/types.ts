import type { TranscriptionCredential } from '@/types/domain'

export interface Segment {
  start: number
  end: number
  text: string
}

export interface Word {
  start: number
  end: number
  text: string
}

export interface SpeakerTurn {
  start: number
  end: number
  speaker: string
}

export type Progress = (message: string, fraction?: number) => void

export interface ProviderJob {
  audio: Blob
  parts: Blob[]
  partSeconds: number
  language: string
  credential: TranscriptionCredential
  progress: Progress
  signal?: AbortSignal
}

export interface ProviderResult {
  words: Word[]
  turns: SpeakerTurn[]
}
