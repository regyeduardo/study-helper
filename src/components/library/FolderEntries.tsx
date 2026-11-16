// "Entradas:" na pasta da biblioteca: o controle e o cabeçalho de cada grupo de notas. Só na navegação da pasta (Explorer).
import { Link, useNavigate } from 'react-router-dom'

import type { FileMeta } from '@/types/domain'
import { entryKind } from '@/components/library/entry-kind'
import { OptionsButton, TableCheck } from '@/components/library/FileRows'
import type { useFileActions } from '@/components/library/use-file-actions'
import { Icon } from '@/components/ui/Icon'
import { usePathName } from '@/hooks/use-library-view'
import { FOLDER_ENTRIES_MODES, type FolderEntriesMode } from '@/lib/folder-entries'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import '@/styles/folder-entries.css'

/**
 * The three ways the folder can treat the entradas, in the tools row; the choice stays in the library settings, so it follows the account.
 * On a phone the row has no room for a label beside the select: each choice then carries "Entradas:" itself.
 */
export function FolderEntriesSelect({ mode, narrow = false }: { mode: FolderEntriesMode; narrow?: boolean }) {
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const toast = useUiStore(state => state.toast)
  return (
    <label className="ex-entries">
      {!narrow && <span aria-hidden="true">Entradas:</span>}
      <select aria-label="Entradas" value={mode} onChange={event => void updateSettings({ folderEntries: event.target.value as FolderEntriesMode }).catch(() => toast('Não consegui guardar essa escolha.'))}>
        {FOLDER_ENTRIES_MODES.map(option => (
          <option key={option.id} value={option.id}>
            {narrow ? `Entradas: ${option.label}` : option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** The `data-entry-group` of the header of the notes born of no entrada. */
export const NO_ENTRY = 'none'

const count = (notes: number) => `${notes.toLocaleString('pt-BR')} ${notes === 1 ? 'nota' : 'notas'}`

interface EntryGroupRowProps {
  /** Null: "Sem entrada". */
  entry: FileMeta | null
  /** The notes of the group that this folder view lists, checked or not. */
  notes: FileMeta[]
  open: boolean
  onToggle(): void
  /** The folder being browsed: an entrada that lives in another one says where. */
  folderId: string | null
  narrow: boolean
  /** Off in a shared link: nothing there is checked or moved. */
  selectable: boolean
  draggable: boolean
  actions: ReturnType<typeof useFileActions>
}

/** The header row of a group: the entrada's icon, name, type and how many notes; it opens the entrada, and folds and unfolds its notes. */
export function EntryGroupRow({ entry, notes, open, onToggle, folderId, narrow, selectable, draggable, actions }: EntryGroupRowProps) {
  const navigate = useNavigate()
  const pathName = usePathName()
  const selection = useUiStore(state => state.selection)
  const setSelection = useUiStore(state => state.setSelection)
  const name = entry?.name ?? 'Sem entrada'
  const kind = entry ? entryKind(entry) : null
  const goes = () => (entry ? navigate(paths.entry(entry.id)) : onToggle())
  const ids = notes.map(note => note.id)
  const marked = ids.filter(id => selection.has(id)).length
  const checked = marked === 0 ? false : marked === ids.length ? true : 'some'
  const toggleNotes = () => setSelection(checked === true ? [...selection].filter(id => !ids.includes(id)) : [...new Set([...selection, ...ids])])
  const where = entry && entry.folderId !== folderId ? pathName(entry.folderId) : null
  const fold = `${open ? 'Recolher' : 'Mostrar'} as notas ${entry ? `de ${entry.name}` : 'sem entrada'}`
  return (
    <tr
      className="ex-group"
      aria-label={name}
      data-entry-group={entry?.id ?? NO_ENTRY}
      tabIndex={0}
      onClick={goes}
      onKeyDown={event => event.key === 'Enter' && event.target === event.currentTarget && goes()}
      {...(draggable && entry ? actions.dragFile(entry) : {})}
    >
      {/* only what is in sight can be checked: a folded group has no checkbox, as its notes are out of the selection */}
      <td className="ex-check" onClick={selectable && open ? event => (event.stopPropagation(), toggleNotes()) : undefined}>
        {draggable && entry && <Icon name="grip" className="ex-grip" />}
        {selectable && open && <TableCheck checked={checked} label={`Marcar as notas ${entry ? `de ${entry.name}` : 'sem entrada'}`} onToggle={toggleNotes} />}
      </td>
      <td colSpan={narrow ? 1 : 3}>
        <div className="ex-name ex-group-name">
          <button className="ex-fold" aria-expanded={open} aria-label={fold} title={fold} onClick={event => (event.stopPropagation(), onToggle())}>
            <Icon name={open ? 'chev' : 'chevr'} />
          </button>
          {kind && <Icon name={kind.icon} />}
          {entry ? (
            <Link className="ex-title" to={paths.entry(entry.id)} onClick={event => event.stopPropagation()}>
              {entry.name}
            </Link>
          ) : (
            <span className="ex-title">{name}</span>
          )}
        </div>
        <div className="ex-sub ex-group-sub">
          {kind && <span>{kind.label}</span>}
          <span>{count(notes.length)}</span>
          {where && <span className="ex-where">{`em ${where}`}</span>}
        </div>
      </td>
      <td className="ex-act">{selectable && entry && <OptionsButton kind="file" id={entry.id} name={entry.name} />}</td>
    </tr>
  )
}
