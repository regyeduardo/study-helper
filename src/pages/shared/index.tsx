import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import type { SharedFile, SharedItem } from '@/types/domain'
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

function folderPath(item: SharedItem, folderId: string | null): string {
  const names: string[] = []
  let current = item.folders.find(folder => folder.id === folderId)
  for (let depth = 0; current && depth < 64; depth++) {
    if (current.parentId !== null) names.unshift(current.name)
    current = item.folders.find(folder => folder.id === current!.parentId)
  }
  return names.join(' › ')
}

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

export default function SharedPage() {
  const { shareId = '' } = useParams()
  const navigate = useNavigate()
  const toast = useUiStore(state => state.toast)
  const ownShares = useLibraryStore(state => state.index.shares)
  const rememberSharedLink = useLibraryStore(state => state.rememberSharedLink)
  const createFolder = useLibraryStore(state => state.createFolder)
  const createFile = useLibraryStore(state => state.createFile)
  const updateSidecar = useLibraryStore(state => state.updateSidecar)
  const [state, setState] = useState<PageState>({ kind: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<SharedAttempts>(() => readSharedAttempts(shareId))
  const [importing, setImporting] = useState(false)
  const now = useNow()

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    setAttempts(readSharedAttempts(shareId))
    void fetchSharedItemController(shareId).then(item => {
      if (!alive) return
      if (!item || !Array.isArray(item.files) || !item.files.length || isExpired(item.expiresAt)) {
        setState({ kind: 'unavailable' })
        return
      }
      setState({ kind: 'ready', item })
      setSelected(item.files[0].id)
      if (!ownShares.some(share => share.id === item.id)) void rememberSharedLink({ id: item.id, kind: item.kind, title: item.title, openedAt: nowIso(), expiresAt: item.expiresAt })
    })
    return () => {
      alive = false
    }
  }, [shareId])

  const unavailable = state.kind === 'unavailable' || (state.kind === 'ready' && isExpired(state.item.expiresAt, now))

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

  const item = state.kind === 'ready' ? state.item : null
  const file = item?.files.find(entry => entry.id === selected) ?? item?.files[0] ?? null

  return (
    <div className="shared-page">
      <header className="shared-top">
        <span className="shared-brand">
          <span className="mark">E</span>Estudo
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => navigate(paths.home)}>
          <Icon name="book" />
          Minha biblioteca
        </button>
      </header>
      <div className="shared-scroll">
        {state.kind === 'loading' ? (
          <div className="welcome" role="status">
            <span className="muted">Abrindo o compartilhamento…</span>
          </div>
        ) : unavailable || !item ? (
          <div className="welcome" role="alert">
            <h1>Item indisponível</h1>
            <p className="muted" style={{ margin: 0 }}>
              O link expirou ou quem compartilhou apagou.
            </p>
            <button className="btn primary" onClick={() => navigate(paths.home)}>
              Abrir minha biblioteca
            </button>
          </div>
        ) : (
          <div className="shared-body">
            <div className="shared-head">
              <span className="faint">
                <Icon name={item.kind === 'folder' ? 'folder' : 'file'} /> Compartilhado com você · só leitura · faltam {daysLeftText(item.expiresAt, now)}
              </span>
              <h1>{item.title}</h1>
              <div className="shared-actions">
                <button className="btn primary" disabled={importing} onClick={() => void importItem(item)}>
                  <Icon name="download" />
                  {importing ? 'Importando…' : 'Importar para a minha biblioteca'}
                </button>
                <span className="muted">Importar faz uma cópia sua, que não expira.</span>
              </div>
            </div>
            {item.kind === 'folder' && (
              <nav className="shared-files" aria-label="Notas compartilhadas">
                {item.files.map(entry => (
                  <button key={entry.id} className="shared-file" aria-current={entry.id === file?.id} onClick={() => setSelected(entry.id)}>
                    <Icon name="file" />
                    <span>
                      <b>{entry.name}</b>
                      {folderPath(item, entry.folderId) && <small className="faint">{folderPath(item, entry.folderId)}</small>}
                    </span>
                  </button>
                ))}
              </nav>
            )}
            {file && (
              <article className="shared-doc" aria-label={file.name}>
                {item.kind === 'folder' && <h2>{file.name}</h2>}
                {file.questions.length > 0 && <ExamBox shareId={item.id} file={file} attempts={attempts} onAttempts={setAttempts} />}
                <GithubMarkdownView key={file.id} markdown={file.content} />
              </article>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
