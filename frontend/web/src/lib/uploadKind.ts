const MEDIA_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma', 'aiff',
  'mp4', 'webm', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'mpeg', 'mpg', 'm4v', '3gp',
])

const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'sbv', 'ass', 'ssa', 'sub'])

export type UploadKind = 'media' | 'subtitle' | 'document'

export function extensionOf(name: string): string {
  const parts = (name ?? '').toLowerCase().split('.')
  return parts.length > 1 ? parts[parts.length - 1] : ''
}

export function uploadKind(file: File | null): UploadKind | null {
  if (!file) return null

  const extension = extensionOf(file.name)
  if (SUBTITLE_EXTENSIONS.has(extension)) return 'subtitle'
  if (MEDIA_EXTENSIONS.has(extension)) return 'media'
  if (!extension && (file.type.startsWith('audio/') || file.type.startsWith('video/'))) return 'media'
  return 'document'
}

export function needsTranscription(file: File | null): boolean {
  return uploadKind(file) === 'media'
}
