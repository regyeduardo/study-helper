import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { ShareContent, ShareKind, ShareRecord } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { createShareController, isShareConfigured, uploadShareMediaController } from '@/controllers/share.controller'
import { env } from '@/lib/env'
import { paths } from '@/lib/paths'
import { buildShareContent, questionCountOf, shareBytes, shareMediaOf, shareUrl } from '@/lib/share'
import { loadTurnstile } from '@/lib/turnstile'
import { useAccountStore } from '@/stores/account'
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

interface MediaProgress {
  name: string
  percent: number
}

function CreatedShare({ share, mediaFailed }: { share: ShareRecord; mediaFailed: string[] }) {
  const toast = useUiStore(state => state.toast)
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  const url = shareUrl(share.id)
  const copy = async () => {
    await navigator.clipboard?.writeText(url).catch(() => undefined)
    toast('Link copiado')
  }
  return (
    <>
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
        Vale por 3 dias, até {dateTime(share.expiresAt, timeZone)}, e mostra a versão de agora. Se mudar alguma coisa, apague em Compartilhados e compartilhe de novo.
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
  const [content, setContent] = useState<ShareContent | null>(null)
  const [questions, setQuestions] = useState(0)
  const [progress, setProgress] = useState<MediaProgress | null>(null)
  const [mediaFailed, setMediaFailed] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [captcha, setCaptcha] = useState('')
  const [captchaRound, setCaptchaRound] = useState(0)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<ShareRecord | null>(null)
  const google = account.kind === 'google'
  const configured = isShareConfigured()
  const token = (options?: { force?: boolean }) => tokenFor(account.id, options)
  const name = target === 'folder' ? folders.find(folder => folder.id === id)?.name : files.find(file => file.id === id)?.name

  useEffect(() => {
    if (!google || !configured) return
    let alive = true
    setContent(null)
    void buildShareContent({ kind: target, id }, folders, files, openFile, withExams).then(built => alive && setContent(built))
    return () => {
      alive = false
    }
  }, [withExams, google, configured, target, id])

  useEffect(() => {
    if (!google || !configured) return
    void questionCountOf({ kind: target, id }, folders, files).then(setQuestions)
  }, [google, configured])

  const bytes = content ? shareBytes(content) : null
  const media = content ? shareMediaOf(content, files, localMedia, repo) : []
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
      const record: ShareRecord = { id: result.id, kind: target, itemId: id, title: content.title, bytes: result.bytes + uploaded.sent, withExams, createdAt: result.createdAt, expiresAt: result.expiresAt }
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
    <Dialog title={`Compartilhar · ${name ?? ''}`} size="narrow" onClose={ui.close} footer={footer}>
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
        ) : created ? (
          <CreatedShare share={created} mediaFailed={mediaFailed} />
        ) : (
          <>
            <span className="muted" style={{ fontSize: 13 }}>
              Quem tiver o link pode ler, sem entrar em conta. O link vale por 3 dias e mostra a versão de agora.
            </span>
            <button className="opt" role="checkbox" aria-checked={withExams} onClick={() => setWithExams(value => !value)}>
              <span className={`check ${withExams ? 'on' : ''}`}>{withExams && <Icon name="check" />}</span>
              <span>
                <b>Levar as provas</b>
                <span>{questions === 1 ? 'Vai só a questão' : questions ? `Vão só as ${questions} questões` : 'Vão só as questões'}. Suas tentativas, notas e destaques ficam com você.</span>
              </span>
            </button>
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
