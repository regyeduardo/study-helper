import { useEffect, useMemo, useState } from 'react'

import type { LayoutId, Settings } from '@/types/domain'
import { AiSettings } from '@/components/dialogs/AiSettings'
import { IntegrationStatus } from '@/components/dialogs/IntegrationStatus'
import { Icon } from '@/components/ui/Icon'
import { isNarrowScreen } from '@/hooks/use-is-narrow'
import { fromLegacy, legacyAiOf } from '@/lib/ai/config'
import { DEFAULT_STORAGE_LIMIT_BYTES, defaultSettings } from '@/lib/defaults'
import { currentDevice } from '@/lib/device'
import { storageBreakdown, type StorageBreakdown } from '@/lib/storage/storage-usage'
import { applyTheme, savedTheme, type ThemeChoice } from '@/lib/theme'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { isOnline, useSyncStore } from '@/stores/sync'
import { type SettingsTab, useUiStore } from '@/stores/ui'
import { agoText, formatBytes } from '@/utils/format'

export const LAYOUTS: { id: LayoutId; name: string; about: string }[] = [
  { id: 'reader', name: '1 · Leitor', about: 'Lateral recolhível, leitor largo no meio e painel à direita com índice, notas e informações.' },
  { id: 'columns', name: '2 · Colunas', about: 'Coleções, lista e documento lado a lado, como no Bear e no Apple Notas.' },
  { id: 'commands', name: '3 · Comandos', about: 'Tabela densa com filtros e "Exibição", como no Linear; clicar espia o documento ao lado.' },
  { id: 'focus', name: '4 · Foco', about: 'Tela "Hoje", biblioteca só de texto e leitura em tela cheia com barra flutuante.' },
]

const LANGUAGES = [
  ['', 'Detectar sozinho'],
  ['pt', 'Português'],
  ['en', 'Inglês'],
  ['es', 'Espanhol'],
  ['fr', 'Francês'],
  ['de', 'Alemão'],
  ['it', 'Italiano'],
]

const MB = 1024 * 1024

function AppearanceTab() {
  const layout = useLibraryStore(state => state.index.settings.layout)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const [theme, setTheme] = useState<ThemeChoice>(savedTheme())
  return (
    <>
      <div className="field">
        <span className="lab">Cara do app</span>
        <div className="layout-pick" role="radiogroup" aria-label="Cara do app">
          {LAYOUTS.map(item => (
            <button key={item.id} role="radio" aria-checked={layout === item.id} aria-pressed={layout === item.id} onClick={() => void updateSettings({ layout: item.id })}>
              <b>{item.name}</b>
              <small>{item.about}</small>
            </button>
          ))}
        </div>
        <span className="faint" style={{ fontSize: 12 }}>
          Fica salvo nas suas configurações e vale em todos os seus navegadores.
        </span>
      </div>
      <div className="field">
        <label htmlFor="theme">Tema</label>
        <select
          className="input"
          id="theme"
          value={theme}
          onChange={event => {
            const choice = event.target.value as ThemeChoice
            setTheme(choice)
            applyTheme(choice)
          }}
        >
          <option value="system">Igual ao sistema</option>
          <option value="light">Claro</option>
          <option value="dark">Escuro</option>
        </select>
      </div>
    </>
  )
}

