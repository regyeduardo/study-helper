import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { useFileActions } from '@/components/library/use-file-actions'
import { useLiveLibrary, usePathName } from '@/hooks/use-library-view'
import { paths } from '@/lib/paths'
import { useUiStore } from '@/stores/ui'

export function useSiblings(meta: FileMeta): { previous: FileMeta | null; next: FileMeta | null } {
  const { files, folders } = useLiveLibrary()
  const sort = useUiStore(state => state.sort)
  return useMemo(() => {
    const folder = folders.find(item => item.id === meta.folderId)
    const list = files.filter(file => file.folderId === meta.folderId)
    if (folder?.isCourse || folders.find(item => item.id === folder?.parentId)?.isCourse) list.sort((a, b) => a.position - b.position)
    else if (sort === 'title') list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    else if (sort === 'mastery') list.sort((a, b) => (a.mastery ?? 101) - (b.mastery ?? 101))
    else list.sort((a, b) => b.updated.at.localeCompare(a.updated.at))
    const index = list.findIndex(file => file.id === meta.id)
    return { previous: index > 0 ? list[index - 1] : null, next: index >= 0 && index < list.length - 1 ? list[index + 1] : null }
  }, [files, folders, meta.id, meta.folderId, sort])
}

export function DocumentNav({ meta }: { meta: FileMeta }) {
  const { previous, next } = useSiblings(meta)
  const { openFile } = useFileActions()
  const navigate = useNavigate()
  const pathName = usePathName()
  return (
    <nav className="doc-nav" aria-label="Navegar entre arquivos">
      {previous ? (
        <button onClick={() => openFile(previous)}>
          <small>
            <Icon name="back" /> Anterior
          </small>
          <b>{previous.name}</b>
        </button>
      ) : (
        <span className="ghost" />
      )}
      <button className="up" onClick={() => navigate(paths.folder(meta.folderId))}>
        <small>
          <Icon name="folder" /> Voltar à pasta
        </small>
        <b>{pathName(meta.folderId)}</b>
      </button>
      {next ? (
        <button className="next" onClick={() => openFile(next)}>
          <small>
            Próximo <Icon name="fwd" />
          </small>
          <b>{next.name}</b>
        </button>
      ) : (
        <span className="ghost" />
      )}
    </nav>
  )
}
