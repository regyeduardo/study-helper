import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FolderMeta } from '@/types/domain'
import { useFileActions } from '@/components/library/use-file-actions'
import { FolderIcon } from '@/components/ui/FolderIcon'
import { Icon } from '@/components/ui/Icon'
import { useLiveLibrary } from '@/hooks/use-library-view'
import { paths } from '@/lib/paths'
import { useUiStore } from '@/stores/ui'
import '@/styles/explorer.css'

interface FolderTreeProps {
  folders: FolderMeta[]
  current: string | null | undefined
  hits: Map<string, number>
  onGo?(): void
}

function ordered(folders: FolderMeta[], parentId: string | null): FolderMeta[] {
  return folders.filter(folder => folder.parentId === parentId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt-BR'))
}

function pathTo(folders: FolderMeta[], id: string | null | undefined): Set<string> {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const open = new Set<string>()
  for (let folder = id ? byId.get(id) : undefined, steps = 0; folder && steps < 64; folder = folder.parentId ? byId.get(folder.parentId) : undefined, steps++) open.add(folder.id)
  return open
}

export function FolderTree({ folders, current, hits, onGo }: FolderTreeProps) {
  const navigate = useNavigate()
  const { dropTarget } = useFileActions()
  const drag = useUiStore(state => state.drag)
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map())
  const onPath = pathTo(folders, current)
  const isOpen = (id: string) => toggled.get(id) ?? onPath.has(id)
  const go = (id: string | null) => {
    navigate(paths.folder(id))
    onGo?.()
  }
  const moveNote = (id: string | null) => {
    if (drag?.over !== id) return null
    const count = drag.fileIds.length + drag.folderIds.length
    return <span className="tree-move">{`Mover ${count} ${count === 1 ? 'item' : 'itens'}`}</span>
  }
  const item = (folder: FolderMeta, level: number): React.ReactNode => {
    const children = ordered(folders, folder.id)
    const open = isOpen(folder.id)
    const count = hits.get(folder.id)
    return (
      <div key={folder.id} role="none">
        <div className="tree-row" style={{ paddingLeft: 4 + (level - 1) * 14 }} {...dropTarget(folder.id)}>
          {children.length ? (
            <button className="tree-tw" aria-label={`${open ? 'Fechar' : 'Abrir'} ${folder.name}`} onClick={() => setToggled(map => new Map(map).set(folder.id, !open))}>
              <Icon name={open ? 'down' : 'fwd'} />
            </button>
          ) : (
            <span className="tree-tw" />
          )}
          <button role="treeitem" aria-level={level} aria-label={folder.name} aria-expanded={children.length ? open : undefined} aria-current={current === folder.id ? 'page' : undefined} className="nv tree-it" onClick={() => go(folder.id)}>
            <FolderIcon color={folder.color} />
            <span className="tree-name">{folder.name}</span>
            {count ? <span className="n">({count})</span> : null}
          </button>
          {moveNote(folder.id)}
        </div>
        {open && children.length > 0 && <div role="group">{children.map(child => item(child, level + 1))}</div>}
      </div>
    )
  }
  return (
    <div role="tree" aria-label="Pastas" className="tree">
      <div className="tree-row" style={{ paddingLeft: 4 }} {...dropTarget(null)}>
        <span className="tree-tw" />
        <button role="treeitem" aria-level={1} aria-label="Biblioteca" aria-current={current === null ? 'page' : undefined} className="nv tree-it" onClick={() => go(null)}>
          <Icon name="book" />
          <span className="tree-name">Biblioteca</span>
        </button>
        {moveNote(null)}
      </div>
      {ordered(folders, null).map(folder => item(folder, 1))}
    </div>
  )
}

/**
 * "Favoritos": the folders marked as favorite, at any depth, each one in its color. Nothing is drawn without a favorite.
 * `inline`: a row of chips in the library, for the layouts that have no side bar.
 */
export function FavoriteFolders({ current, onGo, inline = false }: { current?: string | null; onGo?(): void; inline?: boolean }) {
  const navigate = useNavigate()
  const { dropTarget } = useFileActions()
  const { folders } = useLiveLibrary()
  const favorites = folders.filter(folder => folder.favorite).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  if (!favorites.length) return null
  const list = (
    <ul className={inline ? 'fav-nav fav-chips' : 'fav-nav'} aria-label="Favoritos">
      {favorites.map(folder => (
        <li key={folder.id} {...dropTarget(folder.id)}>
          <button
            className={inline ? 'chip' : 'nv'}
            aria-current={current === folder.id ? 'page' : undefined}
            onClick={() => {
              navigate(paths.folder(folder.id))
              onGo?.()
            }}
          >
            <FolderIcon color={folder.color} />
            <span className="tree-name">{folder.name}</span>
          </button>
        </li>
      ))}
    </ul>
  )
  return inline ? (
    <div className="fav-strip">
      <span className="fav-strip-t">Favoritos</span>
      {list}
    </div>
  ) : (
    <>
      <div className="nh">Favoritos</div>
      {list}
    </>
  )
}
