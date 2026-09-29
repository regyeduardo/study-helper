import { Icon } from '@/components/ui/Icon'
import { useFreeAi } from '@/hooks/use-free-ai'
import { FREE_AI_EXHAUSTED, isExhausted, lessonsLeft, lessonsText } from '@/lib/ai/free'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function FreeAi() {
  const check = useFreeAi()
  const ai = useLibraryStore(state => state.index.settings.ai)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const open = useUiStore(state => state.open)

  if (check.kind === 'off') return null
  if (check.kind !== 'ready') {
    return (
      <span className="faint" role="status" aria-label="IA grátis" style={{ fontSize: 12.5 }}>
        {check.kind === 'loading' ? 'Vendo a IA grátis de hoje…' : check.message}
      </span>
    )
  }
  if (isExhausted(check.balance)) {
    return (
      <div className="banner" role="alert" aria-label="IA grátis">
        <Icon name="warn" />
        <span style={{ display: 'grid', gap: 8 }}>
          <span>{FREE_AI_EXHAUSTED} Volta à meia-noite. Até lá, escolha outra IA:</span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => void updateSettings({ ai: { ...ai, provider: 'ovh', apiKey: '', model: '', baseUrl: '' } })}>
              <Icon name="bulb" />
              Usar a OVH (grátis, lenta)
            </button>
            <button className="btn" onClick={() => open({ kind: 'settings', tab: 'ai' })}>
              <Icon name="key" />
              Configurar o Gemini grátis
            </button>
          </span>
        </span>
      </div>
    )
  }
  return (
    <div className="banner info" role="status" aria-label="IA grátis">
      <Icon name="info" />
      <span>
        IA grátis: <b>{lessonsText(lessonsLeft(check.balance))}</b>.
      </span>
    </div>
  )
}
