import { Link, useNavigate } from 'react-router-dom'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { Check } from '@/components/ui/Check'
import { FolderIcon } from '@/components/ui/FolderIcon'
import { Icon, type IconName } from '@/components/ui/Icon'
import { FamilyCount, FileIcon, MasteryMeter, MotherBadge, PendingBadge, Tags, TypeDot } from '@/components/library/Badges'
import { SaveToDrive } from '@/components/library/SaveToDrive'
import { useFileActions } from '@/components/library/use-file-actions'
import { useFileBytes, usePathName } from '@/hooks/use-library-view'
import { familyCount, isNote } from '@/lib/family'
import { MEDIA_LABEL, mediaLength, mediaOf } from '@/lib/file-types'
import { type ItemKind, kindOf } from '@/lib/library-filters'
import type { SearchHit } from '@/lib/library-search'
import { paths } from '@/lib/paths'
import { clockTime } from '@/lib/transcription/export'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { formatBytes, plainText, shortDate } from '@/utils/format'

interface RowProps {
  file: FileMeta
  showWhere: boolean
  inCourse?: boolean
}

function MoreButton({ file }: { file: FileMeta }) {
  const openMenu = useUiStore(state => state.openMenu)
  return (
    <button
      className="ibtn more"
      aria-label={`Opções de ${file.name}`}
      onClick={event => {
        event.stopPropagation()
        const box = event.currentTarget.getBoundingClientRect()
        openMenu({ kind: 'file', id: file.id, x: box.left - 200, y: box.bottom + 4 })
      }}
    >
      <Icon name="dots" />
    </button>
  )
}

function ReorderButtons({ file, siblings }: { file: FileMeta; siblings?: FileMeta[] }) {
  const reorder = useUiStore(state => state.reorder)
  const updateFile = useLibraryStore(state => state.updateFile)
  if (!reorder || !siblings) return null
  const index = siblings.findIndex(item => item.id === file.id)
  const move = async (direction: -1 | 1) => {
    const other = siblings[index + direction]
    if (!other) return
    await updateFile(file.id, { position: other.position === file.position ? other.position + direction : other.position })
    await updateFile(other.id, { position: file.position })
  }
  return (
    <span style={{ display: 'flex', gap: 2 }}>
      <button className="ibtn" style={{ width: 24, height: 24 }} onClick={event => (event.stopPropagation(), void move(-1))} aria-label="Subir" disabled={index <= 0}>
        <Icon name="up" />
      </button>
      <button className="ibtn" style={{ width: 24, height: 24 }} onClick={event => (event.stopPropagation(), void move(1))} aria-label="Descer" disabled={index >= siblings.length - 1}>
        <Icon name="down" />
      </button>
    </span>
  )
}

function Where({ file }: { file: FileMeta }) {
  const pathName = usePathName()
  return (
    <span className="where">
      <Icon name="folder" /> {pathName(file.folderId)}
    </span>
  )
}

/** Created and updated, in one discreet line under the name, for the layouts whose lists have no date columns (FR-040). */
export function DatesLine({ file }: { file: FileMeta }) {
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const day = (at: string) => new Date(at).toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' })
  return <span className="ex-dates">{`Criado ${day(file.created.at)} · Atualizado ${day(file.updated.at)}`}</span>
}

function FileBytes({ file }: { file: FileMeta }) {
  return <span>{formatBytes(useFileBytes(file))}</span>
}

function useRowHandlers(file: FileMeta, onActivate: () => void) {
  const openMenu = useUiStore(state => state.openMenu)
  const { dragFile } = useFileActions()
  return {
    ...dragFile(file),
    role: 'button' as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') onActivate()
    },
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault()
      openMenu({ kind: 'file', id: file.id, x: event.clientX, y: event.clientY })
    },
  }
}

