import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FolderMeta } from '@/types/domain'
import { FolderChooserDialog, type FolderSource } from '@/components/dialogs/FolderChooser'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { useNow } from '@/hooks/use-now'
import { blocking } from '@/lib/blocking'
import { paths } from '@/lib/paths'
import { daysLeftText, importSharedEntry, importSharedItem, linkMediaState, prefetchEntryMedia, type MediaPlace, readSharedAttempts, sharedMediaFailure } from '@/lib/share'
import { useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

/** What the recipient is asked about the media: where to keep it (it is in the link), or whether to import without it (it is still going up). */
type MediaChoice = { kind: 'place'; folderId: string | null; size: number } | { kind: 'pending'; folderId: string | null }

function MediaChoiceDialog({ choice, drive, onPick, onClose }: { choice: MediaChoice; drive: boolean; onPick(place: MediaPlace | null): void; onClose(): void }) {
  if (choice.kind === 'pending') {
    return (
      <Dialog
        title="A mídia ainda está subindo"
        size="narrow"
        role="alertdialog"
        onClose={onClose}
        footer={
          <>
            <button className="btn quiet" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn primary" onClick={() => onPick(null)}>
              Importar só o texto
            </button>
          </>
        }
      >
        <div className="db">
          <span className="muted">Quem compartilhou ainda está enviando a mídia (ou o envio não terminou). Dá para importar só o texto agora. Para ter a mídia, espere ela terminar de subir e importe de novo.</span>
        </div>
      </Dialog>
    )
  }
  const size = choice.size ? ` (${formatBytes(choice.size)})` : ''
  return (
    <Dialog
      title={drive ? 'Onde guardar a mídia?' : 'Baixar a mídia?'}
      size="narrow"
      role="alertdialog"
      onClose={onClose}
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn" onClick={() => onPick(null)}>
            Só o texto
          </button>
          <button className={`btn ${drive ? '' : 'primary'}`} onClick={() => onPick('browser')}>
            Neste navegador
          </button>
          {drive && (
            <button className="btn primary" onClick={() => onPick('drive')}>
              No Google Drive
            </button>
          )}
        </>
      }
    >
      <div className="db">
        <span className="muted">
          {drive
            ? `A gravação${size} vem junto com a nota. No Google Drive ela abre em qualquer aparelho seu; neste navegador, só aqui. Dá para importar só o texto.`
            : `A gravação${size} vem junto com a nota e fica guardada só neste navegador. Dá para importar só o texto.`}
        </span>
      </div>
    </Dialog>
  )
}

