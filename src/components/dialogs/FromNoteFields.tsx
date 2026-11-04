import { useMemo, useState } from 'react'

import type { FileMeta, Settings } from '@/types/domain'
import { FolderPicker } from '@/components/dialogs/SimpleDialogs'
import { Dialog } from '@/components/ui/Dialog'
import { usePathName } from '@/hooks/use-library-view'
import { aiConfigOf, modelByUid } from '@/lib/ai/config'
import { mediaOf } from '@/lib/file-types'
import { ATA_MODELS } from '@/lib/generation/ata'
import { homeFolderOf, type Placement } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { shortDate } from '@/utils/format'

// The picker's value for the folder named after the source while it does not exist.
const NEW_HOME = 'pasta-nova'

/** "Gerar de novo" of a note made from another (Ata, Aula): its source, and whether it is the Ata of a recording. */
export function againOf(file: FileMeta, files: FileMeta[]): { source: FileMeta; ata: boolean } | null {
  const source = file.parentFileId ? files.find(item => item.id === file.parentFileId && !item.deletedAt) : undefined
  if (!source || file.sourceExcerpt || (file.type !== 'meeting' && file.type !== 'class') || mediaOf(file) !== 'text') return null
  return { source, ata: file.type === 'meeting' && mediaOf(source) !== 'text' }
}

/** How it came out the last time: "Ata Fathom · DeepSeek V3 · em 28/10". */
export function madeLine(file: FileMeta, settings: Settings): string {
  const made = file.made
  const model = made?.model ? (modelByUid(aiConfigOf(settings), made.model)?.name ?? made.model.replace(/^.*::/, '')) : file.generation?.model
  const at = made?.at ?? file.generation?.startedAt
  return [made?.ataModel ? `Ata ${ATA_MODELS[made.ataModel].name}` : made?.parts?.length ? 'Ata Padrão' : '', model, at ? `em ${shortDate(at, settings.timezone)}` : ''].filter(Boolean).join(' · ')
}

/** The Modelo da IA of the last time, while it is still in "Meus modelos". */
export function lastModel(file: FileMeta | undefined, settings: Settings): { pick?: string; videoWrites?: boolean } {
  const config = aiConfigOf(settings)
  const uid = file?.made?.model ?? config.models.find(model => model.mid === file?.generation?.model)?.uid
  return { ...(uid && modelByUid(config, uid) ? { pick: uid } : {}), ...(file?.made?.everyStep ? { videoWrites: true } : {}) }
}

/** "Salvar em" of a note made from another: the folder named after the source comes chosen; "Trocar" opens the folder window. */
export function useNoteFolder(sourceId: string) {
  const source = useLibraryStore(state => state.files.find(file => file.id === sourceId))
  const folders = useLibraryStore(state => state.folders)
  const pathName = usePathName()
  const home = useMemo(() => (source ? homeFolderOf(source, folders) : null), [source, folders])
  const homeValue = home ? (home.id ?? NEW_HOME) : null
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const value = picked === undefined ? homeValue : picked
  const pathOf = (id: string | null) => (id === NEW_HOME && home ? (home.parentId ? `${pathName(home.parentId)} › ${home.name}` : home.name) : pathName(id))
  const hintOf = (id: string | null) =>
    !source || !home || id !== homeValue
      ? 'Só a nota nova vai para essa pasta.'
      : !home.id
        ? `Cria a pasta “${home.name}” em ${pathName(home.parentId)} e leva a nota “${source.name}” junto.`
        : source.folderId === home.id
          ? `A nota “${source.name}” já está nessa pasta.`
          : `A nota “${source.name}” vai junto para essa pasta.`
  const place: Placement = home && value === homeValue ? 'home' : { folderId: value }
  return { home, value, place, open, setOpen, choose: (id: string | null) => setPicked(id), pathOf, hintOf }
}

type NoteFolder = ReturnType<typeof useNoteFolder>

export function SaveIn({ folder }: { folder: NoteFolder }) {
  return (
    <div className="field" role="group" aria-label="Salvar em">
      <span className="lab">Salvar em</span>
      <div className="save-in">
        <b>{`${folder.pathOf(folder.value)}${folder.value === NEW_HOME ? ' (pasta nova)' : ''}`}</b>
        <button className="btn" onClick={() => folder.setOpen(true)}>
          Trocar
        </button>
      </div>
      <span className="faint" style={{ fontSize: 12.5 }}>
        {folder.hintOf(folder.value)}
      </span>
    </div>
  )
}

/** "Onde salvar a nota nova": the folder picker of Mover, over the generation dialog. */
export function FolderWindow({ folder, noteName }: { folder: NoteFolder; noteName: string }) {
  const [draft, setDraft] = useState(folder.value)
  const back = () => folder.setOpen(false)
  const use = () => {
    folder.choose(draft)
    back()
  }
  const { home } = folder
  return (
    <Dialog
      title="Onde salvar a nota nova"
      size="narrow"
      onClose={back}
      footer={
        <>
          <button className="btn quiet" onClick={back}>
            Voltar
          </button>
          <button className="btn primary" onClick={use}>
            Usar esta pasta
          </button>
        </>
      }
    >
      <div className="db">
        <div className="field">
          <span className="lab">Para qual pasta</span>
          <FolderPicker value={draft} onChange={setDraft} extra={home && !home.id ? { id: NEW_HOME, name: home.name, parentId: home.parentId } : undefined} />
          <span className="faint" style={{ fontSize: 12.5 }}>
            {folder.hintOf(draft)}
          </span>
        </div>
        <div className="field">
          <span className="lab">Fica em</span>
          <span style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{`${folder.pathOf(draft)} › ${noteName}`}</span>
        </div>
      </div>
    </Dialog>
  )
}

/** "O que fazer com o resultado" of Gerar de novo. */
export function ReplaceOrNew({ replace, onReplace }: { replace: boolean; onReplace(replace: boolean): void }) {
  return (
    <div className="field">
      <span className="lab">O que fazer com o resultado</span>
      <div className="opts cols2" role="radiogroup" aria-label="O que fazer com o resultado">
        {[true, false].map(choice => (
          <button key={String(choice)} className="opt" role="radio" aria-checked={replace === choice} onClick={() => onReplace(choice)}>
            <span className="radio" />
            <span>
              <b>{choice ? 'Substituir esta nota' : 'Criar nota nova'}</b>
              <span>{choice ? 'mesmo nome e pasta, texto novo' : 'esta fica, você escolhe a pasta'}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
