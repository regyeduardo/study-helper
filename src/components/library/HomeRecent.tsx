// Início: só as últimas coisas feitas, em uma lista por dia (Hoje, Ontem, Esta semana, Antes).
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { FileMeta } from '@/types/domain'
import { Icon, type IconName } from '@/components/ui/Icon'
import { entryKind } from '@/components/library/EntryList'
import { useFileActions } from '@/components/library/use-file-actions'
import { useLiveLibrary, usePathName } from '@/hooks/use-library-view'
import { isNote, motherOf } from '@/lib/family'
import { typeInfo } from '@/lib/file-types'
import { doneAt, groupByDay, recentItems, whenLabel } from '@/lib/home-recent'
import { type NoteKind, noteKindOf } from '@/lib/library-filters'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import '@/styles/home-recent.css'

const PAGE = 20
const NOTE_LABEL: Record<NoteKind, string> = { ata: 'Ata', aula: 'Aula', explicacao: 'Explicação', leitura: 'Leitura', nota: 'Nota', video: 'Vídeo', audio: 'Áudio', pdf: 'PDF', link: 'Link', texto: 'Texto', tema: 'Tema', arquivo: 'Outro arquivo' }

/** What the item is, as the person calls it, and its icon: a note that keeps a source by its kind, a written note by its type (the color is the type's). */
function whatItIs(file: FileMeta): { label: string; icon: IconName; tone: string } {
  if (isNote(file)) return { label: NOTE_LABEL[noteKindOf(file)], icon: 'note', tone: typeInfo(file.type).tone }
  const kind = entryKind(file)
  return { label: kind.label, icon: kind.icon, tone: '' }
}

export function HomeRecent() {
  const { files } = useLiveLibrary()
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const pathName = usePathName()
  const { openFile } = useFileActions()
  const navigate = useNavigate()
  const open = useUiStore(state => state.open)
  const [limit, setLimit] = useState(PAGE)
  const items = useMemo(() => recentItems(files), [files])
  const now = Date.now()
  const groups = groupByDay(items.slice(0, limit), now, timeZone)

  return (
    <section className="home-recent" aria-labelledby="home-recent-title">
      <h2 id="home-recent-title" className="hr-title">
        Últimas coisas feitas
      </h2>
      {items.length === 0 ? (
        <div className="hr-empty">
          <p>Nada por aqui ainda. Crie ou grave algo e aparece aqui.</p>
          <div className="hr-actions">
            <button className="btn primary" onClick={() => open({ kind: 'new' })}>
              <Icon name="plus" />
              Novo
            </button>
            <button className="btn" onClick={() => open({ kind: 'record' })}>
              <Icon name="rec" />
              Gravar
            </button>
          </div>
        </div>
      ) : (
        <>
          {groups.map(group => (
            <div key={group.id} className="hr-group">
              <h3>{group.label}</h3>
              <ul className="hr-list">
                {group.items.map(file => {
                  const kind = whatItIs(file)
                  const mother = file.parentFileId ? motherOf(files, file) : null
                  const from = mother && !isNote(mother) ? mother : null
                  const place = pathName(file.folderId)
                  const at = doneAt(file)
                  return (
                    <li key={file.id}>
                      <button className="hr-row" onClick={() => (isNote(file) ? openFile(file) : navigate(paths.entry(file.id)))}>
                        <span className={`hr-ic ${kind.tone}`}>
                          <Icon name={kind.icon} />
                        </span>
                        <span className="hr-main">
                          <span className="hr-name">
                            {file.name}
                            {file.status === 'generating' && <span className="pending">gerando…</span>}
                          </span>
                          <span className="hr-sub">
                            <span>{kind.label}</span>
                            <span className="hr-where" title={place}>
                              {place}
                            </span>
                            {from && (
                              <span className="hr-from" title={from.name}>
                                {`de: ${from.name}`}
                              </span>
                            )}
                          </span>
                        </span>
                        <time className="hr-time" dateTime={new Date(at).toISOString()}>
                          {whenLabel(at, now, timeZone)}
                        </time>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          {items.length > limit && (
            <button className="btn hr-more" onClick={() => setLimit(current => current + PAGE)}>
              Mostrar mais
            </button>
          )}
        </>
      )}
    </section>
  )
}
