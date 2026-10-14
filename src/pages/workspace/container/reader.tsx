import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { ReaderShell } from '@/components/layout/ReaderShell'
import { EmptyList } from '@/components/library/EmptyList'
import { Explorer } from '@/components/library/Explorer'
import { ReaderRow } from '@/components/library/FileRows'
import { FilterChips, SortSelect } from '@/components/library/Filters'
import { FolderTiles } from '@/components/library/FolderTiles'
import { SelectionBar } from '@/components/library/SelectionBar'
import { SHARING_TITLES, SharingView } from '@/components/library/SharingLists'
import { SharedBadge } from '@/components/library/SharedBadge'
import { SharedStatus } from '@/pages/shared'
import { TrashList } from '@/components/library/TrashList'
import { UpButton } from '@/components/library/Crumbs'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { hasGenerated, Inspector } from '@/components/reader/Inspector'
import { useLibraryView } from '@/hooks/use-library-view'
import type { ViewRoute } from '@/hooks/use-view-route'
import { isNarrowScreen } from '@/hooks/use-is-narrow'
import { MEDIA_LABEL, mediaLength, mediaOf, REVIEW_BELOW } from '@/lib/file-types'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'
import { ContinueCard, greeting, QuickActions, reviewSentence, todayText, useHomeData, useScrollerRef, WelcomeEmpty } from '@/pages/workspace/container/shared'

const TITLES = { folder: 'Biblioteca', review: 'Para revisar', favorites: 'Favoritos', trash: 'Lixeira', home: 'Início', doc: '', ...SHARING_TITLES }

function HomeBlock({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="home-block" aria-label={title}>
      <h3>
        {title}
        {hint && <span className="faint">{hint}</span>}
      </h3>
      <div className="home-items">{children}</div>
    </section>
  )
}

function HomeItem({ file, side, onOpen }: { file: FileMeta; side: string; onOpen(): void }) {
  return (
    <button className="home-item" onClick={onOpen}>
      <span>{file.name}</span>
      <span className="faint">{side}</span>
    </button>
  )
}

function Home() {
  const data = useHomeData()
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const navigate = useNavigate()
  const open = useUiStore(state => state.open)
  if (data.empty) return <WelcomeEmpty />
  const go = (file: FileMeta) => () => navigate(paths.file(file.id))
  const totalCards = data.cards.reduce((sum, item) => sum + item.due, 0)
  const mediaSide = (file: FileMeta) => [MEDIA_LABEL[mediaOf(file)], mediaLength(file.origin?.durationSeconds)].filter(Boolean).join(' · ')
  return (
    <div className="homegrid">
      <div>
        <div className="muted" style={{ fontSize: 13 }}>
          {todayText(timeZone)}
        </div>
        <h2 style={{ margin: '4px 0 0', fontSize: 24, fontWeight: 600, letterSpacing: '-.01em' }}>
          {greeting()}. {reviewSentence(data.review.length + totalCards)}
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
      <div className="home-blocks">
        {data.cards.length > 0 && (
          <HomeBlock title="Cartões para hoje" hint={`${totalCards} ${totalCards === 1 ? 'cartão' : 'cartões'} em ${data.cards.length} ${data.cards.length === 1 ? 'nota' : 'notas'}`}>
            {data.cards.map(item => (
              <HomeItem key={item.file.id} file={item.file} side={String(item.due)} onOpen={() => open({ kind: 'cards', fileId: item.file.id })} />
            ))}
          </HomeBlock>
        )}
        {data.review.length > 0 && (
          <HomeBlock title="Para revisar" hint={`domínio abaixo de ${REVIEW_BELOW}%`}>
            {data.review.map(file => (
              <HomeItem key={file.id} file={file} side={`${file.mastery}%`} onOpen={go(file)} />
            ))}
          </HomeBlock>
        )}
        {data.untranscribed.length > 0 && (
          <HomeBlock title="Gravações sem transcrição">
            {data.untranscribed.map(file => (
              <HomeItem key={file.id} file={file} side={mediaSide(file)} onOpen={go(file)} />
            ))}
          </HomeBlock>
        )}
        <HomeBlock title="Últimas notas">
          {data.latest.map(file => (
            <HomeItem key={file.id} file={file} side={mediaSide(file)} onOpen={go(file)} />
          ))}
        </HomeBlock>
      </div>
    </div>
  )
}