export function ReaderRow({ file, showWhere, inCourse, siblings }: RowProps & { siblings?: FileMeta[] }) {
  const selected = useUiStore(state => state.selection.has(file.id))
  const toggleSelected = useUiStore(state => state.toggleSelected)
  const { openFile, toggleFavorite } = useFileActions()
  const handlers = useRowHandlers(file, () => openFile(file))
  return (
    <div className={`row ${selected ? 'sel' : ''}`} {...handlers} data-file-id={file.id}>
      <Check on={selected} label={`${selected ? 'Desmarcar' : 'Marcar'} ${file.name}`} onToggle={() => toggleSelected(file.id)} />
      <div>
        <div className="title">
          <FileIcon type={file.type} />
          {file.name}
          <FamilyCount file={file} />
        </div>
        <div className="sub">
          <TypeDot type={file.type} />
          {showWhere && !inCourse && <Where file={file} />}
          <MotherBadge file={file} />
          {file.status !== 'ready' ? (
            <>
              <PendingBadge generating={file.status === 'generating'} />
              <FileBytes file={file} />
            </>
          ) : (
            <>
              <span>{file.readingMinutes} min</span>
              <FileBytes file={file} />
              <MasteryMeter value={file.mastery} />
            </>
          )}
          <Tags tags={file.tags} />
          <SaveToDrive fileId={file.id} compact />
        </div>
      </div>
      <div className="side">
        <ReorderButtons file={file} siblings={siblings} />
        <button className={`ibtn star ${file.favorite ? 'on' : ''}`} onClick={event => (event.stopPropagation(), void toggleFavorite(file))} aria-label={file.favorite ? 'Tirar dos favoritos' : 'Favoritar'}>
          <Icon name="star" />
        </button>
        <MoreButton file={file} />
      </div>
    </div>
  )
}

export function ColumnsCard({ file, showWhere, currentId, excerpt, siblings }: RowProps & { currentId: string | null; excerpt: string; siblings?: FileMeta[] }) {
  const selection = useUiStore(state => state.selection)
  const toggleSelected = useUiStore(state => state.toggleSelected)
  const { openFile } = useFileActions()
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const current = currentId === file.id
  const multi = selection.has(file.id) && selection.size > 1
  const handlers = useRowHandlers(file, () => openFile(file))
  return (
    <div className={`card ${current || selection.has(file.id) ? 'sel' : ''}`} {...handlers} aria-current={current} data-file-id={file.id}>
      <Check on={multi} label="Marcar para ação em massa" onToggle={() => toggleSelected(file.id)} />
      <div style={{ minWidth: 0 }}>
        <div className="title">
          <FileIcon type={file.type} />
          {file.name}
          <FamilyCount file={file} />
        </div>
        <div className="ex">{file.status === 'pending' ? 'Aula ainda não escrita. Toque para gerar.' : excerpt || file.description}</div>
        <div className="sub">
          <TypeDot type={file.type} />
          {showWhere && <Where file={file} />}
          <MotherBadge file={file} />
          <DatesLine file={file} />
          <FileBytes file={file} />
          {file.status !== 'ready' ? <span className="pending">{file.status === 'generating' ? 'gerando…' : 'pendente'}</span> : <MasteryMeter value={file.mastery} />}
          {file.favorite && (
            <span className="star on">
              <Icon name="star" />
            </span>
          )}
          <SaveToDrive fileId={file.id} compact />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 2, alignContent: 'start' }}>
        <MoreButton file={file} />
        <ReorderButtons file={file} siblings={siblings} />
      </div>
    </div>
  )
}

export function CommandsRow({ file, showWhere, inCourse, siblings }: RowProps & { siblings?: FileMeta[] }) {
  const { selection, toggleSelected, peekId, set } = useUiStore()
  const { openFile } = useFileActions()
  const pathName = usePathName()
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const selected = selection.has(file.id)
  const bytes = useFileBytes(file)
  const handlers = useRowHandlers(file, () => set({ peekId: peekId === file.id ? null : file.id }))
  const updated = new Date(file.updated.at).toLocaleString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`tr ${selected || peekId === file.id ? 'sel' : ''}`} {...handlers} data-file-id={file.id}>
      <Check on={selected} label={`Marcar ${file.name}`} onToggle={() => toggleSelected(file.id)} />
      <div className="title">
        <FileIcon type={file.type} />
        {file.name}
        <FamilyCount file={file} />
        <small>
          {showWhere && !inCourse ? `${pathName(file.folderId)} · ` : ''}
          {formatBytes(bytes)}
          {file.tags.length ? ` · ${file.tags.map(tag => `#${tag}`).join(' ')}` : ''}
        </small>
        <small className="ex-dates">
          <DatesLine file={file} />
        </small>
        <MotherBadge file={file} className="fam-selo-row" />
        <SaveToDrive fileId={file.id} compact />
      </div>
      <div className="hide-s">
        <TypeDot type={file.type} />
      </div>
      <div className="hide-s">{file.status !== 'ready' ? <span className="pending">{file.status === 'generating' ? 'gerando…' : 'pendente'}</span> : <MasteryMeter value={file.mastery} />}</div>
      <div className="d hide-s">{updated.replace(',', '')}</div>
      <div style={{ display: 'flex' }}>
        <ReorderButtons file={file} siblings={siblings} />
        <button className="ibtn" onClick={event => (event.stopPropagation(), openFile(file))} aria-label={`Abrir ${file.name} inteiro`} title="Abrir inteiro">
          <Icon name="fwd" />
        </button>
        <MoreButton file={file} />
      </div>
    </div>
  )
}

