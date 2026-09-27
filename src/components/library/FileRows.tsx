import type { FileMeta } from '@/types/domain'
import { Check } from '@/components/ui/Check'
import { Icon } from '@/components/ui/Icon'
import { FileIcon, MasteryMeter, PendingBadge, Tags, TypeDot } from '@/components/library/Badges'
import { useFileActions } from '@/components/library/use-file-actions'
import { usePathName } from '@/hooks/use-library-view'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { plainText, shortDate } from '@/utils/format'

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
        </div>
        <div className="sub">
          <TypeDot type={file.type} />
          {showWhere && !inCourse && <Where file={file} />}
          {file.status !== 'ready' ? (
            <PendingBadge generating={file.status === 'generating'} />
          ) : (
            <>
              <span>{file.readingMinutes} min</span>
              <MasteryMeter value={file.mastery} />
            </>
          )}
          <Tags tags={file.tags} />
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
        </div>
        <div className="ex">{file.status === 'pending' ? 'Aula ainda não escrita. Toque para gerar.' : excerpt || file.description}</div>
        <div className="sub">
          <TypeDot type={file.type} />
          {showWhere && <Where file={file} />}
          <span>{shortDate(file.updated.at, timeZone)}</span>
          {file.status !== 'ready' ? <span className="pending">{file.status === 'generating' ? 'gerando…' : 'pendente'}</span> : <MasteryMeter value={file.mastery} />}
          {file.favorite && (
            <span className="star on">
              <Icon name="star" />
            </span>
          )}
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
  const handlers = useRowHandlers(file, () => set({ peekId: peekId === file.id ? null : file.id }))
  const updated = new Date(file.updated.at).toLocaleString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`tr ${selected || peekId === file.id ? 'sel' : ''}`} {...handlers} data-file-id={file.id}>
      <Check on={selected} label={`Marcar ${file.name}`} onToggle={() => toggleSelected(file.id)} />
      <div className="title">
        <FileIcon type={file.type} />
        {file.name}
        <small>
          {showWhere && !inCourse ? `${pathName(file.folderId)} · ` : ''}
          {file.tags.map(tag => `#${tag}`).join(' ')}
        </small>
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
        <div className="title">{file.name}</div>
        <div className="faint" style={{ fontSize: 12.5, marginTop: 2, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {showWhere && <Where file={file} />}
          {file.status !== 'ready' ? (
            <span className="pending">{file.status === 'generating' ? 'gerando…' : 'pendente'}</span>
          ) : (
            <>
              <span>{file.readingMinutes} min</span>
              <MasteryMeter value={file.mastery} />
            </>
          )}
          <Tags tags={file.tags} />
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

export function excerptOf(content: string | undefined): string {
  return content ? plainText(content).slice(0, 180) : ''
}
