import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { AiConfig, AiProvider, AiProviderId, AiStep, AiUse } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { type CatalogModel, fetchModelList, type ModelPrice, ReadError } from '@/controllers/models.controller'
import { errAdvice, errLong, errShort, eLista, keyMask, nem, nextSort, NO_PRICE, PER_TOKEN, plain, plural, priceSide, type SortState, sortedModels, validUrl } from '@/lib/ai/catalog'
import { aiConfigOf, ATA_STEPS, compatible, MEDIA, type Media, MEDIA_LABEL, type MediaInfo, modelByUid, providerById, targetOf, USE_GROUPS, type UseGroup, type UseInfo, withoutModels, withoutProvider } from '@/lib/ai/config'
import { PROVIDERS, providerOf } from '@/lib/ai/providers'
import { useLibraryStore } from '@/stores/library'
import { type AiTab, type Assessment, assessModel, FRESH_MS, informs, type Live, mediaOfModel, type ProbeKey, searchesWeb, useModelsStore } from '@/stores/models'

const TABS: [AiTab, string][] = [
  ['provedores', 'Provedores'],
  ['modelos', 'Modelos'],
  ['padroes', 'Padrões por uso'],
]

const LEGEND = 'azul = aceita · cinza = não aceita · ? = o provedor não informa'
const UNKNOWN = '? o provedor não informa o que aceita'
const TEXT: Media[] = ['texto']

const resorted = (current: SortState, key: 'name' | 'in' | 'out'): SortState => {
  const next = { ...current }
  nextSort(next, key)
  return next
}

const uid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function useAiConfig(): [AiConfig, (next: AiConfig) => void] {
  const settings = useLibraryStore(state => state.index.settings)
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const config = useMemo(() => aiConfigOf(settings), [settings])
  return [config, next => void updateSettings({ aiConfig: next })]
}

const Reading = ({ text = 'lendo do provedor…' }: { text?: string }) => <span className="reading">{text}</span>

/* ---------- Provedores ---------- */

interface Editing {
  id: string | null
  type: AiProviderId
  name: string
  key: string
  base: string
  customBase: string
  confirm: boolean
  test: { state: 'busy' | 'ok' | 'fail'; text: string } | null
}

// The list may be public, but only Personalizado (a local server) generates without a key.
const keyless = (provider: { type: AiProviderId; key: string }) => provider.type !== 'custom' && !provider.key

function situation(live: Live | undefined, provider: AiProvider): { cls: string; text: string } {
  if (!live || live.state === 'reading') return { cls: 'sit-muted', text: 'lendo do provedor…' }
  if (live.state === 'error') return { cls: 'sit-bad', text: errShort(live.error) }
  if (keyless(provider)) return { cls: 'sit-bad', text: 'falta a chave' }
  return informs(live) ? { cls: 'sit-ok', text: 'ok' } : { cls: 'sit-muted', text: 'não informa' }
}

function subLine(provider: AiProvider, live: Live | undefined): { bad?: boolean; text: string } {
  const type = providerOf(provider.type)
  if (live?.state === 'error') return { bad: true, text: live.error.kind === 'nokey' ? 'sem chave' : errLong(live.error) }
  const who = provider.key ? keyMask(provider.key) : type.needsKey ? 'sem chave' : type.name
  if (!live || live.state === 'reading') return { text: `${who} · lendo do provedor…` }
  if (keyless(provider)) return { bad: true, text: `sem chave · ${plural(live.list.length, 'modelo', 'modelos')}` }
  return { text: `${who} · ${plural(live.list.length, 'modelo', 'modelos')} · ${informs(live) ? 'ok' : 'não informa mídias'}` }
}

