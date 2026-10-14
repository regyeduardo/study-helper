import type { FileMeta, FileType } from '@/types/domain'

export type NoteMedia = 'text' | 'audio' | 'video'

export const MEDIA_LABEL: Record<NoteMedia, string> = { text: 'Texto', audio: 'Áudio', video: 'Vídeo' }

export function mediaOf(meta: Pick<FileMeta, 'origin'>): NoteMedia {
  const origin = meta.origin
  if (!origin || (origin.input !== 'recording' && origin.input !== 'file')) return 'text'
  const mime = origin.mime ?? ''
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/') || origin.input === 'recording') return 'audio'
  return 'text'
}

export function mediaLength(seconds: number | null | undefined): string {
  if (!seconds) return ''
  const minutes = Math.round(seconds / 60)
  if (seconds < 60) return `${Math.round(seconds)} s`
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`
}

export function recordingName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, '')
}

export const FILE_TYPES: { id: FileType; label: string; tone: string }[] = [
  { id: 'class', label: 'Aula', tone: 't-aula' },
  { id: 'explanation', label: 'Explicação', tone: 't-exp' },
  { id: 'meeting', label: 'Reunião', tone: 't-reu' },
  { id: 'reading', label: 'Leitura', tone: 't-lei' },
]

export function typeInfo(type: FileType) {
  return FILE_TYPES.find(item => item.id === type) ?? FILE_TYPES[0]
}

export const REVIEW_BELOW = 70
export const LOW_MASTERY_BELOW = 60
