import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { DRAG_FOLDER, useFileActions } from '@/components/library/use-file-actions'
import type { FolderTile } from '@/hooks/use-library-view'
import { paths } from '@/lib/paths'
import { useUiStore } from '@/stores/ui'

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function FolderTiles({ tiles }: { tiles: FolderTile[] }) {
  const navigate = useNavigate()
  const { dropTarget } = useFileActions()
  const openMenu = useUiStore(state => state.openMenu)
  if (!tiles.length) return null
  return (
    <section className="blk">
      <h3 className="blk-h">
        <Icon name="folder" />
        Pastas <span>{tiles.length}</span>
      </h3>
      <div className="tiles">
        {tiles.map(({ folder, files, subfolders }) => (
          <div
            key={folder.id}
            className="tile"
            role="button"
            tabIndex={0}
            draggable
            onDragStart={event => event.dataTransfer.setData(DRAG_FOLDER, folder.id)}
            onClick={() => navigate(paths.folder(folder.id))}
            onKeyDown={event => event.key === 'Enter' && navigate(paths.folder(folder.id))}
            onContextMenu={event => {
              event.preventDefault()
              openMenu({ kind: 'folder', id: folder.id, x: event.clientX, y: event.clientY })
            }}
            {...dropTarget(folder.id)}
          >
            <span className="tile-ic">
              <Icon name={folder.isCourse ? 'layers' : 'folder'} />
            </span>
            <span className="tile-t">
              {folder.name}
              {folder.isCourse && <> <span className="crs">curso</span></>}
            </span>
            <span className="tile-m">
              {plural(files, 'arquivo', 'arquivos')}
              {subfolders ? ` · ${plural(subfolders, 'pasta', 'pastas')}` : ''}
            </span>
            <button
              className="ibtn more"
              aria-label={`Opções da pasta ${folder.name}`}
              onClick={event => {
                event.stopPropagation()
                const box = event.currentTarget.getBoundingClientRect()
                openMenu({ kind: 'folder', id: folder.id, x: box.left, y: box.bottom + 4 })
              }}
            >
              <Icon name="dots" />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
