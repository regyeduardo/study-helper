import type { FileMeta, FileType, SourceMeta } from '@/types/domain'

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

/** A YouTube link: a video seen by its link, with no media here to play (`mediaOf` stays 'text'). */
export function isYoutube(meta: Pick<FileMeta, 'origin'>): boolean {
  return meta.origin?.input === 'youtube' && Boolean(meta.origin.url)
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

/** The notes that keep a source (once "Entradas"): the special page plays, transcribes and shows the notes born of them. */
export const SOURCE_TYPES: { id: FileType; label: string; tone: string }[] = [
  { id: 'video', label: 'Vídeo', tone: 't-reu' },
  { id: 'audio', label: 'Áudio', tone: 't-reu' },
  { id: 'pdf', label: 'PDF', tone: 't-lei' },
  { id: 'link', label: 'Link', tone: 't-lei' },
  { id: 'text', label: 'Texto', tone: 't-lei' },
  { id: 'topic', label: 'Tema', tone: 't-lei' },
  { id: 'document', label: 'Outro arquivo', tone: 't-lei' },
]

const SOURCE_IDS = new Set(SOURCE_TYPES.map(item => item.id))

export function typeInfo(type: FileType) {
  return FILE_TYPES.find(item => item.id === type) ?? SOURCE_TYPES.find(item => item.id === type) ?? FILE_TYPES[0]
}

/** The type of the note made of a source: YouTube and video → Vídeo; audio and a microphone recording → Áudio; PDF; link; pasted text; topic; any other file. */
export function sourceTypeOf(origin: SourceMeta | null | undefined): FileType {
  if (!origin) return 'text'
  if (origin.input === 'youtube') return 'video'
  if (origin.input === 'url') return 'link'
  if (origin.input === 'topic') return 'topic'
  if (origin.input === 'text') return 'text'
  const media = mediaOf({ origin })
  if (media !== 'text') return media
  return origin.mime === 'application/pdf' || /\.pdf$/i.test(origin.name ?? '') ? 'pdf' : 'document'
}

/** A note that keeps a source: one of the new types, or an item of a library from before (`role: 'entrada'`), read as is. */
export function isSourceNote(file: Pick<FileMeta, 'role' | 'type'>): boolean {
  return file.role === 'entrada' || SOURCE_IDS.has(file.type)
}

/** The type the person sees: an old entrada is the type of its origin, without changing the item. */
export function noteTypeOf(file: Pick<FileMeta, 'role' | 'type' | 'origin'>): FileType {
  return file.role === 'entrada' ? sourceTypeOf(file.origin) : file.type
}

/** Nota de mídia: Vídeo or Áudio. */
export function isMediaNote(file: Pick<FileMeta, 'role' | 'type' | 'origin'>): boolean {
  const type = isSourceNote(file) ? noteTypeOf(file) : null
  return type === 'video' || type === 'audio'
}

/** The text of the note is the reading of its media (its transcription): a Leitura, or a media note (Vídeo, Áudio). */
export function readsAsTranscript(file: Pick<FileMeta, 'role' | 'type' | 'origin'>): boolean {
  return file.type === 'reading' || isMediaNote(file)
}

/** Gravação: a media note the app itself recorded (meeting, screen or microphone); a video the person sent is not one. */
export function isRecording(file: Pick<FileMeta, 'role' | 'type' | 'origin'>): boolean {
  return isMediaNote(file) && file.origin?.input === 'recording'
}

export const REVIEW_BELOW = 70
export const LOW_MASTERY_BELOW = 60
