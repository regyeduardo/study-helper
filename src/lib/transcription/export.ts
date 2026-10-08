import type { RecordingData, TranscriptBlock } from '@/types/domain'

export function clockTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
  return hours ? `${hours}:${rest}` : rest
}

export function speakerName(recording: RecordingData, id: string): string {
  return recording.speakers.find(speaker => speaker.id === id)?.name ?? id
}

export function speechLine(recording: RecordingData, block: TranscriptBlock): string {
  return block.speaker ? `${speakerName(recording, block.speaker)} [${clockTime(block.start)}]: ${block.text}\n` : `[${clockTime(block.start)}] ${block.text}\n`
}

export function transcriptText(recording: RecordingData): string {
  return recording.blocks.map(block => speechLine(recording, block)).join('')
}

function srtTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000))
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor((total % 3600000) / 60000))}:${pad(Math.floor((total % 60000) / 1000))},${pad(total % 1000, 3)}`
}

export function transcriptSrt(recording: RecordingData): string {
  return recording.blocks
    .map((block, index) => {
      const end = block.end > block.start ? block.end : block.start + 1
      const speech = block.speaker ? `${speakerName(recording, block.speaker)}: ${block.text}` : block.text
      return `${index + 1}\n${srtTime(block.start)} --> ${srtTime(end)}\n${speech}\n`
    })
    .join('\n')
}
