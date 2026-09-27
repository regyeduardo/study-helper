export interface Segment {
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
