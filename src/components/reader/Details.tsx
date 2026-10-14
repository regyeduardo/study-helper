import { useState } from 'react'

import type { FileMeta } from '@/types/domain'
import { mediaOf } from '@/lib/file-types'
import { listLocalMedia, removeLocalMedia } from '@/lib/recording/media-library'
import { removeStoredSource } from '@/lib/storage/source-storage'
import { transcriptText } from '@/lib/transcription/export'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

type PartId = 'media' | 'transcript' | 'generated'

interface Part {
  id: PartId
  label: string
  bytes: number
  where: string
}

const CONFIRM: Record<PartId, string> = {
  media: 'Apagar só a mídia? A transcrição e o resto da nota continuam, mas não dá mais para ouvir nem refazer a transcrição.',
  transcript: 'Apagar só a transcrição? A mídia continua e dá para transcrever de novo.',
  generated: 'Apagar só o texto gerado? A transcrição e a mídia continuam e dá para gerar de novo.',
}

export function NoteParts({ meta }: { meta: FileMeta }) {
  const library = useLibraryStore()
  const toast = useUiStore(state => state.toast)
  const [confirming, setConfirming] = useState<PartId | null>(null)
  const opened = library.opened[meta.id]
  const local = library.localMedia.find(item => item.fileIds.includes(meta.id))
  const origin = meta.origin
  const kept = Boolean(origin && (origin.storedFileId || origin.storedUrl) && !origin.removedAt)
  const recording = opened?.sidecar.recording
  const transcript = recording?.blocks.length ? transcriptText(recording) : ''
  const parts: Part[] = []
  if (mediaOf(meta) !== 'text' && (local || kept)) parts.push({ id: 'media', label: 'Mídia', bytes: local?.size ?? origin?.sizeBytes ?? 0, where: [local && 'este computador', kept && origin?.storage === 'drive' ? 'Google Drive' : kept ? 'nuvem' : ''].filter(Boolean).join(' e ') })
  if (transcript) parts.push({ id: 'transcript', label: 'Transcrição', bytes: new Blob([transcript]).size, where: 'na nota' })
  if (transcript && (meta.type === 'meeting' || meta.type === 'class') && opened?.content) parts.push({ id: 'generated', label: meta.type === 'meeting' ? 'Ata' : 'Aula', bytes: new Blob([opened.content]).size, where: 'na nota' })
  if (!parts.length) return null

  const remove = async (part: PartId) => {
    if (part === 'media') {
      if (local) {
        await removeLocalMedia(local.storedName)
        useLibraryStore.setState({ localMedia: await listLocalMedia() })
      }
      if (kept && origin && library.repo) await library.updateFile(meta.id, { origin: await removeStoredSource(origin, library.repo) })
      else if (origin) await library.updateFile(meta.id, { origin: { ...origin, removedAt: new Date().toISOString() } })
    }
    if (part === 'transcript') {
      await library.updateSidecar(meta.id, sidecar => ({ ...sidecar, recording: undefined, transcript: undefined }))
      if (meta.type === 'reading') await library.saveContent(meta.id, '')
    }
    if (part === 'generated') {
      await library.saveContent(meta.id, transcript.trim())
      await library.updateFile(meta.id, { type: 'reading' })
    }
    setConfirming(null)
    toast('Parte apagada; a nota continua')
  }

  return (
    <div className="sec">
      <h4>Partes da nota</h4>
      <ul className="parts" aria-label="Partes da nota">
        {parts.map(part => (
          <li key={part.id}>
            <span>
              <b>{part.label}</b>
              <span className="faint">
                {formatBytes(part.bytes)} · {part.where}
              </span>
            </span>
            <button className="btn quiet danger" onClick={() => setConfirming(part.id)}>
              Apagar só {part.id === 'media' ? 'a mídia' : part.id === 'transcript' ? 'a transcrição' : 'o texto gerado'}
            </button>
            {confirming === part.id && (
              <div className="inline-confirm">
                {CONFIRM[part.id]}
                <button className="btn danger" onClick={() => void remove(part.id)}>
                  Apagar
                </button>
                <button className="btn quiet" onClick={() => setConfirming(null)}>
                  Manter
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
