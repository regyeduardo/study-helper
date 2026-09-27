import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { useLiveLibrary, usePathName } from '@/hooks/use-library-view'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'

export function ConfirmDialog({ overlay }: { overlay: Extract<Overlay, { kind: 'confirm' }> }) {
  const close = useUiStore(state => state.close)
  const [busy, setBusy] = useState(false)
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
          <button
            className={`btn ${overlay.danger ? 'danger' : 'primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              close()
              await overlay.onConfirm()
            }}
          >
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
  const [description, setDescription] = useState((target === 'folder' && current && 'isCourse' in current && current.isCourse ? current.courseDescription : current?.description) ?? '')
  const save = async () => {
    if (!name.trim()) return
    if (target === 'file') await library.updateFile(id, { name: name.trim(), description })
    else {
      const folder = library.folders.find(item => item.id === id)
      await library.updateFolder(id, folder?.isCourse ? { name: name.trim(), courseDescription: description } : { name: name.trim(), description })
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

export function FolderPicker({ value, onChange, exclude = [] }: { value: string | null; onChange(id: string | null): void; exclude?: string[] }) {
  const { folders } = useLiveLibrary()
  const flat: { id: string; name: string; depth: number; course: boolean }[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of folders.filter(item => item.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
      if (exclude.includes(folder.id)) continue
      flat.push({ id: folder.id, name: folder.name, depth, course: folder.isCourse })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)
  return (
    <select className="input" value={value ?? ''} onChange={event => onChange(event.target.value || null)} aria-label="Pasta">
      <option value="">Biblioteca (raiz)</option>
      {flat.map(item => (
        <option key={item.id} value={item.id}>
          {'   '.repeat(item.depth + 1)}
          {item.name}
          {item.course ? ' (curso)' : ''}
        </option>
      ))}
    </select>
  )
}

export function MoveDialog({ fileIds, folderIds }: { fileIds: string[]; folderIds: string[] }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const [target, setTarget] = useState<string | null>(null)
  const descendants = (id: string): string[] => [id, ...library.folders.filter(folder => folder.parentId === id).flatMap(folder => descendants(folder.id))]
  const exclude = folderIds.flatMap(descendants)
  const count = fileIds.length + folderIds.length
  const move = async () => {
    await library.moveFiles(fileIds, target)
    for (const id of folderIds) await library.updateFolder(id, { parentId: target })
    ui.close()
    ui.clearSelection()
    ui.toast(`Movido para ${library.folders.find(folder => folder.id === target)?.name ?? 'Biblioteca'}`)
  }
  return (
    <Dialog
      title={`Mover ${count} ${count === 1 ? 'item' : 'itens'}`}
      size="narrow"
      onClose={ui.close}
      footer={
        <>
          <button className="btn quiet" onClick={ui.close}>
            Cancelar
          </button>
          <button className="btn primary" onClick={() => void move()}>
            <Icon name="move" />
            Mover
          </button>
        </>
      }
    >
      <div className="db">
        <div className="field">
          <span className="lab">Para qual pasta</span>
          <FolderPicker value={target} onChange={setTarget} exclude={exclude} />
        </div>
      </div>
    </Dialog>
  )
}
