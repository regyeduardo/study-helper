import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { FolderChooserDialog } from '@/components/dialogs/FolderChooser'
import { moveItems } from '@/components/library/use-file-actions'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { useBusy } from '@/hooks/use-busy'
import { usePathName } from '@/hooks/use-library-view'
import { blocking } from '@/lib/blocking'
import { descendantsOf, isNote } from '@/lib/family'
import { paths } from '@/lib/paths'
import { itemsOf } from '@/lib/working'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'
import { isSourceNote } from '@/lib/file-types'

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

/** The main button of a window that waits for a write: the spinner and the new text show at once, and it is off until the write ends. */
export function BusyButton({ busy, label, busyLabel, disabled = false, onClick }: { busy: boolean; label: string; busyLabel: string; disabled?: boolean; onClick(): void }) {
  return (
    <button className="btn primary" disabled={disabled || busy} onClick={onClick}>
      {busy && <Icon name="sync" className="spinning" />}
      {busy ? busyLabel : label}
    </button>
  )
}

export function FailureBanner({ text }: { text: string }) {
  return (
    <div className="banner" role="alert">
      <Icon name="warn" />
      <span>{text}</span>
    </div>
  )
}

export function NewFolderDialog({ parentId }: { parentId: string | null }) {
  const close = useUiStore(state => state.close)
  const toast = useUiStore(state => state.toast)
  const createFolder = useLibraryStore(state => state.createFolder)
  const pathName = usePathName()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    if (!name.trim()) return
    setError(null)
    // a folder is a write to the Drive: the button answers at once and does not make two
    const folder = await run(async () => {
      try {
        // a name already there is refused, saying so (FR-021)
        return await createFolder({ name: name.trim(), parentId }, 'block')
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Não deu para criar a pasta.')
        return undefined
      }
    })
    if (!folder) return
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
          <BusyButton busy={busy} label="Criar pasta" busyLabel="Criando…" disabled={!name.trim()} onClick={() => void create()} />
        </>
      }
    >
      <div className="db">
        <div className="field">
          <label htmlFor="nf-name">Nome</label>
          <input className="input" id="nf-name" autoFocus placeholder="Ex.: Direito tributário" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => event.key === 'Enter' && void create()} />
        </div>
        {error && <FailureBanner text={error} />}
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
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!name.trim()) return
    setError(null)
    // the new name shows in the list at once; the window waits for the write, saying so, and saves once
    const saved = await run(async () => {
      try {
        // a name already there is refused, saying so (FR-021)
        if (target === 'file') await library.updateFile(id, { name: name.trim(), description }, 'block')
        else await library.updateFolder(id, { name: name.trim(), description }, 'block')
        return true
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Não deu para salvar.')
        return false
      }
    })
    if (saved) close()
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
          <BusyButton busy={busy} label="Salvar" busyLabel="Salvando…" disabled={!name.trim()} onClick={() => void save()} />
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
        {error && <FailureBanner text={error} />}
      </div>
    </Dialog>
  )
}

export function MoveDialog({ fileIds, folderIds }: { fileIds: string[]; folderIds: string[] }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const count = fileIds.length + folderIds.length
  const folderName = (target: string | null) => useLibraryStore.getState().folders.find(folder => folder.id === target)?.name ?? 'Biblioteca'
  const move = async (target: string | null, family: string[]) => {
    const moving = [...new Set([...fileIds, ...family])]
    const total = moving.length + folderIds.length
    const only = useLibraryStore.getState().files.find(file => file.id === moving[0])?.name ?? useLibraryStore.getState().folders.find(folder => folder.id === folderIds[0])?.name
    // the window closes at once; the writes (one per item) go on in the window that holds the app, counting them
    ui.close()
    try {
      const moved = await blocking(total === 1 ? `Movendo "${only}"…` : `Movendo ${itemsOf(total)}…`, blocker => moveItems(blocker, moving, folderIds, target), { phase: `Levando para ${folderName(target)}`, cancellable: true })
      ui.clearSelection()
      if (moved < total) return ui.toast(`${moved} de ${total} movidos para ${folderName(target)}`)
      const notes = family.filter(id => useLibraryStore.getState().files.some(file => file.id === id && isNote(file))).length
      ui.toast(`Movido para ${folderName(target)}${notes ? `, com ${notes} ${notes === 1 ? 'nota' : 'notas'}` : ''}`)
    } catch (error) {
      // what the list showed in the new folder goes back (the store does it); the reason is a toast
      ui.toast(`Não deu para mover: ${error instanceof Error ? error.message : 'tente de novo.'}`)
    }
  }
  // a note with notes born of it (a video, a PDF…): after the folder, the person says whether the notes go too (B)
  const choose = (target: string | null) => {
    const { files } = useLibraryStore.getState()
    // the family goes whole: a YouTube note inside one of the notes ("Gerar a partir disto") goes too; the window counts the notes
    const keepsSource = (id: string) => files.some(file => file.id === id && isSourceNote(file))
    const born = [...new Set(fileIds.filter(keepsSource).flatMap(id => descendantsOf(files, id).map(file => file.id)))].filter(id => !fileIds.includes(id))
    if (!born.length) return void move(target, [])
    const notes = born.filter(id => files.some(file => file.id === id && isNote(file))).length
    const where = `“${folderName(target)}”`
    const many = notes === 1 ? `Há 1 nota filha (Ata, Aula, Explicação…). Ela pode ir junto para ${where} ou ficar onde está.` : `Há ${notes} notas filhas (Ata, Aula, Explicação…). Elas podem ir junto para ${where} ou ficar onde estão.`
    ui.open({
      kind: 'confirm',
      title: 'Levar as notas também?',
      text: many,
      ok: 'Levar as filhas junto',
      onConfirm: () => move(target, born),
      alt: { label: count === 1 ? 'Só mover esta' : 'Só mover estas', onConfirm: () => move(target, []) },
    })
  }
  return <FolderChooserDialog value={null} exclude={folderIds} title={`Mover ${count} ${count === 1 ? 'item' : 'itens'}`} confirmLabel="Mover" onConfirm={choose} onClose={ui.close} />
}