function LinksTab() {
  const settings = useLibraryStore(state => state.index.settings)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  return (
    <>
      <div className="field">
        <span className="lab">Link do YouTube</span>
        <div className="opts" role="radiogroup">
          <button className="opt" role="radio" aria-checked={settings.youtube.reader === 'youtube-transcript'} onClick={() => void updateSettings({ youtube: { ...settings.youtube, reader: 'youtube-transcript' } })}>
            <span className="radio" />
            <span>
              <b>youtube-transcript.ai</b>
              <span>
                Sem chave. Pega a legenda do vídeo. <span className="lim">Uso justo, sem garantia: pode ficar lento ou fora do ar.</span>
              </span>
            </span>
          </button>
          <button className="opt" role="radio" aria-checked={settings.youtube.reader === 'gemini'} onClick={() => void updateSettings({ youtube: { ...settings.youtube, reader: 'gemini' } })}>
            <span className="radio" />
            <span>
              <b>Gemini (Google)</b>
              <span>
                Chave grátis. Assiste o vídeo, inclusive sem legenda. <span className="lim">Até 8 h de vídeo por dia, só vídeo público.</span>
              </span>
            </span>
          </button>
        </div>
      </div>
      {settings.youtube.reader === 'gemini' && (
        <div className="field">
          <label htmlFor="gemini-key">Chave do Gemini</label>
          <input className="input" id="gemini-key" type="password" autoComplete="off" value={settings.youtube.geminiApiKey} onChange={event => void updateSettings({ youtube: { ...settings.youtube, geminiApiKey: event.target.value } })} />
        </div>
      )}
      <div className="banner info">
        <Icon name="info" />
        <span>Link de site é lido pelo Jina Reader (grátis, 20 pedidos por minuto).</span>
      </div>
    </>
  )
}

function StorageTab() {
  const account = useAccountStore(state => state.active())
  const usage = useSyncStore(state => state.usage)
  const refreshUsage = useSyncStore(state => state.refreshUsage)
  const limit = useLibraryStore(state => state.index.settings.storageLimitBytes)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const [draft, setDraft] = useState(limit ?? DEFAULT_STORAGE_LIMIT_BYTES)
  useEffect(() => void refreshUsage(), [refreshUsage])
  const percent = usage && limit ? Math.min(100, (usage.appBytes / limit) * 100) : 0
  return (
    <>
      <div className="field">
        <span className="lab">Uso do app</span>
        <div className="usebar">
          <i style={{ width: `${Math.max(percent, 1.2)}%`, background: 'var(--acc1)' }} />
        </div>
        <span className="usage">
          {formatBytes(usage?.appBytes)} {limit ? `de ${formatBytes(limit)}` : '(sem limite definido)'}
        </span>
      </div>
      <div className="field">
        <label htmlFor="lim">Limite do app: {formatBytes(draft)}</label>
        <input type="range" id="lim" min={256 * MB} max={10240 * MB} step={256 * MB} value={draft} onChange={event => setDraft(Number(event.target.value))} onMouseUp={() => void updateSettings({ storageLimitBytes: draft })} onKeyUp={() => void updateSettings({ storageLimitBytes: draft })} />
        <span className="faint" style={{ fontSize: 12 }}>
          O app confere antes de cada gravação e bloqueia o que passar do limite, dizendo quanto falta.
        </span>
      </div>
      {account.kind === 'google' ? (
        <div className="field">
          <span className="lab">Google Drive</span>
          <div className="usebar">
            <i style={{ width: `${usage?.cloudTotalBytes ? ((usage.cloudUsedBytes ?? 0) / usage.cloudTotalBytes) * 100 : 0}%`, background: 'var(--t-exp)' }} />
          </div>
          <span className="usage">
            {formatBytes(usage?.cloudUsedBytes)} de {formatBytes(usage?.cloudTotalBytes)} usados na conta · o app usa {formatBytes(usage?.appBytes)}
          </span>
        </div>
      ) : (
        <div className="banner info">
          <Icon name="info" />
          <span>No perfil Local, tudo fica neste navegador (espaço livre estimado: {formatBytes(usage?.cloudTotalBytes)}). O app pediu ao navegador para não apagar esses dados.</span>
        </div>
      )}
    </>
  )
}

