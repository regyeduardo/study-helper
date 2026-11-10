import { useId, useMemo, useState } from 'react'

import type { AtaStepModels, FileMeta, Settings } from '@/types/domain'
import { FolderChooserDialog } from '@/components/dialogs/FolderChooser'
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

/** "Modelos por passo" of the last time: what each step used, while it is still in "Meus modelos". A note made when the video model wrote every step comes back with it in Contexto too. */
export function lastSteps(file: FileMeta | undefined, settings: Settings): AtaStepModels {
  const config = aiConfigOf(settings)
  const still = (uid: string | undefined) => (uid && modelByUid(config, uid) ? uid : undefined)
  const video = still(file?.made?.steps?.video)
  const context = still(file?.made?.steps?.context) ?? (file?.made?.everyStep ? still(file.made.model) : undefined)
  return { ...(video ? { video } : {}), ...(context ? { context } : {}) }
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
  // NEW_HOME means the home folder: once it is made, its real id
  const value = picked === undefined || picked === NEW_HOME ? homeValue : picked
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

/** "Onde salvar a nota nova": the single folder chooser, over the generation dialog. */
export function FolderWindow({ folder, noteName }: { folder: NoteFolder; noteName: string }) {
  const { home } = folder
  return (
    <FolderChooserDialog
      value={folder.value}
      extra={home && !home.id ? { id: NEW_HOME, name: home.name, parentId: home.parentId } : undefined}
      title="Onde salvar a nota nova"
      leaf={noteName}
      hint={folder.hintOf}
      onConfirm={id => (folder.choose(id), folder.setOpen(false))}
      onClose={() => folder.setOpen(false)}
    />
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

/** "Mais opções": the instruction for the AI, as in Novo conteúdo; open when it comes from the last time. */
export function MoreOptions({ instruction, onInstruction, placeholder, open = false }: { instruction: string; onInstruction(instruction: string): void; placeholder: string; open?: boolean }) {
  const id = useId()
  return (
    <details open={open}>
      <summary className="muted" style={{ fontSize: 13, cursor: 'pointer' }}>
        Mais opções
      </summary>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor={id}>Instrução extra para a IA (opcional)</label>
        <textarea className="input" id={id} value={instruction} onChange={event => onInstruction(event.target.value)} placeholder={placeholder} />
      </div>
    </details>
  )
}
