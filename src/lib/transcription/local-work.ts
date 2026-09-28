import { speakerTurns } from '@/lib/transcription/diarization'
import { transcribeWithParakeet } from '@/lib/transcription/parakeet'
import type { Progress, Segment, SpeakerTurn } from '@/lib/transcription/types'
import { transcribeWithWhisper } from '@/lib/transcription/whisper'

export type LocalEngine = 'whisper' | 'parakeet'

export interface LocalJob {
  engine: LocalEngine | null
  language: string
  separateSpeakers: boolean
  samples: Float32Array
}

export interface LocalResult {
  segments: Segment[] | null
  turns: SpeakerTurn[]
}

export async function runLocalJob(job: LocalJob, progress: Progress): Promise<LocalResult> {
  let segments: Segment[] | null = null
  if (job.engine === 'parakeet') segments = await transcribeWithParakeet(job.samples, job.language, progress)
  else if (job.engine === 'whisper') segments = await transcribeWithWhisper(job.samples, job.language, progress)
  let turns: SpeakerTurn[] = []
  if (job.separateSpeakers) {
    try {
      turns = await speakerTurns(job.samples, progress)
    } catch {
      turns = []
    }
  }
  return { segments, turns }
}
