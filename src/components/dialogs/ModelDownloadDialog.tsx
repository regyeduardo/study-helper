import { useEffect, useState } from 'react'

import { Dialog } from '@/components/ui/Dialog'
import { type ModelDownload, setModelDownloadAsker } from '@/lib/transcription/consent'

interface Pending {
  downloads: ModelDownload[]
  answer(accepted: boolean): void
}

export function ModelDownloadDialog() {
  const [pending, setPending] = useState<Pending | null>(null)
  useEffect(() => {
    setModelDownloadAsker(downloads => new Promise<boolean>(resolve => setPending({ downloads, answer: resolve })))
    return () => setModelDownloadAsker(null)
  }, [])
  if (!pending) return null
  const answer = (accepted: boolean) => {
    pending.answer(accepted)
    setPending(null)
  }
  const total = pending.downloads.reduce((sum, download) => sum + download.megabytes, 0)
  return (
    <Dialog
      title="Baixar o modelo de transcrição?"
      size="narrow"
      onClose={() => answer(false)}
      footer={
        <>
          <button className="btn quiet" onClick={() => answer(false)}>
            Agora não
          </button>
          <button className="btn primary" onClick={() => answer(true)}>
            Baixar ~{total} MB
          </button>
        </>
      }
    >
      <div className="db">
        <span>Para transcrever neste navegador, o app precisa baixar uma vez:</span>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {pending.downloads.map(download => (
            <li key={download.id}>
              {download.name}: ~{download.megabytes} MB
            </li>
          ))}
        </ul>
        <span className="faint">Fica guardado neste navegador para as próximas vezes. Dá para ver e apagar em Configurações › Outros.</span>
      </div>
    </Dialog>
  )
}
