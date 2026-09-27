export type UploadKind = 'pdf' | 'docx' | 'doc_legacy' | 'subtitle' | 'media' | 'text' | 'zip'

const MEDIA_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma', 'aiff',
  'mp4', 'webm', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'mpeg', 'mpg', 'm4v', '3gp',
])
const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'sbv', 'ass', 'ssa', 'sub'])

const TIMESTAMP = /^\s*[\d:.,]+\s*-->\s*[\d:.,]+.*$/
const INDEX = /^\s*\d+\s*$/
const TAG = /<\/?[a-zA-Z][^>]*>|\{[^}]*\}/g
const ASS_EVENT = /^Dialogue:\s*(?:[^,]*,){9}(.*)$/
const SUBTITLE_HINT = /-->|^Dialogue:/m
const ASS_HEADERS = ['Format:', 'Style:', 'ScriptType:', 'Title:', 'Collisions:', 'PlayResX', 'PlayResY']

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('latin1').decode(bytes)
  }
}

export function looksLikeText(bytes: Uint8Array): boolean {
  if (!bytes.length) return true
  const sample = bytes.slice(0, 4096)
  if (sample.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return true
  } catch {
    const printable = sample.filter(byte => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 160).length
    return printable / sample.length > 0.9
  }
}

export function detectKind(name: string, bytes: Uint8Array): UploadKind {
  const extension = extensionOf(name)
  if (extension === 'pdf' || decodeText(bytes.slice(0, 5)) === '%PDF-') return 'pdf'
  if (extension === 'docx') return 'docx'
  if (extension === 'doc') return 'doc_legacy'
  if (extension === 'zip') return 'zip'
  if (SUBTITLE_EXTENSIONS.has(extension)) return 'subtitle'
  if (MEDIA_EXTENSIONS.has(extension)) return 'media'
  if (!looksLikeText(bytes)) return 'media'
  if (SUBTITLE_HINT.test(decodeText(bytes.slice(0, 16000)).slice(0, 4000))) return 'subtitle'
  return 'text'
}

export function subtitleToText(content: string): string {
  const lines: string[] = []
  for (const rawLine of content.replaceAll('\r\n', '\n').split('\n')) {
    let line = rawLine.trim()
    if (!line || line.toUpperCase().startsWith('WEBVTT')) continue
    if (INDEX.test(line) || TIMESTAMP.test(line)) continue
    if (line.startsWith('[') && line.endsWith(']')) continue
    if (ASS_HEADERS.some(header => line.startsWith(header))) continue
    const dialogue = ASS_EVENT.exec(line)
    if (dialogue) line = dialogue[1].replaceAll('\\N', ' ')
    line = line.replace(TAG, '').trim()
    if (!line) continue
    if (lines.length && lines[lines.length - 1] === line) continue
    lines.push(line)
  }
  return lines.join(' ').trim()
}
