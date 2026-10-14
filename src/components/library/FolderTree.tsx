import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FolderMeta } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { paths } from '@/lib/paths'

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
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map())
  const onPath = pathTo(folders, current)
  const isOpen = (id: string) => toggled.get(id) ?? onPath.has(id)
  const go = (id: string | null) => {
    navigate(paths.folder(id))
    onGo?.()
  }
  const item = (folder: FolderMeta, level: number): React.ReactNode => {
    const children = ordered(folders, folder.id)
    const open = isOpen(folder.id)
    const count = hits.get(folder.id)
    return (
      <div key={folder.id} role="none">
        <div className="tree-row" style={{ paddingLeft: 4 + (level - 1) * 14 }}>
          {children.length ? (
            <button className="tree-tw" aria-label={`${open ? 'Fechar' : 'Abrir'} ${folder.name}`} onClick={() => setToggled(map => new Map(map).set(folder.id, !open))}>
              <Icon name={open ? 'down' : 'fwd'} />
            </button>
          ) : (
            <span className="tree-tw" />
          )}
          <button role="treeitem" aria-level={level} aria-label={folder.name} aria-expanded={children.length ? open : undefined} aria-current={current === folder.id ? 'page' : undefined} className="nv tree-it" onClick={() => go(folder.id)}>
            <Icon name="folder" />
            <span className="tree-name">{folder.name}</span>
            {count ? <span className="n">({count})</span> : null}
          </button>
        </div>
        {open && children.length > 0 && <div role="group">{children.map(child => item(child, level + 1))}</div>}
      </div>
    )
  }
  return (
    <div role="tree" aria-label="Pastas" className="tree">
      <div className="tree-row" style={{ paddingLeft: 4 }}>
        <span className="tree-tw" />
        <button role="treeitem" aria-level={1} aria-label="Biblioteca" aria-current={current === null ? 'page' : undefined} className="nv tree-it" onClick={() => go(null)}>
          <Icon name="book" />
          <span className="tree-name">Biblioteca</span>
        </button>
      </div>
      {ordered(folders, null).map(folder => item(folder, 1))}
    </div>
  )
}
