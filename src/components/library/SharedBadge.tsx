import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FolderMeta } from '@/types/domain'
import { FolderChooserDialog, type FolderSource } from '@/components/dialogs/FolderChooser'
import { Icon } from '@/components/ui/Icon'
import { useNow } from '@/hooks/use-now'
import { paths } from '@/lib/paths'
import { daysLeftText, hasSharedMedia, importSharedEntry, importSharedItem, type MediaPlace, readSharedAttempts } from '@/lib/share'
import { useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function SharedBadge({ label = false, button = false }: { label?: boolean; button?: boolean }) {
  const shared = useLibraryStore(state => state.sharedView)
  const leaveShared = useLibraryStore(state => state.leaveShared)
  const toast = useUiStore(state => state.toast)
  const open = useUiStore(state => state.open)
  const driveAvailable = useAccountStore(state => state.active().kind === 'google')
  const navigate = useNavigate()
  const [importing, setImporting] = useState(false)
  // the link of an entrada asks first for the folder, among the folders of who imports (FR-068)
  const [ownFolders, setOwnFolders] = useState<FolderMeta[] | null>(null)
  const now = useNow()
  if (!shared) return null
  const { item } = shared

  const importItem = async (place: MediaPlace | null, folderId: string | null) => {
    setImporting(true)
    try {
      leaveShared()
      delete document.documentElement.dataset.shared
      const library = useLibraryStore.getState()
      const media = place ? { place, repo: library.repo, track: useJobsStore.getState().trackTask } : undefined
      const actions = { createFolder: library.createFolder, createFile: library.createFile, updateSidecar: library.updateSidecar }
      if (item.kind === 'entrada') {
        const result = await importSharedEntry(item, readSharedAttempts(item.id), actions, { folderId, existing: library.files, media })
        toast('Importado para a sua biblioteca')
        navigate(paths.file(result.fileId))
        return
      }
      const result = await importSharedItem(item, readSharedAttempts(item.id), actions, media)
      toast('Importado para a sua biblioteca')
      navigate(result.fileId ? paths.file(result.fileId) : paths.folder(result.folderId))
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não consegui importar.')
      setImporting(false)
    }
  }

  const askMedia = (folderId: string | null) => {
    if (!hasSharedMedia(item)) return void importItem(null, folderId)
    if (!driveAvailable) return void importItem('browser', folderId)
    open({
      kind: 'confirm',
      title: 'Onde guardar a mídia?',
      text: 'A gravação vem junto com a nota. No Google Drive ela abre em qualquer aparelho seu; neste navegador, só aqui.',
      ok: 'No Google Drive',
      onConfirm: () => importItem('drive', folderId),
      alt: { label: 'Neste navegador', onConfirm: () => importItem('browser', folderId) },
    })
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

  const both = label === button
  const tag = (
    <span className="crs" aria-label="Compartilhado">
      compartilhado · só leitura · faltam {daysLeftText(item.expiresAt, now)}
    </span>
  )
  const action = (
    <button className="btn primary" disabled={importing} onClick={startImport}>
      <Icon name="download" />
      {importing ? 'Importando…' : 'Importar para a minha biblioteca'}
    </button>
  )
  if (!both)
    return label ? (
      tag
    ) : (
      <>
        {action}
        {chooser}
      </>
    )
  return (
    <span className="shared-badge">
      {tag}
      {action}
      {chooser}
    </span>
  )
}
