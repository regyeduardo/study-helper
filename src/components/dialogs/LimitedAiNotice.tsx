import { Icon } from '@/components/ui/Icon'
import { providerOf } from '@/lib/ai/providers'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export function LimitedAiNotice() {
  const ai = useLibraryStore(state => state.index.settings.ai)
  const open = useUiStore(state => state.open)
  if (ai.provider !== 'ovh' || ai.apiKey) return null
  const keyUrl = providerOf('gemini').keyHelpUrl
  return (
    <div className="banner info" role="note" aria-label="IA limitada">
      <Icon name="info" />
      <span style={{ display: 'grid', gap: 6 }}>
        <span>Você está usando a IA grátis que já vem no app (OVHcloud). Ela funciona sem cadastro, mas é lenta, perto de 10 minutos por aula grande, e tem limite de uso.</span>
        <span>
          <b>Recomendado: use o Google Gemini, que também é grátis.</b> Para criar a chave grátis:
        </span>
        <ol aria-label="Como criar a chave grátis do Gemini" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 2 }}>
          <li>
            Abra{' '}
            <a href={keyUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--acc1)' }}>
              aistudio.google.com/apikey
            </a>{' '}
            e entre com a sua conta Google.
          </li>
          <li>
            Clique em <b>Create API key</b>. Se pedir, aceite os termos e deixe criar um projeto novo; não pede cartão.
          </li>
          <li>Copie a chave que aparece.</li>
          <li>
            Aqui no app, em Configurações › Inteligência artificial, escolha <b>Google Gemini</b>, cole a chave em <b>Chave da API</b> e clique em <b>Testar e salvar</b>.
          </li>
        </ol>
        <span>
          <button className="btn quiet" style={{ height: 24, padding: '0 8px' }} onClick={() => open({ kind: 'settings', tab: 'ai' })}>
            Configurar IA
          </button>
        </span>
      </span>
    </div>
  )
}
