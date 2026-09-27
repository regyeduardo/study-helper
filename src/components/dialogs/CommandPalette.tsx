import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon, type IconName } from '@/components/ui/Icon'
import { useLiveLibrary, usePathName } from '@/hooks/use-library-view'
import { useViewRoute } from '@/hooks/use-view-route'
import { paths } from '@/lib/paths'
import { toggleTheme } from '@/lib/theme'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'

interface Item {
  key: string
  icon: IconName
  title: string
  hint: string
  run(): void
}

const RESULT_LIMIT = 8

export function CommandPalette() {
  const ui = useUiStore()
  const navigate = useNavigate()
  const route = useViewRoute()
  const { files, folders } = useLiveLibrary()
  const contents = useLibraryStore(state => state.opened)
  const markOpened = useLibraryStore(state => state.markOpened)
  const openedAt = useLibraryStore(state => state.openedAt)
  const syncNow = useSyncStore(state => state.syncNow)
  const pathName = usePathName()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const matches = (text: string) => !q || text.toLowerCase().includes(q)
    const docs = files
      .filter(file => matches(`${file.name} ${file.tags.join(' ')} ${contents[file.id]?.content ?? ''}`))
      .sort((a, b) => (openedAt[b.id] ?? 0) - (openedAt[a.id] ?? 0) || b.updated.at.localeCompare(a.updated.at))
      .slice(0, RESULT_LIMIT)
      .map<Item>(file => ({
        key: `file:${file.id}`,
        icon: 'file',
        title: file.name,
        hint: pathName(file.folderId),
        run: () => {
          markOpened(file.id)
          navigate(paths.file(file.id))
        },
      }))
    const places = folders
      .filter(folder => matches(folder.name))
      .slice(0, RESULT_LIMIT)
      .map<Item>(folder => ({ key: `folder:${folder.id}`, icon: folder.isCourse ? 'layers' : 'folder', title: folder.name, hint: folder.isCourse ? 'curso' : 'pasta', run: () => navigate(paths.folder(folder.id)) }))
    const actions = (
      [
      { key: 'new', icon: 'plus', title: 'Novo conteúdo', hint: 'N', run: () => ui.open({ kind: 'new' }) },
      { key: 'record', icon: 'rec', title: 'Gravar reunião', hint: 'R', run: () => ui.open({ kind: 'record' }) },
      { key: 'import', icon: 'upload', title: 'Importar arquivo (.md, .zip, PDF, docx)', hint: '', run: () => ui.open({ kind: 'import' }) },
      ...(route.view === 'doc' && route.fileId ? [{ key: 'exam', icon: 'exam' as IconName, title: 'Fazer a prova deste documento', hint: '', run: () => ui.open({ kind: 'exam', fileId: route.fileId! }) }] : []),
      { key: 'sync', icon: 'sync', title: 'Sincronizar agora', hint: '', run: () => void syncNow() },
      { key: 'settings', icon: 'gear', title: 'Abrir configurações', hint: ',', run: () => ui.open({ kind: 'settings' }) },
      { key: 'activity', icon: 'clock', title: 'Ver o histórico do que o app fez', hint: '', run: () => ui.open({ kind: 'activity' }) },
      { key: 'review', icon: 'warn', title: 'Ir para Para revisar', hint: '', run: () => navigate(paths.review) },
      { key: 'favorites', icon: 'star', title: 'Ir para Favoritos', hint: '', run: () => navigate(paths.favorites) },
      { key: 'trash', icon: 'trash', title: 'Ir para a Lixeira', hint: '', run: () => navigate(paths.trash) },
      { key: 'theme', icon: 'layers', title: 'Trocar tema claro ou escuro', hint: '', run: toggleTheme },
      ] as Item[]
    ).filter(action => matches(action.title))
    return [...docs, ...places, ...actions]
  }, [query, files, folders, contents, openedAt, route, pathName])

  const run = (item: Item | undefined) => {
    if (!item) return
    ui.close()
    item.run()
  }

  return (
    <div className="scrim" onMouseDown={event => event.target === event.currentTarget && ui.close()}>
      <div className="pal" role="dialog" aria-label="Buscar ou fazer algo">
        <input
          autoFocus
          aria-label="Buscar arquivos, pastas e ações"
          placeholder="Buscar arquivos, pastas e ações…"
          value={query}
          autoComplete="off"
          onChange={event => {
            setQuery(event.target.value)
            setIndex(0)
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') (event.preventDefault(), setIndex(value => Math.min(items.length - 1, value + 1)))
            if (event.key === 'ArrowUp') (event.preventDefault(), setIndex(value => Math.max(0, value - 1)))
            if (event.key === 'Enter') run(items[index])
            if (event.key === 'Escape') ui.close()
          }}
        />
        <div className="res">
          <div className="grp">{query.trim() ? 'Resultados' : 'Abertos por último'}</div>
          {items.length ? (
            items.map((item, position) => (
              <button key={item.key} className={`it ${position === index ? 'on' : ''}`} onMouseEnter={() => setIndex(position)} onClick={() => run(item)}>
                <Icon name={item.icon} />
                <span className="t">{item.title}</span>
                <small>{item.hint}</small>
              </button>
            ))
          ) : (
            <div className="empty" style={{ padding: 18 }}>
              Nada encontrado.
            </div>
          )}
        </div>
        <div className="df" style={{ justifyContent: 'flex-start' }}>
          <span className="kbd">↑</span>
          <span className="kbd">↓</span>
          <span className="grow">navegar</span>
          <span className="kbd">Enter</span> abrir <span className="kbd">Esc</span> fechar
        </div>
      </div>
    </div>
  )
}
