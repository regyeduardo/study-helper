import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta } from '@/types/domain'
import { SaveToDrive, useOnlyHere } from '@/components/library/SaveToDrive'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { mediaOf } from '@/lib/file-types'
import { transcriptFileName, transcriptOf } from '@/lib/generation/transcript'
import { type LocalMedia, listLocalMedia, readLocalMedia, removeLocalMedia } from '@/lib/recording/media-library'
import { paths } from '@/lib/paths'
import { keepFromDrive } from '@/lib/storage/source-storage'
import { useLibraryStore } from '@/stores/library'
import { useRecorderStore } from '@/stores/recorder'
import { useUiStore } from '@/stores/ui'
import { downloadBlob } from '@/utils/download'
import { duration, formatBytes } from '@/utils/format'

type Place = 'aqui' | 'drive' | 'app' | 'dois'

// T136: where a media is. "Nos dois" is the account (App or Google Drive) and this computer.
const PLACES: Record<Place, string> = { aqui: 'Só neste computador', drive: 'No Google Drive', app: 'No App', dois: 'Nos dois' }

/** Kept in the account: the Google Drive, or the App (the same "drive" storage, with an `app:` address, spec 003). */
const inDrive = (file: FileMeta) => file.origin?.storage === 'drive' && Boolean(file.origin.storedFileId) && !file.origin.removedAt
const cloudOf = (file: FileMeta): 'app' | 'drive' => (file.origin?.storedFileId?.startsWith('app:') ? 'app' : 'drive')

function PlaceTag({ place }: { place: Place }) {
  return (
    <span className="media-place" data-place={place}>
      {PLACES[place]}
    </span>
  )
}

/** The item a media turned into: it opens the item's page and closes Mídias. */
function ItemLink({ file }: { file: FileMeta }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  return (
    <a
      href={paths.file(file.id)}
      onClick={event => {
        event.preventDefault()
        ui.close()
        navigate(paths.file(file.id))
      }}
    >
      {file.name}
    </a>
  )
}

function MediaItem({ item, onRemoved }: { item: LocalMedia; onRemoved(): void }) {
  const files = useLibraryStore(state => state.files)
  const repo = useLibraryStore(state => state.repo)
  const reopen = useRecorderStore(state => state.reopen)
  const ui = useUiStore()
  const [url, setUrl] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<{ text: string; name: string } | null>(null)
  const [missing, setMissing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  const notes = item.fileIds.map(id => files.find(file => file.id === id && !file.deletedAt)).filter(file => file !== undefined)
  const onlyHere = useOnlyHere()
  const toSave = notes.find(onlyHere)
  // a copy still to save means "only here", even when another item of the same media is already in the Drive
  const place: Place = !toSave && notes.some(inDrive) ? 'dois' : 'aqui'
  const video = item.mime.startsWith('video')
  // T138: the button is there only when there is something to download; the text is read from the library when the notes change
  const seen = notes.map(note => `${note.id}@${note.updated.at}`).join()
  useEffect(() => {
    let alive = true
    setTranscript(null)
    void (async () => {
      for (const note of repo ? notes : []) {
        // a note that cannot be read just has no transcription to offer
        const text = await transcriptOf(note, repo!).catch(() => null)
        if (text) return alive && setTranscript({ text, name: note.name })
      }
    })()
    return () => {
      alive = false
    }
  }, [seen, repo])
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
  const downloadTranscript = () => {
    if (transcript) downloadBlob(new Blob([transcript.text], { type: 'text/plain;charset=utf-8' }), transcriptFileName(transcript.name))
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
                <ItemLink file={note} />
              </span>
            ))}
          </>
        ) : (
          'Ainda não virou nota.'
        )}
      </span>
      <div className="media-where">
        <PlaceTag place={place} />
        {place === 'aqui' && (toSave ? <SaveToDrive fileId={toSave.id} bare /> : !notes.length && <SaveToDrive media={item} bare />)}
      </div>
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
        {transcript && (
          <button className="btn" onClick={downloadTranscript}>
            <Icon name="download" />
            Baixar a transcrição
          </button>
        )}
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

/** T136: what is only in the Drive. Keeping it here is the way back to "Nos dois". */
function DriveOnlyItem({ file }: { file: FileMeta }) {
  const toast = useUiStore(state => state.toast)
  const [busy, setBusy] = useState(false)
  const origin = file.origin!
  const video = mediaOf(file) === 'video'
  const keep = async () => {
    setBusy(true)
    try {
      await keepFromDrive(file.id)
      toast('Guardado neste computador.')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não deu para guardar neste computador.')
    } finally {
      // on success the row leaves this list; if the list did not change, the button must not stay stuck
      setBusy(false)
    }
  }
  return (
    <li className="media-item">
      <div className="mh">
        <Icon name={video ? 'monitor' : 'mic'} />
        <b>{origin.name}</b>
      </div>
      <span className="muted">{[new Date(file.created.at).toLocaleString('pt-BR'), origin.durationSeconds ? duration(origin.durationSeconds) : '', origin.sizeBytes ? formatBytes(origin.sizeBytes) : ''].filter(Boolean).join(' · ')}</span>
      <span className="faint">
        Na biblioteca: <ItemLink file={file} />
      </span>
      <div className="media-where">
        <PlaceTag place={cloudOf(file)} />
        <button className="btn" disabled={busy} onClick={() => void keep()}>
          <Icon name="download" />
          {busy ? 'Guardando…' : 'Guardar neste computador'}
        </button>
      </div>
    </li>
  )
}

const CLOUD_SECTIONS = [
  { cloud: 'app', title: 'Só no App', text: 'Estas mídias estão no App, na sua conta do Estudo, e ainda não estão neste computador.' },
  { cloud: 'drive', title: 'Só no Google Drive', text: 'Estas mídias estão no seu Drive e ainda não estão neste computador.' },
] as const

export function MediaDialog() {
  const ui = useUiStore()
  const [items, setItems] = useState<LocalMedia[] | null>(null)
  const files = useLibraryStore(state => state.files)
  const localMedia = useLibraryStore(state => state.localMedia)
  const driveLibrary = useLibraryStore(state => state.repo?.kind === 'drive')
  const refresh = () => void listLocalMedia().then(setItems)
  // what is kept or linked while the window is open changes the list
  useEffect(refresh, [localMedia])
  // only in the Drive: media of the library that has an address there and no copy here; the Local profile cannot reach the Drive
  const onlyInDrive = useMemo(
    () =>
      driveLibrary
        ? files.filter(file => !file.deletedAt && mediaOf(file) !== 'text' && inDrive(file) && !localMedia.some(item => item.fileIds.includes(file.id))).sort((a, b) => b.created.at.localeCompare(a.created.at))
        : [],
    [files, localMedia, driveLibrary],
  )
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
          !onlyInDrive.length && <span className="muted">Nenhuma gravação guardada ainda.</span>
        )}
        {items !== null &&
          CLOUD_SECTIONS.map(section => {
            const list = onlyInDrive.filter(file => cloudOf(file) === section.cloud)
            if (!list.length) return null
            return (
              <Fragment key={section.cloud}>
                <b className="media-section">{section.title}</b>
                <span className="faint" style={{ fontSize: 12 }}>
                  {section.text}
                </span>
                <ul className="media-list">
                  {list.map(file => (
                    <DriveOnlyItem key={file.id} file={file} />
                  ))}
                </ul>
              </Fragment>
            )
          })}
      </div>
    </Dialog>
  )
}
