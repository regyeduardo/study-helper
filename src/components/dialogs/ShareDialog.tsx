import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { ArtifactKind, ShareContent, ShareKind, ShareRecord } from '@/types/domain'
import { EntryShareTree } from '@/components/dialogs/EntryShareTree'
import { entryKind } from '@/components/library/EntryList'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { createShareController, isShareConfigured, uploadShareMediaController } from '@/controllers/share.controller'
import { env } from '@/lib/env'
import { paths } from '@/lib/paths'
import { mediaLength, mediaOf } from '@/lib/file-types'
import { buildEntryShareContent, buildShareContent, entryMediaOf, questionCountOf, shareBytes, shareMediaOf, shareUrl } from '@/lib/share'
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

/** `already`: the link made before, still valid, shown when the dialog opens again for the same item. */
function CreatedShare({ share, mediaFailed, already = false }: { share: ShareRecord; mediaFailed: string[]; already?: boolean }) {
  const toast = useUiStore(state => state.toast)
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const url = shareUrl(share.id)
  const copy = async () => {
    await navigator.clipboard?.writeText(url).catch(() => undefined)
    toast('Link copiado')
  }
  return (
    <>
      {already && (
        <p className="share-state">
          <b>Já compartilhado</b>
          {` em ${dateTime(share.createdAt, timeZone)}. Vale até ${dateTime(share.expiresAt, timeZone)} e mostra a versão daquele dia.`}
        </p>
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
          ? '“Renovar” cria outro link, com a versão de agora, por mais 3 dias. Este continua valendo até vencer.'
          : `Vale por 3 dias, até ${dateTime(share.expiresAt, timeZone)}, e mostra a versão de agora. Se mudar alguma coisa, apague em Compartilhados e compartilhe de novo.`}
      </span>
      {mediaFailed.length > 0 && (
        <div className="banner" role="alert">
          <Icon name="warn" />
          <span>Não consegui enviar a mídia de {mediaFailed.join(', ')}. O link funciona, mas sem tocar a gravação.</span>
        </div>
      )}
    </>
  )
}

export function ShareDialog({ target, id }: { target: ShareKind; id: string }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const account = useAccountStore(state => state.active())
  const tokenFor = useAccountStore(state => state.tokenFor)
  const folders = useLibraryStore(state => state.folders)
  const files = useLibraryStore(state => state.files)
  const openFile = useLibraryStore(state => state.openFile)
  const saveShare = useLibraryStore(state => state.saveShare)
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
  // the link of this item made before and still valid comes first: copy it, or "Renovar" to share the version of now
  const valid = useLibraryStore(state => state.index.shares.find(record => record.kind === target && record.itemId === id && Date.parse(record.expiresAt) > Date.now()) ?? null)
  const [renewing, setRenewing] = useState(false)
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
    const built = entrada ? buildEntryShareContent(id, files, openFile, choiceOf(tree, chosen), recorder) : buildShareContent({ kind: target, id }, folders, files, openFile, withExams, recorder, kinds)
    void built.then(made => alive && setContent(made))
    return () => {
      alive = false
    }
  }, [withExams, kinds, chosen, google, configured, target, id])

  useEffect(() => {
    if (!google || !configured || entrada) return
    void questionCountOf({ kind: target, id }, folders, files).then(setQuestions)
  }, [google, configured])

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

  const uploadMedia = async (shareId: string): Promise<{ sent: number; failed: string[] }> => {
    let total = media.reduce((sum, item) => sum + (item.size ?? 0), 0)
    let sent = 0
    const failed: string[] = []
    for (const item of media) {
      const show = (bytesSent: number) => setProgress({ name: item.name, percent: total ? Math.min(100, Math.round(((sent + bytesSent) / total) * 100)) : 0 })
      try {
        show(0)
        const blob = await item.read()
        if (item.size === null) total += blob.size
        if (!blob.size) throw new Error('mídia vazia')
        sent += await uploadShareMediaController(token, shareId, item.fileId, blob, item.mime, show)
      } catch {
        failed.push(item.name)
      }
    }
    return { sent, failed }
  }

  const share = async () => {
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      const result = await createShareController(token, captcha, content)
      const uploaded = await uploadMedia(result.id)
      const record: ShareRecord = { id: result.id, kind: target, itemId: id, title: content.title, bytes: result.bytes + uploaded.sent, withExams: entrada || withExams, createdAt: result.createdAt, expiresAt: result.expiresAt }
      await saveShare(record)
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
  ) : valid && !renewing && !created && configured ? (
    <>
      <button className="btn quiet" onClick={ui.close}>
        Fechar
      </button>
      {/* "Copiar link", in the body, is the one primary action here */}
      <button className="btn" onClick={() => setRenewing(true)}>
        <Icon name="sync" />
        Renovar
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
      <button className="btn primary" disabled={!configured || !content || empty || !captcha || busy} onClick={() => void share()}>
        <Icon name="link" />
        {busy ? 'Compartilhando…' : 'Compartilhar'}
      </button>
    </>
  )

  return (
    <Dialog title={`${entrada ? 'Compartilhar entrada' : 'Compartilhar'} · ${name ?? ''}`} size={entrada ? 'normal' : 'narrow'} onClose={ui.close} footer={footer}>
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
        ) : valid && !renewing && !created ? (
          <CreatedShare share={valid} mediaFailed={[]} already />
        ) : created ? (
          <CreatedShare share={created} mediaFailed={mediaFailed} />
        ) : (
          <>
            <span className="muted" style={{ fontSize: 13 }}>
              Quem tiver o link pode ler, sem entrar em conta. O link vale por 3 dias e mostra a versão de agora.
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
