import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { FocusShell } from '@/components/layout/OtherShells'
import { Crumbs, UpButton } from '@/components/library/Crumbs'
import { EmptyList } from '@/components/library/EmptyList'
import { FocusRow } from '@/components/library/FileRows'
import { FilterChips, SortSelect } from '@/components/library/Filters'
import { FolderTiles } from '@/components/library/FolderTiles'
import { SelectionBar } from '@/components/library/SelectionBar'
import { TrashList } from '@/components/library/TrashList'
import { useFileActions } from '@/components/library/use-file-actions'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { InspectorBody } from '@/components/reader/Inspector'
import { useLibraryView, useLiveLibrary } from '@/hooks/use-library-view'
import type { ViewRoute } from '@/hooks/use-view-route'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { type InspectorTab, useUiStore } from '@/stores/ui'
import { ContinueCard, QuickActions, reviewSentence, useHomeData, useScrollerRef, WelcomeEmpty } from '@/pages/workspace/container/shared'

function Home() {
  const data = useHomeData()
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const { folders, files } = useLiveLibrary()
  if (data.empty) return <WelcomeEmpty />
  const course = folders.find(folder => folder.isCourse && files.some(file => file.status === 'pending' && isInside(file.folderId, folder.id, folders)))
  const courseFiles = course ? files.filter(file => isInside(file.folderId, course.id, folders)).sort((a, b) => a.position - b.position) : []
  const date = new Date().toLocaleDateString('pt-BR', { timeZone, weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })
  return (
    <div className="home">
      <div>
        <div className="date">{date}</div>
        <h2>{data.continueReading ? `Hoje: continuar “${data.continueReading.name}”. ${reviewSentence(data.review.length)}` : reviewSentence(data.review.length)}</h2>
      </div>
      {data.continueReading && (
        <div className="sect">
          <h3>
            Continuar <span className="ln" />
          </h3>
          <ContinueCard file={data.continueReading} className="cont4" />
        </div>
      )}
      {data.review.length > 0 && (
        <div className="sect">
          <h3>
            Revisar <span className="ln" />
            <span style={{ textTransform: 'none', letterSpacing: 0 }}>{data.review.length}</span>
          </h3>
          {data.review.map(file => (
            <FocusRow key={file.id} file={file} showWhere />
          ))}
        </div>
      )}
      <div className="sect">
        <h3>
          Fazer <span className="ln" />
        </h3>
        <QuickActions fileForExam={data.continueReading} />
      </div>
      {course && (
        <div className="sect">
          <h3>
            Curso em andamento: {course.name} <span className="ln" />
          </h3>
          {courseFiles.map((file, index) => (
            <FocusRow key={file.id} file={file} showWhere={false} inCourse order={index + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function isInside(folderId: string | null, ancestorId: string, folders: { id: string; parentId: string | null }[]): boolean {
  let current = folderId
  for (let depth = 0; current && depth < 64; depth++) {
    if (current === ancestorId) return true
    current = folders.find(folder => folder.id === current)?.parentId ?? null
  }
  return false
}

function Library({ route }: { route: ViewRoute }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const data = useLibraryView(route.view, route.folderId)
  const pill = (active: boolean, icon: Parameters<typeof Icon>[0]['name'], label: string, to: string) => (
    <button className="chip" aria-pressed={active} onClick={() => navigate(to)}>
      <Icon name={icon} />
      {label}
    </button>
  )
  return (
    <div className="lib">
      <label className="find">
        <Icon name="search" />
        <input aria-label="Procurar" placeholder="Procurar em todos os arquivos" value={ui.query} onChange={event => ui.setQuery(event.target.value)} />
      </label>
      <div className="fl">
        {pill(route.view === 'folder', 'book', 'Biblioteca', paths.library)}
        {pill(route.view === 'review', 'warn', 'Para revisar', paths.review)}
        {pill(route.view === 'favorites', 'star', 'Favoritos', paths.favorites)}
        {pill(route.view === 'trash', 'trash', 'Lixeira', paths.trash)}
      </div>
      {data.browsing && (
        <div className="crumbs" style={{ fontSize: 14 }}>
          <UpButton folderId={route.folderId} />
          <Crumbs folderId={route.folderId} />
          <span style={{ flex: 1 }} />
          <button className="btn quiet" onClick={() => ui.open({ kind: 'new-folder', parentId: route.folderId })}>
            <Icon name="folder" />
            Nova pasta
          </button>
        </div>
      )}
      {route.view === 'trash' ? (
        <TrashList />
      ) : (
        <>
          <FolderTiles tiles={data.tiles} />
          {!data.hideFiles && (
            <section className="blk">
              <h3 className="blk-h">
                <Icon name="file" />
                Arquivos <span>{data.files.length}</span>
              </h3>
              <div className="fl">
                <FilterChips />
                {data.isCourse ? (
                  <button className="btn quiet" aria-pressed={ui.reorder} onClick={() => ui.set({ reorder: !ui.reorder })} style={{ marginLeft: 'auto' }}>
                    <Icon name="sort" />
                    {ui.reorder ? 'Pronto' : 'Ordenar aulas'}
                  </button>
                ) : (
                  <SortSelect />
                )}
              </div>
              <SelectionBar />
              <div>
                {data.isCourse
                  ? data.courseGroups.map(group => (
                      <div key={group.module?.id ?? 'root'} className="sect" style={{ marginTop: 14 }}>
                        {group.module && (
                          <h3>
                            {group.module.name} <span className="ln" />
                          </h3>
                        )}
                        {group.files.map((file, index) => (
                          <FocusRow key={file.id} file={file} showWhere={false} inCourse order={index + 1} siblings={group.files} />
                        ))}
                      </div>
                    ))
                  : data.files.map(file => <FocusRow key={file.id} file={file} showWhere={!data.browsing} />)}
                {!data.files.length && !data.isCourse && <EmptyList filtering={data.filtering} browsing={data.browsing} hasTiles={data.tiles.length > 0} />}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Dock({ fileId }: { fileId: string }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const { toggleFavorite } = useFileActions()
  const pop = (tab: InspectorTab) => ui.set({ focusPop: ui.focusPop === tab ? null : tab })
  if (!meta) return null
  return (
    <>
      <div className="dock" role="toolbar" aria-label="Documento">
        <button onClick={() => navigate(-1)}>
          <Icon name="back" />
          Voltar
        </button>
        <span className="sep" />
        <button aria-pressed={ui.focusPop === 'toc'} onClick={() => pop('toc')}>
          <Icon name="list" />
          Índice
        </button>
        <button aria-pressed={ui.focusPop === 'notes'} onClick={() => pop('notes')}>
          <Icon name="note" />
          Notas
        </button>
        <button aria-pressed={ui.focusPop === 'info'} onClick={() => pop('info')}>
          <Icon name="info" />
          Informações
        </button>
        <span className="sep" />
        <button onClick={() => ui.open({ kind: 'exam', fileId })}>
          <Icon name="exam" />
          Prova
        </button>
        <button aria-pressed={meta.favorite} onClick={() => void toggleFavorite(meta)}>
          <Icon name="star" className={meta.favorite ? 'star on' : ''} />
          {meta.favorite ? 'Favorito' : 'Favoritar'}
        </button>
        <button
          onClick={event => {
            const box = event.currentTarget.getBoundingClientRect()
            ui.openMenu({ kind: 'file', id: fileId, x: box.left - 120, y: box.top - 360 })
          }}
          aria-label="Mais opções"
        >
          <Icon name="dots" />
        </button>
      </div>
      {ui.focusPop && (
        <div className="pop4">
          <div className="insp-body">
            <InspectorBody fileId={fileId} tab={ui.focusPop} onPick={() => ui.set({ focusPop: null })} />
          </div>
        </div>
      )}
    </>
  )
}

export function FocusWorkspace({ route }: { route: ViewRoute }) {
  const scroller = useScrollerRef()
  const isDoc = route.view === 'doc' && route.fileId
  return (
    <FocusShell dock={isDoc ? <Dock fileId={route.fileId!} /> : undefined}>
      <div className="scroll" ref={scroller}>
        {isDoc ? <DocumentBody fileId={route.fileId!} /> : route.view === 'home' ? <Home /> : <Library route={route} />}
      </div>
    </FocusShell>
  )
}
