import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { FolderChooserDialog } from '@/components/dialogs/FolderChooser'
import { Dialog } from '@/components/ui/Dialog'
import { usePathName } from '@/hooks/use-library-view'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'

export function ConfirmDialog({ overlay }: { overlay: Extract<Overlay, { kind: 'confirm' }> }) {
  const close = useUiStore(state => state.close)
  const [busy, setBusy] = useState(false)
  const run = (action: () => void | Promise<void>) => async () => {
    setBusy(true)
    close()
    await action()
  }
  return (
    <Dialog
      title={overlay.title}
      size="narrow"
      role="alertdialog"
      onClose={close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          {overlay.alt && (
            <button className="btn" disabled={busy} onClick={run(overlay.alt.onConfirm)}>
              {overlay.alt.label}
            </button>
          )}
          <button className={`btn ${overlay.danger ? 'danger' : 'primary'}`} disabled={busy} onClick={run(overlay.onConfirm)}>
            {overlay.ok}
          </button>
        </>
      }
    >
      <div className="db">
        <span className="muted">{overlay.text}</span>
      </div>
    </Dialog>
  )
}

export function NewFolderDialog({ parentId }: { parentId: string | null }) {
  const close = useUiStore(state => state.close)
  const toast = useUiStore(state => state.toast)
  const createFolder = useLibraryStore(state => state.createFolder)
  const pathName = usePathName()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const create = async () => {
    if (!name.trim()) return
    const folder = await createFolder({ name: name.trim(), parentId })
    close()
    toast(`Pasta "${folder.name}" criada`)
    navigate(paths.folder(folder.id))
  }
  return (
    <Dialog
      title={`Nova pasta${parentId ? ` em ${pathName(parentId)}` : ''}`}
      size="narrow"
      onClose={close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
            Criar pasta
          </button>
        </>
      }
    >
      <div className="db">
        <div className="field">
          <label htmlFor="nf-name">Nome</label>
          <input className="input" id="nf-name" autoFocus placeholder="Ex.: Direito tributário" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => event.key === 'Enter' && void create()} />
        </div>
      </div>
    </Dialog>
  )
}

export function RenameDialog({ target, id }: { target: 'file' | 'folder'; id: string }) {
  const close = useUiStore(state => state.close)
  const library = useLibraryStore()
  const current = target === 'file' ? library.files.find(file => file.id === id) : library.folders.find(folder => folder.id === id)
  const [name, setName] = useState(current?.name ?? '')
  const [description, setDescription] = useState(current?.description ?? '')
  const save = async () => {
    if (!name.trim()) return
    if (target === 'file') await library.updateFile(id, { name: name.trim(), description })
    else {
      await library.updateFolder(id, { name: name.trim(), description })
    }
    close()
  }
  return (
    <Dialog
      title={target === 'file' ? 'Renomear arquivo' : 'Renomear pasta'}
      size="narrow"
      onClose={close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>
            Salvar
          </button>
        </>
      }
    >
      <div className="db">
        <div className="field">
          <label htmlFor="rn-name">Nome</label>
          <input className="input" id="rn-name" autoFocus value={name} onChange={event => setName(event.target.value)} onKeyDown={event => event.key === 'Enter' && void save()} />
        </div>
        <div className="field">
          <label htmlFor="rn-desc">Descrição</label>
          <textarea className="input" id="rn-desc" value={description} onChange={event => setDescription(event.target.value)} />
        </div>
      </div>
    </Dialog>
  )
}

export function MoveDialog({ fileIds, folderIds }: { fileIds: string[]; folderIds: string[] }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const count = fileIds.length + folderIds.length
  const move = async (target: string | null) => {
    await library.moveFiles(fileIds, target)
    for (const id of folderIds) await library.updateFolder(id, { parentId: target })
    ui.close()
    ui.clearSelection()
    ui.toast(`Movido para ${library.folders.find(folder => folder.id === target)?.name ?? 'Biblioteca'}`)
  }
  return <FolderChooserDialog value={null} exclude={folderIds} title={`Mover ${count} ${count === 1 ? 'item' : 'itens'}`} confirmLabel="Mover" onConfirm={id => void move(id)} onClose={ui.close} />
}