function DevicesTab() {
  const account = useAccountStore(state => state.active())
  const devices = useSyncStore(state => state.devices)
  const me = currentDevice()
  if (account.kind === 'local') {
    return (
      <div className="banner info">
        <Icon name="info" />
        <span>O perfil Local não sincroniza: só existe este navegador. Entre com o Google para ver os seus dispositivos.</span>
      </div>
    )
  }
  const sorted = [...devices].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  return (
    <div className="field">
      <span className="lab">Logados agora ou há pouco</span>
      <div>
        {sorted.map(device => {
          const online = isOnline(device)
          return (
            <div key={device.id} className="dev">
              <Icon name="monitor" />
              <div>
                <div>
                  {device.name}
                  {device.id === me.id ? ' (este navegador)' : ''}
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  visto {agoText(device.lastSeen)}
                </div>
              </div>
              <span className={`st ${online ? 'on' : ''}`}>{online ? 'logado' : 'fora'}</span>
            </div>
          )
        })}
        {!sorted.length && <span className="muted">Ainda sincronizando…</span>}
      </div>
      <span className="faint" style={{ fontSize: 12 }}>
        Cada navegador marca presença na pasta devices/ a cada sincronização. Logado = visto nos últimos 10 min.
      </span>
    </div>
  )
}

