// "Baixar" a mídia de uma entrada (FR-076): a cópia deste navegador, a do Drive, o endereço de um serviço ou o link compartilhado.
import { useState } from 'react'

import { Icon } from '@/components/ui/Icon'
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

export function DownloadMedia({ fileId, name, url, label = 'Baixar', className = 'btn' }: DownloadMediaProps) {
  const toast = useUiStore(state => state.toast)
  const [busy, setBusy] = useState(false)
  const download = async () => {
    // a long media takes a while to read: the button answers at once
    setBusy(true)
    try {
      if (url) {
        // the reason is what the Worker answered: expired, not finished going up, or no connection at all
        const response = await fetch(url).catch(() => null)
        if (!response?.ok) throw new Error(sharedMediaFailure(response?.status ?? null))
        downloadBlob(await response.blob(), name)
      } else {
        const source = await mediaToDownload(fileId)
        if (typeof source === 'string') window.open(source, '_blank', 'noopener')
        else downloadBlob(source, name)
      }
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
