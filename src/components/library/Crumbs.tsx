import { Fragment } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { useFileActions } from '@/components/library/use-file-actions'
import { useFolderPath } from '@/hooks/use-library-view'
import { paths } from '@/lib/paths'

interface CrumbsProps {
  folderId: string | null
  tail?: string
  style?: React.CSSProperties
}

export function Crumbs({ folderId, tail, style }: CrumbsProps) {
  const path = useFolderPath(folderId)
  const navigate = useNavigate()
  const { dropTarget } = useFileActions()
  const atRoot = !path.length && !tail
  return (
    <nav className="crumbs" aria-label="Caminho" style={style}>
      {atRoot ? (
        <span className="cur">Biblioteca</span>
      ) : (
        <button onClick={() => navigate(paths.library)} {...dropTarget(null)}>
          Biblioteca
        </button>
      )}
      {path.map((folder, index) => {
        const last = index === path.length - 1 && !tail
        return (
          <Fragment key={folder.id}>
            <Icon name="chevr" />
            {last ? (
              <span className="cur">{folder.name}</span>
            ) : (
              <button onClick={() => navigate(paths.folder(folder.id))} {...dropTarget(folder.id)}>
                {folder.name}
              </button>
            )}
          </Fragment>
        )
      })}
      {tail && (
        <>
          <Icon name="chevr" />
          <span className="cur" title={tail}>
            {tail}
          </span>
        </>
      )}
    </nav>
  )
}

export function UpButton({ folderId }: { folderId: string | null }) {
  const path = useFolderPath(folderId)
  const navigate = useNavigate()
  if (!folderId || !path.length) return null
  const parent = path[path.length - 2]
  return (
    <button className="ibtn" onClick={() => navigate(paths.folder(parent?.id ?? null))} aria-label={`Subir para ${parent?.name ?? 'Biblioteca'}`} title="Subir uma pasta">
      <Icon name="up" />
    </button>
  )
}