function ProvidersTab({ config, save }: { config: AiConfig; save(next: AiConfig): void }) {
  const live = useModelsStore(state => state.live)
  const read = useModelsStore(state => state.read)
  const forget = useModelsStore(state => state.forget)
  const ui = useModelsStore(state => state.ui)
  const setUi = useModelsStore(state => state.setUi)
  const [editing, setEditing] = useState<Editing | null>(null)
  const token = useRef(0)
  const panel = useRef<HTMLDivElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const focusName = useRef(false)

  useEffect(() => {
    if (!editing) return
    panel.current?.scrollIntoView?.({ block: 'nearest' })
    if (focusName.current) nameInput.current?.focus()
    focusName.current = false
  }, [editing?.id, Boolean(editing)]) // eslint-disable-line react-hooks/exhaustive-deps

  const openEditor = (id: string | null) => {
    const provider = id ? providerById(config, id) : undefined
    const type = provider ? provider.type : PROVIDERS[0].id
    token.current++
    focusName.current = !id
    setEditing({ id, type, name: provider ? provider.name : providerOf(type).name, key: provider?.key ?? '', base: provider?.base ?? '', customBase: provider?.base ?? '', confirm: false, test: null })
  }
  const patch = (change: Partial<Editing>) => setEditing(current => (current ? { ...current, ...change } : current))

  const pickType = (type: AiProviderId) => {
    if (!editing) return
    const previous = providerOf(editing.type)
    const customBase = editing.type === 'custom' ? editing.base : editing.customBase
    token.current++
    patch({ type, name: !editing.name.trim() || editing.name === previous.name ? providerOf(type).name : editing.name, customBase, base: type === 'custom' ? customBase : '', test: null })
  }

  const runTest = async () => {
    if (!editing) return
    const type = providerOf(editing.type)
    const draft = { type: editing.type, key: editing.key.trim(), base: editing.base }
    if (type.id === 'custom' && !validUrl(draft.base.trim())) return patch({ test: { state: 'fail', text: 'Informe a URL base, com http:// ou https://.' } })
    const mine = ++token.current
    patch({ test: { state: 'busy', text: 'lendo do provedor…' } })
    try {
      const list = await fetchModelList(draft)
      if (mine !== token.current) return
      if (keyless(draft)) return patch({ test: { state: 'fail', text: `Li ${plural(list.length, 'modelo', 'modelos')}, mas falta a chave: sem ela nada é gerado.` } })
      const untested =draft.key && type.id !== 'custom' && !type.needsKey ? ' · lista pública, a chave não foi testada' : ''
      patch({ test: { state: 'ok', text: `✓ Conectado · ${plural(list.length, 'modelo', 'modelos')} · não gasta token${untested}` } })
    } catch (error) {
      if (mine !== token.current) return
      patch({ test: { state: 'fail', text: errLong(error instanceof ReadError ? error : new ReadError('bad')) } })
    }
  }

  const saveProvider = () => {
    if (!editing) return
    const type = providerOf(editing.type)
    const data = { type: type.id, name: editing.name.trim() || type.name, key: editing.key.trim(), base: type.id === 'custom' ? editing.base.trim() : '' }
    if (type.id === 'custom' && !validUrl(data.base)) return patch({ test: { state: 'fail', text: 'Informe a URL base, com http:// ou https://.' } })
    const existing = editing.id ? providerById(config, editing.id) : undefined
    const provider: AiProvider = existing ? { ...existing, ...data } : { id: uid(), ...data }
    save({ ...config, providers: existing ? config.providers.map(item => (item.id === provider.id ? provider : item)) : [...config.providers, provider] })
    setEditing(null)
    void read(provider, true)
  }

  const removeProvider = (id: string) => {
    save(withoutProvider(config, id))
    forget(id)
    if (ui.filter === id) setUi({ filter: 'all' })
    setEditing(null)
  }

  const errors = config.providers.flatMap(provider => {
    const state = live[provider.id]
    return state?.state === 'error' ? [{ provider, error: state.error }] : []
  })

  return (
    <>
      <div className="bar-head" id="pv-bar">
        <span className="grow muted">Cada provedor tem sua chave. Os modelos vêm dele, lidos ao vivo.</span>
        <button className="btn primary" onClick={() => openEditor(null)}>
          + Adicionar provedor
        </button>
      </div>
      <div id="pv-table" className="tcard">
        {config.providers.length ? (
          <table className="pv">
            <colgroup>
              <col />
              <col style={{ width: '18%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: 84 }} />
            </colgroup>
            <thead>
              <tr>
                {['Provedor', 'Tipo', 'Chave', 'Modelos', 'Situação', ''].map(title => (
                  <th key={title || 'acao'} scope="col" className={title === 'Modelos' ? 'c-count' : undefined}>
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {config.providers.map(provider => {
                const state = live[provider.id]
                const sit = situation(state, provider)
                const sub = subLine(provider, state)
                return (
                  <tr key={provider.id} className={editing?.id === provider.id ? 'sel' : ''} data-provider={provider.name} onClick={() => openEditor(provider.id)}>
                    <td className="c-name">
                      <b>{provider.name}</b>
                      <span className={`pv-sub${sub.bad ? ' bad' : ''}`}>{sub.text}</span>
                    </td>
                    <td>{providerOf(provider.type).name}</td>
                    <td className="c-key">{keyMask(provider.key)}</td>
                    <td className="c-count">{state?.state === 'ok' ? String(state.list.length) : '—'}</td>
                    <td className={`c-sit ${sit.cls}`}>{sit.text}</td>
                    <td className="c-act">
                      <button
                        className="btn quiet"
                        aria-label={`Editar ${provider.name}`}
                        onClick={event => {
                          event.stopPropagation()
                          openEditor(provider.id)
                        }}
                      >
                        <span className="ed-text">Editar</span>
                        <span className="chev">
                          <Icon name="fwd" />
                        </span>
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <p className="empty" style={{ margin: 0 }}>
            Nenhum provedor.
          </p>
        )}
      </div>
      <div id="pv-alerts">
        {errors.map(({ provider, error }) => (
          <div key={provider.id} className="banner" role="status" data-alert={provider.name}>
            <Icon name="warn" />
            <div>{`${provider.name}: ${errLong(error)}. ${errAdvice(error)}`}</div>
          </div>
        ))}
      </div>
      <div id="pv-panel" ref={panel}>
        {editing && (
          <ProviderPanel
            editing={editing}
            models={editing.id ? config.models.filter(model => model.pid === editing.id).length : 0}
            nameInput={nameInput}
            onPatch={patch}
            onType={pickType}
            onTest={() => void runTest()}
            onSave={saveProvider}
            onCancel={() => setEditing(null)}
            onRemove={() => editing.id && removeProvider(editing.id)}
          />
        )}
      </div>
    </>
  )
}

function ProviderPanel(props: { editing: Editing; models: number; nameInput: React.RefObject<HTMLInputElement | null>; onPatch(change: Partial<Editing>): void; onType(type: AiProviderId): void; onTest(): void; onSave(): void; onCancel(): void; onRemove(): void }) {
  const { editing, models, onPatch } = props
  const type = providerOf(editing.type)
  const custom = type.id === 'custom'
  return (
    <div className="panel" aria-label="Painel do provedor" role="group">
      <div className="panel-head">
        <b>{editing.id ? editing.name : 'Novo provedor'}</b>
        {editing.id && <span className="muted small">· editando</span>}
      </div>
      <div className="pf top">
        <span className="lab">Tipo</span>
        <div className="chips" role="group" aria-label="Tipo">
          {PROVIDERS.map(item => (
            <button key={item.id} className="chip" aria-pressed={item.id === editing.type} onClick={() => props.onType(item.id)}>
              {item.name}
            </button>
          ))}
        </div>
      </div>
      <div className="pf">
        <label htmlFor="pv-name">Nome</label>
        <div className="wrap">
          <input ref={props.nameInput} className="input" id="pv-name" value={editing.name} autoComplete="off" onChange={event => onPatch({ name: event.target.value })} />
        </div>
      </div>
      <div className="pf">
        <label htmlFor="pv-key">Chave</label>
        <div className="wrap">
          <input className="input" id="pv-key" type="password" value={editing.key} autoComplete="new-password" spellCheck={false} placeholder={`Cole a chave de ${type.name}`} onChange={event => onPatch({ key: event.target.value })} />
        </div>
      </div>
      <div className="pf">
        <label htmlFor="pv-base">URL base</label>
        <div className="wrap">
          <input
            className="input"
            id="pv-base"
            value={custom ? editing.base : type.baseUrl}
            readOnly={!custom}
            spellCheck={false}
            autoComplete="off"
            placeholder={custom ? 'https://minha-ia.exemplo.com/v1' : undefined}
            onChange={event => custom && onPatch({ base: event.target.value })}
          />
          {!custom && <span className="muted small">já vem do tipo</span>}
        </div>
      </div>
      <div className="pf">
        <span />
        <div className="test">
          <button className="btn" onClick={props.onTest}>
            Testar conexão
          </button>
          <span id="pv-test" className={`test-msg${editing.test ? ` ${editing.test.state}` : ''}`} role="status">
            {editing.test?.text ?? ''}
          </span>
        </div>
      </div>
      {editing.confirm ? (
        <div className="inline-confirm">
          <span>{`Remover ${editing.name}${models ? ` e ${models === 1 ? 'o modelo dele' : `os ${models} modelos dele`}` : ''}?`}</span>
          <button className="btn" onClick={() => onPatch({ confirm: false })}>
            Cancelar
          </button>
          <button className="btn danger" onClick={props.onRemove}>
            Remover
          </button>
        </div>
      ) : (
        <div className="panel-foot">
          {editing.id && (
            <button className="btn danger" onClick={() => onPatch({ confirm: true })}>
              Remover provedor
            </button>
          )}
          <span className="sp" />
          <button className="btn" onClick={props.onCancel}>
            Cancelar
          </button>
          <button className="btn primary" onClick={props.onSave}>
            Salvar
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------- tabela de modelos: a mesma em Meus modelos e no diálogo ---------- */

function MediaSlots({ media }: { media: MediaInfo | null }) {
  return (
    <div className="accept">
      {MEDIA.map(([id, label]) => {
        const value = media ? media[id] : null
        const state = value === true ? 'yes' : value === false ? 'no' : 'unknown'
        const title = !media ? UNKNOWN.slice(2) : state === 'yes' ? `aceita ${label}` : state === 'no' ? `não aceita ${label}` : `o provedor não informa ${label}`
        return (
          <span key={id} className="md" data-media={id} data-state={state} title={title}>
            {state === 'unknown' ? `${label}?` : label}
          </span>
        )
      })}
    </div>
  )
}

function PriceCell({ side, price, pending }: { side: 'in' | 'out'; price: ModelPrice | null | undefined; pending?: boolean }) {
  const label = side === 'in' ? 'Entrada' : 'Saída'
  const base = `c-price c-${side}`
  if (pending)
    return (
      <td className={`${base} none`} data-label={label} title="lendo do provedor…">
        …
      </td>
    )
  const found = priceSide(price, side)
  if (found.group === 2)
    return (
      <td className={`${base} none`} data-label={label} title={NO_PRICE}>
        —
      </td>
    )
  return (
    <td className={base} data-label={label} title={`${found.text} ${found.about}`}>
      {found.text}
    </td>
  )
}

function NameCell({ name, sub }: { name: string; sub?: string }) {
  return (
    <td className="c-model">
      <div className="an" title={sub && sub !== name ? `${name}\n${sub}` : name}>
        <b>{name}</b>
        {sub && sub !== name && <small>{sub}</small>}
      </div>
    </td>
  )
}

function ModelTable({ sort, onSort, children }: { sort: SortState; onSort(key: 'name' | 'in' | 'out'): void; children: ReactNode }) {
  const head = (key: 'name' | 'in' | 'out', label: string) => {
    const on = sort.key === key
    const arrow = (
      <span className="arr" aria-hidden="true">
        {!on ? '' : sort.dir > 0 ? '↑' : '↓'}
      </span>
    )
    return (
      <th scope="col" className={key === 'name' ? 'c-model' : `c-price c-${key}`} data-sort={key} aria-sort={!on ? 'none' : sort.dir > 0 ? 'ascending' : 'descending'}>
        <button className="sort" title={`Ordenar por ${label.toLowerCase()}`} onClick={() => onSort(key)}>
          {key === 'name' ? (
            <>
              {label}
              {arrow}
            </>
          ) : (
            <>
              {arrow}
              {label}
            </>
          )}
        </button>
        {key !== 'name' && <small className="unit">{PER_TOKEN}</small>}
      </th>
    )
  }
  return (
    <table className="mt">
      <colgroup>
        <col />
        <col className="c-price" />
        <col className="c-price" />
        <col className="c-acc" />
        <col className="c-act" />
      </colgroup>
      <thead>
        <tr>
          {head('name', 'Modelo')}
          {head('in', 'Entrada')}
          {head('out', 'Saída')}
          <th scope="col" className="c-acc">
            Aceita
          </th>
          <th scope="col" className="c-act" aria-label="Ação" />
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

/* ---------- Modelos ---------- */

function ModelsTab({ config, save }: { config: AiConfig; save(next: AiConfig): void }) {
  const live = useModelsStore(state => state.live)
  const read = useModelsStore(state => state.read)
  const ui = useModelsStore(state => state.ui)
  const setUi = useModelsStore(state => state.setUi)
  const adding = useModelsStore(state => state.adding)
  const setAdding = useModelsStore(state => state.setAdding)
  const [sort, setSort] = useState<SortState>({ key: null, dir: 1 })
  const addButton = useRef<HTMLButtonElement>(null)
  const filter = ui.filter !== 'all' && !config.models.some(model => model.pid === ui.filter) ? 'all' : ui.filter
  const used = config.providers.filter(provider => config.models.some(model => model.pid === provider.id))
  const rows = config.models.filter(model => filter === 'all' || model.pid === filter)
  const count = config.models.length
  const from = new Set(config.models.map(model => model.pid)).size

  const foundOf = (pid: string, mid: string): CatalogModel | undefined => {
    const state = live[pid]
    return state?.state === 'ok' ? state.byId.get(mid) : undefined
  }
  const removeModel = (id: string) => save(withoutModels(config, new Set([id])))

  const acceptCell = (pid: string, mid: string) => {
    const state = live[pid]
    if (!state || state.state === 'reading') return <Reading />
    const found = state.state === 'ok' ? state.byId.get(mid) : undefined
    const why = state.state === 'error' ? `não deu para ler: ${errLong(state.error)}` : found ? null : 'o provedor não lista mais este modelo'
    return why || !found ? (
      <span className="err" title={why ?? ''}>
        {why}
      </span>
    ) : (
      <MediaSlots media={found.media} />
    )
  }

  return (
    <>
      <div className="bar-head" id="m-head">
        <span className="grow">
          <b>{count ? `Meus modelos · ${count}, de ${plural(from, 'provedor', 'provedores')}` : 'Meus modelos'}</b>
        </span>
        <button className="btn" onClick={() => config.providers.forEach(provider => void read(provider, true))}>
          Ler de novo dos provedores
        </button>
        <button ref={addButton} className="btn primary" id="m-add-btn" onClick={() => setAdding(true)}>
          + Adicionar modelo
        </button>
      </div>
      <div className="chiprow" id="m-filter" role="group" aria-label="Filtrar por provedor" hidden={used.length === 0}>
        {[{ id: 'all', name: 'Todos' }, ...used].map(provider => (
          <button key={provider.id} className="chip" aria-pressed={filter === provider.id} onClick={() => setUi({ filter: provider.id })}>
            {provider.name}
          </button>
        ))}
      </div>
      <div id="m-list" className="tcard">
        {rows.length ? (
          <ModelTable sort={sort} onSort={key => setSort(current => resorted(current, key))}>
            {sortedModels(rows, sort, model => foundOf(model.pid, model.mid)?.price).map(model => {
              const provider = providerById(config, model.pid)
              const state = live[model.pid]
              const pending = !state || state.state === 'reading'
              const price = foundOf(model.pid, model.mid)?.price
              return (
                <tr key={model.uid} className="mrow" data-model={model.mid} data-provider={provider?.name ?? ''}>
                  <NameCell name={model.name} sub={[provider?.name ?? '', model.mid].filter(Boolean).join(' · ')} />
                  <PriceCell side="in" price={price} pending={pending} />
                  <PriceCell side="out" price={price} pending={pending} />
                  <td className="c-acc">{acceptCell(model.pid, model.mid)}</td>
                  <td className="c-act">
                    <button className="btn" aria-label={`Remover ${model.name}`} title="Remover" onClick={() => removeModel(model.uid)}>
                      Remover
                    </button>
                  </td>
                </tr>
              )
            })}
          </ModelTable>
        ) : (
          <p className="empty" style={{ margin: 0 }}>
            Nenhum modelo ainda.
          </p>
        )}
      </div>
      <div className="notes">
        <p className="muted small" id="m-legend" style={{ margin: 0 }} hidden={rows.length === 0}>
          {`${LEGEND} · lido agora do provedor`}
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          Nada fica guardado sobre o que cada modelo aceita ou custa: a lista pergunta ao provedor toda vez que abre.
        </p>
      </div>
      {adding &&
        createPortal(
          <AddModelDialog
            config={config}
            save={save}
            onClose={() => {
              setAdding(false)
              addButton.current?.focus()
            }}
          />,
          document.body,
        )}
    </>
  )
}

/* diálogo Adicionar modelo: separado da lista, por cima das configurações */
function AddModelDialog({ config, save, onClose }: { config: AiConfig; save(next: AiConfig): void; onClose(): void }) {
  const live = useModelsStore(state => state.live)
  const read = useModelsStore(state => state.read)
  const lastPid = useModelsStore(state => state.ui.addPid)
  const setUi = useModelsStore(state => state.setUi)
  const [pid, setPid] = useState<string | null>(providerById(config, lastPid) ? lastPid! : (config.providers[0]?.id ?? null))
  const [query, setQuery] = useState('')
  const [accept, setAccept] = useState<Set<Media>>(new Set())
  const [sort, setSort] = useState<SortState>({ key: null, dir: 1 })
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const latest = useRef(config)
  latest.current = config
  const provider = providerById(config, pid ?? undefined)
  const state = provider ? live[provider.id] : undefined

  useEffect(() => {
    const first = providerById(latest.current, pid ?? undefined)
    if (first) void read(first, true)
    search.current?.focus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const refilter = () => {
    if (list.current) list.current.scrollTop = 0
  }
  const pickProvider = (id: string) => {
    setPid(id)
    setUi({ addPid: id })
    const next = providerById(config, id)
    if (next) void read(next, true)
  }
  const clearFilters = () => {
    setQuery('')
    setAccept(new Set())
    refilter()
    search.current?.focus()
  }
  const toggleMedia = (media: Media) => {
    setAccept(current => {
      const next = new Set(current)
      if (next.has(media)) next.delete(media)
      else next.add(media)
      return next
    })
    refilter()
  }
  const inList = (id: string) => latest.current.models.some(model => model.uid === id)
  const toggleModel = (item: CatalogModel) => {
    if (!provider) return
    const id = `${provider.id}::${item.id}`
    const now = latest.current
    save(inList(id) ? withoutModels(now, new Set([id])) : { ...now, models: [...now.models, { uid: id, pid: provider.id, mid: item.id, name: item.name }] })
  }

  const items = state?.state === 'ok' ? state.list : null
  const reading = !state || state.state === 'reading'
  const terms = plain(query).split(/\s+/).filter(Boolean)
  const found = items ? items.filter(model => terms.every(term => plain(`${model.name} ${model.id}`).includes(term)) && [...accept].every(media => model.media?.[media] === true)) : []

  return (
    <div className="scrim add-scrim ias-add">
      <div className="dialog add-dialog" id="add-dialog" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <div className="dh">
          <h2 id="add-title">Adicionar modelo</h2>
          <button className="ibtn" aria-label="Fechar" title="Fechar" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {config.providers.length ? (
          <div className="add-body">
            <div className="frow">
              <span className="lab lab-hide">Provedor</span>
              <div className="chiprow" id="add-provs" role="group" aria-label="Provedor">
                {config.providers.map(item => (
                  <button key={item.id} className="chip" data-pid={item.id} aria-pressed={item.id === pid} onClick={() => pickProvider(item.id)}>
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="frow">
              <label className="lab lab-hide" htmlFor="add-search">
                Buscar
              </label>
              <div className="fill">
                <input
                  ref={search}
                  className="input"
                  id="add-search"
                  type="search"
                  placeholder="Buscar modelo"
                  aria-label="Buscar modelo"
                  autoComplete="off"
                  value={query}
                  onChange={event => {
                    setQuery(event.target.value)
                    refilter()
                  }}
                />
              </div>
            </div>
            <div className="frow">
              <span className="lab">Aceita</span>
              <div className="chiprow" id="add-accept" role="group" aria-label="Aceita">
                {MEDIA.map(([id, label]) => {
                  const on = accept.has(id)
                  const says = reading || Boolean(items?.some(model => model.media?.[id] === true))
                  const disabled = !on && !says
                  return (
                    <button key={id} className="chip" data-media={id} aria-pressed={on} disabled={disabled} title={disabled ? `Nenhum modelo de ${provider ? provider.name : 'este provedor'} informa ${MEDIA_LABEL[id]}` : ''} onClick={() => toggleMedia(id)}>
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="add-tools">
              <div id="add-state" role="status">
                {reading ? (
                  <Reading />
                ) : state?.state === 'error' ? (
                  <div className="banner">
                    <Icon name="warn" />
                    <div>{`${provider!.name}: ${errLong(state.error)}. ${errAdvice(state.error)}`}</div>
                  </div>
                ) : (
                  `${found.length} de ${plural(items?.length ?? 0, 'modelo', 'modelos')} · lido agora do provedor`
                )}
              </div>
              <button className="btn quiet" id="add-clear" style={{ visibility: query.trim() || accept.size ? undefined : 'hidden' }} onClick={clearFilters}>
                Limpar filtros
              </button>
            </div>
            <div id="add-list" ref={list} className="tcard add-list" hidden={state?.state === 'error'}>
              <ModelTable
                sort={sort}
                onSort={key => {
                  setSort(current => resorted(current, key))
                  refilter()
                }}
              >
                {!reading && items && !found.length && (
                  <tr>
                    <td className="blank" colSpan={5}>
                      <p className="empty" style={{ margin: 0, paddingInline: 0 }}>
                        Nenhum modelo com esses filtros.
                      </p>
                    </td>
                  </tr>
                )}
                {!reading &&
                  provider &&
                  sortedModels(found, sort, model => model.price).map(model => {
                    const added = inList(`${provider.id}::${model.id}`)
                    return (
                      <tr key={model.id} className="arow" data-model={model.id}>
                        <NameCell name={model.name} sub={model.id} />
                        <PriceCell side="in" price={model.price} />
                        <PriceCell side="out" price={model.price} />
                        <td className="c-acc">
                          <MediaSlots media={model.media} />
                        </td>
                        <td className="c-act">
                          <button className="btn" aria-label={`Adicionar ${model.name}`} aria-pressed={added} onClick={() => toggleModel(model)}>
                            {added ? '✓ Adicionado' : 'Adicionar'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
              </ModelTable>
            </div>
          </div>
        ) : (
          <div className="add-body">
            <p className="empty" style={{ margin: 0 }}>
              Nenhum provedor.
            </p>
          </div>
        )}
        <div className="df">
          <span className="grow">{LEGEND}</span>
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Padrões por uso ---------- */

const narrow = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width:760px)').matches : false)
const warned = (found: Assessment) => found.kind === 'media' && found.missing.length > 0

function TestButton({ busy, onClick }: { busy: boolean; onClick(): void }) {
  return busy ? (
    <Reading text="testando…" />
  ) : (
    <button className="btn quiet test-btn" onClick={onClick}>
      Testar
    </button>
  )
}

function DefaultsTab({ config, save }: { config: AiConfig; save(next: AiConfig): void }) {
  const live = useModelsStore(state => state.live)
  const probes = useModelsStore(state => state.probes)
  const read = useModelsStore(state => state.read)
  const probe = useModelsStore(state => state.probe)
  const ui = useModelsStore(state => state.ui)
  const setUi = useModelsStore(state => state.setUi)
  const [webPick, setWebPick] = useState('')
  const [webTested, setWebTested] = useState('')
  const advShut = ui.advShut ?? narrow()

  const assess = (id: string | undefined, needs: Media[]) => assessModel(config, live, probes, id, needs)
  const optionLabel = (id: string) => {
    const model = modelByUid(config, id)!
    const provider = providerById(config, model.pid)
    return provider ? `${model.name} · ${provider.name}` : model.name
  }
  const nameOf = (id: string | undefined) => modelByUid(config, id)?.name
  const web = (id: string) => searchesWeb(config, live, probes, id)

  const choose = (box: 'defaults' | 'steps', id: AiUse | AiStep, value: string) => {
    const next = { ...config[box] } as Record<string, string>
    if (value) next[id] = value
    else delete next[id]
    save({ ...config, [box]: next })
    const model = modelByUid(config, value)
    const state = model ? live[model.pid] : undefined
    const provider = model ? providerById(config, model.pid) : undefined
    if (provider && (!state || (state.state !== 'reading' && Date.now() - state.at > FRESH_MS))) void read(provider, false)
  }

  const testMedia = (id: string | undefined, keys: ProbeKey[]) => {
    const target = targetOf(config, id)
    if (id && target && keys.length) void probe(id, target, keys)
  }
  const busy = (id: string | undefined, keys: ProbeKey[]) => Boolean(id && keys.some(key => probes[id]?.[key]?.state === 'busy'))

  const hint = (use: UseInfo<string>, id: string | undefined, found: Assessment): ReactNode[] => {
    if (found.kind === 'reading') return [<Reading key="r" />]
    if (found.kind === 'error') return [<span key="e" className="err">{`não deu para ler: ${errLong(found.error)}`}</span>]
    if (found.kind === 'gone')
      return [
        <span key="g" className="err">
          o provedor não lista mais este modelo
        </span>,
      ]
    if (found.kind === 'unknown')
      return [
        <span key="u" className="unk">
          {UNKNOWN} <TestButton busy={busy(id, use.needs)} onClick={() => testMedia(id, use.needs)} />
        </span>,
      ]
    if (found.kind !== 'media') return []
    const kids: ReactNode[] = []
    if (found.missing.length) {
      const noText = found.missing.includes('texto')
      kids.push(
        <div key="w" className="banner" data-warn={found.missing.join(',')}>
          <Icon name="warn" />
          <div>
            {`${found.name} não aceita ${nem(found.missing.map(media => MEDIA_LABEL[media]))}.`}
            <small>{use.route && !noText ? use.route : `${use.label} recebe ${eLista(use.needs.map(media => MEDIA_LABEL[media]))}.`}</small>
          </div>
        </div>,
      )
    }
    const open = found.unsure.filter(media => !found.failed.includes(media))
    if (open.length)
      kids.push(
        <span key="s" className="unk">
          {`? o provedor não informa se aceita ${nem(open.map(media => MEDIA_LABEL[media]))}`} <TestButton busy={busy(id, open)} onClick={() => testMedia(id, open)} />
        </span>,
      )
    for (const media of found.failed) {
      const result = id ? probes[id]?.[media] : undefined
      kids.push(<span key={`f-${media}`} className="err">{`não deu para testar ${MEDIA_LABEL[media]}: ${result?.state === 'fail' ? result.message : ''}`}</span>)
    }
    return kids
  }

  const webHint = (chosen: string | undefined): ReactNode[] => {
    const untested = config.models.filter(model => !web(model.uid) && probes[model.uid]?.web?.state !== 'no')
    const pick = untested.some(model => model.uid === webPick) ? webPick : (untested[0]?.uid ?? '')
    const result = webTested ? probes[webTested]?.web : undefined
    const kids: ReactNode[] = [
      <small key="n" className="muted small">
        Precisa de um modelo que pesquise na web.
      </small>,
    ]
    if (chosen && !web(chosen))
      kids.push(
        <div key="w" className="banner" data-warn="web">
          <Icon name="warn" />
          <div>
            {`${nameOf(chosen)} não confirmou que pesquisa na web.`}
            <small>Teste o modelo abaixo ou escolha outro.</small>
          </div>
        </div>,
      )
    if (untested.length)
      kids.push(
        <div key="t" className="web-test">
          <select className="input" aria-label="Modelo para testar a pesquisa na web" value={pick} onChange={event => setWebPick(event.target.value)}>
            {untested.map(model => (
              <option key={model.uid} value={model.uid}>
                {optionLabel(model.uid)}
              </option>
            ))}
          </select>
          <TestButton
            busy={busy(pick, ['web'])}
            onClick={() => {
              setWebTested(pick)
              testMedia(pick, ['web'])
            }}
          />
        </div>,
      )
    if (result && result.state !== 'busy') {
      const name = nameOf(webTested)
      kids.push(
        result.state === 'yes' ? (
          <span key="r" className="sit-ok small">{`✓ ${name} pesquisa na web`}</span>
        ) : result.state === 'no' ? (
          <span key="r" className="unk">{`${name} não pesquisou na web`}</span>
        ) : (
          <span key="r" className="err">{`não deu para testar: ${result.message}`}</span>
        ),
      )
    }
    return kids
  }

  const useRow = (use: UseInfo<string>, box: 'defaults' | 'steps', emptyLabel: string, options: string[], kids: ReactNode[]) => {
    const step = box === 'steps'
    const id = `use-${step ? 'step-' : ''}${use.id}`
    const value = (config[box] as Record<string, string | undefined>)[use.id]
    const current = modelByUid(config, value) ? value! : ''
    return (
      <div key={use.id} className={`use${use.main ? ' main' : ''}`} data-use={use.id} data-step={step ? '1' : undefined}>
        <label htmlFor={id}>{use.label}</label>
        <select className="input" id={id} value={current} onChange={event => choose(box, use.id as AiUse & AiStep, event.target.value)}>
          <option value="">{emptyLabel}</option>
          {options.map(option => (
            <option key={option} value={option}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
        <div className="hint" aria-live="polite">
          {kids}
        </div>
      </div>
    )
  }

  const group = (item: UseGroup) => {
    const shut = Boolean(ui.shut[item.id])
    let warns = 0
    const rows = item.uses.map(use => {
      const own = config.defaults[use.id]
      const inherited = use.from ? config.defaults[use.from] : undefined
      const inheritedOk = use.id === 'web' ? Boolean(inherited && modelByUid(config, inherited) && web(inherited)) : true
      const effective = own && modelByUid(config, own) ? own : inheritedOk ? inherited : undefined
      const must = use.id === 'aula' ? TEXT : use.needs
      const options = config.models.filter(model => model.uid === own || (use.id === 'web' ? web(model.uid) : compatible(mediaOfModel(config, live, probes, model.uid), must))).map(model => model.uid)
      let emptyLabel = config.models.length ? 'escolha um modelo' : 'nenhum modelo'
      if (use.from) {
        const base = modelByUid(config, inherited)
        emptyLabel = `herda de ${use.from === 'estudo' ? 'Estudo' : 'Vídeo e áudio'} (${base ? base.name : 'sem modelo'})`
        if (use.id === 'web' && !inheritedOk) emptyLabel = options.length ? 'escolha um modelo' : 'nenhum modelo que pesquise na web'
      }
      if (use.id === 'web') return useRow(use, 'defaults', emptyLabel, options, webHint(effective))
      const found = assess(effective, use.needs)
      if (warned(found)) warns++
      return useRow(use, 'defaults', emptyLabel, options, hint(use, effective, found))
    })
    return (
      <section key={item.id} className={`grp grp-${item.id}${shut ? ' shut' : ''}`} data-group={item.id}>
        <h3 className="gtitle">{item.title}</h3>
        <button className="ghead" aria-expanded={!shut} onClick={() => setUi({ shut: { ...ui.shut, [item.id]: !shut } })}>
          <Icon name="fwd" />
          <span className="gsum">{`${item.title} · ${plural(item.uses.length, 'uso', 'usos')}${warns ? ` · ${plural(warns, 'aviso', 'avisos')}` : ''}`}</span>
        </button>
        <div className="gbody">{rows}</div>
      </section>
    )
  }

  const [estudo, midia, reuniao] = USE_GROUPS
  const ata = modelByUid(config, config.defaults.ata || config.defaults.estudo)
  return (
    <>
      <p className="muted small" style={{ margin: 0 }}>
        O seletor lista todos os seus modelos. Se o escolhido não aceita o que o uso recebe, aparece um aviso embaixo dele.
      </p>
      <div className="cols">
        <div className="col">{group(estudo)}</div>
        <div className="col">
          {group(midia)}
          {group(reuniao)}
          <section className={`grp grp-adv${advShut ? ' shut' : ''}`}>
            <button className="ghead adv-head" aria-expanded={!advShut} onClick={() => setUi({ advShut: !advShut })}>
              <Icon name="fwd" />
              Avançado: modelo por passo (herda da Ata)
            </button>
            <div className="gbody steps">
              {ATA_STEPS.map(step =>
                useRow(
                  step,
                  'steps',
                  `herda da Ata (${ata ? ata.name : 'sem modelo'})`,
                  config.models.map(model => model.uid),
                  hint(step, config.steps[step.id], assess(config.steps[step.id], step.needs)),
                ),
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  )
}

/* ---------- área ---------- */

export function AiSettings() {
  const [config, save] = useAiConfig()
  const ui = useModelsStore(state => state.ui)
  const setUi = useModelsStore(state => state.setUi)
  const read = useModelsStore(state => state.read)
  const readStale = useModelsStore(state => state.readStale)
  const providers = useRef(config.providers)
  providers.current = config.providers

  useEffect(() => {
    for (const provider of providers.current) void read(provider, true)
    return () => useModelsStore.getState().setAdding(false)
  }, [read])

  const setTab = (tab: AiTab) => {
    setUi({ tab })
    readStale(providers.current)
  }

  return (
    <>
      <div className="ai-tabs" role="tablist" aria-label="Partes da inteligência artificial">
        {TABS.map(([id, label]) => (
          <button key={id} className="chip" role="tab" aria-selected={ui.tab === id} aria-pressed={ui.tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div id="tab" role="tabpanel">
        {ui.tab === 'provedores' && <ProvidersTab key="provedores" config={config} save={save} />}
        {ui.tab === 'modelos' && <ModelsTab config={config} save={save} />}
        {ui.tab === 'padroes' && <DefaultsTab config={config} save={save} />}
      </div>
    </>
  )
}
