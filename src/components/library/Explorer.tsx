import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta, FolderMeta } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { useFileActions } from '@/components/library/use-file-actions'
import { folderHitCounts, useLiveLibrary, useSearchHits } from '@/hooks/use-library-view'
import { MEDIA_LABEL, mediaLength, mediaOf, type NoteMedia, REVIEW_BELOW } from '@/lib/file-types'
import type { SearchHit } from '@/lib/library-search'
import { paths, type View } from '@/lib/paths'
import { clockTime } from '@/lib/transcription/export'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

type SortColumn = 'name' | 'media' | 'tags' | 'prova'

const COLUMNS: [SortColumn, string][] = [
  ['name', 'Nome'],
  ['media', 'Mídia'],
  ['tags', 'Etiquetas'],
  ['prova', 'Prova'],
]

const MEDIA_FILTERS: [NoteMedia | null, string][] = [
  [null, 'Tudo'],
  ['text', 'Texto'],
  ['audio', 'Áudio'],
  ['video', 'Vídeo'],
]

function mediaCell(file: FileMeta): string {
  const media = mediaOf(file)
  const length = mediaLength(file.origin?.durationSeconds)
  return media === 'text' || !length ? MEDIA_LABEL[media] : `${MEDIA_LABEL[media]} · ${length}`
}

