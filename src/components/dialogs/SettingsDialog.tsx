import { useEffect, useMemo, useState } from 'react'

import type { AiProviderId, AiSettings, LayoutId, TranscriptionEngine } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { listModelsController } from '@/controllers/ai.controller'
import { isFreeChoice, PROVIDERS, type ProviderInfo, providerOf } from '@/lib/ai/providers'
import { DEFAULT_STORAGE_LIMIT_BYTES } from '@/lib/defaults'
import { currentDevice } from '@/lib/device'
import { applyTheme, savedTheme, type ThemeChoice } from '@/lib/theme'
import { ENGINES } from '@/lib/transcription'
import { useAccountStore } from '@/stores/account'
import { useLibraryStore } from '@/stores/library'
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

const PROVIDER_GROUPS: { label: string; includes: (provider: ProviderInfo) => boolean }[] = [
  { label: 'Grátis na nuvem · sem chave', includes: provider => provider.free && !provider.needsKey },
  { label: 'Grátis na nuvem · chave grátis', includes: provider => provider.free && provider.needsKey },
  { label: 'Pagas e personalizado', includes: provider => !provider.free },
]

function AiTab() {
  const saved = useLibraryStore(state => state.index.settings.ai)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const [draft, setDraft] = useState<AiSettings>(saved)
  const [keys, setKeys] = useState<Record<string, string>>({ [saved.provider]: saved.apiKey })
  const [models, setModels] = useState<string[]>(saved.model ? [saved.model] : [])
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; message?: string }>({ state: 'idle' })
  const provider = providerOf(draft.provider)
  const changed = JSON.stringify(draft) !== JSON.stringify(saved)

  const pick = (id: AiProviderId) => {
    setDraft({ provider: id, baseUrl: id === 'custom' ? draft.baseUrl : '', apiKey: keys[id] ?? '', model: '' })
    setModels([])
    setTest({ state: 'idle' })
  }

  const runTest = async (): Promise<boolean> => {
    setTest({ state: 'busy' })
    try {
      const found = provider.models ?? (await listModelsController(draft))
      if (provider.models) await listModelsController(draft)
      setModels(found)
      if (!draft.model && found.length) setDraft(current => ({ ...current, model: provider.keylessModel && !current.apiKey && found.includes(provider.keylessModel) ? provider.keylessModel : found[0] }))
      setTest({ state: 'ok', message: `Conectado · ${found.length} ${found.length === 1 ? 'modelo disponível' : 'modelos disponíveis'}` })
      return true
    } catch (error) {
      setTest({ state: 'fail', message: error instanceof Error ? error.message : 'Não respondeu.' })
      return false
    }
  }

  const save = async () => {
    if (!(await runTest())) return
    await updateSettings({ ai: draft })
    setTest(current => ({ ...current, message: `${current.message ?? 'Conectado'} · salvo` }))
  }

  return (
    <>
      {PROVIDER_GROUPS.map(group => (
        <div className="field" key={group.label}>
          <span className="lab">{group.label}</span>
          <div className="prov">
            {PROVIDERS.filter(group.includes).map(item => (
              <button key={item.id} aria-pressed={draft.provider === item.id} onClick={() => pick(item.id)}>
                <b>{item.name}</b>
                <small className={item.free ? 'free' : ''}>{item.tag}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      {draft.provider === 'custom' && (
        <div className="field">
          <label htmlFor="ai-url">URL base (formato OpenAI)</label>
          <input className="input" id="ai-url" placeholder={provider.baseUrl || 'https://minha-ia.exemplo.com/v1'} value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} />
        </div>
      )}
      <div className="field">
        <label htmlFor="ai-key">Chave da API{provider.needsKey ? '' : ' (opcional)'}</label>
        <input
          className="input"
          id="ai-key"
          type="password"
          autoComplete="off"
          placeholder={provider.needsKey ? `Cole a chave de ${provider.name}` : 'Sem chave funciona; com chave, usa o seu plano'}
          value={draft.apiKey}
          onChange={event => {
            setDraft({ ...draft, apiKey: event.target.value })
            setKeys({ ...keys, [draft.provider]: event.target.value })
          }}
        />
        <span className="faint" style={{ fontSize: 12 }}>
          Fica salva no .json das suas configurações e aparece sempre com asteriscos.
          {provider.keyHelpUrl && (
            <>
              {' '}
              Pegue a chave em{' '}
              <a href={provider.keyHelpUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--acc1)' }}>
                {new URL(provider.keyHelpUrl).host}
              </a>
              .
            </>
          )}
        </span>
      </div>
      <div className="field">
        <label htmlFor="ai-model">Modelo</label>
        {models.length ? (
          <select className="input" id="ai-model" value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })}>
            {!models.includes(draft.model) && <option value={draft.model}>{draft.model || 'escolha'}</option>}
            {models.map(model => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : (
          <input className="input" id="ai-model" placeholder={provider.keylessModel ?? 'Teste para listar os modelos'} value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} />
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          A lista vem do próprio {provider.name} depois do teste.
        </span>
      </div>
      {isFreeChoice(draft) && (
        <div className="freewarn">
          <Icon name="warn" />
          Modelos grátis podem comprometer o resultado da geração.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void runTest()} disabled={test.state === 'busy'}>
          <Icon name="check" />
          Testar sem gastar token
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={test.state === 'busy' || !changed}>
          Testar e salvar
        </button>
        <span style={{ fontSize: 13, color: test.state === 'ok' ? 'var(--ok)' : test.state === 'fail' ? 'var(--bad)' : 'var(--fg-muted)' }} role="status">
          {test.state === 'busy' ? 'Testando…' : (test.message ?? 'O teste só lista os modelos: não consome nada.')}
        </span>
      </div>
    </>
  )
}

function TranscriptionTab() {
  const settings = useLibraryStore(state => state.index.settings)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const transcription = settings.transcription
  const set = (patch: Partial<typeof transcription>) => void updateSettings({ transcription: { ...transcription, ...patch } })
  return (
    <>
      <div className="field">
        <span className="lab">Transcrição de áudio e vídeo</span>
        <div className="opts" role="radiogroup">
          {ENGINES.map(engine => (
            <button key={engine.id} className="opt" role="radio" aria-checked={transcription.engine === engine.id} onClick={() => set({ engine: engine.id as TranscriptionEngine })}>
              <span className="radio" />
              <span>
                <b>{engine.name}</b>
                <span>
                  {engine.where}. <span className="lim">{engine.limits}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {transcription.engine === 'groq' && (
        <div className="field">
          <label htmlFor="groq-key">Chave da Groq</label>
          <input className="input" id="groq-key" type="password" autoComplete="off" value={transcription.groqApiKey} onChange={event => set({ groqApiKey: event.target.value })} placeholder="gsk_…" />
        </div>
      )}
      <div className="field">
        <label htmlFor="tr-lang">Idioma falado</label>
        <select className="input" id="tr-lang" value={transcription.language} onChange={event => set({ language: event.target.value })}>
          {LANGUAGES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <button className="opt" role="checkbox" aria-checked={transcription.separateSpeakers} onClick={() => set({ separateSpeakers: !transcription.separateSpeakers })}>
        <span className="radio" style={{ borderRadius: 5 }} />
        <span>
          <b>Separar quem fala</b>
          <span>Marca "Falante 1", "Falante 2"… na transcrição. Baixa ~35 MB na primeira vez e roda no navegador.</span>
        </span>
      </button>
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
        <label htmlFor="exam-mode">Prova</label>
        <select className="input" id="exam-mode" value={settings.examOneAtATime ? 'one' : 'all'} onChange={event => void updateSettings({ examOneAtATime: event.target.value === 'one' })}>
          <option value="all">Todas as questões de uma vez</option>
          <option value="one">Uma questão por vez</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="gh">Token do GitHub (leitor de markdown)</label>
        <input className="input" id="gh" type="password" autoComplete="off" value={settings.githubToken} onChange={event => void updateSettings({ githubToken: event.target.value })} placeholder="Opcional: sem token, o GitHub deixa 60 documentos por hora" />
      </div>
    </>
  )
}

const TABS: [SettingsTab, string][] = [
  ['appearance', 'Aparência'],
  ['ai', 'Inteligência artificial'],
  ['transcription', 'Transcrição e links'],
  ['storage', 'Armazenamento'],
  ['devices', 'Dispositivos'],
  ['general', 'Geral'],
]

export function SettingsDialog({ initial = 'appearance' }: { initial?: SettingsTab }) {
  const close = useUiStore(state => state.close)
  const account = useAccountStore(state => state.active())
  const [tab, setTab] = useState<SettingsTab>(initial)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  return (
    <div className="scrim" onMouseDown={event => event.target === event.currentTarget && close()}>
      <div className="dialog wide" role="dialog" aria-label="Configurações" style={{ height: 'min(680px,100%)' }}>
        <div className="dh">
          <h2>Configurações</h2>
          <button className="ibtn" onClick={close} aria-label="Fechar">
            <Icon name="x" />
          </button>
        </div>
        <div className="set-grid">
          <nav className="set-nav">
            {TABS.map(([id, label]) => (
              <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="set-body">
            {tab === 'appearance' && <AppearanceTab />}
            {tab === 'ai' && <AiTab />}
            {tab === 'transcription' && <TranscriptionTab />}
            {tab === 'storage' && <StorageTab />}
            {tab === 'devices' && <DevicesTab />}
            {tab === 'general' && <GeneralTab />}
          </div>
        </div>
        <div className="df">
          <span className="grow">Tudo fica no .json das suas configurações{account.kind === 'local' ? ' (no perfil Local, neste navegador)' : ', na pasta .sync-study-helper do seu Drive'}.</span>
          <button className="btn primary" onClick={close}>
            Pronto
          </button>
        </div>
      </div>
    </div>
  )
}
