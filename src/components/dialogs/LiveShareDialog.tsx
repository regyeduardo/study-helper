import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { ArtifactKind, FileMeta, FolderMeta, ShareKind } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { apiMessage } from '@/controllers/api.controller'
import { createLiveLink, itemLiveLink, type LiveLink, stopLiveLink } from '@/controllers/live-share.controller'
import { filesInside } from '@/hooks/use-library-view'
import { descendantsOf } from '@/lib/family'
import { mediaOf } from '@/lib/file-types'
import { paths } from '@/lib/paths'
import { appShareUrl, LIVE_EXPIRES } from '@/lib/share'
import { filePlaceOf } from '@/lib/storage/place'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { dateTime } from '@/utils/format'

/** The notes a link of this item carries: the entrada and every note born of it, the note alone, or the notes of the folder. */
function carriedNotes(target: ShareKind, id: string, files: FileMeta[], folders: FolderMeta[]): FileMeta[] {
  if (target === 'folder') return filesInside(files, folders.filter(folder => !folder.deletedAt), [id]).filter(file => !file.deletedAt)
  const item = files.find(file => file.id === id)
  if (!item) return []
  return target === 'entrada' ? [item, ...descendantsOf(files, id)] : [item]
}

/** Who uses the app structure and keeps in the App everything the link carries shares from the App (spec 003, história 7); anything else goes as before. */
export function sharesFromApp(target: ShareKind, id: string, appOn: boolean, files: FileMeta[], folders: FolderMeta[]): boolean {
  if (!appOn) return false
  const notes = carriedNotes(target, id, files, folders)
  return notes.length > 0 && notes.every(file => filePlaceOf(file, folders, 'drive') === 'app')
}

const ARTIFACT_BOXES: { kind: ArtifactKind; title: string; text: string }[] = [
  { kind: 'mapa', title: 'Levar os mapas', text: 'Vai o desenho de cada mapa. As conversas ficam com você.' },
  { kind: 'cartoes', title: 'Levar os cartões', text: 'Vão a frente e o verso. O seu progresso de revisão fica com você.' },
  { kind: 'tutor', title: 'Levar as conversas do Tutor', text: 'Vão as perguntas e as respostas de cada conversa.' },
]

const WHAT: Record<ShareKind, string> = {
  entrada: 'esta entrada como ela está agora: a mídia, a transcrição e todas as notas que nasceram dela',
  file: 'esta nota como ela está agora',
  folder: 'esta pasta como ela está agora, com as notas dela',
}

function Box({ on, title, text, onToggle }: { on: boolean; title: string; text: string; onToggle(): void }) {
  return (
    <button className="opt" role="checkbox" aria-checked={on} onClick={onToggle}>
      <span className={`check ${on ? 'on' : ''}`}>{on && <Icon name="check" />}</span>
      <span>
        <b>{title}</b>
        <span>{text}</span>
      </span>
    </button>
  )
}

