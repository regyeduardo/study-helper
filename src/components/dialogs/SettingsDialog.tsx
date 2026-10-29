import { useEffect, useMemo, useState } from 'react'

import type { AiProviderId, AiSettings, LayoutId, ProviderEngine, Settings, SpeakersEngine, TranscriptionCredential, TranscriptionEngine } from '@/types/domain'
import { IntegrationStatus } from '@/components/dialogs/IntegrationStatus'
import { PassModels } from '@/components/dialogs/PassModels'
import { Icon } from '@/components/ui/Icon'
import { listModelsController } from '@/controllers/ai.controller'
import { isFreeChoice, isKnownProvider, modelOf, PROVIDER_LEFT, PROVIDERS, type ProviderInfo, providerOf } from '@/lib/ai/providers'
import { DEFAULT_STORAGE_LIMIT_BYTES, defaultSettings } from '@/lib/defaults'
import { currentDevice } from '@/lib/device'
import { storageBreakdown, type StorageBreakdown } from '@/lib/storage/storage-usage'
import { applyTheme, savedTheme, type ThemeChoice } from '@/lib/theme'
import { ENGINES } from '@/lib/transcription'
import { DEEPINFRA_MODEL } from '@/lib/transcription/providers/deepinfra'
import { GEMINI_MODEL } from '@/lib/transcription/providers/gemini'
import { OPENAI_MODEL } from '@/lib/transcription/providers/openai'
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
  { label: 'Com chave grátis', includes: provider => provider.free },
  { label: 'Pagas e personalizado', includes: provider => !provider.free },
]

