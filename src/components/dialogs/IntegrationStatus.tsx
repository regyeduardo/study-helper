import { useEffect } from 'react'

import { Icon } from '@/components/ui/Icon'
import { INTEGRATION_DOWNLOADS, integrationOsOf, useIntegrationStore } from '@/lib/recording/integration'

const OS_NAMES = { linux: 'Linux', windows: 'Windows' }

export function IntegrationStatus() {
  const status = useIntegrationStore(state => state.status)
  const hello = useIntegrationStore(state => state.hello)
  const check = useIntegrationStore(state => state.check)
  const os = integrationOsOf()
  useEffect(() => {
    void check()
  }, [check])
  if (status === 'connected') {
    return (
      <div className="banner info" role="status" aria-label="Integração">
        <Icon name="check" />
        <span>
          Integração conectada{hello ? ` (versão ${hello.version})` : ''}. Ela grava o som de uma janela ou do computador inteiro e o seu microfone direto do sistema.
        </span>
      </div>
    )
  }
  return (
    <div className="banner" role="status" aria-label="Integração">
      <Icon name="info" />
      <span style={{ display: 'grid', gap: 8 }}>
        <span>
          {status === 'missing'
            ? 'Integração não conectada. Com ela você grava o som de uma janela ou do computador inteiro e o seu microfone, em qualquer navegador.'
            : 'Procurando a integração neste computador…'}
        </span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {os ? (
            <a className="btn" href={INTEGRATION_DOWNLOADS[os]} download style={{ textDecoration: 'none', color: 'var(--fg)' }}>
              <Icon name="download" />
              Baixar a integração ({OS_NAMES[os]})
            </a>
          ) : (
            <span className="faint">A integração existe para Linux e Windows.</span>
          )}
          <button className="btn quiet" onClick={() => void check()} disabled={status === 'checking'}>
            Verificar de novo
          </button>
        </span>
        {os === 'linux' && <span className="faint">Depois de baixar, abra o arquivo (se pedir, marque “permitir executar”). Ele se instala sozinho e passa a abrir com o login.</span>}
        {os === 'windows' && <span className="faint">Depois de baixar, abra o arquivo. Se o Windows avisar, clique em “Mais informações › Executar assim mesmo”. Ele se instala sozinho e passa a abrir com o login.</span>}
      </span>
    </div>
  )
}