export function FocusRow({ file, showWhere, inCourse, order, siblings }: RowProps & { order?: number; siblings?: FileMeta[] }) {
  const selected = useUiStore(state => state.selection.has(file.id))
  const toggleSelected = useUiStore(state => state.toggleSelected)
  const { openFile } = useFileActions()
  const handlers = useRowHandlers(file, () => openFile(file))
  return (
    <div className={`lrow ${selected ? 'sel' : ''}`} {...handlers} data-file-id={file.id}>
      <span className="num">{inCourse ? String(order ?? 0).padStart(2, '0') : <TypeDot type={file.type} />}</span>
      <div>
        <div className="title">
          {file.name}
          <FamilyCount file={file} />
        </div>
        <div className="faint" style={{ fontSize: 12.5, marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {showWhere && <Where file={file} />}
          <MotherBadge file={file} />
          {file.status !== 'ready' ? (
            <>
              <span className="pending">{file.status === 'generating' ? 'gerando…' : 'pendente'}</span>
              <FileBytes file={file} />
            </>
          ) : (
            <>
              <span>{file.readingMinutes} min</span>
              <FileBytes file={file} />
              <MasteryMeter value={file.mastery} />
            </>
          )}
          <Tags tags={file.tags} />
          <DatesLine file={file} />
          <SaveToDrive fileId={file.id} compact />
        </div>
      </div>
      <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        <ReorderButtons file={file} siblings={siblings} />
        <MoreButton file={file} />
        <Check on={selected} label={`Marcar ${file.name}`} onToggle={() => toggleSelected(file.id)} />
      </span>
    </div>
  )
}

/* ---------- the table of the explorer ---------- */

type FileActions = ReturnType<typeof useFileActions>

interface TableRowProps {
  narrow: boolean
  /** Off in a shared link: nothing there is checked or moved. */
  selectable: boolean
  draggable: boolean
  actions: FileActions
}

const KIND_TEXT: Record<ItemKind, string> = { video: 'Vídeo', audio: 'Áudio', pdf: 'PDF', link: 'Link', texto: 'Texto', tema: 'Tema', arquivo: 'Arquivo', nota: 'Nota' }
const KIND_ICON: Record<ItemKind, IconName> = { video: 'monitor', audio: 'mic', pdf: 'file', link: 'link', texto: 'text', tema: 'bulb', arquivo: 'file', nota: 'note' }

function kindLine(file: FileMeta): string {
  const media = mediaOf(file)
  if (media !== 'text') {
    const length = mediaLength(file.origin?.durationSeconds)
    return length ? `${MEDIA_LABEL[media]} · ${length}` : MEDIA_LABEL[media]
  }
  if (isNote(file)) return file.parentFileId || file.origin ? 'Nota' : 'Nota · escrita direto'
  return KIND_TEXT[kindOf(file)]
}

function kindIcon(file: FileMeta): IconName {
  const media = mediaOf(file)
  return media === 'video' ? 'monitor' : media === 'audio' ? 'mic' : KIND_ICON[kindOf(file)]
}

function dayAndTime(at: string, timeZone: string): { day: string; time: string } {
  const date = new Date(at)
  const format = (value: Date) => value.toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' })
  const day = format(date)
  return { day: day === format(new Date()) ? 'Hoje' : day, time: date.toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }) }
}

/** Date over time, each in its own element. */
export function DateCell({ at }: { at: string }) {
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const { day, time } = dayAndTime(at, timeZone)
  return (
    <td className="ex-date">
      <span className="ex-day">{day}</span>
      <span className="ex-time">{time}</span>
    </td>
  )
}

/** In a narrow space the dates leave the columns for one discreet line under the name (FR-040). */
function DateLine({ at }: { at: string }) {
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const { day, time } = dayAndTime(at, timeZone)
  return <span className="ex-dates">{`Atualizado ${day} ${time}`}</span>
}

interface TableCheckProps {
  /** `'some'`: part of the table is checked. */
  checked: boolean | 'some'
  label: string
  onToggle(): void
}

