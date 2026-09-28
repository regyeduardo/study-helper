import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { type LocalMedia, listLocalMedia, readLocalMedia, removeLocalMedia } from '@/lib/recording/media-library'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { useRecorderStore } from '@/stores/recorder'
import { useUiStore } from '@/stores/ui'
import { duration, formatBytes } from '@/utils/format'

function MediaItem({ item, onRemoved }: { item: LocalMedia; onRemoved(): void }) {
  const files = useLibraryStore(state => state.files)
  const reopen = useRecorderStore(state => state.reopen)
  const ui = useUiStore()
  const navigate = useNavigate()
  const [url, setUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  const notes = item.fileIds.map(id => files.find(file => file.id === id && !file.deletedAt)).filter(file => file !== undefined)
  const video = item.mime.startsWith('video')
  const load = async (): Promise<File | null> => {
    try {
      return await readLocalMedia(item)
    } catch {
      setMissing(true)
      return null
    }
  }
  const play = async () => {
    const file = await load()
    if (file) setUrl(URL.createObjectURL(file))
  }
  const download = async () => {
    const file = await load()
    if (!file) return
    const link = document.createElement('a')
    link.href = URL.createObjectURL(file)
    link.download = item.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 10000)
  }
  const generate = async () => {
    const file = await load()
    if (!file) return
    ui.close()
    reopen({ file, mime: item.mime, durationSeconds: item.durationSeconds, storedName: item.storedName })
  }
  const remove = async () => {
    await removeLocalMedia(item.storedName)
    onRemoved()
  }
  return (
    <li className="media-item">
      <div className="mh">
        <Icon name={video ? 'monitor' : 'mic'} />
        <b>{item.name}</b>
      </div>
      <span className="muted">
        {new Date(item.createdAt).toLocaleString('pt-BR')} · {duration(item.durationSeconds)} · {formatBytes(item.size)}
      </span>
      <span className="faint">
        {notes.length ? (
          <>
            Virou:{' '}
            {notes.map((note, index) => (
              <span key={note.id}>
                {index > 0 && ', '}
                <a
                  href={paths.file(note.id)}
                  onClick={event => {
                    event.preventDefault()
                    ui.close()
                    navigate(paths.file(note.id))
                  }}
                >
                  {note.name}
                </a>
              </span>
            ))}
          </>
        ) : (
          'Ainda não virou nota.'
        )}
      </span>
      {missing && <span className="lim">O arquivo não está mais neste navegador.</span>}
      {url && (video ? <video src={url} controls playsInline style={{ width: '100%', borderRadius: 8 }} /> : <audio src={url} controls style={{ width: '100%' }} />)}
      <div className="acts">
        {!url && (
          <button className="btn" onClick={() => void play()}>
            <Icon name="rec" />
            Ouvir
          </button>
        )}
        <button className="btn" onClick={() => void download()}>
          <Icon name="download" />
          Baixar
        </button>
        <button className="btn" onClick={() => void generate()}>
          <Icon name="bulb" />
          {notes.length ? 'Gerar de novo' : 'Gerar'}
        </button>
        {confirming ? (
          <>
            <button className="btn danger" onClick={() => void remove()}>
              Apagar de vez
            </button>
            <button className="btn quiet" onClick={() => setConfirming(false)}>
              Voltar
            </button>
          </>
        ) : (
          <button className="btn quiet" onClick={() => setConfirming(true)}>
            <Icon name="trash" />
            Apagar
          </button>
        )}
      </div>
    </li>
  )
}

export function MediaDialog() {
  const ui = useUiStore()
  const [items, setItems] = useState<LocalMedia[] | null>(null)
  const refresh = () => void listLocalMedia().then(setItems)
  useEffect(refresh, [])
  return (
    <Dialog title="Mídias neste computador" onClose={ui.close}>
      <div className="db">
        <span className="faint" style={{ fontSize: 12 }}>
          As gravações ficam no armazenamento deste navegador, neste computador, até você apagar. Limpar os dados do site no navegador também apaga: baixe o que quiser guardar fora.
        </span>
        {items === null ? (
          <span className="muted">Carregando…</span>
        ) : items.length ? (
          <ul className="media-list">
            {items.map(item => (
              <MediaItem key={item.storedName} item={item} onRemoved={refresh} />
            ))}
          </ul>
        ) : (
          <span className="muted">Nenhuma gravação guardada ainda.</span>
        )}
      </div>
    </Dialog>
  )
}
