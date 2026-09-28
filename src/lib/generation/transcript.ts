import type { FileMeta, SourceMeta } from '@/types/domain'
import type { Repository } from '@/lib/storage/repository'

function cameFromMedia(origin: SourceMeta | null): boolean {
  return Boolean(origin && (origin.input === 'recording' || origin.mime?.startsWith('audio/') || origin.mime?.startsWith('video/')))
}

export function transcriptFileName(name: string): string {
  return `${name.replace(/[\/:*?"<>|]+/g, '-').trim() || 'nota'} - transcrição.txt`
}

export async function transcriptOf(meta: FileMeta, repo: Repository): Promise<string | null> {
  const sidecar = await repo.readSidecar(meta.id).catch(() => null)
  if (sidecar?.transcript) return sidecar.transcript
  if (meta.type === 'reading' && cameFromMedia(meta.origin)) {
    const content = await repo.readContent(meta.id).catch(() => '')
    return content.trim() || null
  }
  return null
}
