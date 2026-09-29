import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { SharedFile, SharedItem } from '@/types/domain'
import { FileIcon, TypeDot } from '@/components/library/Badges'
import { Icon } from '@/components/ui/Icon'
import GithubMarkdownView from '@/components/reader/GithubMarkdownView'
import { fetchSharedItemController } from '@/controllers/share.controller'
import { useNow } from '@/hooks/use-now'
import { masteryOf } from '@/lib/exam'
import { nowIso } from '@/lib/ids'
import { paths } from '@/lib/paths'
import { daysLeftText, importSharedItem, isExpired, readSharedAttempts, saveSharedAttempt, type SharedAttempts } from '@/lib/share'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

type PageState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; item: SharedItem }

function ExamBox({ shareId, file, attempts, onAttempts }: { shareId: string; file: SharedFile; attempts: SharedAttempts; onAttempts(next: SharedAttempts): void }) {
  const open = useUiStore(state => state.open)
  const done = attempts[file.id] ?? []
  const last = done[done.length - 1]
  const lastPercent = last ? masteryOf(last.correct, last.total) : null
  return (
    <div className="shared-exam">
      <button className="btn" onClick={() => open({ kind: 'shared-exam', title: file.name, questions: file.questions, onRecord: fields => onAttempts(saveSharedAttempt(shareId, file.id, fields)) })}>
        <Icon name="exam" />
        Fazer a prova ({file.questions.length === 1 ? '1 questão' : `${file.questions.length} questões`})
      </button>
      <span className="muted">As notas desta prova ficam só neste navegador e não vão para nenhuma conta. Se você importar, elas vão junto.</span>
      {last && (
        <span className="faint" aria-label="Suas notas neste navegador">
          Feita {done.length === 1 ? '1 vez' : `${done.length} vezes`} · última: {lastPercent ?? 0}%
        </span>
      )}
    </div>
  )
}

function orderedFiles(item: SharedItem): { folder: SharedItem['folders'][number] | null; files: SharedFile[] }[] {
  const byPosition = <T extends { position: number }>(list: T[]) => [...list].sort((a, b) => a.position - b.position)
  const walk = (parentId: string | null): { folder: SharedItem['folders'][number] | null; files: SharedFile[] }[] =>
    byPosition(item.folders.filter(folder => folder.parentId === parentId)).flatMap(folder => [{ folder, files: byPosition(item.files.filter(file => file.folderId === folder.id)) }, ...walk(folder.id)])
  const loose = byPosition(item.files.filter(file => !file.folderId || !item.folders.some(folder => folder.id === file.folderId)))
  return [...(loose.length ? [{ folder: null, files: loose }] : []), ...walk(null)].filter(group => group.files.length)
}

export function SharedView({ shareId, fileId }: { shareId: string; fileId: string | null }) {
  const navigate = useNavigate()
  const toast = useUiStore(state => state.toast)
  const ownShares = useLibraryStore(state => state.index.shares)
  const rememberSharedLink = useLibraryStore(state => state.rememberSharedLink)
  const createFolder = useLibraryStore(state => state.createFolder)
  const createFile = useLibraryStore(state => state.createFile)
  const updateSidecar = useLibraryStore(state => state.updateSidecar)
  const [state, setState] = useState<PageState>({ kind: 'loading' })
  const [attempts, setAttempts] = useState<SharedAttempts>(() => readSharedAttempts(shareId))
  const [importing, setImporting] = useState(false)
  const now = useNow()

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    setAttempts(readSharedAttempts(shareId))
    void fetchSharedItemController(shareId).then(item => {
      if (!alive) return
      if (!item || !item.files.length || isExpired(item.expiresAt)) {
        setState({ kind: 'unavailable' })
        return
      }
      setState({ kind: 'ready', item })
      if (!ownShares.some(share => share.id === item.id)) void rememberSharedLink({ id: item.id, kind: item.kind, title: item.title, openedAt: nowIso(), expiresAt: item.expiresAt })
    })
    return () => {
      alive = false
    }
  }, [shareId])

  const importItem = async (item: SharedItem) => {
    setImporting(true)
    try {
      const result = await importSharedItem(item, attempts, { createFolder, createFile, updateSidecar })
      toast('Importado para a sua biblioteca')
      navigate(result.fileId ? paths.file(result.fileId) : paths.folder(result.folderId))
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não consegui importar.')
      setImporting(false)
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="empty" role="status">
        Abrindo o compartilhamento…
      </div>
    )
  }
  const item = state.kind === 'ready' && !isExpired(state.item.expiresAt, now) ? state.item : null
  if (!item) {
    return (
      <div className="empty" role="alert">
        <Icon name="warn" />
        <div>
          <b>Item indisponível</b>
          <div className="muted">O link expirou ou quem compartilhou apagou.</div>
        </div>
      </div>
    )
  }

  const file = item.kind === 'file' ? item.files[0] : (item.files.find(entry => entry.id === fileId) ?? null)
  const badge = (
    <span className="crs" aria-label="Compartilhado">
      compartilhado · só leitura · faltam {daysLeftText(item.expiresAt, now)}
    </span>
  )
  const importButton = (
    <button className="btn primary" disabled={importing} onClick={() => void importItem(item)}>
      <Icon name="download" />
      {importing ? 'Importando…' : 'Importar para a minha biblioteca'}
    </button>
  )

  if (file) {
    return (
      <article className="article" aria-label={file.name}>
        <div className="libhead">
          {item.kind === 'folder' && (
            <button className="ibtn" aria-label="Voltar à pasta" onClick={() => navigate(paths.shared(item.id))}>
              <Icon name="back" />
            </button>
          )}
          <h2>{file.name}</h2>
          {badge}
          <span style={{ marginLeft: 'auto' }}>{importButton}</span>
        </div>
        {file.questions.length > 0 && <ExamBox shareId={item.id} file={file} attempts={attempts} onAttempts={setAttempts} />}
        <GithubMarkdownView key={file.id} markdown={file.content} />
      </article>
    )
  }

  return (
    <>
      <div className="libhead">
        <h2>{item.title}</h2>
        {badge}
        <span style={{ marginLeft: 'auto' }}>{importButton}</span>
      </div>
      <div className="libbody">
        <div className="list">
          {orderedFiles(item).map(group => (
            <div key={group.folder?.id ?? 'root'}>
              {group.folder && group.folder.parentId && (
                <div className="grp-h gh">
                  <Icon name="layers" /> {group.folder.name} <span className="faint">{group.files.length === 1 ? '1 aula' : `${group.files.length} aulas`}</span>
                </div>
              )}
              {group.files.map(entry => (
                <div key={entry.id} className="row" role="button" tabIndex={0} onClick={() => navigate(paths.sharedFile(item.id, entry.id))} onKeyDown={event => event.key === 'Enter' && navigate(paths.sharedFile(item.id, entry.id))}>
                  <span />
                  <div>
                    <div className="title">
                      <FileIcon type={entry.type} />
                      {entry.name}
                    </div>
                    <div className="sub">
                      <TypeDot type={entry.type} />
                      {entry.questions.length > 0 && <span>com prova</span>}
                    </div>
                  </div>
                  <div className="side" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
