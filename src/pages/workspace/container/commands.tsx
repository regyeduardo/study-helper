import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta, FileType } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { CommandsShell } from '@/components/layout/OtherShells'
import { useCounts } from '@/components/layout/ReaderShell'
import { MasteryMeter, TypeDot } from '@/components/library/Badges'
import { EmptyList } from '@/components/library/EmptyList'
import { CommandsRow } from '@/components/library/FileRows'
import { FolderTiles } from '@/components/library/FolderTiles'
import { SelectionBar } from '@/components/library/SelectionBar'
import { SHARING_TITLES, SharingView } from '@/components/library/SharingLists'
import { SharedBadge } from '@/components/library/SharedBadge'
import { SharedStatus } from '@/pages/shared'
import { TrashList } from '@/components/library/TrashList'
import { useFileActions } from '@/components/library/use-file-actions'
import { DocumentBody, DocumentHead } from '@/components/reader/DocumentArticle'
import GithubMarkdownView from '@/components/reader/GithubMarkdownView'
import { InspectorBody, InspectorTabs } from '@/components/reader/Inspector'
import { useLibraryView, useLiveLibrary, usePathName } from '@/hooks/use-library-view'
import { useDocument } from '@/hooks/use-document'
import type { ViewRoute } from '@/hooks/use-view-route'
import { FILE_TYPES, typeInfo } from '@/lib/file-types'
import { paths, type View } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { type GroupKey, type SortKey, useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'
import { useScrollerRef } from '@/pages/workspace/container/shared'

function FilterBar() {
  const ui = useUiStore()
  const { files } = useLiveLibrary()
  const [menu, setMenu] = useState<{ kind: 'filter' | 'display'; x: number; y: number } | null>(null)
  const tags = useMemo(() => [...new Set(files.flatMap(file => file.tags))].sort(), [files])
  const anchor = (kind: 'filter' | 'display') => (event: React.MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    setMenu(menu?.kind === kind ? null : { kind, x: box.left, y: box.bottom + 6 })
  }
  const chips = []
  if (ui.types.size)
    chips.push(
      <span key="type" className="fchip">
        <span>Tipo</span>
        <span>
          é <b>{[...ui.types].map(type => typeInfo(type).label).join(' ou ')}</b>
        </span>
        <button onClick={() => [...ui.types].forEach(type => ui.toggleType(type))} aria-label="Tirar filtro de tipo">
          <Icon name="x" />
        </button>
      </span>,
    )
  if (ui.lowMastery)
    chips.push(
      <span key="low" className="fchip">
        <span>Domínio</span>
        <span>
          abaixo de <b>60%</b>
        </span>
        <button onClick={ui.toggleLowMastery} aria-label="Tirar filtro de domínio">
          <Icon name="x" />
        </button>
      </span>,
    )
  if (ui.tag)
    chips.push(
      <span key="tag" className="fchip">
        <span>Tag</span>
        <span>
          é <b>#{ui.tag}</b>
        </span>
        <button onClick={() => ui.setTag(null)} aria-label="Tirar filtro de tag">
          <Icon name="x" />
        </button>
      </span>,
    )
  if (ui.query)
    chips.push(
      <span key="q" className="fchip">
        <span>Texto</span>
        <span>
          contém <b>{ui.query}</b>
        </span>
        <button onClick={() => ui.setQuery('')} aria-label="Tirar a busca">
          <Icon name="x" />
        </button>
      </span>,
    )
  return (
    <div className="fbar">
      {chips}
      <input className="input fbar-search" style={{ height: 26, padding: '2px 8px' }} aria-label="Buscar" placeholder="Filtrar por texto" value={ui.query} onChange={event => ui.setQuery(event.target.value)} />
      <button className="btn quiet" onClick={anchor('filter')}>
        <Icon name="filter" />
        Filtro
      </button>
      {chips.length > 0 && (
        <button className="btn quiet" onClick={ui.clearFilters}>
          Limpar
        </button>
      )}
      <span style={{ flex: 1 }} />
      <button className="btn quiet" onClick={anchor('display')}>
        <Icon name="sort" />
        Exibição
      </button>
      {menu?.kind === 'filter' && (
        <Popover x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="Filtro">
          <div className="mh">Tipo</div>
          {FILE_TYPES.map(type => (
            <button key={type.id} className="mi" onClick={() => ui.toggleType(type.id as FileType)}>
              <span className={`check ${ui.types.has(type.id) ? 'on' : ''}`}>{ui.types.has(type.id) && <Icon name="check" />}</span>
              <span className={`tdot ${type.tone}`} style={{ color: 'var(--fg)', fontSize: 13 }}>
                {type.label}
              </span>
            </button>
          ))}
          <div className="hr" />
          <button className="mi" onClick={ui.toggleLowMastery}>
            <span className={`check ${ui.lowMastery ? 'on' : ''}`}>{ui.lowMastery && <Icon name="check" />}</span>
            Domínio abaixo de 60%
          </button>
          {tags.length > 0 && <div className="mh">Tag</div>}
          {tags.map(tag => (
            <button key={tag} className="mi" onClick={() => ui.setTag(tag)}>
              <span className={`check ${ui.tag === tag ? 'on' : ''}`}>{ui.tag === tag && <Icon name="check" />}</span>#{tag}
            </button>
          ))}
        </Popover>
      )}
      {menu?.kind === 'display' && (
        <Popover x={menu.x - 120} y={menu.y} onClose={() => setMenu(null)} label="Exibição">
          <div className="mh">Agrupar por</div>
          {(
            [
              ['none', 'Nada'],
              ['type', 'Tipo'],
              ['folder', 'Pasta'],
            ] as [GroupKey, string][]
          ).map(([key, label]) => (
            <button key={key} className={`mi ${ui.group === key ? 'on' : ''}`} onClick={() => (ui.setGroup(key), setMenu(null))}>
              {ui.group === key ? <Icon name="check" /> : <span style={{ width: 16 }} />}
              {label}
            </button>
          ))}
          <div className="mh">Ordenar por</div>
          {(
            [
              ['recent', 'Mais recentes'],
              ['title', 'Título (A–Z)'],
              ['mastery', 'Menor domínio primeiro'],
            ] as [SortKey, string][]
          ).map(([key, label]) => (
            <button key={key} className={`mi ${ui.sort === key ? 'on' : ''}`} onClick={() => (ui.setSort(key), setMenu(null))}>
              {ui.sort === key ? <Icon name="check" /> : <span style={{ width: 16 }} />}
              {label}
            </button>
          ))}
        </Popover>
      )}
    </div>
  )
}

function Table({ route }: { route: ViewRoute }) {
  const ui = useUiStore()
  const data = useLibraryView(route.view, route.folderId)
  const pathName = usePathName()
  const { folders } = useLiveLibrary()
  const head = (
    <div className="tr th">
      <span />
      <span>Título</span>
      <span className="hide-s">Tipo</span>
      <span className="hide-s">Domínio</span>
      <span className="hide-s">Alterado</span>
      <span />
    </div>
  )
  if (route.view === 'trash') {
    return (
      <div className="tbl" style={{ padding: 12 }}>
        <TrashList />
      </div>
    )
  }
  const rows = (files: FileMeta[], inCourse = false) => files.map(file => <CommandsRow key={file.id} file={file} showWhere={!data.browsing} inCourse={inCourse} siblings={inCourse ? files : undefined} />)
  let body: React.ReactNode
  if (data.isCourse) {
    body = data.courseGroups.map(group => (
      <div key={group.module?.id ?? 'root'}>
        {group.module && (
          <div className="gh">
            <Icon name="layers" />
            {group.module.name}
            <span className="faint">
              {group.files.length} · {formatBytes(group.bytes)}
            </span>
          </div>
        )}
        {rows(group.files, true)}
      </div>
    ))
  } else if (ui.group === 'type') {
    body = FILE_TYPES.map(type => {
      const items = data.files.filter(file => file.type === type.id)
      return items.length ? (
        <div key={type.id}>
          <div className="gh">
            <TypeDot type={type.id} />
            <span className="faint">{items.length}</span>
          </div>
          {rows(items)}
        </div>
      ) : null
    })
  } else if (ui.group === 'folder') {
    const ids = [null, ...folders.map(folder => folder.id)]
    body = ids.map(id => {
      const items = data.files.filter(file => file.folderId === id)
      return items.length ? (
        <div key={id ?? 'root'}>
          <div className="gh">
            <Icon name="folder" />
            {pathName(id)}
            <span className="faint">{items.length}</span>
          </div>
          {rows(items)}
        </div>
      ) : null
    })
  } else body = rows(data.files)
  return (
    <div className="tbl">
      {data.tiles.length > 0 && (
        <div style={{ padding: '14px 12px 0' }}>
          <FolderTiles tiles={data.tiles} />
        </div>
      )}
      {!data.hideFiles && (
        <>
          <h3 className="blk-h" style={{ padding: '12px 12px 8px' }}>
            <Icon name="file" />
            Arquivos <span>{data.files.length}</span>
          </h3>
          {head}
          {body}
          {!data.files.length && !data.isCourse && <EmptyList filtering={data.filtering} browsing={data.browsing} hasTiles={data.tiles.length > 0} />}
        </>
      )}
    </div>
  )
}

function Peek({ fileId }: { fileId: string }) {
  const ui = useUiStore()
  const { meta, opened } = useDocument(fileId)
  const { openFile } = useFileActions()
  if (!meta) return null
  return (
    <aside className="peek" aria-label="Espiar documento">
      <div className="ph">
        <button className="ibtn" onClick={() => ui.set({ peekId: null })} aria-label="Fechar e desmarcar">
          <Icon name="x" />
        </button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Espiando
        </span>
        <span className="spacer" />
        <button className="btn quiet" onClick={() => ui.open({ kind: 'exam', fileId })}>
          <Icon name="exam" />
          <span className="lbl">Prova</span>
        </button>
        <button className="btn" onClick={() => openFile(meta)}>
          <span className="lbl">Abrir inteiro</span> <Icon name="fwd" />
        </button>
      </div>
      <div className="pscroll">
        <DocumentHead meta={meta} onInfo={() => openFile(meta)} />
        {meta.status === 'pending' ? <p className="muted">Aula ainda não escrita. Abra inteiro para gerar.</p> : opened?.content ? <GithubMarkdownView markdown={opened.content} /> : <div className="muted">Abrindo…</div>}
      </div>
    </aside>
  )
}

function Properties({ fileId }: { fileId: string }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const pathName = usePathName()
  const { folders } = useLiveLibrary()
  const meta = library.files.find(file => file.id === fileId)
  if (!meta) return null
  return (
    <aside className="props" aria-label="Propriedades">
      <div className="sec">
        <h4>Propriedades</h4>
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="prop">
            <span>Tipo</span>
            <select aria-label="Tipo" value={meta.type} onChange={event => void library.updateFile(meta.id, { type: event.target.value as FileType })}>
              {FILE_TYPES.map(type => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span>Pasta</span>
            <select aria-label="Pasta" value={meta.folderId ?? ''} onChange={event => void library.updateFile(meta.id, { folderId: event.target.value || null })}>
              <option value="">Biblioteca</option>
              {folders.map(folder => (
                <option key={folder.id} value={folder.id}>
                  {pathName(folder.id)}
                </option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span>Domínio</span>
            <span>
              <MasteryMeter value={meta.mastery} />
            </span>
          </div>
          <div className="prop">
            <span>Favorito</span>
            <span>
              <button className="btn" onClick={() => void library.updateFile(meta.id, { favorite: !meta.favorite })}>
                <Icon name="star" className={meta.favorite ? 'star on' : ''} />
                {meta.favorite ? 'Sim' : 'Não'}
              </button>
            </span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => ui.open({ kind: 'exam', fileId })}>
          <Icon name="exam" />
          Fazer a prova
        </button>
        <button
          className="btn quiet"
          onClick={event => {
            const box = event.currentTarget.getBoundingClientRect()
            ui.openMenu({ kind: 'file', id: fileId, x: box.left, y: box.bottom + 4 })
          }}
        >
          <Icon name="dots" />
          Mais
        </button>
      </div>
      <InspectorTabs tab={ui.inspectorTab} onTab={tab => ui.set({ inspectorTab: tab })} />
      <div style={{ display: 'grid', gap: 18 }}>
        <InspectorBody fileId={fileId} tab={ui.inspectorTab} />
      </div>
    </aside>
  )
}

export function CommandsWorkspace({ route }: { route: ViewRoute }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const counts = useCounts()
  const scroller = useScrollerRef()
  const data = useLibraryView(route.view === 'home' ? 'folder' : route.view, route.folderId)
  const shared = useLibraryStore(state => state.sharedView)
  const effective: ViewRoute = route.view === 'home' ? { view: 'folder', folderId: null, fileId: null } : route
  if (route.view === 'shared') {
    return (
      <CommandsShell>
        <div className="body">
          <div className="docscroll" ref={scroller}>
            <SharedStatus unavailable={Boolean(route.unavailable)} />
          </div>
        </div>
      </CommandsShell>
    )
  }
  if (route.view === 'doc' && route.fileId) {
    return (
      <CommandsShell>
        <div className="body">
          <div className="docgrid">
            <div className="docscroll" ref={scroller}>
              <DocumentBody fileId={route.fileId} />
            </div>
            <Properties fileId={route.fileId} />
          </div>
        </div>
      </CommandsShell>
    )
  }
  const view = effective.view
  const tab = (target: View, label: string, to: string, count: number) => (
    <button className="vw" aria-pressed={view === target} onClick={() => navigate(to)}>
      {label}
      <span className="n">{count}</span>
    </button>
  )
  return (
    <CommandsShell>
      <nav className="views" aria-label="Visões">
        {tab('folder', 'Biblioteca', paths.library, counts.library)}
        {tab('review', 'Para revisar', paths.review, counts.review)}
        {tab('favorites', 'Favoritos', paths.favorites, counts.favorites)}
        {tab('trash', 'Lixeira', paths.trash, counts.trash)}
        {tab('shares', SHARING_TITLES.shares, paths.shares, counts.shares)}
        {tab('sharedWithMe', SHARING_TITLES.sharedWithMe, paths.sharedWithMe, counts.sharedWithMe)}
        {data.browsing && !shared && (
          <button className="btn quiet" onClick={() => ui.open({ kind: 'new-folder', parentId: effective.folderId })}>
            <Icon name="folder" />
            Nova pasta
          </button>
        )}
        <span className="spacer" />
        <SharedBadge />
        {data.isCourse && !shared && (
          <button className="btn quiet" aria-pressed={ui.reorder} onClick={() => ui.set({ reorder: !ui.reorder })}>
            <Icon name="sort" />
            {ui.reorder ? 'Pronto' : 'Ordenar aulas'}
          </button>
        )}
        {data.browsing && effective.folderId && (
          <button className="btn quiet" onClick={() => ui.open({ kind: 'folder-exam', folderId: effective.folderId })}>
            <Icon name="exam" />
            Prova da pasta
          </button>
        )}
        <button className="btn quiet" onClick={() => ui.open({ kind: 'settings' })}>
          <Icon name="gear" />
          Configurações
        </button>
      </nav>
      {view !== 'trash' && view !== 'shares' && view !== 'sharedWithMe' && <FilterBar />}
      <div className="body">
        {view === 'shares' || view === 'sharedWithMe' ? (
          <div className="tbl" style={{ padding: 12 }}>
            <SharingView view={view} heading={false} />
          </div>
        ) : (
          <Table route={effective} />
        )}
        {ui.peekId && <Peek fileId={ui.peekId} />}
        {ui.selection.size > 0 && (
          <div className="floatbar">
            <SelectionBar />
          </div>
        )}
      </div>
    </CommandsShell>
  )
}
