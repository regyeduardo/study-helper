import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import type { ShareRecord } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { deleteShareController, ShareError } from '@/controllers/share.controller'
import { useNow } from '@/hooks/use-now'
import { paths } from '@/lib/paths'
import { activeLinks, daysLeftText, isExpired, shareUrl } from '@/lib/share'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { formatBytes } from '@/utils/format'

export const SHARING_TITLES = { shares: 'Compartilhados', sharedWithMe: 'Compartilhado comigo', shared: 'Compartilhado' }

function ShareRow({ share }: { share: ShareRecord }) {
  const ui = useUiStore()
  const account = useAccountStore(state => state.active())
  const tokenFor = useAccountStore(state => state.tokenFor)
  const dropShare = useLibraryStore(state => state.dropShare)
  const url = shareUrl(share.id)
  const expired = isExpired(share.expiresAt)

  const remove = async () => {
    if (!expired) {
      if (account.kind !== 'google') {
        ui.toast('Entre com o Google para apagar o compartilhamento')
        return
      }
      try {
        const result = await deleteShareController(options => tokenFor(account.id, options), share.id)
        await dropShare(share.id)
        ui.toast(result.returned ? `Compartilhamento apagado: ${formatBytes(result.returned)} voltaram para a cota de hoje` : 'Compartilhamento apagado')
        return
      } catch (error) {
        if (!(error instanceof ShareError && error.status === 404)) {
          ui.toast(error instanceof Error ? error.message : 'Não consegui apagar.')
          return
        }
      }
    }
    await dropShare(share.id)
    ui.toast('Compartilhamento apagado')
  }

  const copy = async () => {
    await navigator.clipboard?.writeText(url).catch(() => undefined)
    ui.toast('Link copiado')
  }

  return (
    <div className="share-row" aria-label={`Compartilhamento: ${share.title}`}>
      <span className="share-ic">
        <Icon name={share.kind === 'folder' ? 'folder' : 'file'} />
      </span>
      <div className="share-main">
        <div className="title">{share.title}</div>
        {expired ? (
          <span className="faint share-link">Link expirado</span>
        ) : (
          <a className="share-link" href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
        )}
        <div className="sub">
          <span>
            <Icon name="clock" /> {expired ? 'expirado' : `faltam ${daysLeftText(share.expiresAt)}`}
          </span>
          <span>{formatBytes(share.bytes)}</span>
          {share.withExams && <span>com as provas</span>}
        </div>
      </div>
      <div className="share-actions">
        {!expired && (
          <button className="btn quiet" onClick={() => void copy()}>
            <Icon name="link" />
            <span className="lbl">Copiar link</span>
          </button>
        )}
        <button
          className="btn danger"
          onClick={() =>
            ui.open({
              kind: 'confirm',
              title: 'Apagar o compartilhamento?',
              text: `O link de "${share.title}" para de funcionar para todo mundo.`,
              ok: 'Apagar',
              danger: true,
              onConfirm: remove,
            })
          }
        >
          <Icon name="trash" />
          Apagar
        </button>
      </div>
    </div>
  )
}

function MyShares() {
  const shares = useLibraryStore(state => state.index.shares)
  useNow()
  if (!shares.length) return <p className="muted share-empty">Você ainda não compartilhou nada. Abra o menu ⋯ de uma nota, pasta ou curso e escolha Compartilhar.</p>
  return (
    <div className="share-list">
      {shares.map(share => (
        <ShareRow key={share.id} share={share} />
      ))}
    </div>
  )
}

function SharedWithMe() {
  const links = useLibraryStore(state => state.index.sharedWithMe)
  const pruneSharedLinks = useLibraryStore(state => state.pruneSharedLinks)
  const navigate = useNavigate()
  useNow()
  const active = activeLinks(links)
  useEffect(() => {
    if (active.length !== links.length) void pruneSharedLinks()
  }, [active.length, links.length])
  if (!active.length) return <p className="muted share-empty">Nenhum link ativo. Os links que você abrir aparecem aqui até expirarem.</p>
  return (
    <div className="share-list">
      {active.map(link => (
        <div key={link.id} className="share-row" aria-label={`Compartilhado comigo: ${link.title}`}>
          <span className="share-ic">
            <Icon name={link.kind === 'folder' ? 'folder' : 'file'} />
          </span>
          <div className="share-main">
            <div className="title">{link.title}</div>
            <div className="sub">
              <span>
                <Icon name="clock" /> faltam {daysLeftText(link.expiresAt)}
              </span>
            </div>
          </div>
          <div className="share-actions">
            <button className="btn" onClick={() => navigate(paths.shared(link.id))}>
              <Icon name="fwd" />
              Abrir
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

export function SharingView({ view, heading = true }: { view: 'shares' | 'sharedWithMe'; heading?: boolean }) {
  return (
    <section className="sharing" aria-label={SHARING_TITLES[view]}>
      {heading && <h2>{SHARING_TITLES[view]}</h2>}
      {view === 'shares' ? <MyShares /> : <SharedWithMe />}
    </section>
  )
}