function AiTab() {
  const saved = useLibraryStore(state => state.index.settings.ai)
  const credentials = useLibraryStore(state => state.index.settings.aiCredentials)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const [draft, setDraft] = useState<AiSettings>(saved)
  const [keys, setKeys] = useState<Record<string, string>>({ [saved.provider]: saved.apiKey })
  const [models, setModels] = useState<string[]>(providerOf(saved.provider).models ?? (saved.model ? [saved.model] : []))
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; message?: string }>({ state: 'idle' })
  const provider = providerOf(draft.provider)
  const changed = JSON.stringify(draft) !== JSON.stringify(saved)

  const known = (id: AiProviderId) => credentials[id] ?? (id === saved.provider ? { apiKey: saved.apiKey, model: saved.model, baseUrl: saved.baseUrl } : undefined)

  const pick = (id: AiProviderId) => {
    const kept = known(id)
    setDraft({ provider: id, baseUrl: id === 'custom' ? (kept?.baseUrl ?? draft.baseUrl) : '', apiKey: keys[id] ?? kept?.apiKey ?? '', model: kept?.model ?? '' })
    setModels(providerOf(id).models ?? (kept?.model ? [kept.model] : []))
    setTest({ state: 'idle' })
  }

  const remember = (tested: AiSettings) => updateSettings({ aiCredentials: { ...credentials, [tested.provider]: { apiKey: tested.apiKey, model: tested.model, baseUrl: tested.baseUrl } } })

  const forgetKey = async () => {
    setDraft({ ...draft, apiKey: '' })
    setKeys({ ...keys, [draft.provider]: '' })
    const rest = Object.fromEntries(Object.entries(credentials).filter(([id]) => id !== draft.provider))
    const inUse = saved.provider === draft.provider
    await updateSettings({ aiCredentials: rest, ...(inUse ? { ai: provider.needsKey ? defaultSettings().ai : { ...saved, apiKey: '' } } : {}) })
  }

  const runTest = async (): Promise<AiSettings | null> => {
    setTest({ state: 'busy' })
    try {
      const found = provider.models ?? (await listModelsController(draft))
      if (provider.models) await listModelsController(draft)
      setModels(found)
      const fallback = provider.keylessModel && !draft.apiKey && found.includes(provider.keylessModel) ? provider.keylessModel : found[0]
      const tested = { ...draft, model: draft.model || fallback || '' }
      setDraft(tested)
      await remember(tested)
      setTest({ state: 'ok', message: `Conectado · ${found.length} ${found.length === 1 ? 'modelo disponível' : 'modelos disponíveis'}` })
      return tested
    } catch (error) {
      setTest({ state: 'fail', message: error instanceof Error ? error.message : 'Não respondeu.' })
      return null
    }
  }

  const save = async () => {
    const tested = await runTest()
    if (!tested) return
    await updateSettings({ ai: tested })
    setTest(current => ({ ...current, message: `${current.message ?? 'Conectado'} · salvo` }))
  }

  const savedProvider = providerOf(saved.provider)
  return (
    <>
      <div className="banner info" role="note" aria-label="IA em uso">
        <Icon name="check" />
        <span>
          Em uso: <b>{savedProvider.name}</b>
          {` · ${modelOf(saved) || 'sem modelo'}`}
          {saved.provider === 'custom' && saved.baseUrl ? ` · ${saved.baseUrl}` : ''}
          {saved.apiKey ? ` · chave ••••${saved.apiKey.slice(-4)}` : savedProvider.needsKey ? ' · sem chave' : ''}
        </span>
      </div>
      {!isKnownProvider(saved.provider) && (
        <div className="freewarn" role="alert">
          <Icon name="warn" />
          {PROVIDER_LEFT}
        </div>
      )}
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
      <>
          <div className="field">
            <label htmlFor="ai-key">Chave da API{provider.needsKey ? '' : ' (opcional)'}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                id="ai-key"
                type="password"
                autoComplete="off"
                style={{ flex: 1 }}
                placeholder={provider.needsKey ? `Cole a chave de ${provider.name}` : 'Sem chave funciona; com chave, usa o seu plano'}
                value={draft.apiKey}
                onChange={event => {
                  setDraft({ ...draft, apiKey: event.target.value })
                  setKeys({ ...keys, [draft.provider]: event.target.value })
                }}
              />
              {(draft.apiKey || known(draft.provider)?.apiKey) && (
                <button className="btn" onClick={() => void forgetKey()}>
                  <Icon name="trash" />
                  Apagar chave
                </button>
              )}
            </div>
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
          <select className="input" id="ai-model" value={modelOf(draft)} onChange={event => setDraft({ ...draft, model: event.target.value })}>
            {!models.includes(modelOf(draft)) && <option value={modelOf(draft)}>{modelOf(draft) || 'escolha'}</option>}
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
          {provider.models ? 'Só o modelo que passou no teste de uso contínuo do app.' : `A lista vem do próprio ${provider.name} depois do teste.`}
        </span>
      </div>
      {isFreeChoice(draft) && (
        <div className="freewarn">
          <Icon name="warn" />
          Modelos grátis podem comprometer o resultado da geração.
        </div>
      )}
      </>
      <PassModels />
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

const EMPTY_CREDENTIAL: TranscriptionCredential = { apiKey: '', baseUrl: '', model: '', extra: '' }

const PROVIDER_FORM: Record<ProviderEngine, { keyHint: string; model: string }> = {
  openai: { keyHint: 'sk-…', model: OPENAI_MODEL },
  deepinfra: { keyHint: 'chave da DeepInfra', model: DEEPINFRA_MODEL },
  gemini: { keyHint: 'chave do Google AI Studio', model: GEMINI_MODEL },
  custom: { keyHint: 'chave do serviço', model: '' },
}

const SPEAKER_ENGINES: Exclude<SpeakersEngine, ''>[] = ['deepinfra', 'openai', 'custom']
const ENGINE_NAMES: Record<Exclude<SpeakersEngine, ''>, string> = { deepinfra: 'DeepInfra (Nemotron)', openai: 'OpenAI', custom: 'Personalizado' }
const ENGINE_OF: Record<Exclude<SpeakersEngine, ''>, string> = { deepinfra: 'da DeepInfra', openai: 'da OpenAI', custom: 'do provedor personalizado' }

const VISION_PROVIDERS: AiProviderId[] = ['openai', 'anthropic', 'gemini', 'xai', 'custom']

function VisionTab() {
  const settings = useLibraryStore(state => state.index.settings)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; message?: string }>({ state: 'idle' })
  const vision = settings.vision ?? { provider: '', model: '' }
  const chosen = vision.provider || null
  const known = (id: AiProviderId) => settings.aiCredentials[id] ?? (settings.ai.provider === id ? { apiKey: settings.ai.apiKey, model: settings.ai.model, baseUrl: settings.ai.baseUrl } : undefined)
  const credential = chosen ? known(chosen) : undefined
  const provider = chosen ? providerOf(chosen) : null
  const setVision = (patch: Partial<typeof vision>) => void updateSettings({ vision: { ...vision, ...patch } })
  const setCredential = (patch: { apiKey?: string; baseUrl?: string }) => {
    if (!chosen) return
    void updateSettings({ aiCredentials: { ...settings.aiCredentials, [chosen]: { apiKey: '', model: '', baseUrl: '', ...credential, ...patch } } })
    setTest({ state: 'idle' })
  }
  const runTest = async () => {
    if (!chosen) return
    setTest({ state: 'busy' })
    try {
      const found = await listModelsController({ provider: chosen, baseUrl: credential?.baseUrl ?? '', apiKey: credential?.apiKey ?? '', model: vision.model })
      setTest({ state: 'ok', message: `Conectado · ${found.length} ${found.length === 1 ? 'modelo disponível' : 'modelos disponíveis'}` })
    } catch (error) {
      setTest({ state: 'fail', message: error instanceof Error ? error.message : 'Não respondeu.' })
    }
  }
  return (
    <>
      <div className="field">
        <span className="lab">Provedor da visão</span>
        <div className="prov">
          <button aria-pressed={!chosen} onClick={() => setVision({ provider: '', model: '' })}>
            <b>Nenhum</b>
            <small>não olha a tela gravada</small>
          </button>
          {VISION_PROVIDERS.map(id => (
            <button key={id} aria-pressed={chosen === id} onClick={() => (setVision({ provider: id, model: chosen === id ? vision.model : (providerOf(id).models?.[0] ?? '') }), setTest({ state: 'idle' }))}>
              <b>{providerOf(id).name}</b>
              <small className={providerOf(id).free ? 'free' : ''}>{providerOf(id).tag}</small>
            </button>
          ))}
        </div>
      </div>
      {chosen && provider && (
        <>
          {chosen === 'custom' && (
            <div className="field">
              <label htmlFor="vision-url">URL base da visão</label>
              <input className="input" id="vision-url" placeholder="https://minha-ia.exemplo.com/v1" value={credential?.baseUrl ?? ''} onChange={event => setCredential({ baseUrl: event.target.value })} />
            </div>
          )}
          <div className="field">
            <label htmlFor="vision-key">Chave do {provider.name}</label>
            <input className="input" id="vision-key" type="password" autoComplete="off" placeholder={`Cole a chave de ${provider.name}`} value={credential?.apiKey ?? ''} onChange={event => setCredential({ apiKey: event.target.value })} />
            <span className="faint" style={{ fontSize: 12 }}>
              {settings.ai.provider === chosen ? 'É a mesma chave da aba Geral: mudar aqui muda lá também.' : 'Fica salva só para este provedor; não mexe na IA de texto.'}
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
            <label htmlFor="vision-model">Modelo de visão</label>
            <input className="input" id="vision-model" autoComplete="off" value={vision.model} onChange={event => setVision({ model: event.target.value })} placeholder="um modelo que lê imagem, ex.: gemini-3.5-flash-lite" />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => void runTest()} disabled={test.state === 'busy'}>
              <Icon name="check" />
              Testar a visão
            </button>
            <span style={{ fontSize: 13, color: test.state === 'ok' ? 'var(--ok)' : test.state === 'fail' ? 'var(--bad)' : 'var(--fg-muted)' }} role="status">
              {test.state === 'busy' ? 'Testando…' : (test.message ?? 'Lê nomes e slides da tela gravada.')}
            </span>
          </div>
        </>
      )}
    </>
  )
}