function GeneralTab() {
  const settings = useLibraryStore(state => state.index.settings)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone')
    } catch {
      return ['America/Sao_Paulo', 'America/Manaus', 'America/Recife', 'Europe/Lisbon', 'UTC']
    }
  }, [])
  return (
    <>
      <div className="field">
        <label htmlFor="tz">Fuso horário</label>
        <select className="input" id="tz" value={settings.timezone} onChange={event => void updateSettings({ timezone: event.target.value })}>
          {zones.map(zone => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="tr-lang">Idioma falado</label>
        <select className="input" id="tr-lang" value={settings.transcription.language} onChange={event => void updateSettings({ transcription: { ...settings.transcription, language: event.target.value } })}>
          {LANGUAGES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="tr-terms">Siglas, nomes e termos que costumam sair errados</label>
        <textarea className="input" id="tr-terms" rows={3} placeholder="Um por linha. Ex.: API, Kubernetes, Ana Paula" value={settings.transcription.terms ?? ''} onChange={event => void updateSettings({ transcription: { ...settings.transcription, terms: event.target.value } })} />
        <span className="muted" style={{ fontSize: 12.5 }}>Vão junto com cada transcrição e com a revisão por IA, para o texto sair com a escrita certa.</span>
      </div>
      <div className="field">
        <label htmlFor="exam-mode">Prova</label>
        <select className="input" id="exam-mode" value={settings.examOneAtATime ? 'one' : 'all'} onChange={event => void updateSettings({ examOneAtATime: event.target.value === 'one' })}>
          <option value="all">Todas as questões de uma vez</option>
          <option value="one">Uma questão por vez</option>
        </select>
      </div>
      <SettingsImport />
    </>
  )
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function settingsFrom(text: string): Partial<Settings> | null {
  try {
    const parsed = JSON.parse(text) as { settings?: Partial<Settings> } & Partial<Settings>
    const found = parsed.settings ?? parsed
    return found && typeof found === 'object' && ('ai' in found || 'aiConfig' in found || 'transcription' in found) ? found : null
  } catch {
    return null
  }
}

function SettingsImport() {
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const [status, setStatus] = useState<string | null>(null)
  const restore = async (file: File | undefined) => {
    if (!file) return
    const imported = settingsFrom(await readText(file))
    if (!imported) {
      setStatus('Esse arquivo não tem configurações do app. Escolha o study-helper.json da pasta .sync-study-helper.')
      return
    }
    // A file saved before Provedores/Modelos/Padrões gets its old AI fields mapped, like on load.
    const aiConfig = imported.aiConfig ?? fromLegacy({ ...defaultSettings(), ...imported })
    await updateSettings({ ...imported, aiConfig, ai: legacyAiOf(aiConfig) })
    setStatus('Configurações trazidas do arquivo: IA, transcrição, links, fuso, layout e o resto.')
  }
  return (
    <div className="field">
      <span className="lab">Trazer configurações de um arquivo</span>
      <span className="faint" style={{ fontSize: 12 }}>
        Escolha o study-helper.json de uma pasta .sync-study-helper (de outra conta ou de uma cópia) para trazer todas as configurações de lá.
      </span>
      <label className="btn" style={{ justifySelf: 'start' }}>
        <Icon name="upload" />
        Escolher o study-helper.json
        <input type="file" accept=".json,application/json" hidden aria-label="Arquivo de configurações" onChange={event => void restore(event.target.files?.[0])} />
      </label>
      {status && (
        <span role="status" style={{ fontSize: 13 }}>
          {status}
        </span>
      )}
    </div>
  )
}

function OthersTab() {
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null)
  useEffect(() => {
    void storageBreakdown()
      .then(setBreakdown)
      .catch(() => setBreakdown({ mediaBytes: 0, appBytes: 0, totalBytes: 0 }))
  }, [])
  const parts: [string, number][] = breakdown
    ? [
        ['Gravações em Mídias', breakdown.mediaBytes],
        ['Dados do app (notas, cache e configurações)', breakdown.appBytes],
      ]
    : []
  return (
    <>
      <div className="field">
        <span className="lab">Integração no computador</span>
        <IntegrationStatus />
      </div>
      <div className="field">
        <span className="lab">Quanto o app ocupa neste navegador</span>
        {breakdown === null ? (
          <span className="faint">Medindo…</span>
        ) : (
          <>
            {parts.map(([name, bytes]) => (
              <span key={name} className="usage" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{name}</span>
                <span>{formatBytes(bytes)}</span>
              </span>
            ))}
            <span className="usage" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
              <span>Total</span>
              <span>{formatBytes(breakdown.totalBytes)}</span>
            </span>
          </>
        )}
      </div>
    </>
  )
}

const TABS: [SettingsTab, string][] = [
  ['appearance', 'Aparência'],
  ['ai', 'Inteligência artificial'],
  ['links', 'Links'],
  ['storage', 'Armazenamento'],
  ['devices', 'Dispositivos'],
  ['general', 'Geral'],
  ['others', 'Outros'],
]

export function SettingsDialog({ initial }: { initial?: SettingsTab }) {
  const close = useUiStore(state => state.close)
  const adding = useModelsStore(state => state.adding)
  // Idioma falado and the terms moved to Geral; the old "Transcrição" link opens it.
  const [tab, setTab] = useState<SettingsTab>(initial === 'transcription' ? 'general' : (initial ?? 'appearance'))
  // On the phone, opened without a section, it starts on the list of sections.
  const [menu, setMenu] = useState(() => !initial && isNarrowScreen())
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  const label = TABS.find(([id]) => id === tab)?.[1] ?? 'Configurações'
  return (
    <div className="scrim" inert={adding} onMouseDown={event => event.target === event.currentTarget && close()}>
      <div className="dialog settings" role="dialog" aria-label="Configurações">
        <div className="dh">
          {!menu && (
            <button className="ibtn on-phone" aria-label="Voltar" onClick={() => setMenu(true)}>
              <Icon name="back" />
            </button>
          )}
          <h2>
            <span className="on-desk">Configurações</span>
            <span className="on-phone">{menu ? 'Configurações' : label}</span>
          </h2>
          <button className="ibtn" onClick={close} aria-label="Fechar">
            <Icon name="x" />
          </button>
        </div>
        <div className={`set-grid${menu ? ' is-menu' : ''}`}>
          <nav className="set-nav" aria-label="Seções">
            {TABS.map(([id, name]) => (
              <button
                key={id}
                aria-pressed={tab === id}
                onClick={() => {
                  setTab(id)
                  setMenu(false)
                }}
              >
                {name}
              </button>
            ))}
          </nav>
          <div className={`set-body${tab === 'ai' ? ' ias' : ''}`}>
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'ai' && <AiSettings />}
            {tab === 'links' && <LinksTab />}
            {tab === 'storage' && <StorageTab />}
            {tab === 'devices' && <DevicesTab />}
            {tab === 'general' && <GeneralTab />}
            {tab === 'others' && <OthersTab />}
          </div>
        </div>
      </div>
    </div>
  )
}
