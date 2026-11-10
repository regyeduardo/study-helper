import { create } from 'zustand'

import type { AiConfig, AiProvider, AiSettings, AiUse } from '@/types/domain'
import { type CatalogModel, fetchModelList, ReadError } from '@/controllers/models.controller'
import { aiConfigOf, type Media, type MediaInfo, modelByUid } from '@/lib/ai/config'
import { type DiagnosisDeps, type DiagnosisPlan, type DiagnosisProgress, type DiagnosisResult, liveDiagnosisDeps, planDiagnosis, runDiagnosis } from '@/lib/ai/diagnosis'
import { probeMedia, probeWeb, type ProbeResult } from '@/lib/ai/probe'
import { useLibraryStore } from '@/stores/library'

export type Live =
  | { state: 'reading'; token: number }
  | { state: 'ok'; token: number; at: number; list: CatalogModel[]; byId: Map<string, CatalogModel> }
  | { state: 'error'; token: number; at: number; error: ReadError }

export type ProbeKey = Media | 'web'
export type ProbeState = { state: 'busy' } | ProbeResult

export type AiTab = 'provedores' | 'modelos' | 'padroes' | 'recomendacoes'

export interface AiUiState {
  tab: AiTab
  filter: string
  shut: Record<string, boolean>
  advShut?: boolean
  /** Last provider chosen in "Adicionar modelo". */
  addPid?: string
  /** The use whose ladder is open in Recomendações; none: "Geral". */
  recUse?: AiUse | null
}

/** The diagnosis of Recomendações. `scope`: the one use it covers; null: all of them. It lives here so a run goes on when the tab is left. */
export type DiagnosisState =
  | { state: 'idle' }
  | { state: 'planning'; scope: AiUse | null }
  | { state: 'ready'; scope: AiUse | null; plan: DiagnosisPlan }
  | { state: 'running'; scope: AiUse | null; plan: DiagnosisPlan; progress: DiagnosisProgress | null }
  | { state: 'done'; scope: AiUse | null; result: DiagnosisResult; at: string }
  | { state: 'failed'; scope: AiUse | null; message: string }

interface ModelsState {
  /** What each provider answered: only in memory, never saved. */
  live: Record<string, Live>
  /** "Testar": what a model answered for a media or for web search, only in memory. */
  probes: Record<string, Partial<Record<ProbeKey, ProbeState>>>
  ui: AiUiState
  setUi(patch: Partial<AiUiState>): void
  /** "Adicionar modelo" is open over the settings (they go inert). */
  adding: boolean
  setAdding(open: boolean): void
  diagnosis: DiagnosisState
  /** Reads the catalogs (free) and says what the run would cost. Nothing paid happens here. */
  diagnosisPlan(scope: AiUse | null): Promise<void>
  diagnosisRun(): Promise<void>
  /** "Parar": what ran stays saved, nothing else is spent. */
  diagnosisStop(): void
  diagnosisClose(): void
  read(provider: AiProvider, loud: boolean): Promise<void>
  readStale(providers: AiProvider[]): void
  forget(providerId: string): void
  probe(uid: string, target: AiSettings, keys: ProbeKey[]): Promise<void>
}

export const FRESH_MS = 30000

/** While a run goes, the results are saved at most this often, and always at the end. */
const SAVE_EVERY_MS = 5000

let diagnosisDeps: DiagnosisDeps | null = null
let diagnosisAbort: AbortController | null = null

