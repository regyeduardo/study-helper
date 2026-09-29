import { Icon } from '@/components/ui/Icon'
import type { FreeMinutesCheck } from '@/hooks/use-free-minutes'
import { FREE_MINUTES_INVITE, minutesText, shortOfMinutesText } from '@/lib/transcription/free'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function FreeMinutes({ check }: { check: FreeMinutesCheck }) {
  const transcription = useLibraryStore(state => state.index.settings.transcription)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const open = useUiStore(state => state.open)

  if (check.kind === 'off') return null
  if (check.kind === 'invite') {
    return (
      <div className="banner info" role="note" aria-label="Minutos grátis">
        <Icon name="info" />
        <span>{FREE_MINUTES_INVITE}.</span>
      </div>
    )
  }
  if (check.kind === 'loading') {
    return (
      <span className="faint" role="status" aria-label="Minutos grátis" style={{ fontSize: 12.5 }}>
        {check.measuring ? 'Medindo a fala do áudio e os minutos grátis de hoje…' : 'Vendo os minutos grátis de hoje…'}
      </span>
    )
  }
  if (check.kind === 'failed') {
    return (
      <span className="faint" role="status" aria-label="Minutos grátis" style={{ fontSize: 12.5 }}>
        {check.message}
      </span>
    )
  }
  if (check.short) {
    const useGroq = () => {
      void updateSettings({ transcription: { ...transcription, engine: 'groq' } })
      open({ kind: 'settings', tab: 'transcription' })
    }
    return (
      <div className="banner" role="alert" aria-label="Minutos grátis">
        <Icon name="warn" />
        <span style={{ display: 'grid', gap: 8 }}>
          <span>{shortOfMinutesText(check.remainingSeconds, check.speechSeconds ?? 0)} Nada foi enviado. Escolha outra forma:</span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => void updateSettings({ transcription: { ...transcription, engine: 'whisper' } })}>
              <Icon name="monitor" />
              Transcrever no navegador (Whisper)
            </button>
            <button className="btn" onClick={useGroq}>
              <Icon name="key" />
              Usar chave grátis da Groq
            </button>
          </span>
        </span>
      </div>
    )
  }
  return (
    <div className="banner info" role="status" aria-label="Minutos grátis">
      <Icon name="info" />
      <span>
        Hoje restam <b>{minutesText(check.remainingSeconds)}</b> grátis.{' '}
        {check.speechSeconds === null ? 'Só a fala conta: o silêncio é cortado antes de enviar.' : `Este áudio tem ${minutesText(check.speechSeconds, Math.ceil)} de fala; só a fala conta.`}
      </span>
    </div>
  )
}