function sortFiles(files: FileMeta[], column: SortColumn, ascending: boolean): FileMeta[] {
  const byName = (a: FileMeta, b: FileMeta) => a.name.localeCompare(b.name, 'pt-BR')
  const compare: Record<SortColumn, (a: FileMeta, b: FileMeta) => number> = {
    name: byName,
    media: (a, b) => mediaCell(a).localeCompare(mediaCell(b), 'pt-BR') || byName(a, b),
    tags: (a, b) => a.tags.join(',').localeCompare(b.tags.join(','), 'pt-BR') || byName(a, b),
    prova: (a, b) => (a.mastery === null ? 1 : 0) - (b.mastery === null ? 1 : 0) || (a.mastery ?? 0) - (b.mastery ?? 0) || byName(a, b),
  }
  const sorted = [...files].sort(compare[column])
  return ascending ? sorted : sorted.reverse()
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

function rowsFor(view: View, folderId: string | null, files: FileMeta[], folders: FolderMeta[], media: NoteMedia | null, tag: string | null) {
  let list = files
  if (tag) list = list.filter(file => file.tags.includes(tag))
  else if (view === 'review') list = list.filter(file => file.mastery !== null && file.mastery < REVIEW_BELOW)
  else if (view === 'favorites') list = list.filter(file => file.favorite)
  else list = list.filter(file => file.folderId === folderId)
  if (media) list = list.filter(file => mediaOf(file) === media)
  const subfolders = view === 'folder' && !tag && !media ? folders.filter(folder => folder.parentId === folderId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR')) : []
  return { list, subfolders }
}

export function Explorer({ view, folderId }: { view: View; folderId: string | null }) {
  const navigate = useNavigate()
  const ui = useUiStore()
  const { files, folders } = useLiveLibrary()
  const { openFile, toggleFavorite } = useFileActions()
  const shared = useLibraryStore(state => Boolean(state.sharedView))
  const [sort, setSort] = useState<{ column: SortColumn; ascending: boolean }>({ column: 'name', ascending: true })
  const hits = useSearchHits(ui.query)
  const inside = folderHitCounts(hits, files, folders)
  const { list, subfolders } = rowsFor(view, folderId, files, folders, ui.media, ui.tag)
  const rows = sortFiles(list, sort.column, sort.ascending)
  const tested = list.filter(file => file.mastery !== null)
  const average = tested.length ? Math.round(tested.reduce((sum, file) => sum + (file.mastery ?? 0), 0) / tested.length) : null
  const sortBy = (column: SortColumn) => setSort(current => ({ column, ascending: current.column === column ? !current.ascending : true }))
  const menu = (kind: 'file' | 'folder', id: string) => (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation()
    const box = event.currentTarget.getBoundingClientRect()
    ui.openMenu({ kind, id, x: box.left - 200, y: box.bottom + 4 })
  }
  return (
    <section className="explorer">
      <div className="ex-tools">
        <label className="ex-search">
          <Icon name="search" />
          <input type="search" aria-label="Buscar" placeholder="Buscar em tudo, até no que foi falado" value={ui.query} onChange={event => ui.setQuery(event.target.value)} />
        </label>
        <div className="ex-chips" role="group" aria-label="Mídia">
          {MEDIA_FILTERS.map(([media, label]) => (
            <button key={label} className="chip" aria-pressed={ui.media === media} onClick={() => ui.setMedia(media)}>
              {label}
            </button>
          ))}
        </div>
        {ui.tag && (
          <button className="chip" aria-pressed="true" onClick={() => ui.setTag(null)}>
            #{ui.tag} <Icon name="x" />
          </button>
        )}
        <span className="spacer" />
        {view === 'folder' && !shared && (
          <button className="btn" onClick={() => ui.open({ kind: 'new-folder', parentId: folderId })}>
            <Icon name="folder" />
            Nova pasta
          </button>
        )}
        {view === 'folder' && folderId && !shared && (
          <button className="ibtn" aria-label="Opções da pasta" onClick={menu('folder', folderId)}>
            <Icon name="dots" />
          </button>
        )}
      </div>
      {average !== null && view === 'folder' && (
        <div className="ex-strip">
          <span className="muted">Desta pasta:</span>
          <button className="chip" onClick={() => folderId && ui.open({ kind: 'folder-exam', folderId })}>
            Prova · {average}%
          </button>
        </div>
      )}
      <table className="ex-table" aria-label="Notas e pastas">
        <thead>
          <tr>
            {COLUMNS.map(([column, label]) => (
              <th key={column} aria-sort={sort.column === column ? (sort.ascending ? 'ascending' : 'descending') : undefined}>
                <button onClick={() => sortBy(column)}>{label}</button>
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {subfolders.map(folder => {
            const count = inside.get(folder.id) ?? 0
            return (
              <tr key={folder.id} className={count ? 'hit' : undefined} onClick={() => navigate(paths.folder(folder.id))}>
                <td>
                  <div className="ex-name">
                    <Icon name="folder" />
                    {folder.name}
                  </div>
                  {count > 0 && <div className="ex-snip">{count === 1 ? '1 resultado dentro' : `${count} resultados dentro`}</div>}
                </td>
                <td>pasta</td>
                <td />
                <td />
                <td className="ex-act">
                  {!shared && (
                    <button className="ibtn" aria-label={`Opções de ${folder.name}`} onClick={menu('folder', folder.id)}>
                      <Icon name="dots" />
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {rows.map(file => {
            const hit = hits.get(file.id)
            return (
              <tr key={file.id} className={hit ? 'hit' : undefined} data-file-id={file.id} onClick={() => openFile(file)}>
                <td>
                  <div className="ex-name">
                    <Icon name={mediaOf(file) === 'text' ? 'file' : mediaOf(file) === 'video' ? 'monitor' : 'mic'} />
                    {file.name}
                    {file.status !== 'ready' && <span className="pending">{file.status === 'generating' ? 'gerando…' : 'pendente'}</span>}
                  </div>
                  {hit && <Snippet hit={hit} />}
                </td>
                <td>{mediaCell(file)}</td>
                <td>{file.tags.join(', ')}</td>
                <td>{file.mastery === null ? '' : `${file.mastery}%`}</td>
                <td className="ex-act">
                  <button className={`ibtn star ${file.favorite ? 'on' : ''}`} onClick={event => (event.stopPropagation(), void toggleFavorite(file))} aria-label={file.favorite ? 'Tirar dos favoritos' : 'Favoritar'}>
                    <Icon name="star" />
                  </button>
                  <button className="ibtn" aria-label={`Opções de ${file.name}`} onClick={menu('file', file.id)}>
                    <Icon name="dots" />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!rows.length && !subfolders.length && <div className="empty">{ui.media || ui.tag ? 'Nada com esse filtro aqui.' : 'Pasta vazia. Use Novo ou Gravar para começar.'}</div>}
    </section>
  )
}