type AiSection = 'general' | 'transcription' | 'vision'

const AI_SECTIONS: [AiSection, string][] = [
  ['general', 'Geral'],
  ['transcription', 'Transcrição'],
  ['vision', 'Visão'],
]

function AiArea({ initial }: { initial: AiSection }) {
  const [section, setSection] = useState<AiSection>(initial)
  return (
    <>
      <div className="ai-tabs" role="tablist" aria-label="Partes da inteligência artificial">
        {AI_SECTIONS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={section === id} className="chip" aria-pressed={section === id} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </div>
      {section === 'general' && <AiTab />}
      {section === 'transcription' && <TranscriptionTab />}
      {section === 'vision' && <VisionTab />}
    </>
  )
}

function validExtra(extra: string): boolean {
  if (!extra.trim()) return true
  try {
    const parsed: unknown = JSON.parse(extra)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function TranscriptionTab() {
  const settings = useLibraryStore(state => state.index.settings)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const transcription = settings.transcription
  const set = (patch: Partial<typeof transcription>) => void updateSettings({ transcription: { ...transcription, ...patch } })
  const credentials = transcription.credentials ?? {}
  const form = transcription.engine in PROVIDER_FORM ? PROVIDER_FORM[transcription.engine as ProviderEngine] : null
  const credential = credentials[transcription.engine as ProviderEngine] ?? EMPTY_CREDENTIAL
  const second = form && transcription.speakersEngine !== transcription.engine ? (transcription.speakersEngine ?? '') : ''
  const chosen = ENGINES.find(engine => engine.id === transcription.engine) ?? null
  const setCredential = (engine: ProviderEngine, patch: Partial<TranscriptionCredential>) => set({ credentials: { ...credentials, [engine]: { ...EMPTY_CREDENTIAL, ...credentials[engine], ...patch } } })
  return (
    <>
      <div className="field">
        <span className="lab">Transcrição de áudio e vídeo</span>
        <div className="opts cols2" role="radiogroup">
          {ENGINES.map(engine => (
            <button key={engine.id} className="opt" role="radio" aria-checked={transcription.engine === engine.id} onClick={() => set({ engine: engine.id as TranscriptionEngine })}>
              <span className="radio" />
              <span>
                <b>{engine.name}</b>
                <span>{engine.where}</span>
              </span>
            </button>
          ))}
        </div>
        {chosen && <span className="lim-line">{chosen.limits}</span>}
      </div>
      {form && (
        <>
          {transcription.engine === 'custom' && (
            <div className="field">
              <label htmlFor="tr-base">Endereço (URL base)</label>
              <input className="input" id="tr-base" autoComplete="off" value={credential.baseUrl} onChange={event => setCredential(transcription.engine as ProviderEngine, { baseUrl: event.target.value })} placeholder="https://…/v1" />
            </div>
          )}
          <div className="row2">
            <div className="field">
              <label htmlFor="tr-key">Chave da API</label>
              <input className="input" id="tr-key" type="password" autoComplete="off" value={credential.apiKey} onChange={event => setCredential(transcription.engine as ProviderEngine, { apiKey: event.target.value })} placeholder={form.keyHint} />
            </div>
            <div className="field">
              <label htmlFor="tr-model">Modelo</label>
              <input className="input" id="tr-model" autoComplete="off" value={credential.model} onChange={event => setCredential(transcription.engine as ProviderEngine, { model: event.target.value })} placeholder={form.model || 'nome do modelo no serviço'} />
            </div>
          </div>
          {transcription.engine === 'custom' && (
            <details className="field">
              <summary className="lab" style={{ cursor: 'pointer' }}>
                Avançado
              </summary>
              <label htmlFor="tr-extra" style={{ marginTop: 6 }}>
                Opções extras (JSON)
              </label>
              <textarea className="input" id="tr-extra" spellCheck={false} value={credential.extra} onChange={event => setCredential('custom', { extra: event.target.value })} placeholder={'{"timestamp_granularities": ["word"], "diarize": true}'} />
              <span className="muted" style={{ fontSize: 12.5 }}>
                {validExtra(credential.extra) ? 'Cada campo vai junto com o áudio no pedido. Use para ligar tempos por palavra e falantes no seu serviço.' : 'Isto não é um JSON válido: as opções extras não serão enviadas.'}
              </span>
            </details>
          )}
          <div className="row2">
            {transcription.engine !== 'gemini' && (
              <div className="field">
                <label htmlFor="tr-speakers">Quem fala (segundo provedor)</label>
                <select className="input" id="tr-speakers" value={second} onChange={event => set({ speakersEngine: event.target.value as SpeakersEngine })}>
                  <option value="">Só o provedor acima</option>
                  {SPEAKER_ENGINES.filter(id => id !== transcription.engine).map(id => (
                    <option key={id} value={id}>
                      {ENGINE_NAMES[id]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {second && (
              <div className="field">
                <label htmlFor="tr-second-key">Chave {ENGINE_OF[second]}</label>
                <input className="input" id="tr-second-key" type="password" autoComplete="off" value={credentials[second]?.apiKey ?? ''} onChange={event => setCredential(second, { apiKey: event.target.value })} placeholder={PROVIDER_FORM[second].keyHint} />
              </div>
            )}
          </div>
          {transcription.engine !== 'gemini' && <span className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>O segundo provedor só é usado quando o de cima devolve o texto sem dizer quem falou.</span>}
        </>
      )}
      <div className="field">
        <label htmlFor="tr-terms">Siglas, nomes e termos que costumam sair errados</label>
        <textarea className="input" id="tr-terms" rows={3} placeholder="Um por linha. Ex.: API, Kubernetes, Ana Paula" value={transcription.terms ?? ''} onChange={event => set({ terms: event.target.value })} />
        <span className="muted" style={{ fontSize: 12.5 }}>Vão junto com cada transcrição e com a revisão por IA, para o texto sair com a escrita certa.</span>
      </div>
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
    return found && typeof found === 'object' && ('ai' in found || 'transcription' in found) ? found : null
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
    await updateSettings(imported)
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
              <button key={id} aria-pressed={tab === id || (id === 'ai' && tab === 'transcription')} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          <div className="set-body">
            {tab === 'appearance' && <AppearanceTab />}
            {(tab === 'ai' || tab === 'transcription') && <AiArea key={tab} initial={tab === 'transcription' ? 'transcription' : 'general'} />}
            {tab === 'links' && <LinksTab />}
            {tab === 'storage' && <StorageTab />}
            {tab === 'devices' && <DevicesTab />}
            {tab === 'general' && <GeneralTab />}
            {tab === 'others' && <OthersTab />}
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