export function Library({ route }: { route: ViewRoute }) {
  const ui = useUiStore()
  const data = useLibraryView(route.view, route.folderId)
  const shared = useLibraryStore(state => state.sharedView)
  const q = ui.query.trim()
  const explorer = !data.isCourse && (route.view === 'folder' || route.view === 'review' || route.view === 'favorites')
  const title = q && !explorer ? `Resultados para “${ui.query}”` : route.view === 'folder' ? (data.folder?.name ?? 'Biblioteca') : TITLES[route.view]
  return (
    <>
      <div className="libhead">
        {data.browsing && route.folderId && (
          <span style={route.folderId === shared?.rootId ? { visibility: 'hidden' } : undefined}>
            <UpButton folderId={route.folderId} />
          </span>
        )}
        <h2>{title}</h2>
        {data.isCourse && <span className="crs">curso</span>}
        {shared && <SharedBadge label />}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {shared && <SharedBadge button />}
          {route.view !== 'trash' && !explorer && (
            <input className="input lib-search" style={{ height: 30 }} placeholder="Buscar no título e no texto" aria-label="Buscar" value={ui.query} onChange={event => ui.setQuery(event.target.value)} />
          )}
          {data.browsing && !shared && !explorer && (
            <button className="btn" onClick={() => ui.open({ kind: 'new-folder', parentId: route.folderId })}>
              <Icon name="folder" />
              Nova pasta
            </button>
          )}
          {data.isCourse && !shared && (
            <button className="btn" aria-pressed={ui.reorder} onClick={() => ui.set({ reorder: !ui.reorder })}>
              <Icon name="sort" />
              {ui.reorder ? 'Pronto' : 'Ordenar aulas'}
            </button>
          )}
          {data.browsing && route.folderId && !shared && !explorer && (
            <button className="btn quiet" onClick={() => ui.open({ kind: 'folder-exam', folderId: route.folderId })}>
              <Icon name="exam" />
              Prova da pasta
            </button>
          )}
        </span>
      </div>
      {route.view === 'trash' ? (
        <TrashList />
      ) : explorer ? (
        <Explorer view={route.view} folderId={route.folderId} />
      ) : (
        <div className="libbody">
          <FolderTiles tiles={data.tiles} />
          {!data.hideFiles && (
            <section className="blk">
              <h3 className="blk-h">
                <Icon name="file" />
                Arquivos <span>{data.isCourse ? data.courseGroups.reduce((sum, group) => sum + group.files.length, 0) : data.files.length}</span>
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
                            <Icon name="layers" /> {group.module.name} <span className="faint">{group.files.length} aulas · {formatBytes(group.bytes)}</span>
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
      <button className="ibtn" aria-pressed={ui.rightOpen && ui.panelAsked} onClick={() => ui.set(ui.rightOpen && ui.panelAsked ? { panelAsked: false } : { rightOpen: true, panelAsked: true })} aria-label="Painel da direita" title="Índice, notas e detalhes ( ] )">
        <Icon name="panel" />
      </button>
    </>
  )
}

export function ReaderWorkspace({ route }: { route: ViewRoute }) {
  const rightOpen = useUiStore(state => state.rightOpen)
  const panelAsked = useUiStore(state => state.panelAsked)
  const setUi = useUiStore(state => state.set)
  const generated = useLibraryStore(state => hasGenerated(state.files.find(file => file.id === route.fileId)))
  const scroller = useScrollerRef()
  useEffect(() => {
    if (isNarrowScreen()) setUi({ rightOpen: false, drawer: false })
  }, [route.fileId, route.folderId, route.view])
  useEffect(() => {
    if (!useUiStore.getState().panelAsked || useUiStore.getState().inspectorTab !== 'info') setUi({ panelAsked: false })
  }, [route.fileId])
  useEffect(() => {
    if (generated) setUi({ inspectorTab: 'mine' })
    else if (useUiStore.getState().inspectorTab === 'mine') setUi({ inspectorTab: 'toc' })
  }, [route.fileId, generated])
  if (route.view === 'doc' && route.fileId) {
    return (
      <ReaderShell docActions={<DocActions fileId={route.fileId} />}>
        <div className="docscroll" ref={scroller}>
          <DocumentBody fileId={route.fileId} />
        </div>
        {rightOpen && (generated || panelAsked) && (
          <aside className="insp" aria-label="Painel do documento">
            <Inspector fileId={route.fileId} />
          </aside>
        )}
      </ReaderShell>
    )
  }
  return (
    <ReaderShell>
      <div className="libwrap">
        {route.view === 'home' ? <Home /> : route.view === 'shared' ? <SharedStatus unavailable={Boolean(route.unavailable)} /> : route.view === 'shares' || route.view === 'sharedWithMe' ? <SharingView view={route.view} /> : <Library route={route} />}
      </div>
    </ReaderShell>
  )
}
