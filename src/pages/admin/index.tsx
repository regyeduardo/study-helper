import { type FormEvent, type KeyboardEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import {
  type AdminAccount,
  adminAccounts,
  adminCancelCode,
  adminCodes,
  adminCreateCode,
  adminRevoke,
  adminAi,
  adminSetAi,
  adminSetSettings,
  adminSettings,
  apiMessage,
  type PromoCode,
} from '@/controllers/api.controller'
import { blocking } from '@/lib/blocking'
import { AiConfigSource, AiSettings } from '@/components/dialogs/AiSettings'
import { APP_KEY, fromAppConfig, toAppConfig } from '@/lib/ai/app-ai'
import type { AiConfig } from '@/types/domain'
import { useServerAccount } from '@/stores/server-account'
import { useUiStore } from '@/stores/ui'
import { agoText, formatBytes } from '@/utils/format'
import '@/styles/admin.css'

/** Where the Administração lives; the account menu links here only for the admin account. */
export const ADMIN_PATH = '/administracao'

type Tab = 'codes' | 'accounts' | 'ai' | 'settings'
const TABS: [Tab, string][] = [
  ['codes', 'Códigos'],
  ['accounts', 'Contas'],
  ['ai', 'IA do app'],
  ['settings', 'Configuração'],
]

const CODE_STATUS: Record<PromoCode['status'], [string, string]> = {
  active: ['Ativo', 'ok'],
  'used-up': ['Esgotado', 'muted'],
  expired: ['Vencido', 'warn'],
  canceled: ['Cancelado', 'bad'],
}
const FILTERS: [PromoCode['status'] | 'all', string][] = [
  ['all', 'Todos'],
  ['active', 'Ativos'],
  ['used-up', 'Esgotados'],
  ['expired', 'Vencidos'],
  ['canceled', 'Cancelados'],
]
const ACCOUNT_STATUS: Record<AdminAccount['status'], [string, string]> = {
  'no-code': ['Sem código', 'muted'],
  enabled: ['Liberada', 'ok'],
  revoked: ['Acesso retirado', 'bad'],
}

/** A code read in groups of four, as people copy it: "K7QM 3XRT 9PWD". */
const grouped = (code: string) => code.match(/.{1,4}/g)?.join(' ') ?? code
/** Validity is a day: read in UTC, so it never slips to the day before. */
const utcDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'sem data')
const localDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : 'sem data')
const inThirtyDays = () => new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)

