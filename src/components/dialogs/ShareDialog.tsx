import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { ArtifactKind, ShareContent, ShareKind, ShareRecord } from '@/types/domain'
import { EntryShareTree } from '@/components/dialogs/EntryShareTree'
import { LiveShareDialog, sharesFromApp } from '@/components/dialogs/LiveShareDialog'
import { entryKind } from '@/components/library/EntryList'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { type CreatedShare as CreatedResult, createShareController, forgetShareMediaController, isShareConfigured, type PlannedMedia, ShareError, type ShareStatus, shareStatusController, type UpdatedShare, updateShareController, uploadShareMediaController } from '@/controllers/share.controller'
import { filesInside } from '@/hooks/use-library-view'
import { blocking } from '@/lib/blocking'
import { env } from '@/lib/env'
import { paths } from '@/lib/paths'
import { mediaLength, mediaOf } from '@/lib/file-types'
import { buildEntryShareContent, buildShareContent, entryMediaOf, findValidShare, questionCountOf, shareBytes, shareMediaOf, shareUrl } from '@/lib/share'
import { choiceCount, choiceOf, defaultChoice, entryShareTree, MEDIA_KEY, toggleChoice } from '@/lib/share-entry'
import { loadTurnstile } from '@/lib/turnstile'
import { recorderName, useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { dateTime, formatBytes } from '@/utils/format'

function TurnstileBox({ onToken }: { onToken(token: string): void }) {
  const box = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let widget: string | null = null
    loadTurnstile()
      .then(api => {
        if (!alive || !box.current) return
        widget = api.render(box.current, { sitekey: env.turnstileSiteKey, language: 'pt-br', callback: onToken, 'expired-callback': () => onToken(''), 'error-callback': () => onToken('') })
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
      if (widget) window.turnstile?.remove(widget)
    }
  }, [])
  return (
    <>
      <div ref={box} className="turnstile" aria-label="Verificação anti-robô" />
      {failed && <span className="muted">Não consegui carregar a verificação anti-robô. Recarregue a página e tente de novo.</span>}
    </>
  )
}

const ARTIFACT_BOXES: { kind: ArtifactKind; title: string; text: string }[] = [
  { kind: 'mapa', title: 'Levar os mapas', text: 'Vai o desenho de cada mapa. As conversas ficam com você.' },
  { kind: 'cartoes', title: 'Levar os cartões', text: 'Vão a frente e o verso. O seu progresso de revisão fica com você.' },
  { kind: 'tutor', title: 'Levar as conversas do Tutor', text: 'Vão as perguntas e as respostas de cada conversa.' },
]

interface MediaProgress {
  name: string
  percent: number
}

/** What the window says about the link: `already` the one made before, still valid; `updated` the same link with the version of now; `notice` why a new link was made instead. */
function CreatedShare({ share, mediaFailed, already = false, updated = false, notice = null, unlisted = false, status = null, hasMedia = false }: { share: ShareRecord; mediaFailed: string[]; already?: boolean; updated?: boolean; notice?: string | null; unlisted?: boolean; status?: ShareStatus | null; hasMedia?: boolean }) {
  const toast = useUiStore(state => state.toast)
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const url = shareUrl(share.id)
  const copy = async () => {
    await navigator.clipboard?.writeText(url).catch(() => undefined)
    toast('Link copiado')
  }
  // the Worker says whether the media of this item is in the link: sent, or the upload never finished
  const mediaThere = status && hasMedia ? status.media.length > 0 : null
  return (
    <>
      {already && (
        <p className="share-state">
          <b>Já compartilhado</b>
          {` em ${dateTime(share.createdAt, timeZone)}${share.updatedAt ? `, atualizado em ${dateTime(share.updatedAt, timeZone)}` : ''}. Vale até ${dateTime(share.expiresAt, timeZone)} e mostra a versão daquele dia.`}
        </p>
      )}
      {updated && (
        <p className="share-state">
          <b>Link atualizado</b>
          {`. Vale até ${dateTime(share.expiresAt, timeZone)} e mostra a versão de agora. Quem já tem o link vê a versão nova.`}
        </p>
      )}
      {notice && (
        <div className="banner info" role="status">
          <Icon name="link" />
          <span>{notice}</span>
        </div>
      )}
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
        {already
          ? '“Atualizar o link” põe a versão de agora neste mesmo link, por mais 3 dias. A mídia que já está lá não sobe de novo.'
          : updated
            ? 'Para mudar de novo, abra Compartilhar e atualize o link outra vez.'
            : `Vale por 3 dias, até ${dateTime(share.expiresAt, timeZone)}, e mostra a versão de agora. Se mudar alguma coisa, abra Compartilhar de novo e atualize o link.`}
      </span>
      {already && mediaThere === true && (
        <span className="muted" style={{ fontSize: 13 }}>
          A mídia vai junto neste link e fica disponível até {dateTime(status?.mediaExpiresAt ?? share.expiresAt, timeZone)}.
        </span>
      )}
      {already && mediaThere === false && (
        <div className="banner" role="alert">
          <Icon name="warn" />
          <span>A mídia não está neste link (o envio não terminou). “Atualizar o link” envia de novo.</span>
        </div>
      )}
      {unlisted && (
        <div className="banner" role="alert">
          <Icon name="warn" />
          <span>Não consegui guardar este link na lista de Compartilhados. Copie o link agora.</span>
        </div>
      )}
      {mediaFailed.length > 0 && (
        <div className="banner" role="alert">
          <Icon name="warn" />
          <span>Não consegui enviar a mídia de {mediaFailed.join(', ')}. O link funciona, mas sem tocar a gravação. “Atualizar o link” tenta de novo.</span>
        </div>
      )}
    </>
  )
}