export function SharedBadge({ label = false, button = false }: { label?: boolean; button?: boolean }) {
  const shared = useLibraryStore(state => state.sharedView)
  const leaveShared = useLibraryStore(state => state.leaveShared)
  const toast = useUiStore(state => state.toast)
  const open = useUiStore(state => state.open)
  const driveAvailable = useAccountStore(state => state.active().kind === 'google')
  const navigate = useNavigate()
  const [importing, setImporting] = useState(false)
  // the media of an entrada downloads while the link is still open, with its progress on the button
  const [downloading, setDownloading] = useState<number | null>(null)
  // the link of an entrada asks first for the folder, among the folders of who imports (FR-068)
  const [ownFolders, setOwnFolders] = useState<FolderMeta[] | null>(null)
  const [choice, setChoice] = useState<MediaChoice | null>(null)
  const now = useNow()
  if (!shared) return null
  const { item } = shared

  /** `skipped`: why the media was not even tried (it is past its days), told after the import. */
  const importItem = async (place: MediaPlace | null, folderId: string | null, skipped?: string) => {
    setImporting(true)
    // from the click until the last note is copied (several writes each) the app is held in the window, with the note in hand
    try {
      await blocking('Importando para a sua biblioteca…', async blocker => {
        const state = linkMediaState(item)
        const size = state.kind === 'ready' ? state.media.size : 0
        const downloading = (fraction: number) => {
          setDownloading(fraction)
          blocker.progress(size ? { phase: 'Baixando a mídia', doneBytes: Math.round(fraction * size), totalBytes: size } : { phase: `Baixando a mídia: ${Math.round(fraction * 100)}%` })
        }
        if (place && item.kind === 'entrada') blocker.progress({ phase: 'Baixando a mídia' })
        const fetched = place && item.kind === 'entrada' ? await prefetchEntryMedia(item, downloading) : {}
        setDownloading(null)
        leaveShared()
        delete document.documentElement.dataset.shared
        const library = useLibraryStore.getState()
        // the line of each media stays in Tarefas; the window says its step too
        const track = (title: string) => {
          const task = useJobsStore.getState().trackTask(title)
          blocker.progress({ phase: 'Guardando a mídia' })
          return { ...task, update: (message: string, fraction: number | null) => (task.update(message, fraction), blocker.progress({ phase: message })) }
        }
        const media = place ? { place, repo: library.repo, track, ...fetched } : undefined
        let copied = 0
        const createFile: typeof library.createFile = async (fields, content) => {
          blocker.progress({ phase: 'Copiando as notas', done: copied, total: item.files.length, current: fields.name, doneBytes: undefined, totalBytes: undefined })
          const meta = await library.createFile(fields, content)
          blocker.progress({ done: ++copied })
          return meta
        }
        const actions = { createFolder: library.createFolder, createFile, updateSidecar: library.updateSidecar }
        if (item.kind === 'entrada') {
          const result = await importSharedEntry(item, readSharedAttempts(item.id), actions, { folderId, existing: library.files, media })
          const why = result.mediaFailed ?? skipped
          toast(why ? `Importado, mas a mídia não veio: ${why}` : 'Importado para a sua biblioteca')
          navigate(paths.file(result.fileId))
          return
        }
        const result = await importSharedItem(item, readSharedAttempts(item.id), actions, media)
        const why = result.mediaFailed ?? skipped
        toast(why ? `Importado, mas a mídia não veio: ${why}` : 'Importado para a sua biblioteca')
        navigate(result.fileId ? paths.file(result.fileId) : paths.folder(result.folderId))
      })
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não consegui importar.')
      setDownloading(null)
      setImporting(false)
    }
  }

  const askMedia = (folderId: string | null) => {
    const state = linkMediaState(item)
    if (state.kind === 'expired') return void importItem(null, folderId, sharedMediaFailure(410))
    if (state.kind === 'pending') return setChoice({ kind: 'pending', folderId })
    if (state.kind === 'ready') return setChoice({ kind: 'place', folderId, size: state.media.size })
    void importItem(null, folderId)
  }

  const pick = (place: MediaPlace | null) => {
    const folderId = choice?.folderId ?? null
    setChoice(null)
    void importItem(place, folderId)
  }

  const startImport = () => {
    if (item.kind === 'entrada') return setOwnFolders(useLibraryStore.getState().ownFolders())
    askMedia(null)
  }

  const source: FolderSource | null = ownFolders && {
    folders: ownFolders,
    createFolder: async fields => {
      const folder = await useLibraryStore.getState().createOwnFolder(fields)
      setOwnFolders(useLibraryStore.getState().ownFolders())
      return folder
    },
  }
  const chooser = source && (
    <FolderChooserDialog
      value={null}
      source={source}
      title="Importar para a minha biblioteca"
      confirmLabel="Importar aqui"
      leaf={item.title}
      onClose={() => setOwnFolders(null)}
      onConfirm={folderId => {
        setOwnFolders(null)
        askMedia(folderId)
      }}
    />
  )

  const choose = choice && <MediaChoiceDialog choice={choice} drive={driveAvailable} onPick={pick} onClose={() => setChoice(null)} />
  const both = label === button
  const tag = (
    <span className="crs" aria-label="Compartilhado">
      compartilhado · só leitura · faltam {daysLeftText(item.expiresAt, now)}
    </span>
  )
  const action = (
    <button className="btn primary" disabled={importing} onClick={startImport}>
      <Icon name="download" />
      {downloading !== null ? `Baixando a mídia… ${Math.round(downloading * 100)}%` : importing ? 'Importando…' : 'Importar para a minha biblioteca'}
    </button>
  )
  if (!both)
    return label ? (
      tag
    ) : (
      <>
        {action}
        {chooser}
        {choose}
      </>
    )
  return (
    <span className="shared-badge">
      {tag}
      {action}
      {chooser}
      {choose}
    </span>
  )
}
