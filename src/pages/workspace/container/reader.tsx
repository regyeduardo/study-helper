import { useEffect } from 'react'

import { Icon } from '@/components/ui/Icon'
import { ReaderShell } from '@/components/layout/ReaderShell'
import { EmptyList } from '@/components/library/EmptyList'
import { ReaderRow } from '@/components/library/FileRows'
import { FilterChips, SortSelect } from '@/components/library/Filters'
import { FolderTiles } from '@/components/library/FolderTiles'
import { SelectionBar } from '@/components/library/SelectionBar'
import { TrashList } from '@/components/library/TrashList'
import { UpButton } from '@/components/library/Crumbs'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { Inspector } from '@/components/reader/Inspector'
import { useLibraryView } from '@/hooks/use-library-view'
import type { ViewRoute } from '@/hooks/use-view-route'
import { isNarrowScreen } from '@/hooks/use-is-narrow'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { ContinueCard, greeting, QuickActions, reviewSentence, todayText, useHomeData, useScrollerRef, WelcomeEmpty } from '@/pages/workspace/container/shared'

const TITLES = { folder: 'Biblioteca', review: 'Para revisar', favorites: 'Favoritos', trash: 'Lixeira', home: 'Início', doc: '' }

function Home() {
  const data = useHomeData()
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  if (data.empty) return <WelcomeEmpty />
  return (
    <div className="homegrid">
      <div>
        <div className="muted" style={{ fontSize: 13 }}>
          {todayText(timeZone)}
        </div>
        <h2 style={{ margin: '4px 0 0', fontSize: 24, fontWeight: 600, letterSpacing: '-.01em' }}>
          {greeting()}. {reviewSentence(data.review.length)}
        </h2>
      </div>
      <QuickActions fileForExam={data.continueReading} />
      {data.continueReading && (
        <div>
          <div className="nh" style={{ paddingLeft: 0 }}>
            Continuar lendo
          </div>
          <ContinueCard file={data.continueReading} />
        </div>
      )}
      {data.review.length > 0 && (
        <div>
          <div className="nh" style={{ paddingLeft: 0 }}>
            Para revisar{' '}
            <span className="faint" style={{ marginLeft: 6, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
              domínio abaixo de 70%
            </span>
          </div>
          <div className="list">
            {data.review.map(file => (
              <ReaderRow key={file.id} file={file} showWhere />
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="nh" style={{ paddingLeft: 0 }}>
          Mexidos por último
        </div>
        <div className="list">
          {data.recent.map(file => (
            <ReaderRow key={file.id} file={file} showWhere />
          ))}
        </div>
      </div>
    </div>
  )
}

export function Library({ route }: { route: ViewRoute }) {
  const ui = useUiStore()
  const data = useLibraryView(route.view, route.folderId)
  const q = ui.query.trim()
  const title = q ? `Resultados para “${ui.query}”` : route.view === 'folder' ? (data.folder?.name ?? 'Biblioteca') : TITLES[route.view]
  return (
    <>
      <div className="libhead">
        {data.browsing && route.folderId && <UpButton folderId={route.folderId} />}
        <h2>{title}</h2>
        {data.isCourse && <span className="crs">curso</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {route.view !== 'trash' && (
            <input className="input lib-search" style={{ height: 30 }} placeholder="Buscar no título e no texto" aria-label="Buscar" value={ui.query} onChange={event => ui.setQuery(event.target.value)} />
          )}
          {data.browsing && (
            <button className="btn" onClick={() => ui.open({ kind: 'new-folder', parentId: route.folderId })}>
              <Icon name="folder" />
              Nova pasta
            </button>
          )}
          {data.isCourse && (
            <button className="btn" aria-pressed={ui.reorder} onClick={() => ui.set({ reorder: !ui.reorder })}>
              <Icon name="sort" />
              {ui.reorder ? 'Pronto' : 'Ordenar aulas'}
            </button>
          )}
          {data.browsing && route.folderId && (
            <button className="btn quiet" onClick={() => ui.open({ kind: 'folder-exam', folderId: route.folderId })}>
              <Icon name="exam" />
              Prova da pasta
            </button>
          )}
        </span>
      </div>
      {route.view === 'trash' ? (
        <TrashList />
      ) : (
        <div className="libbody">
          <FolderTiles tiles={data.tiles} />
          {!data.hideFiles && (
            <section className="blk">
              <h3 className="blk-h">
                <Icon name="file" />
                Arquivos <span>{data.files.length}</span>
              </h3>
              <div className="filters" style={{ margin: 0 }}>
                <FilterChips />
                {!data.isCourse && <SortSelect />}
              </div>
              <div className="selwrap" style={{ margin: 0 }}>
                <SelectionBar />
              </div>
              <div className="list">
                {data.isCourse
                  ? data.courseGroups.map(group => (
                      <div key={group.module?.id ?? 'root'}>
                        {group.module && (
                          <div className="grp-h gh">
                            <Icon name="layers" /> {group.module.name} <span className="faint">{group.files.length} aulas</span>
                          </div>
                        )}
                        {group.files.map(file => (
                          <ReaderRow key={file.id} file={file} showWhere={false} inCourse siblings={group.files} />
                        ))}
                      </div>
                    ))
                  : data.files.map(file => <ReaderRow key={file.id} file={file} showWhere={!data.browsing} />)}
                {!data.files.length && !data.isCourse && <EmptyList filtering={data.filtering} browsing={data.browsing} hasTiles={data.tiles.length > 0} />}
              </div>
            </section>
          )}
          {data.browsing && (
            <p className="faint drag-hint" style={{ margin: 0, padding: '0 2px', fontSize: 12.5 }}>
              Para mover, arraste um arquivo até uma pasta ou até o caminho no topo.
            </p>
          )}
        </div>
      )}
    </>
  )
}

function DocActions({ fileId }: { fileId: string }) {
  const ui = useUiStore()
  return (
    <>
      <button className="btn quiet" onClick={() => ui.open({ kind: 'exam', fileId })}>
        <Icon name="exam" />
        <span className="lbl">Prova</span>
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
      <button className="ibtn" aria-pressed={ui.rightOpen} onClick={() => ui.set({ rightOpen: !ui.rightOpen })} aria-label="Painel da direita" title="Índice, notas e informações ( ] )">
        <Icon name="panel" />
      </button>
    </>
  )
}

export function ReaderWorkspace({ route }: { route: ViewRoute }) {
  const rightOpen = useUiStore(state => state.rightOpen)
  const setUi = useUiStore(state => state.set)
  const scroller = useScrollerRef()
  useEffect(() => {
    if (isNarrowScreen()) setUi({ rightOpen: false, drawer: false })
  }, [route.fileId, route.folderId, route.view])
  if (route.view === 'doc' && route.fileId) {
    return (
      <ReaderShell docActions={<DocActions fileId={route.fileId} />}>
        <div className="docscroll" ref={scroller}>
          <DocumentBody fileId={route.fileId} />
        </div>
        {rightOpen && (
          <aside className="insp" aria-label="Painel do documento">
            <Inspector fileId={route.fileId} />
          </aside>
        )}
      </ReaderShell>
    )
  }
  return (
    <ReaderShell>
      <div className="libwrap">{route.view === 'home' ? <Home /> : <Library route={route} />}</div>
    </ReaderShell>
  )
}