/** Why a new link was made when the same one could not be updated; the Worker answers 404 to a route it does not have, to a link that is gone, 410 past the expiry, 403 for another account's. */
function fallbackNotice(failure: unknown): string | null {
  if (!(failure instanceof ShareError)) return null
  if (failure.code === 'share_gone') return 'O link anterior tinha sido apagado, então criei um link novo.'
  if (failure.code === 'expired') return 'O link anterior já tinha vencido, então criei um link novo.'
  if (failure.code === 'not_owner') return 'O link anterior foi criado por outra conta Google, então criei um link novo.'
  if (failure.status === 404) return 'O serviço de compartilhamento ainda não atualiza o mesmo link, então criei um link novo. O anterior continua valendo até vencer.'
  return null
}

/** Who uses the app structure shares from the App (live link, no share-worker); who does not, as before. */
export function ShareDialog({ target, id }: { target: ShareKind; id: string }) {
  const live = useLibraryStore(state => sharesFromApp(target, id, state.appOn, state.files, state.folders))
  return live ? <LiveShareDialog target={target} id={id} /> : <WorkerShareDialog target={target} id={id} />
}

function WorkerShareDialog({ target, id }: { target: ShareKind; id: string }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const account = useAccountStore(state => state.active())
  const tokenFor = useAccountStore(state => state.tokenFor)
  const folders = useLibraryStore(state => state.folders)
  const files = useLibraryStore(state => state.files)
  const openFile = useLibraryStore(state => state.openFile)
  const saveShare = useLibraryStore(state => state.saveShare)
  const dropShare = useLibraryStore(state => state.dropShare)
  const localMedia = useLibraryStore(state => state.localMedia)
  const repo = useLibraryStore(state => state.repo)
  const [withExams, setWithExams] = useState(false)
  const [kinds, setKinds] = useState<ArtifactKind[]>(['mapa'])
  const [content, setContent] = useState<ShareContent | null>(null)
  const [questions, setQuestions] = useState(0)
  const [progress, setProgress] = useState<MediaProgress | null>(null)
  const [mediaFailed, setMediaFailed] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [captcha, setCaptcha] = useState('')
  const [captchaRound, setCaptchaRound] = useState(0)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<ShareRecord | null>(null)
  // the link of this item made before and still valid comes first (a note shared as "arquivo" is the same item as when it is an entrada):
  // copy it, or "Atualizar o link" to put the version of now in the same link
  const validId = useLibraryStore(state => findValidShare(state.index.shares, target, id)?.id ?? null)
  const valid = useLibraryStore(state => state.index.shares.find(record => record.id === validId) ?? null)
  const [renewing, setRenewing] = useState(false)
  const [status, setStatus] = useState<ShareStatus | null>(null)
  const [gone, setGone] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [updated, setUpdated] = useState(false)
  const [unlisted, setUnlisted] = useState(false)
  const google = account.kind === 'google'
  const configured = isShareConfigured()
  const token = (options?: { force?: boolean }) => tokenFor(account.id, options)
  const name = target === 'folder' ? folders.find(folder => folder.id === id)?.name : files.find(file => file.id === id)?.name
  // an entrada goes with its family, item by item (FR-066)
  const entrada = target === 'entrada'
  const entry = entrada ? (files.find(file => file.id === id) ?? null) : null
  const tree = useMemo(() => (entrada ? entryShareTree(files, id) : []), [entrada, files, id])
  const entryMedia = entrada ? entryMediaOf(id, files, localMedia, repo) : null
  const [chosen, setChosen] = useState(() => defaultChoice(tree, Boolean(entryMedia)))
  const [transcribed, setTranscribed] = useState(false)

  useEffect(() => {
    if (!google || !configured) return
    let alive = true
    setContent(null)
    const recorder = recorderName(useAccountStore.getState().active())
    // the size comes from reading every note that goes in the link (a Drive read each): the window holds the app and counts them
    const choice = entrada ? choiceOf(tree, chosen) : null
    const total = choice ? 1 + choice.notes.length : target === 'folder' ? filesInside(files, folders.filter(folder => !folder.deletedAt), [id]).filter(file => !file.deletedAt).length : 1
    const built = blocking(
      'Preparando o compartilhamento…',
      blocker => {
        let read = 0
        const reading = async (noteId: string) => {
          blocker.progress({ done: read, total, current: files.find(file => file.id === noteId)?.name })
          const opened = await openFile(noteId)
          read++
          return opened
        }
        return choice ? buildEntryShareContent(id, files, reading, choice, recorder) : buildShareContent({ kind: target, id }, folders, files, reading, withExams, recorder, kinds)
      },
      { phase: 'Lendo as notas', total },
    )
    built.then(
      made => alive && setContent(made),
      failure => alive && setError(failure instanceof Error ? failure.message : 'Não deu para ler as notas.'),
    )
    return () => {
      alive = false
    }
  }, [withExams, kinds, chosen, google, configured, target, id])

  useEffect(() => {
    if (!google || !configured || entrada) return
    void questionCountOf({ kind: target, id }, folders, files).then(setQuestions)
  }, [google, configured])

  // the Worker says whether the link of this item still exists and whether its media is in it
  useEffect(() => {
    if (!google || !configured || !validId) return
    let alive = true
    setStatus(null)
    shareStatusController(token, validId).then(
      found => alive && setStatus(found),
      failure => {
        // only "share_gone" says it is gone: a Worker without this route answers not_found to anything
        if (!alive || !(failure instanceof ShareError) || failure.code !== 'share_gone') return
        setGone(true)
        void dropShare(validId).catch(() => undefined)
      },
    )
    return () => {
      alive = false
    }
  }, [validId, google, configured])

  useEffect(() => {
    if (!entrada) return
    let alive = true
    void openFile(id).then(opened => alive && setTranscribed(Boolean(opened.sidecar.recording?.blocks.length || opened.sidecar.transcript?.trim())), () => undefined)
    return () => {
      alive = false
    }
  }, [entrada, id])

  const toggleKind = (kind: ArtifactKind) => setKinds(list => (list.includes(kind) ? list.filter(item => item !== kind) : [...list, kind]))
  const bytes = content ? shareBytes(content) : null
  const media = entrada ? (entryMedia && chosen.has(MEDIA_KEY) ? [entryMedia] : []) : content ? shareMediaOf(content, files, localMedia, repo) : []
  const count = choiceCount(tree, chosen, Boolean(entryMedia))
  const mediaRow = entry && entryMedia ? { icon: entryKind(entry).icon, detail: [mediaOf(entry) === 'video' ? 'vídeo' : 'áudio', mediaLength(entry.origin?.durationSeconds)].filter(Boolean).join(' de '), size: entryMedia.size === null ? '' : formatBytes(entryMedia.size) } : null
  const mediaBytes = media.every(item => item.size !== null) ? media.reduce((sum, item) => sum + (item.size ?? 0), 0) : null
  const empty = content !== null && content.files.length === 0

  /** `skip`: the notes whose media is already in the link (the Worker said so), which are not sent again. */
  const uploadMedia = async (shareId: string, skip: Set<string>): Promise<{ sent: number; failed: string[] }> => {
    const todo = media.filter(item => !skip.has(item.fileId))
    let total = todo.reduce((sum, item) => sum + (item.size ?? 0), 0)
    let sent = 0
    const failed: string[] = []
    for (const item of todo) {
      const show = (bytesSent: number) => setProgress({ name: item.name, percent: total ? Math.min(100, Math.round(((sent + bytesSent) / total) * 100)) : 0 })
      try {
        show(0)
        const blob = await item.read()
        if (item.size === null) total += blob.size
        if (!blob.size) throw new Error('mídia vazia')
        sent += await uploadShareMediaController(token, shareId, item.fileId, blob, item.mime, show)
      } catch {
        failed.push(item.name)
        // the link must not keep saying that this media is coming
        await forgetShareMediaController(token, shareId, item.fileId)
      }
    }
    return { sent, failed }
  }

  /** `update`: the same link with the version of now (the media already in it stays); a Worker that cannot do it, or a link that is gone, ends in a new link, as before. `new`: always a new link. */
  const share = async (mode: 'update' | 'new') => {
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      const planned = media.map(item => ({ fileId: item.fileId, mime: item.mime, size: item.size ?? 0 }))
      let result: (CreatedResult | UpdatedShare) | null = null
      let kept: PlannedMedia[] = []
      let why: string | null = null
      if (mode === 'update' && valid) {
        try {
          const changed = await updateShareController(token, valid.id, captcha, content, planned)
          result = changed
          kept = changed.media
        } catch (failure) {
          why = fallbackNotice(failure)
          if (!why) throw failure
          if (failure instanceof ShareError && failure.code === 'share_gone') await dropShare(valid.id).catch(() => undefined)
        }
      }
      result ??= await createShareController(token, captcha, content, planned)
      const keptBytes = kept.reduce((sum, item) => sum + item.size, 0)
      const base: ShareRecord = {
        id: result.id,
        kind: target,
        itemId: id,
        title: content.title,
        bytes: result.bytes + keptBytes,
        withExams: entrada || withExams,
        createdAt: result.createdAt,
        ...('updatedAt' in result ? { updatedAt: result.updatedAt } : {}),
        expiresAt: result.expiresAt,
      }
      // the link goes to the list before the media goes up: closing the tab in the middle leaves a link with its record, not a link nobody can find
      let listed = await saveShare(base).then(() => true, () => false)
      const uploaded = await uploadMedia(result.id, new Set(kept.map(item => item.fileId)))
      const record: ShareRecord = { ...base, bytes: base.bytes + uploaded.sent }
      if (uploaded.sent) listed = (await saveShare(record).then(() => true, () => false)) && listed
      setUnlisted(!listed)
      setNotice(why)
      setUpdated('updatedAt' in result)
      setMediaFailed(uploaded.failed)
      setCreated(record)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'O compartilhamento falhou.')
      setCaptcha('')
      setCaptchaRound(round => round + 1)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  // "Atualizar o link" was chosen for the link made before: the form below puts the version of now in it
  const updating = Boolean(valid && renewing)
  const footer = !google ? (
    <>
      <button className="btn quiet" onClick={ui.close}>
        Cancelar
      </button>
      <button className="btn primary" onClick={() => ui.open({ kind: 'account' })}>
        <Icon name="user" />
        Entrar com o Google
      </button>
    </>
  ) : valid && !renewing && !created && !busy && configured ? (
    <>
      <button className="btn quiet" onClick={ui.close}>
        Fechar
      </button>
      <button
        className="btn"
        onClick={() => {
          ui.close()
          navigate(paths.shares)
        }}
      >
        Ver compartilhados
      </button>
      {/* "Copiar link", in the body, is the one primary action here */}
      <button className="btn" onClick={() => setRenewing(true)}>
        <Icon name="sync" />
        Atualizar o link
      </button>
    </>
  ) : created ? (
    <>
      <button
        className="btn"
        onClick={() => {
          ui.close()
          navigate(paths.shares)
        }}
      >
        Ver compartilhados
      </button>
      <button className="btn primary" onClick={ui.close}>
        Concluir
      </button>
    </>
  ) : (
    <>
      {entrada && configured && count.total > 0 && (
        <span className="grow sh-count" aria-live="polite">
          <b>
            {count.chosen} de {count.total}
          </b>{' '}
          {count.total === 1 ? 'item vai' : 'itens vão'}
        </span>
      )}
      <button className="btn quiet" onClick={ui.close}>
        Cancelar
      </button>
      {updating && (
        <button className="btn" disabled={!configured || !content || empty || !captcha || busy} onClick={() => void share('new')}>
          Criar outro link
        </button>
      )}
      <button className="btn primary" disabled={!configured || !content || empty || !captcha || busy} onClick={() => void share(updating ? 'update' : 'new')}>
        <Icon name={updating ? 'sync' : 'link'} />
        {busy ? (updating ? 'Atualizando…' : 'Compartilhando…') : updating ? 'Atualizar o link' : 'Compartilhar'}
      </button>
    </>
  )

  return (
    <Dialog title={`Compartilhar · ${name ?? ''}`} size={entrada ? 'normal' : 'narrow'} onClose={ui.close} footer={footer}>
      <div className="db">
        {!google ? (
          <div className="banner info" role="status">
            <Icon name="user" />
            <span>Entre com o Google para compartilhar.</span>
          </div>
        ) : !configured ? (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>O compartilhamento ainda não foi configurado neste site.</span>
          </div>
        ) : valid && !renewing && !created && !busy ? (
          <CreatedShare share={valid} mediaFailed={[]} already status={status} hasMedia={media.length > 0} />
        ) : created ? (
          <CreatedShare share={created} mediaFailed={mediaFailed} updated={updated} notice={notice} unlisted={unlisted} />
        ) : (
          <>
            {gone && (
              <div className="banner info" role="status">
                <Icon name="warn" />
                <span>O link anterior foi apagado. Compartilhe de novo para ter um link novo.</span>
              </div>
            )}
            <span className="muted" style={{ fontSize: 13 }}>
              {updating ? 'Quem tiver o link continua com ele e passa a ver a versão de agora, por mais 3 dias a partir de hoje.' : 'Quem tiver o link pode ler, sem entrar em conta. O link vale por 3 dias e mostra a versão de agora.'}
            </span>
            {entrada && <EntryShareTree tree={tree} chosen={chosen} onToggle={key => setChosen(current => toggleChoice(tree, current, key))} media={mediaRow} transcribed={transcribed} />}
            {!entrada && (
              <button className="opt" role="checkbox" aria-checked={withExams} onClick={() => setWithExams(value => !value)}>
                <span className={`check ${withExams ? 'on' : ''}`}>{withExams && <Icon name="check" />}</span>
                <span>
                  <b>Levar as provas</b>
                  <span>{questions === 1 ? 'Vai só a questão' : questions ? `Vão só as ${questions} questões` : 'Vão só as questões'}. Suas tentativas, notas e destaques ficam com você.</span>
                </span>
              </button>
            )}
            {!entrada && ARTIFACT_BOXES.map(box => {
              const on = kinds.includes(box.kind)
              return (
                <button key={box.kind} className="opt" role="checkbox" aria-checked={on} onClick={() => toggleKind(box.kind)}>
                  <span className={`check ${on ? 'on' : ''}`}>{on && <Icon name="check" />}</span>
                  <span>
                    <b>{box.title}</b>
                    <span>{box.text}</span>
                  </span>
                </button>
              )
            })}
            <div className="share-size" aria-label="Tamanho">
              <div>
                <span className="faint">Texto</span>
                <b>{bytes === null ? '…' : formatBytes(bytes)}</b>
              </div>
              {media.length > 0 && (
                <div>
                  <span className="faint">{media.length === 1 ? 'Mídia' : `Mídia · ${media.length} arquivos`}</span>
                  <b>{mediaBytes === null ? '…' : formatBytes(mediaBytes)}</b>
                </div>
              )}
            </div>
            {media.length > 0 && (
              <span className="muted" style={{ fontSize: 13 }}>
                A gravação vai junto: quem abrir o link pode tocar e pular para cada fala. A mídia fica disponível por 3 dias.
              </span>
            )}
            {progress && (
              <div className="db" role="status" aria-label="Envio da mídia">
                <div className="bar" role="progressbar" aria-label="Enviando a mídia" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
                  <i style={{ '--v': `${progress.percent}%` } as React.CSSProperties} />
                </div>
                <span className="muted" style={{ fontSize: 13 }}>
                  Enviando a mídia ({progress.name}): {progress.percent}%
                </span>
              </div>
            )}
            {empty && (
              <div className="banner" role="alert">
                <Icon name="warn" />
                <span>Não há nota pronta para compartilhar aqui.</span>
              </div>
            )}
            {error && (
              <div className="banner" role="alert">
                <Icon name="warn" />
                <span>{error}</span>
              </div>
            )}
            <TurnstileBox key={captchaRound} onToken={setCaptcha} />
          </>
        )}
      </div>
    </Dialog>
  )
}