const saveDiagnosis = (records: DiagnosisResult['records']) => void useLibraryStore.getState().updateSettings({ aiDiagnosis: records })
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const useModelsStore = create<ModelsState>((set, get) => ({
  live: {},
  probes: {},
  ui: { tab: 'provedores', filter: 'all', shut: { estudo: true, tarefas: true } },
  setUi: patch => set(state => ({ ui: { ...state.ui, ...patch } })),
  adding: false,
  setAdding: adding => set({ adding }),

  diagnosis: { state: 'idle' },

  diagnosisPlan: async scope => {
    set({ diagnosis: { state: 'planning', scope } })
    try {
      const settings = useLibraryStore.getState().index.settings
      const providers = aiConfigOf(settings).providers
      diagnosisDeps = liveDiagnosisDeps(providers)
      const plan = await planDiagnosis({ providers, ...(scope ? { uses: [scope] } : {}), previous: settings.aiDiagnosis ?? [] }, diagnosisDeps)
      // "Cancelar" while it read the catalogs
      if (get().diagnosis.state === 'planning') set({ diagnosis: { state: 'ready', scope, plan } })
    } catch (error) {
      if (get().diagnosis.state === 'planning') set({ diagnosis: { state: 'failed', scope, message: messageOf(error) } })
    }
  },

  diagnosisRun: async () => {
    const current = get().diagnosis
    if (current.state !== 'ready' || !diagnosisDeps) return
    const { scope, plan } = current
    const deps = diagnosisDeps
    diagnosisAbort = new AbortController()
    set({ diagnosis: { state: 'running', scope, plan, progress: null } })
    let savedAt = Date.now()
    try {
      const result = await runDiagnosis(plan, deps, {
        signal: diagnosisAbort.signal,
        onProgress: progress => {
          set({ diagnosis: { state: 'running', scope, plan, progress } })
          if (Date.now() - savedAt > SAVE_EVERY_MS) {
            savedAt = Date.now()
            saveDiagnosis(progress.records)
          }
        },
      })
      saveDiagnosis(result.records)
      set({ diagnosis: { state: 'done', scope, result, at: result.fresh[0]?.at ?? (deps.now?.() ?? new Date()).toISOString() } })
    } catch (error) {
      set({ diagnosis: { state: 'failed', scope, message: messageOf(error) } })
    } finally {
      diagnosisAbort = null
    }
  },

  diagnosisStop: () => diagnosisAbort?.abort(),

  diagnosisClose: () => {
    if (get().diagnosis.state !== 'running') set({ diagnosis: { state: 'idle' } })
  },

  read: async (provider, loud) => {
    const current = get().live[provider.id]
    const token = (current?.token ?? 0) + 1
    set(state => ({ live: { ...state.live, [provider.id]: !loud && current?.state === 'ok' ? { ...current, token } : { state: 'reading', token } } }))
    const mine = () => get().live[provider.id]?.token === token
    try {
      const list = await fetchModelList(provider)
      if (mine()) set(state => ({ live: { ...state.live, [provider.id]: { state: 'ok', token, at: Date.now(), list, byId: new Map(list.map(model => [model.id, model])) } } }))
    } catch (error) {
      if (mine()) set(state => ({ live: { ...state.live, [provider.id]: { state: 'error', token, at: Date.now(), error: error instanceof ReadError ? error : new ReadError('bad') } } }))
    }
  },

  readStale: providers => {
    for (const provider of providers) {
      const live = get().live[provider.id]
      if (!live || (live.state !== 'reading' && Date.now() - live.at > FRESH_MS)) void get().read(provider, false)
    }
  },

  forget: providerId =>
    set(state => {
      const live = { ...state.live }
      delete live[providerId]
      return { live }
    }),

  probe: async (uid, target, keys) => {
    const put = (key: ProbeKey, value: ProbeState) => set(state => ({ probes: { ...state.probes, [uid]: { ...state.probes[uid], [key]: value } } }))
    await Promise.all(
      keys.map(async key => {
        put(key, { state: 'busy' })
        put(key, key === 'web' ? await probeWeb(target) : await probeMedia(target, key))
      }),
    )
  },
}))

/** A provider "informs" when its list says the media of at least one model. */
export const informs = (live: Extract<Live, { state: 'ok' }>) => live.list.length === 0 || live.list.some(model => model.media !== null)

export type Assessment =
  | { kind: 'none' }
  | { kind: 'reading' }
  | { kind: 'error'; error: ReadError }
  | { kind: 'gone' }
  | { kind: 'unknown'; name: string; unsure: Media[] }
  | { kind: 'media'; name: string; missing: Media[]; unsure: Media[]; failed: Media[] }

/** What the provider (and "Testar", when done) says about a model against what a use receives. */
export function assessModel(config: AiConfig, live: Record<string, Live>, probes: ModelsState['probes'], uid: string | undefined, needs: Media[]): Assessment {
  const model = modelByUid(config, uid)
  if (!model) return { kind: 'none' }
  const read = live[model.pid]
  if (!read || read.state === 'reading') return { kind: 'reading' }
  if (read.state === 'error') return { kind: 'error', error: read.error }
  const found = read.byId.get(model.mid)
  if (!found) return { kind: 'gone' }
  const tested = probes[model.uid] ?? {}
  const said = (need: Media): boolean | null => {
    const fromList = found.media?.[need]
    if (fromList === true || fromList === false) return fromList
    const probe = tested[need]
    return probe?.state === 'yes' ? true : probe?.state === 'no' ? false : null
  }
  const media: MediaInfo | null = found.media
  const unsure = needs.filter(need => said(need) === null)
  const failed = unsure.filter(need => tested[need]?.state === 'fail')
  if (!media && needs.every(need => said(need) === null)) return { kind: 'unknown', name: model.name, unsure }
  return { kind: 'media', name: model.name, missing: needs.filter(need => said(need) === false), unsure, failed }
}

/** For the selectors: what the provider says the model takes, with the answers of "Testar" filling the gaps. */
export function mediaOfModel(config: AiConfig, live: Record<string, Live>, probes: ModelsState['probes'], uid: string): MediaInfo | null {
  const model = modelByUid(config, uid)
  const read = model ? live[model.pid] : undefined
  if (!model || !read || read.state !== 'ok') return null
  const found = read.byId.get(model.mid)
  if (!found) return null
  const tested = probes[uid] ?? {}
  const fill = (media: Media): boolean | null => found.media?.[media] ?? (tested[media]?.state === 'yes' ? true : tested[media]?.state === 'no' ? false : null)
  return { texto: fill('texto'), imagem: fill('imagem'), audio: fill('audio'), video: fill('video'), pdf: fill('pdf') }
}

/** Searches the web: the provider's data says so, or "Testar" saw it. Unknown is not enough (Questões da web). */
export function searchesWeb(config: AiConfig, live: Record<string, Live>, probes: ModelsState['probes'], uid: string): boolean {
  if (probes[uid]?.web?.state === 'yes') return true
  const model = modelByUid(config, uid)
  const read = model ? live[model.pid] : undefined
  return Boolean(model && read?.state === 'ok' && read.byId.get(model.mid)?.web)
}
