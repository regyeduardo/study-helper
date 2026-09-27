import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { ColumnsShell } from '@/components/layout/OtherShells'
import { Crumbs, UpButton } from '@/components/library/Crumbs'
import { EmptyList } from '@/components/library/EmptyList'
import { ColumnsCard, excerptOf } from '@/components/library/FileRows'
import { FilterChips } from '@/components/library/Filters'
import { FolderTiles } from '@/components/library/FolderTiles'
import { SelectionBar } from '@/components/library/SelectionBar'
import { TrashList } from '@/components/library/TrashList'
import { useFileActions } from '@/components/library/use-file-actions'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { InspectorBody, InspectorTabs } from '@/components/reader/Inspector'
import { useLibraryView } from '@/hooks/use-library-view'
import type { ViewRoute } from '@/hooks/use-view-route'
import { paths, type View } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { type InspectorTab, useUiStore } from '@/stores/ui'
import { useScrollerRef } from '@/pages/workspace/container/shared'

const TITLES: Record<View, string> = { folder: 'Biblioteca', review: 'Para revisar', favorites: 'Favoritos', trash: 'Lixeira', home: 'Biblioteca', doc: 'Biblioteca' }

function ListColumn({ view, folderId, currentId }: { view: View; folderId: string | null; currentId: string | null }) {
  const ui = useUiStore()
  const data = useLibraryView(view, folderId)
  const contents = useLibraryStore(state => state.opened)
  const trashCount = useLibraryStore(state => state.files.filter(file => file.deletedAt).length)
  const title = view === 'folder' ? (data.folder?.name ?? 'Biblioteca') : TITLES[view]
  return (
    <section className="col-list" aria-label="Lista">
      <div className="lh">
        {view === 'folder' && <Crumbs folderId={folderId} style={{ fontSize: 12 }} />}
        <div className="t">
          <button className="ibtn back-mob" onClick={() => ui.set({ columnsPane: 'nav' })} aria-label="Coleções">
            <Icon name="back" />
          </button>
          {view === 'folder' && <UpButton folderId={folderId} />}
          <h2>{title}</h2>
          <span className="faint" style={{ fontSize: 12 }}>
            {view === 'trash' ? trashCount : data.files.length}
          </span>
          {data.isCourse && (
            <button className="ibtn" aria-pressed={ui.reorder} onClick={() => ui.set({ reorder: !ui.reorder })} aria-label="Ordenar aulas" title="Ordenar aulas">
              <Icon name="sort" />
            </button>
          )}
          <button className="ibtn" onClick={() => ui.open({ kind: 'palette' })} aria-label="Buscar ou fazer algo" title="Ctrl K">
            <Icon name="dots" />
          </button>
          <button className="ibtn mob-only" onClick={() => ui.open({ kind: 'new', folderId })} aria-label="Novo conteúdo">
            <Icon name="plus" />
          </button>
        </div>
        {view !== 'trash' && (
          <>
            <label className="srch2">
              <Icon name="search" />
              <input aria-label="Buscar" placeholder="Buscar no título e no texto" value={ui.query} onChange={event => ui.setQuery(event.target.value)} />
            </label>
            <div className="fl">
              <FilterChips />
            </div>
          </>
        )}
      </div>
      <div className="selwrap">
        <SelectionBar hideSingle />
      </div>
      <div className="items">
        {view === 'trash' ? (
          <TrashList compact />
        ) : (
          <>
            {data.tiles.length > 0 && (
              <div style={{ padding: '8px 4px 0' }}>
                <FolderTiles tiles={data.tiles} />
              </div>
            )}
            {!data.hideFiles && (
              <section className="blk" style={{ padding: '4px 4px 0', gap: 4 }}>
                <h3 className="blk-h" style={{ padding: '4px 6px' }}>
                  <Icon name="file" />
                  Arquivos <span>{data.files.length}</span>
                  {data.browsing && (
                    <button className="btn quiet" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, height: 26 }} onClick={() => ui.open({ kind: 'new-folder', parentId: folderId })}>
                      <Icon name="folder" />
                      Nova pasta
                    </button>
                  )}
                </h3>
                <div>
                  {data.isCourse
                    ? data.courseGroups.map(group => (
                        <div key={group.module?.id ?? 'root'}>
                          {group.module && (
                            <div className="grp-h gh" style={{ margin: '10px 0 4px' }}>
                              <Icon name="layers" /> {group.module.name} <span className="faint">{group.files.length} aulas</span>
                            </div>
                          )}
                          {group.files.map(file => (
                            <ColumnsCard key={file.id} file={file} showWhere={false} currentId={currentId} excerpt={excerptOf(contents[file.id]?.content)} siblings={group.files} />
                          ))}
                        </div>
                      ))
                    : data.files.map(file => <ColumnsCard key={file.id} file={file} showWhere={!data.browsing} currentId={currentId} excerpt={excerptOf(contents[file.id]?.content)} />)}
                  {!data.files.length && !data.isCourse && <EmptyList filtering={data.filtering} browsing={data.browsing} hasTiles={data.tiles.length > 0} />}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function DocColumn({ fileId }: { fileId: string | null }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const meta = useLibraryStore(state => (fileId ? state.files.find(file => file.id === fileId) : undefined))
  const folderName = useLibraryStore(state => state.folders.find(folder => folder.id === meta?.folderId)?.name ?? 'Biblioteca')
  const { toggleFavorite } = useFileActions()
  const scroller = useScrollerRef()
  if (!fileId || !meta) {
    return (
      <section className="col-doc" aria-label="Documento">
        <div className="empty">
          <Icon name="book" />
          <div>Escolha um arquivo na lista para ler aqui.</div>
          <div className="faint" style={{ fontSize: 12.5 }}>
            Clique de novo, no × ou aperte Esc para desmarcar.
          </div>
        </div>
      </section>
    )
  }
  const sheet = (tab: InspectorTab) => ui.set(ui.columnsSheet && ui.inspectorTab === tab ? { columnsSheet: false } : { columnsSheet: true, inspectorTab: tab })
  const close = () => {
    ui.set({ columnsSheet: false, columnsPane: 'list' })
    navigate(paths.folder(meta.folderId))
  }
  return (
    <section className="col-doc" aria-label="Documento">
      <div className="dtop">
        <button className="ibtn back-mob" onClick={() => ui.set({ columnsPane: 'list' })} aria-label="Voltar para a lista">
          <Icon name="back" />
        </button>
        <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
          {folderName}
        </span>
        <div className="spacer" />
        <button className="btn quiet" onClick={() => ui.open({ kind: 'exam', fileId })}>
          <Icon name="exam" />
          <span className="lbl">Prova</span>
        </button>
        <button className="ibtn" aria-pressed={ui.columnsSheet && ui.inspectorTab === 'toc'} onClick={() => sheet('toc')} aria-label="Índice">
          <Icon name="list" />
        </button>
        <button className="ibtn" aria-pressed={ui.columnsSheet && ui.inspectorTab === 'notes'} onClick={() => sheet('notes')} aria-label="Notas">
          <Icon name="note" />
        </button>
        <button className="ibtn" aria-pressed={ui.columnsSheet && ui.inspectorTab === 'info'} onClick={() => sheet('info')} aria-label="Informações">
          <Icon name="info" />
        </button>
        <button className={`ibtn star ${meta.favorite ? 'on' : ''}`} onClick={() => void toggleFavorite(meta)} aria-label={meta.favorite ? 'Tirar dos favoritos' : 'Favoritar'}>
          <Icon name="star" />
        </button>
        <button
          className="ibtn"
          onClick={event => {
            const box = event.currentTarget.getBoundingClientRect()
            ui.openMenu({ kind: 'file', id: fileId, x: box.left - 200, y: box.bottom + 4 })
          }}
          aria-label="Mais opções do documento"
        >
          <Icon name="dots" />
        </button>
        <button className="ibtn mob-only" onClick={() => ui.open({ kind: 'new', folderId: meta.folderId })} aria-label="Novo conteúdo">
          <Icon name="plus" />
        </button>
        <button className="ibtn" onClick={close} aria-label="Fechar o documento">
          <Icon name="x" />
        </button>
      </div>
      <div className="dscroll" ref={scroller}>
        <DocumentBody fileId={fileId} />
      </div>
      {ui.columnsSheet && (
        <div className="sheet">
          <InspectorTabs tab={ui.inspectorTab} onTab={tab => ui.set({ inspectorTab: tab })} />
          <div className="insp-body">
            <InspectorBody fileId={fileId} tab={ui.inspectorTab} />
          </div>
        </div>
      )}
    </section>
  )
}

export function ColumnsWorkspace({ route }: { route: ViewRoute }) {
  const docFolder = useLibraryStore(state => (route.fileId ? (state.files.find(file => file.id === route.fileId)?.folderId ?? null) : null))
  const view: View = route.view === 'doc' ? 'folder' : route.view === 'home' ? 'folder' : route.view
  const folderId = route.view === 'doc' ? docFolder : route.folderId
  return (
    <ColumnsShell>
      <ListColumn view={view} folderId={folderId} currentId={route.fileId} />
      <DocColumn fileId={route.view === 'doc' ? route.fileId : null} />
    </ColumnsShell>
  )
}
