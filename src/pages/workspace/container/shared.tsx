import { useEffect, useRef, useState } from 'react'

import type { FileMeta } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { MasteryMeter, TypeDot } from '@/components/library/Badges'
import { useFileActions } from '@/components/library/use-file-actions'
import { useLiveLibrary } from '@/hooks/use-library-view'
import { useReadingProgress, useTrackReading } from '@/hooks/use-reading-progress'
import { useViewRoute } from '@/hooks/use-view-route'
import { REVIEW_BELOW } from '@/lib/file-types'
import { useAccountStore } from '@/stores/account'
import { useDocumentStore } from '@/stores/document'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function useScrollerRef() {
  const ref = useRef<HTMLDivElement>(null)
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const setScroller = useDocumentStore(state => state.setScroller)
  const { fileId } = useViewRoute()
  useEffect(() => {
    setScroller(ref.current)
    setElement(ref.current)
    return () => setScroller(null)
  })
  useTrackReading(element, fileId)
  return ref
}

export function useHomeData() {
  const { files } = useLiveLibrary()
  const openedAt = useLibraryStore(state => state.openedAt)
  const ready = files.filter(file => file.status === 'ready')
  const byOpened = [...ready].sort((a, b) => (openedAt[b.id] ?? 0) - (openedAt[a.id] ?? 0))
  const continueReading = byOpened.find(file => openedAt[file.id]) ?? null
  const review = files.filter(file => file.mastery !== null && file.mastery < REVIEW_BELOW)
  const recent = [...files].sort((a, b) => b.updated.at.localeCompare(a.updated.at)).slice(0, 3)
  const pending = files.filter(file => file.status === 'pending')
  return { continueReading, review, recent, pending, empty: files.length === 0 }
}

export function todayText(timeZone: string): string {
  const text = new Date().toLocaleDateString('pt-BR', { timeZone, weekday: 'long', day: 'numeric', month: 'long' })
  return text[0].toUpperCase() + text.slice(1)
}

export function greeting(): string {
  const hour = new Date().getHours()
  return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'
}

export function reviewSentence(count: number): string {
  if (!count) return 'Nada pede revisão hoje.'
  return count === 1 ? 'Uma coisa pede revisão hoje.' : `${count} coisas pedem revisão hoje.`
}

export function QuickActions({ fileForExam }: { fileForExam: FileMeta | null }) {
  const open = useUiStore(state => state.open)
  return (
    <div className="quick">
      <button className="btn primary" onClick={() => open({ kind: 'new' })}>
        <Icon name="plus" />
        Novo conteúdo
      </button>
      <button className="btn" onClick={() => open({ kind: 'record' })}>
        <Icon name="rec" />
        Gravar reunião
      </button>
      <button className="btn" onClick={() => open({ kind: 'import' })}>
        <Icon name="upload" />
        Importar .md, .zip, PDF ou docx
      </button>
      {fileForExam && (
        <button className="btn" onClick={() => open({ kind: 'exam', fileId: fileForExam.id })}>
          <Icon name="exam" />
          Prova: {fileForExam.name}
        </button>
      )}
    </div>
  )
}

export function ContinueCard({ file, className = 'cont' }: { file: FileMeta; className?: string }) {
  const { openFile } = useFileActions()
  const progress = useReadingProgress(file.id)
  return (
    <div className={className} role="button" tabIndex={0} onClick={() => openFile(file)} onKeyDown={event => event.key === 'Enter' && openFile(file)}>
      <div>
        <div className="title">{file.name}</div>
        <div className="sub" style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--fg-muted)' }}>
          <TypeDot type={file.type} />
          <span>{file.readingMinutes} min de leitura</span>
          <MasteryMeter value={file.mastery} />
          {progress !== null && <span>{Math.round(progress * 100)}% lido</span>}
        </div>
        {progress !== null && (
          <div className="bar" style={{ marginTop: 12, maxWidth: 360 }}>
            <i style={{ '--v': `${Math.round(progress * 100)}%` } as React.CSSProperties} />
          </div>
        )}
      </div>
      {className === 'cont' && (
        <span className="btn">
          Abrir <Icon name="fwd" />
        </span>
      )}
    </div>
  )
}

export function WelcomeEmpty() {
  const open = useUiStore(state => state.open)
  const account = useAccountStore(state => state.active())
  return (
    <div className="welcome">
      <h1>Sua biblioteca está vazia</h1>
      <p className="muted" style={{ margin: 0 }}>
        {account.kind === 'local'
          ? 'Você está no perfil Local: tudo fica só neste navegador. Entre com o Google para guardar no seu Drive.'
          : 'Tudo o que você criar vai para a pasta .sync-study-helper do seu Google Drive.'}
      </p>
      <div className="quick" style={{ justifyContent: 'center' }}>
        <button className="btn primary" onClick={() => open({ kind: 'new' })}>
          <Icon name="plus" />
          Novo conteúdo
        </button>
        <button className="btn" onClick={() => open({ kind: 'import' })}>
          <Icon name="upload" />
          Importar
        </button>
        {account.kind === 'local' && (
          <button className="btn" onClick={() => open({ kind: 'account' })}>
            <Icon name="user" />
            Entrar com o Google
          </button>
        )}
      </div>
    </div>
  )
}