/** A real checkbox, whose name stays the same checked or not; a click on it never opens the row. */
export function TableCheck({ checked, label, onToggle }: TableCheckProps) {
  const some = checked === 'some'
  return (
    <input
      ref={input => {
        if (input) input.indeterminate = some
      }}
      className="ex-box"
      type="checkbox"
      aria-label={label}
      aria-checked={some ? 'mixed' : undefined}
      checked={checked === true}
      onChange={onToggle}
      onClick={event => event.stopPropagation()}
    />
  )
}

interface SortHeadProps<Column extends string> {
  column: Column
  label: string
  sort: { column: Column; ascending: boolean }
  onSort(column: Column): void
}

export function SortHead<Column extends string>({ column, label, sort, onSort }: SortHeadProps<Column>) {
  return (
    <th aria-sort={sort.column === column ? (sort.ascending ? 'ascending' : 'descending') : undefined}>
      <button onClick={() => onSort(column)}>{label}</button>
    </th>
  )
}

function Snippet({ hit }: { hit: SearchHit }) {
  if (!hit.parts.length && hit.at === null) return null
  return (
    <div className="ex-snip">
      {hit.at !== null && <span className="ex-at">{clockTime(hit.at)} · </span>}
      {hit.parts.map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
    </div>
  )
}

/** Enter on the row itself (not on its star or ⋯) opens it, like the click. */
const onEnter = (open: () => void) => (event: React.KeyboardEvent<HTMLElement>) => event.key === 'Enter' && event.target === event.currentTarget && open()

function OptionsButton({ kind, id, name }: { kind: 'file' | 'folder'; id: string; name: string }) {
  const openMenu = useUiStore(state => state.openMenu)
  return (
    <button
      className="ibtn"
      aria-label={`Opções de ${name}`}
      onClick={event => {
        event.stopPropagation()
        const box = event.currentTarget.getBoundingClientRect()
        openMenu({ kind, id, x: box.left - 200, y: box.bottom + 4 })
      }}
    >
      <Icon name="dots" />
    </button>
  )
}

function CheckCell({ show, name, id, draggable }: { show: boolean; name: string; id: string; draggable: boolean }) {
  const selected = useUiStore(state => state.selection.has(id))
  const toggleSelected = useUiStore(state => state.toggleSelected)
  return (
    // the whole cell is the target: a near miss on a phone must not open the row
    <td
      className="ex-check"
      onClick={
        show
          ? event => {
              event.stopPropagation()
              toggleSelected(id)
            }
          : undefined
      }
    >
      {draggable && <Icon name="grip" className="ex-grip" />}
      {show && <TableCheck checked={selected} label={`Marcar ${name}`} onToggle={() => toggleSelected(id)} />}
    </td>
  )
}

/** "O que nasceu": what came of it, where it came from, or "Nada ainda" for an entrada that gave nothing. */
function Born({ file, nested }: { file: FileMeta; nested: boolean }) {
  const files = useLibraryStore(state => state.files)
  const { notes, artifacts } = familyCount(files, file.id)
  return (
    <>
      <FamilyCount file={file} />
      {!nested && <MotherBadge file={file} className="ex-mother" />}
      {!notes && !artifacts && !isNote(file) && <span className="ex-none">Nada ainda</span>}
    </>
  )
}

interface FileTableRowProps extends TableRowProps {
  file: FileMeta
  depth: number
  hit?: SearchHit
  /** Where it is kept, when that needs saying. */
  place?: string | null
  /** The list of entradas: the name is a link to the page of the entrada, which is also where the row goes. */
  to?: string
  /** What the entrada is, in place of the kind line. */
  kindText?: string
  /** The folder it is in, when the list mixes folders. */
  folderName?: string
}

export function FileTableRow({ file, depth, hit, place, to, kindText, folderName, narrow, selectable, draggable, actions }: FileTableRowProps) {
  const navigate = useNavigate()
  const selected = useUiStore(state => state.selection.has(file.id))
  const open = () => (to ? navigate(to) : actions.openFile(file))
  const name = (
    <>
      <Icon name={kindIcon(file)} />
      <span className="ex-title">{file.name}</span>
      {file.status !== 'ready' && <span className="pending">{file.status === 'generating' ? 'gerando…' : 'pendente'}</span>}
    </>
  )
  const className = [hit && 'hit', depth > 0 && 'fam-nested', selected && 'sel'].filter(Boolean).join(' ') || undefined
  return (
    <tr className={className} style={depth > 0 ? ({ '--fam-depth': depth } as React.CSSProperties) : undefined} aria-label={file.name} data-file-id={file.id} data-depth={depth} tabIndex={0} onClick={open} onKeyDown={onEnter(open)} {...(draggable ? actions.dragFile(file) : {})}>
      <CheckCell show={selectable} name={file.name} id={file.id} draggable={draggable} />
      <td>
        {to ? (
          <Link className="ex-name" to={to} onClick={event => event.stopPropagation()}>
            {name}
          </Link>
        ) : (
          <div className="ex-name">{name}</div>
        )}
        <div className="ex-sub">
          <span>{kindText ?? kindLine(file)}</span>
          {folderName && <span className="ex-where">{folderName}</span>}
          {file.mastery !== null && <span>Prova {file.mastery}%</span>}
          {file.tags.map(tag => (
            <span key={tag}>#{tag}</span>
          ))}
          {place && <span className="ex-place">{place}</span>}
          <SaveToDrive fileId={file.id} compact />
        </div>
        {narrow && (
          <div className="ex-sub">
            <Born file={file} nested={depth > 0} />
            <DateLine at={file.updated.at} />
          </div>
        )}
        {hit && <Snippet hit={hit} />}
      </td>
      {!narrow && (
        <td className="ex-born">
          <Born file={file} nested={depth > 0} />
        </td>
      )}
      {!narrow && <DateCell at={file.created.at} />}
      {!narrow && <DateCell at={file.updated.at} />}
      <td className="ex-act">
        <button className={`ibtn star ${file.favorite ? 'on' : ''}`} onClick={event => (event.stopPropagation(), void actions.toggleFavorite(file))} aria-label={file.favorite ? 'Tirar dos favoritos' : 'Favoritar'}>
          <Icon name="star" />
        </button>
        <OptionsButton kind="file" id={file.id} name={file.name} />
      </td>
    </tr>
  )
}

interface FolderTableRowProps extends TableRowProps {
  folder: FolderMeta
  /** What is directly inside it. */
  items: number
  /** How many search results are inside it. */
  found: number
}

export function FolderTableRow({ folder, items, found, narrow, selectable, draggable, actions }: FolderTableRowProps) {
  const navigate = useNavigate()
  const selected = useUiStore(state => state.selection.has(folder.id))
  const open = () => navigate(paths.folder(folder.id))
  const className = [found > 0 && 'hit', selected && 'sel'].filter(Boolean).join(' ') || undefined
  return (
    <tr className={className} aria-label={folder.name} data-folder-id={folder.id} tabIndex={0} onClick={open} onKeyDown={onEnter(open)} {...(draggable ? actions.dragFolder(folder) : {})} {...(selectable ? actions.dropTarget(folder.id) : {})}>
      <CheckCell show={selectable} name={folder.name} id={folder.id} draggable={draggable} />
      <td>
        <div className="ex-name">
          <FolderIcon color={folder.color} />
          <span className="ex-title">{folder.name}</span>
        </div>
        <div className="ex-sub">
          <span>{`Pasta · ${items} ${items === 1 ? 'item' : 'itens'}`}</span>
        </div>
        {narrow && (
          <div className="ex-sub">
            <DateLine at={folder.updated.at} />
          </div>
        )}
        {found > 0 && <div className="ex-snip">{found === 1 ? '1 resultado dentro' : `${found} resultados dentro`}</div>}
      </td>
      {!narrow && <td className="ex-born" />}
      {!narrow && <DateCell at={folder.created.at} />}
      {!narrow && <DateCell at={folder.updated.at} />}
      <td className="ex-act">{selectable && <OptionsButton kind="folder" id={folder.id} name={folder.name} />}</td>
    </tr>
  )
}

/** A folder listing with each note right under its mother, when she is listed too, in the order given; the rest stays where it was. */
export function nestFamilies(files: FileMeta[]): { file: FileMeta; depth: number }[] {
  const listed = new Set(files.map(file => file.id))
  const under = (file: FileMeta) => Boolean(file.parentFileId && file.parentFileId !== file.id && listed.has(file.parentFileId))
  const children = new Map<string, FileMeta[]>()
  for (const file of files) if (under(file)) children.set(file.parentFileId!, [...(children.get(file.parentFileId!) ?? []), file])
  const nested: { file: FileMeta; depth: number }[] = []
  const placed = new Set<string>()
  const place = (file: FileMeta, depth: number) => {
    if (placed.has(file.id)) return
    placed.add(file.id)
    nested.push({ file, depth })
    for (const child of children.get(file.id) ?? []) place(child, depth + 1)
  }
  for (const file of files) if (!under(file)) place(file, 0)
  // A cycle in the data has no top: what is left goes flat.
  for (const file of files) place(file, 0)
  return nested
}

export function excerptOf(content: string | undefined): string {
  return content ? plainText(content).slice(0, 180) : ''
}
