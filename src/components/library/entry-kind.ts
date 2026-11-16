import type { FileMeta } from '@/types/domain'
import type { IconName } from '@/components/ui/Icon'
import { mediaOf } from '@/lib/file-types'

/** What the entrada is, as the person calls it: Vídeo, Áudio, PDF, Link, Texto colado, Tema… */
export function entryKind(file: Pick<FileMeta, 'origin'>): { label: string; icon: IconName } {
  const media = mediaOf(file)
  if (media === 'video') return { label: 'Vídeo', icon: 'monitor' }
  if (media === 'audio') return { label: 'Áudio', icon: 'mic' }
  const origin = file.origin
  if (origin?.input === 'url') return { label: 'Link', icon: 'link' }
  if (origin?.input === 'youtube') return { label: 'YouTube', icon: 'monitor' }
  if (origin?.input === 'text') return { label: 'Texto colado', icon: 'text' }
  if (origin?.input === 'topic') return { label: 'Tema', icon: 'search' }
  if (origin?.mime === 'application/pdf' || /\.pdf$/i.test(origin?.name ?? '')) return { label: 'PDF', icon: 'file' }
  return { label: 'Arquivo', icon: 'file' }
}