function whoUsed(code: PromoCode): string {
  const names = code.accounts.map(account => account.name || account.email)
  if (!names.length) return ''
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}`
}

function Problem({ error }: { error: unknown }) {
  return (
    <div className="banner" role="alert">
      <Icon name="warn" />
      <span>{apiMessage(error)}</span>
    </div>
  )
}

function CodesTab() {
  const ui = useUiStore()
  const [codes, setCodes] = useState<PromoCode[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [filter, setFilter] = useState<PromoCode['status'] | 'all'>('all')
  const [madeFor, setMadeFor] = useState('')
  const [people, setPeople] = useState('1')
  const [until, setUntil] = useState(inThirtyDays)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<PromoCode | null>(null)

  const load = () =>
    adminCodes()
      .then(list => {
        setCodes(list)
        setError(null)
      })
      .catch(setError)
  useEffect(() => void load(), [])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const code = await adminCreateCode({ madeFor: madeFor.trim() || undefined, maxUses: Math.max(1, Number(people) || 1), validUntil: until })
      setCreated(code)
      setCodes(list => [code, ...(list ?? [])])
      setMadeFor('')
      setError(null)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(grouped(code))
      ui.toast('Código copiado. Mande para a pessoa por mensagem.')
    } catch {
      ui.toast(`Não deu para copiar. O código é ${grouped(code)}.`)
    }
  }

  const cancel = (code: PromoCode) =>
    ui.open({
      kind: 'confirm',
      title: 'Cancelar este código?',
      text: `Ninguém mais consegue usar ${grouped(code.code)}. Quem já entrou com ele continua com acesso.`,
      ok: 'Cancelar o código',
      danger: true,
      onConfirm: async () => {
        try {
          // the app waits in its window until the list comes back with the code canceled
          await blocking('Cancelando o código…', async () => {
            await adminCancelCode(code.id)
            await load()
          })
        } catch (failure) {
          setError(failure)
        }
      },
    })

  const count = (status: PromoCode['status'] | 'all') => (codes ?? []).filter(code => status === 'all' || code.status === status).length
  const shown = (codes ?? []).filter(code => filter === 'all' || code.status === filter)

  return (
    <>
      <form className="adm-new" onSubmit={event => void create(event)}>
        <label className="field adm-for">
          <span className="lab">Para quem (opcional)</span>
          <input className="input" value={madeFor} onChange={event => setMadeFor(event.target.value)} placeholder="Ex.: turma de inglês da noite" maxLength={120} />
        </label>
        <label className="field adm-people">
          <span className="lab">Pessoas</span>
          <input className="input" type="number" min={1} max={1000} value={people} onChange={event => setPeople(event.target.value)} />
        </label>
        <label className="field adm-until">
          <span className="lab">Vale até</span>
          <input className="input" type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={event => setUntil(event.target.value)} required />
        </label>
        <button className="btn primary" type="submit" disabled={busy}>
          <Icon name="plus" />
          {busy ? 'Criando…' : 'Criar código'}
        </button>
      </form>
      {created && (
        <div className="adm-created" role="status" aria-label="Código criado">
          <Icon name="check" />
          <span>
            Código criado{created.madeFor ? ` para ${created.madeFor}` : ''}: <code>{grouped(created.code)}</code>
            <small>
              {' '}
              · {created.maxUses === 1 ? '1 pessoa' : `${created.maxUses} pessoas`}, vale até {utcDay(created.validUntil)}
            </small>
          </span>
          <button className="btn" type="button" onClick={() => void copy(created.code)}>
            Copiar
          </button>
          <button className="ibtn" type="button" aria-label="Fechar o aviso" onClick={() => setCreated(null)}>
            <Icon name="x" />
          </button>
        </div>
      )}
      {error !== null && <Problem error={error} />}
      {codes === null ? (
        error === null && <p className="faint">Carregando os códigos…</p>
      ) : (
        <>
          <div className="seg adm-filter" role="group" aria-label="Situação">
            {FILTERS.map(([status, name]) => (
              <button key={status} aria-pressed={filter === status} onClick={() => setFilter(status)}>
                {name} <b>{count(status)}</b>
              </button>
            ))}
          </div>
          {shown.length ? (
            <div className="adm-table-wrap">
              <table className="adm-table adm-codes">
                <thead>
                  <tr>
                    <th scope="col">Código</th>
                    <th scope="col">Para quem</th>
                    <th scope="col">Usos</th>
                    <th scope="col">Vale até</th>
                    <th scope="col">Situação</th>
                    <th scope="col">Quem usou</th>
                    <th scope="col">
                      <span className="sr-only">Ação</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(code => {
                    const [label, tone] = CODE_STATUS[code.status]
                    return (
                      <tr key={code.id}>
                        <td data-label="Código">
                          <code>{grouped(code.code)}</code>
                        </td>
                        <td data-label="Para quem">{code.madeFor || <span className="faint">sem nome</span>}</td>
                        <td data-label="Usos" className="num">{`${code.uses} de ${code.maxUses}`}</td>
                        <td data-label="Vale até" className="num">
                          {utcDay(code.validUntil)}
                        </td>
                        <td data-label="Situação">
                          <span className={`adm-pill ${tone}`}>{label}</span>
                        </td>
                        <td data-label="Quem usou" title={code.accounts.map(account => `${account.name} · ${account.email}`).join('\n') || undefined}>
                          {whoUsed(code) || <span className="faint">ninguém ainda</span>}
                        </td>
                        <td className="adm-act">
                          {code.status === 'active' && (
                            <button className="btn danger" aria-label={`Cancelar o código ${grouped(code.code)}`} onClick={() => cancel(code)}>
                              Cancelar
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="adm-empty">{codes.length ? 'Nenhum código nesta situação.' : 'Nenhum código ainda. Crie o primeiro acima e mande para a pessoa.'}</p>
          )}
        </>
      )}
    </>
  )
}

function AccountsTab({ selfId }: { selfId: string }) {
  const ui = useUiStore()
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    adminAccounts()
      .then(setAccounts)
      .catch(setError)
  }, [])

  const revoke = (account: AdminAccount) =>
    ui.open({
      kind: 'confirm',
      title: 'Retirar o acesso desta conta?',
      text: `${account.name || account.email} para de usar a estrutura do app agora. O que está na conta será apagado em 30 dias; até lá, a pessoa pode levar tudo para fora.`,
      ok: 'Retirar o acesso',
      danger: true,
      onConfirm: async () => {
        try {
          const { deleteAt } = await blocking('Retirando o acesso…', () => adminRevoke(account.id))
          setAccounts(list => (list ?? []).map(item => (item.id === account.id ? { ...item, status: 'revoked', appEnabled: false, deleteAt } : item)))
        } catch (failure) {
          setError(failure)
        }
      },
    })

  return (
    <>
      {error !== null && <Problem error={error} />}
      {accounts === null ? (
        error === null && <p className="faint">Carregando as contas…</p>
      ) : accounts.length ? (
        <div className="adm-table-wrap">
          <table className="adm-table adm-accounts">
            <thead>
              <tr>
                <th scope="col">Conta</th>
                <th scope="col">Situação</th>
                <th scope="col">Código</th>
                <th scope="col">Espaço</th>
                <th scope="col">Visto</th>
                <th scope="col">
                  <span className="sr-only">Ação</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(account => {
                const [label, tone] = ACCOUNT_STATUS[account.status]
                return (
                  <tr key={account.id}>
                    <td data-label="Conta">
                      <b>{account.name || account.email}</b>
                      <small className="faint">{account.email}</small>
                    </td>
                    <td data-label="Situação">
                      <span className={`adm-pill ${tone}`}>{label}</span>
                      {account.status === 'revoked' && <small className="faint">apaga em {localDay(account.deleteAt)}</small>}
                      {account.status === 'enabled' && !account.appEnabled && <small className="faint">estrutura desligada</small>}
                    </td>
                    <td data-label="Código">{account.code ? <code>{grouped(account.code)}</code> : <span className="faint">nenhum</span>}</td>
                    <td data-label="Espaço" className="num">{`${formatBytes(account.space.notes + account.space.media)} de ${formatBytes(account.space.limit)}`}</td>
                    <td data-label="Visto">{agoText(account.seenAt)}</td>
                    <td className="adm-act">
                      {account.status !== 'revoked' && account.id !== selfId && (
                        <button className="btn danger" aria-label={`Retirar o acesso de ${account.name || account.email}`} onClick={() => revoke(account)}>
                          Retirar acesso
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="adm-empty">Nenhuma conta ainda.</p>
      )}
    </>
  )
}

/**
 * "IA do app" (spec 006): the AI screen of Configurações, for everyone with the structure: the providers with a key on the server and
 * the model of each use (the Recomendações set them all at once). No key here: each provider's key is the server's, from its env.
 */
function AppAiTab() {
  const [state, setState] = useState<{ config: AiConfig; available: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  useEffect(() => {
    adminAi()
      .then(answer => setState({ config: toAppConfig(answer.uses, answer.providers), available: answer.providers }))
      .catch(failure => setError(apiMessage(failure)))
  }, [])
  if (error) return <p className="acc-error" role="alert">{error}</p>
  if (!state) return <p className="muted">Lendo a IA do app…</p>
  const save = (next: AiConfig) => {
    const config = { ...next, providers: next.providers.map(provider => ({ ...provider, key: APP_KEY })) }
    setState(current => (current ? { ...current, config } : current))
    setSaved(null)
    adminSetAi(fromAppConfig(config))
      .then(() => setSaved('Salvo: vale para todos que usam a estrutura do app em até 1 minuto.'))
      .catch(failure => setError(apiMessage(failure)))
  }
  return (
    <div className="adm-ai">
      <p className="muted">
        Vale para todos que usam a estrutura do app: eles não escolhem modelo nem veem a parte de IA. As chaves ficam no servidor{' '}
        {state.available.length ? `(com chave: ${state.available.join(', ')})` : '(nenhum provedor com chave no servidor)'}.
      </p>
      {saved && (
        <p className="muted" role="status">
          {saved}
        </p>
      )}
      {/* the AI screen's look lives under .ias, as in Configurações */}
      <div className="ias adm-ias">
        <AiConfigSource.Provider value={{ config: state.config, save, available: state.available }}>
          <AiSettings />
        </AiConfigSource.Provider>
      </div>
    </div>
  )
}

function SettingsTab() {
  const [requireCode, setRequireCode] = useState<boolean | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    adminSettings()
      .then(answer => setRequireCode(answer.requireCode))
      .catch(setError)
  }, [])
  const flip = async () => {
    if (requireCode === null) return
    setBusy(true)
    try {
      setRequireCode((await blocking('Salvando a configuração…', () => adminSetSettings(!requireCode))).requireCode)
      setError(null)
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {error !== null && <Problem error={error} />}
      {requireCode === null ? (
        error === null && <p className="faint">Carregando…</p>
      ) : (
        <div className="adm-setting">
          <div>
            <b id="require-code">Exigir código para usar a estrutura do app</b>
            <p className="muted">{requireCode ? 'Só liga a estrutura do app quem tiver um código que você criou.' : 'Qualquer conta que entrar pode ligar a estrutura do app, sem código.'}</p>
          </div>
          <button className="adm-switch" role="switch" aria-checked={requireCode} aria-labelledby="require-code" disabled={busy} onClick={() => void flip()}>
            <span aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}

function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="welcome adm-missing">
      <h1>Página não encontrada</h1>
      <p className="muted">Este endereço não existe ou não é para esta conta.</p>
      <button className="btn primary" onClick={() => navigate('/')}>
        Voltar ao app
      </button>
    </div>
  )
}

/**
 * Administração (spec 003, FR-005, FR-058, SC-013; layout 4·A): only the admin account sees it. Códigos to create, follow and cancel,
 * Contas to see and take the access away, and Configuração to turn the code requirement off and on. Any other account, or nobody signed
 * in, sees "Página não encontrada" and nothing of the owner's is asked to the server.
 */
export default function AdminPage() {
  const navigate = useNavigate()
  const me = useServerAccount(state => state.me)
  const status = useServerAccount(state => state.status)
  const [tab, setTab] = useState<Tab>('codes')
  useEffect(() => {
    if (useServerAccount.getState().status === 'unknown')
      void useServerAccount
        .getState()
        .refresh()
        .catch(() => undefined)
  }, [])

  // The tabs as a WAI-ARIA tablist: arrows, Home and End move between them, and the focus follows.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex(([id]) => id === tab)
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[event.key]
    if (to === undefined) return
    event.preventDefault()
    const [next] = TABS[(to + TABS.length) % TABS.length]
    setTab(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`#adm-tab-${next}`)?.focus()
  }

  if (status === 'unknown')
    return (
      <div className="welcome" role="status">
        <span className="muted">Abrindo…</span>
      </div>
    )
  if (status === 'offline' && !me)
    return (
      <div className="welcome adm-missing">
        <h1>Sem conexão com o servidor</h1>
        <p className="muted">Confira a internet e abra de novo.</p>
      </div>
    )
  if (!me?.user.admin) return <NotFound />

  return (
    <div className="adm-page">
      <div className="adm-inner">
        <header className="adm-head">
          <h1>Administração</h1>
          <button className="btn" onClick={() => navigate('/')}>
            <Icon name="back" />
            Voltar ao app
          </button>
        </header>
        <div className="tabs adm-tabs" role="tablist" aria-label="Partes da Administração" onKeyDown={onTabKey}>
          {TABS.map(([id, name]) => (
            <button
              key={id}
              role="tab"
              id={`adm-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={tab === id ? `adm-panel-${id}` : undefined}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
            >
              {name}
            </button>
          ))}
        </div>
        <section className="adm-panel" role="tabpanel" id={`adm-panel-${tab}`} aria-labelledby={`adm-tab-${tab}`}>
          {tab === 'codes' && <CodesTab />}
          {tab === 'accounts' && <AccountsTab selfId={me.user.id} />}
          {tab === 'ai' && <AppAiTab />}
          {tab === 'settings' && <SettingsTab />}
        </section>
      </div>
    </div>
  )
}
