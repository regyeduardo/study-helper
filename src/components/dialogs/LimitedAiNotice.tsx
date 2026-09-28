import { Icon } from '@/components/ui/Icon'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function LimitedAiNotice() {
  const ai = useLibraryStore(state => state.index.settings.ai)
  const open = useUiStore(state => state.open)
  if (ai.provider !== 'ovh' || ai.apiKey) return null
  return (
    <div className="banner info" role="note" aria-label="IA limitada">
      <Icon name="info" />
      <span>
        Você está usando a IA grátis que já vem no app (OVHcloud). Ela funciona sem cadastro, mas é lenta, perto de 10 minutos por aula grande, e tem limite de uso. Para gerar mais rápido, configure outra IA: o Google Gemini, por exemplo, também é grátis.{' '}
        <button className="btn quiet" style={{ height: 24, padding: '0 8px' }} onClick={() => open({ kind: 'settings', tab: 'ai' })}>
          Configurar IA
        </button>
      </span>
    </div>
  )
}
