// "Baixar" a mídia de uma entrada (FR-076): a cópia deste navegador, a do Drive, o endereço de um serviço ou o link compartilhado.
import { useState } from 'react'

import { Icon } from '@/components/ui/Icon'
import { blocking } from '@/lib/blocking'
import { sharedMediaFailure } from '@/lib/share'
import { mediaToDownload } from '@/lib/storage/source-storage'
import { useUiStore } from '@/stores/ui'
import { downloadBlob } from '@/utils/download'

interface DownloadMediaProps {
  fileId: string
  /** The name of the original file: the one the download gets. */
  name: string
  /** The media of a shared link: whoever opens it gets it from the link itself, never from the owner's storage. */
  url?: string
  label?: string
  className?: string
}

/** The body of a download, telling how many bytes came of how many (when the answer says its size). */
async function readCounting(response: Response, tell: (doneBytes: number, totalBytes: number) => void): Promise<Blob> {
  const total = Number(response.headers.get('Content-Length')) || 0
  if (!response.body || !total) return response.blob()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let done = 0
  for (;;) {
    const { value, done: finished } = await reader.read()
    if (finished) break
    chunks.push(value)
    done += value.byteLength
    tell(done, total)
  }
  return new Blob(chunks as BlobPart[], { type: response.headers.get('Content-Type') ?? '' })
}

export function DownloadMedia({ fileId, name, url, label = 'Baixar', className = 'btn' }: DownloadMediaProps) {
  const toast = useUiStore(state => state.toast)
  const [busy, setBusy] = useState(false)
  const download = async () => {
    // a long media takes a while to read: the button answers at once
    setBusy(true)
    try {
      // spec 007 (FR-060): the window of choice F, with how much came, when it should end and that it did not freeze
      await blocking('Baixando a mídia…', async blocker => {
        if (url) {
          // the reason is what the Worker answered: expired, not finished going up, or no connection at all
          const response = await fetch(url).catch(() => null)
          if (!response?.ok) throw new Error(sharedMediaFailure(response?.status ?? null))
          downloadBlob(await readCounting(response, (doneBytes, totalBytes) => blocker.progress({ phase: name, doneBytes, totalBytes })), name)
        } else {
          blocker.progress({ phase: name })
          const source = await mediaToDownload(fileId)
          if (typeof source === 'string') window.open(source, '_blank', 'noopener')
          else downloadBlob(source, name)
        }
      })
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não deu para baixar.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className={className} disabled={busy} onClick={() => void download()}>
      <Icon name="download" />
      {busy ? 'Baixando…' : label}
    </button>
  )
}
