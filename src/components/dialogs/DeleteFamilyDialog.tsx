import '@/styles/delete-family.css'

import type { ArtifactKind, FileMeta } from '@/types/domain'
import { ConfirmDialog } from '@/components/dialogs/SimpleDialogs'
import { FileIcon } from '@/components/library/Badges'
import { Dialog } from '@/components/ui/Dialog'
import { Icon, type IconName } from '@/components/ui/Icon'
import { descendantsOf, familyCount } from '@/lib/family'
import { mediaOf } from '@/lib/file-types'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'

const KIND_ICON: Record<ArtifactKind, IconName> = { mapa: 'layers', cartoes: 'note', tutor: 'bulb' }

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const wordOf = (file: Pick<FileMeta, 'role'>) => (file.role === 'entrada' ? 'entrada' : 'nota')

/** An item without a family that has media: does the media go too? */
export function mediaChoice(file: FileMeta, trash: (media: boolean) => Promise<void>): Extract<Overlay, { kind: 'confirm' }> {
  const word = wordOf(file)
  return {
    kind: 'confirm',
    title: `Apagar "${file.name}"?`,
    text: `A ${word} vai para a lixeira e dá para restaurar. ${mediaOf(file) === 'video' ? 'O vídeo' : 'O áudio'} pode ir junto, mas aí não volta.`,
    ok: `Apagar a ${word} e a mídia`,
    danger: true,
    onConfirm: () => trash(true),
    alt: { label: `Apagar só a ${word}`, onConfirm: () => trash(false) },
  }
}

/** One item and what was born of it. `top`: a selected item, whose own artifacts are not part of the count. */
function Branch({ file, family, top = false }: { file: FileMeta; family: FileMeta[]; top?: boolean }) {
  const folders = useLibraryStore(state => state.folders)
  const children = family.filter(item => item.parentFileId === file.id)
  const artifacts = top ? [] : (file.artifacts ?? [])
  return (
    <li>
      <div className="dfam-node">
        <span className="dfam-name">
          <FileIcon type={file.type} />
          <span>{file.name}</span>
        </span>
        <span className="dfam-where">
          <Icon name="folder" />
          {folders.find(folder => folder.id === file.folderId)?.name ?? 'Biblioteca'}
        </span>
      </div>
      {artifacts.length > 0 && (
        <div className="dfam-arts">
          {artifacts.map(artifact => (
            <span key={artifact.id} className="dfam-art">
              <Icon name={KIND_ICON[artifact.kind]} />
              {artifact.name}
            </span>
          ))}
        </div>
      )}
      {children.length > 0 && (
        <ul>
          {children.map(child => (
            <Branch key={child.id} file={child} family={family} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** "Apagar" of an item, or of a selection (`fileIds`): with descendants, the whole tree and "Apagar tudo" / "Apagar só esta"; without, today's confirmation. */
export function DeleteFamilyDialog({ fileId, fileIds }: { fileId: string; fileIds?: string[] }) {
  const library = useLibraryStore()
  const ui = useUiStore()
  const { files } = library
  const wanted = new Set(fileIds ?? [fileId])
  const selected = files.filter(file => wanted.has(file.id) && !file.deletedAt)
  if (!selected.length) return null

  const familyOf = (file: FileMeta) => descendantsOf(files, file.id)
  const one = selected.length === 1 ? selected[0] : null
  const done = (message: string) => {
    if (fileIds) ui.clearSelection()
    ui.toast(message)
  }

  if (one && !familyOf(one).length) {
    const trash = async (media: boolean) => {
      await library.trashFiles([one.id], { media })
      done(`"${one.name}" foi para a lixeira${media ? ', com a mídia' : ''}`)
    }
    const confirm = library.hasMedia(one.id) ? mediaChoice(one, trash) : { kind: 'confirm' as const, title: `Apagar "${one.name}"?`, text: `A ${wordOf(one)} vai para a lixeira e dá para restaurar.`, ok: 'Apagar', danger: true, onConfirm: () => trash(false) }
    return <ConfirmDialog overlay={confirm} />
  }

  // a selected item inside another's family is shown, and goes, with that family
  const inside = new Set(selected.flatMap(file => familyOf(file).map(item => item.id)))
  const tops = selected.filter(file => !inside.has(file.id))
  const counts = tops.map(file => familyCount(files, file.id))
  const notes = counts.reduce((sum, count) => sum + count.notes, 0)
  const artifacts = counts.reduce((sum, count) => sum + count.artifacts, 0)
  const born = [notes && counted(notes, 'nota', 'notas'), artifacts && counted(artifacts, 'artefato', 'artefatos')].filter(Boolean).join(' · ')
  const total = tops.reduce((sum, file) => sum + 1 + familyOf(file).length, 0)

  const run = (action: () => Promise<void>, message: string) => async () => {
    ui.close()
    await action()
    done(message)
  }
  const trashAll = async () => {
    for (const file of tops) await (familyOf(file).length ? library.trashFamily(file.id) : library.trashFiles([file.id]))
  }
  // those born of another selected go first, so that their children climb past both
  const trashSelected = async () => {
    for (const file of [...selected].sort((a, b) => familyOf(a).length - familyOf(b).length)) await library.trashOnly(file.id)
  }
  const stayed = 'As notas ficaram, cada uma na sua pasta.'

  return (
    <Dialog
      title={one ? `Apagar “${one.name}”?` : `Apagar ${selected.length} itens?`}
      role="alertdialog"
      onClose={ui.close}
      footer={
        <>
          <span className="grow">Tudo vai para a Lixeira e dá para restaurar.</span>
          <button className="btn quiet" onClick={ui.close}>
            Cancelar
          </button>
          <button className="btn" onClick={run(trashSelected, one ? `Só “${one.name}” foi para a Lixeira. ${stayed}` : `Só os ${selected.length} selecionados foram para a Lixeira. ${stayed}`)}>
            {one ? 'Apagar só esta' : 'Apagar só estas'}
          </button>
          <button className="btn danger" onClick={run(trashAll, one ? `“${one.name}” e mais ${counted(notes, 'nota', 'notas')} foram para a Lixeira.` : `${total} itens foram para a Lixeira.`)}>
            Apagar tudo
          </button>
        </>
      }
    >
      <div className="db">
        {born && (
          <p className="dfam-count">
            {one ? 'Dela' : 'Delas'} {notes + artifacts === 1 ? 'nasceu' : 'nasceram'} <b>{born}</b>.
          </p>
        )}
        <div className="dfam-tree">
          <ul className="dfam-list" aria-label="O que vai junto">
            {one
              ? familyOf(one)
                  .filter(item => item.parentFileId === one.id)
                  .map(child => <Branch key={child.id} file={child} family={familyOf(one)} />)
              : tops.map(file => <Branch key={file.id} file={file} family={familyOf(file)} top />)}
          </ul>
        </div>
      </div>
    </Dialog>
  )
}