/** The link of the App: nothing goes through the share-worker, nothing is copied nor sent again; the link opens the item's page in the app. */
export function LiveShareDialog({ target, id }: { target: ShareKind; id: string }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const folders = useLibraryStore(state => state.folders)
  const files = useLibraryStore(state => state.files)
  const shares = useLibraryStore(state => state.index.shares)
  const saveShare = useLibraryStore(state => state.saveShare)
  const dropShare = useLibraryStore(state => state.dropShare)
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  // undefined: still asking the App whether this item already has a link
  const [link, setLink] = useState<LiveLink | null | undefined>(undefined)
  const [made, setMade] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [withExams, setWithExams] = useState(false)
  const [kinds, setKinds] = useState<ArtifactKind[]>(['mapa'])
  const entrada = target === 'entrada'
  const item = target === 'folder' ? folders.find(folder => folder.id === id) : files.find(file => file.id === id)
  const entry = entrada ? (files.find(file => file.id === id) ?? null) : null
  // a media kept somewhere other than the App (this browser, the Google Drive) is not in the App to be played by the link
  const mediaAway = Boolean(entry && mediaOf(entry) !== 'text' && !entry.origin?.removedAt && !entry.origin?.storedFileId?.startsWith('app:'))

  const keep = (found: LiveLink) => {
    if (shares.some(share => share.id === found.id)) return Promise.resolve()
    return saveShare({ id: found.id, kind: target, itemId: id, title: found.title || item?.name || '', bytes: 0, withExams: found.withExams, createdAt: found.createdAt, expiresAt: LIVE_EXPIRES, live: true })
  }

  useEffect(() => {
    let alive = true
    itemLiveLink(id).then(
      found => {
        if (!alive) return
        setLink(found)
        // a link made on another device joins the list of Compartilhados here too
        if (found) void keep(found).catch(() => undefined)
      },
      failure => {
        if (!alive) return
        setLink(null)
        setError(apiMessage(failure))
      },
    )
    return () => {
      alive = false
    }
  }, [id])

  const share = async () => {
    setBusy(true)
    setError(null)
    try {
      const found = await createLiveLink({ item: id, kind: target, withExams: entrada || withExams, artifacts: entrada ? ['mapa'] : kinds })
      await keep(found).catch(() => undefined)
      setLink(found)
      setMade(true)
    } catch (failure) {
      setError(apiMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    if (!link) return
    setBusy(true)
    setError(null)
    try {
      await stopLiveLink(link.id)
      await dropShare(link.id).catch(() => undefined)
      ui.toast('Compartilhamento parado')
      setLink(null)
      setMade(false)
    } catch (failure) {
      setError(apiMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const url = link ? appShareUrl(link.id) : ''
  const copy = async () => {
    await navigator.clipboard?.writeText(url).catch(() => undefined)
    ui.toast('Link copiado')
  }
  const toShares = () => {
    ui.close()
    navigate(paths.shares)
  }

  const footer = link ? (
    <>
      {!made && (
        <button className="btn danger" disabled={busy} onClick={() => void stop()}>
          {busy ? 'Parando…' : 'Parar de compartilhar'}
        </button>
      )}
      <span className="grow" />
      <button className="btn" onClick={toShares}>
        Ver compartilhados
      </button>
      <button className="btn primary" onClick={ui.close}>
        {made ? 'Concluir' : 'Fechar'}
      </button>
    </>
  ) : (
    <>
      <button className="btn quiet" onClick={ui.close}>
        Cancelar
      </button>
      <button className="btn primary" disabled={link === undefined || busy} onClick={() => void share()}>
        <Icon name="link" />
        {busy ? 'Compartilhando…' : 'Compartilhar'}
      </button>
    </>
  )

  return (
    <Dialog title={`Compartilhar · ${item?.name ?? ''}`} size="narrow" onClose={ui.close} footer={footer}>
      <div className="db">
        {link === undefined ? (
          <span className="muted" role="status">
            Procurando o link deste item…
          </span>
        ) : link ? (
          <>
            <p className="share-state">
              <b>{made ? 'Link criado' : 'Já compartilhado'}</b>
              {`${made ? '' : ` em ${dateTime(link.createdAt, timeZone)}`}. Ao vivo: mostra sempre a versão de agora e não vence.`}
            </p>
            <div className="field">
              <label htmlFor="share-link">Link público, só para leitura</label>
              <div className="share-copy">
                <input className="input" id="share-link" readOnly value={url} onFocus={event => event.currentTarget.select()} />
                <button className="btn primary" onClick={() => void copy()}>
                  <Icon name="link" />
                  Copiar link
                </button>
              </div>
            </div>
            <span className="muted" style={{ fontSize: 13 }}>
              Quem abrir vê {WHAT[target]}. O que mudar aqui aparece no link sozinho.
            </span>
          </>
        ) : (
          <>
            <span className="muted" style={{ fontSize: 13 }}>
              Quem tiver o link vê {WHAT[target]}. O que mudar aqui aparece no link sozinho. Abre sem entrar em conta e não vence.
            </span>
            {mediaAway && (
              <div className="banner info" role="status">
                <Icon name="warn" />
                <span>A mídia desta entrada não está no App, então o link vai sem ela.</span>
              </div>
            )}
            {!entrada && (
              <>
                <Box on={withExams} title="Levar as provas" text="Vão só as questões. Suas tentativas, notas e destaques ficam com você." onToggle={() => setWithExams(value => !value)} />
                {ARTIFACT_BOXES.map(box => (
                  <Box key={box.kind} on={kinds.includes(box.kind)} title={box.title} text={box.text} onToggle={() => setKinds(list => (list.includes(box.kind) ? list.filter(kind => kind !== box.kind) : [...list, box.kind]))} />
                ))}
              </>
            )}
          </>
        )}
        {error && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}
