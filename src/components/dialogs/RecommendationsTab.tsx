import { Fragment, type ReactNode, useMemo } from 'react'

import type { AiConfig, AiProviderId, AiUse, DiagnosisRecord } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { USE_GROUPS, USES } from '@/lib/ai/config'
import type { DiagnosisEstimate } from '@/lib/ai/diagnosis'
import { ATA_STEPS, priceFromCatalog, LIST_TITLE, listDayOf, type CurrentPair, type Difference, type Rung, recommendationOf, RECOMMENDATIONS, situationsOf, type UseSituation } from '@/lib/ai/recommendations'
import { providerOf } from '@/lib/ai/providers'
import { USE_REQUIREMENTS } from '@/lib/ai/use-requirements'
import { useLibraryStore } from '@/stores/library'
import { searchesWeb, useModelsStore } from '@/stores/models'
import '@/styles/recommendations.css'

/* ---------- words ---------- */

/** "US$ 0,002": three decimals, four under a tenth of a cent, two from ten cents. `null` is "?" (the provider gives no price). */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '?'
  const digits = value >= 0.1 ? 2 : value >= 0.001 ? 3 : 4
  return `US$ ${value.toFixed(digits).replace('.', ',')}`
}

const dayOf = (at: string, timeZone: string) => new Date(at).toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit' })
const dayAndYear = (at: string, timeZone: string) => new Date(at).toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' })
const providerName = (type: AiProviderId) => providerOf(type).name
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

const DIFFERENCE: Record<Difference['kind'], (difference: Difference) => string> = {
  below: difference => (difference.kind === 'below' ? `≠ nota ${difference.score}` : ''),
  pricier: difference => (difference.kind === 'pricier' ? `≠ ${Math.round(difference.times)}×` : ''),
  other: () => '≠ outro par',
  unset: () => 'sem padrão',
}
const DIFFERENCE_NOTE: Record<Difference['kind'], (difference: Difference) => string> = {
  below: () => 'abaixo da mínima',
  pricier: () => 'mais caro',
  other: () => 'sem nota para comparar',
  unset: () => 'escolha um padrão',
}

/* ---------- choosing a pair ---------- */

interface PairRef {
  provider: AiProviderId
  model: string
  name: string
}

/** The provider the person added for a pair of the list: the one that already holds the model, else the first of that type. */
function providerFor(config: AiConfig, pair: PairRef) {
  const ofType = config.providers.filter(provider => provider.type === pair.provider)
  return ofType.find(provider => config.models.some(model => model.pid === provider.id && model.mid === pair.model)) ?? ofType[0]
}

/** The default of the use becomes the pair; the model joins "Meus modelos" when it is not there yet. Null when the provider is not added. */
function adopt(config: AiConfig, use: AiUse, pair: PairRef): AiConfig | null {
  const provider = providerFor(config, pair)
  if (!provider) return null
  const uid = `${provider.id}::${pair.model}`
  const models = config.models.some(model => model.uid === uid) ? config.models : [...config.models, { uid, pid: provider.id, mid: pair.model, name: pair.name }]
  return { ...config, models, defaults: { ...config.defaults, [use]: uid } }
}

interface UseButtonProps {
  config: AiConfig
  pair: PairRef
  label: string
  name: string
  onClick(): void
  quiet?: boolean
}

function ChooseButton({ config, pair, label, name, onClick, quiet }: UseButtonProps) {
  const missing = providerFor(config, pair) ? null : `Cadastre o provedor ${providerName(pair.provider)} em Provedores`
  return (
    <button className={`btn ${quiet ? 'quiet' : ''} rec-use-btn`} aria-label={name} disabled={Boolean(missing)} title={missing ?? undefined} onClick={onClick}>
      {label}
    </button>
  )
}

/* ---------- Geral ---------- */

interface GeneralProps {
  config: AiConfig
  situations: UseSituation[]
  timeZone: string
  tested: DiagnosisRecord[]
  onOpen(use: AiUse): void
  onChoose(next: AiConfig): void
}

function CurrentCell({ current, difference }: { current: CurrentPair | null; difference: Difference | null }) {
  if (!current) return <span className="rec-none">—</span>
  return (
    <>
      <b>{current.name}</b>
      <span className="rec-sub">
        <span>{providerName(current.provider)}</span>
        {current.inherits && <span>herda</span>}
        {current.score !== null && <span>{difference?.kind === 'below' ? `você ${current.score}` : `nota ${current.score}`}</span>}
        <span>{usd(current.cost)}</span>
      </span>
    </>
  )
}

function General({ config, situations, timeZone, tested, onOpen, onChoose }: GeneralProps) {
  const differ = situations.filter(item => !item.same)
  const last = tested.reduce<string | null>((newest, record) => (!newest || Date.parse(record.at) > Date.parse(newest) ? record.at : newest), null)
  const chooseAll = () => {
    let next = config
    for (const item of differ) {
      const indicated = item.recommendation.indicated
      const adopted = indicated ? adopt(next, item.use, { provider: indicated.pair.provider, model: indicated.pair.model, name: indicated.pair.name }) : null
      if (adopted) next = adopted
    }
    if (next !== config) onChoose(next)
  }
  return (
    <section className="rec-general" aria-label="Geral · todos os usos">
      <header className="rec-head">
        <h3>Geral</h3>
        <span className="rec-sum">{`${situations.length - differ.length} iguais · ${differ.length} diferem`}</span>
        {differ.length > 0 && (
          <button className="btn" onClick={chooseAll}>
            {`Usar o indicado nos ${differ.length}`}
          </button>
        )}
        {last && <span className="rec-last">{`diagnóstico de ${dayOf(last, timeZone)}`}</span>}
      </header>
      <p className="rec-hint">Nota mínima 8 de 10, salvo quando o teste do uso diz outra. O custo é de uma nota típica de cada uso.</p>
      <table className="rec-table" aria-label="Todos os usos">
        <thead>
          <tr>
            <th>Uso</th>
            <th>Melhor custo-benefício</th>
            <th>Seu padrão</th>
            <th>Diferença</th>
            <th>
              <span className="rec-vh">Ação</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {situations.map(item => {
            const indicated = item.recommendation.indicated
            return (
              <tr key={item.use} aria-label={item.label}>
                <td data-cell="Uso">
                  <button className="rec-link" onClick={() => onOpen(item.use)} title={`Abrir a escada de ${item.label}`}>
                    {item.label}
                  </button>
                </td>
                <td data-cell="Melhor custo-benefício">
                  {indicated ? (
                    <>
                      <b>{`★ ${indicated.pair.name}`}</b>
                      <span className="rec-sub">
                        <span>{providerName(indicated.pair.provider)}</span>
                        <span>{`nota ${indicated.score}`}</span>
                        <span title={`por ${USE_REQUIREMENTS[item.use].ruler.per}`}>{usd(indicated.cost)}</span>
                      </span>
                    </>
                  ) : (
                    <span className="rec-none">nenhum par passa da nota mínima</span>
                  )}
                  {item.use === 'ata' && (
                    <div className="rec-steps-box">
                      <span className="rec-steps-h" aria-hidden="true">
                        Passo a passo
                      </span>
                      {/* role="list": a list without bullets loses its role in Safari/VoiceOver */}
                      <ul className="rec-steps" role="list" aria-label="Ata passo a passo">
                        {ATA_STEPS.map(step => (
                          <li key={step.step}>
                            {`${step.label}: `}
                            {step.picks.map((pick, index) => (
                              <Fragment key={`${pick.pair.provider}::${pick.pair.model}`}>
                                {index > 0 && ' ou '}
                                <span className="rec-pick">{pick.pair.name}</span>
                              </Fragment>
                            ))}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </td>
                <td data-cell="Seu padrão">
                  <CurrentCell current={item.current} difference={item.difference} />
                </td>
                <td data-cell="Diferença" className={item.same ? 'rec-same' : 'rec-diff'}>
                  {item.difference ? (
                    <>
                      <b>{DIFFERENCE[item.difference.kind](item.difference)}</b>
                      <span className="rec-sub">{DIFFERENCE_NOTE[item.difference.kind](item.difference)}</span>
                    </>
                  ) : (
                    '✓ é o indicado'
                  )}
                </td>
                <td className="rec-act">
                  {!item.same && indicated && (
                    <ChooseButton
                      config={config}
                      pair={indicated.pair}
                      label="Usar o indicado"
                      name={`Usar o indicado em ${item.label}`}
                      onClick={() => {
                        const next = adopt(config, item.use, indicated.pair)
                        if (next) onChoose(next)
                      }}
                    />
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

/* ---------- the ladder of a use ---------- */

interface LadderProps {
  config: AiConfig
  situation: UseSituation
  timeZone: string
  tested: DiagnosisRecord[]
  onBack(): void
  onChoose(next: AiConfig): void
}

/** The Ata step by step (ATA_STEPS): each step with its own model, measured on the real meeting. */
/** The header of the list score column: "App 10/11" read as a grade out of 11, so it says what it is and the day. */
const scoreHead = (use: AiUse) => `Nota do app · ${listDayOf(use)}`

function AtaSteps() {
  const day = scoreHead('ata')
  return (
    <table className="rec-table rec-pairs rec-steps-table" aria-label="Ata passo a passo">
      <caption>{`Passo a passo, medido em ${listDayOf('ata')} numa reunião real`}</caption>
      <thead>
        <tr>
          <th>Passo</th>
          <th>Modelo · provedor</th>
          <th>{day}</th>
          <th>Por quê</th>
        </tr>
      </thead>
      <tbody>
        {ATA_STEPS.flatMap(step =>
          step.picks.map((pick, index) => (
            <tr key={`${step.step}-${index}`} className={index > 0 ? 'rec-more' : undefined} aria-label={`${step.label} · ${pick.pair.name}`}>
              <td data-cell="Passo">{index === 0 ? step.label : ''}</td>
              <td data-cell="Modelo · provedor">
                <b>{pick.pair.name}</b>
                <span className="rec-sub">
                  <span>{providerName(pick.pair.provider)}</span>
                </span>
              </td>
              <td data-cell={day}>{pick.score}</td>
              <td data-cell="Por quê">{index === 0 ? step.note : ''}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  )
}

function scoreCell(rung: Rung, timeZone: string, ran: boolean) {
  if (rung.testedScore !== null && rung.testedAt) return `${rung.testedScore} · ${dayOf(rung.testedAt, timeZone)}`
  return ran ? 'não rodou' : '—'
}

function Ladder({ config, situation, timeZone, tested, onBack, onChoose }: LadderProps) {
  const { use, label, recommendation, current } = situation
  const requirement = USE_REQUIREMENTS[use]
  const isCurrent = (rung: Rung) => Boolean(current && current.provider === rung.pair.provider && current.model === rung.pair.model)
  const rows = (rungs: Rung[], inside: boolean) =>
    rungs.map(rung => {
      const name = `${rung.pair.name} · ${providerName(rung.pair.provider)}`
      const star = inside && rung === recommendation.indicated
      const note = inside ? null : rung.cost === null ? '? sem preço' : rung.score === null ? 'não testado' : `${rung.score} · abaixo`
      return (
        <tr key={`${rung.pair.provider}::${rung.pair.model}`} className={star ? 'rec-star' : undefined} aria-label={name}>
          <td data-cell="Modelo · provedor">
            <b>{`${star ? '★ ' : ''}${rung.pair.name}`}</b>
            <span className="rec-sub">
              <span>{providerName(rung.pair.provider)}</span>
            </span>
          </td>
          <td data-cell={scoreHead(use)}>{rung.listScore ?? (note ?? '—')}</td>
          <td data-cell="Seu teste">{scoreCell(rung, timeZone, tested.some(record => record.use === use))}</td>
          <td data-cell="Custo por nota">{usd(rung.cost)}</td>
          <td className="rec-act">
            {isCurrent(rung) ? (
              <span className="rec-now">padrão atual</span>
            ) : (
              <ChooseButton
                config={config}
                pair={rung.pair}
                label="Usar como padrão"
                name={`Usar ${name} como padrão`}
                onClick={() => {
                  const next = adopt(config, use, rung.pair)
                  if (next) onChoose(next)
                }}
              />
            )}
          </td>
        </tr>
      )
    })
  const indicated = recommendation.indicated
  return (
    <section className="rec-ladder" aria-label={`Escada de ${label}`}>
      <button className="btn quiet rec-back" onClick={onBack}>
        <Icon name="back" />
        Geral · todos os usos
      </button>
      <h3>{label}</h3>
      <p className="rec-asks">{requirement.asks}</p>
      <p className="rec-hint">{`mínima ${requirement.minScore} · US$ por ${requirement.ruler.per}`}</p>
      {indicated ? (
        <div className="rec-indicated">
          <b>{`★ Indicado: ${indicated.pair.name} · ${providerName(indicated.pair.provider)}`}</b>
          <span>{`nota ${indicated.score} · ${usd(indicated.cost)} por ${requirement.ruler.per}`}</span>
          <p>{recommendation.why}</p>
        </div>
      ) : (
        <div className="rec-indicated rec-indicated-none">
          <b>Nenhum par passa da nota mínima ainda</b>
          <p>{recommendation.why}</p>
        </div>
      )}
      {use === 'ata' && <AtaSteps />}
      <table className="rec-table rec-pairs" aria-label={`Pares de ${label}`}>
        <caption>Do par mais barato que faz direito para cima</caption>
        <thead>
          <tr>
            <th>Modelo · provedor</th>
            <th>{scoreHead(use)}</th>
            <th>Seu teste</th>
            <th>Custo por nota</th>
            <th>
              <span className="rec-vh">Ação</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows(recommendation.ladder, true)}
          {recommendation.outside.length > 0 && (
            <tr className="rec-sep">
              <th colSpan={5} scope="colgroup">
                fora da escada
              </th>
            </tr>
          )}
          {rows(recommendation.outside, false)}
        </tbody>
      </table>
    </section>
  )
}

/* ---------- the diagnosis ---------- */

function EstimateLines({ estimate }: { estimate: DiagnosisEstimate }) {
  return (
    <>
      <span>{`etapas: catálogo grátis · web ${usd(estimate.research)} · testes ${usd(estimate.tests)}`}</span>
      {estimate.unpriced > 0 && <span>{`${estimate.unpriced} ${plural(estimate.unpriced, 'teste', 'testes')} sem preço no provedor: custo ?`}</span>}
    </>
  )
}

function DiagnosisPanel({ scope, timeZone }: { scope: AiUse | null; timeZone: string }) {
  const diagnosis = useModelsStore(state => state.diagnosis)
  const plan = useModelsStore(state => state.diagnosisPlan)
  const run = useModelsStore(state => state.diagnosisRun)
  const stop = useModelsStore(state => state.diagnosisStop)
  const close = useModelsStore(state => state.diagnosisClose)
  const label = scope ? USES.find(use => use.id === scope)?.label : null
  const where = label ? `só ${label}` : 'todos os usos'
  const covered = diagnosis.state !== 'idle' && diagnosis.scope !== scope

  let body: ReactNode
  if (diagnosis.state === 'idle' || (covered && diagnosis.state !== 'running' && diagnosis.state !== 'planning')) {
    body = (
      <div className="rec-diag-idle">
        <p className="rec-hint">{`Diagnóstico automático: testa, dá a nota e indica sozinho, sem você avaliar nada. Agora: ${where}.`}</p>
        <button className="btn" onClick={() => void plan(scope)}>
          <Icon name="sync" />
          Rodar meu diagnóstico
        </button>
      </div>
    )
  } else if (diagnosis.state === 'planning') {
    body = (
      <p className="rec-hint" role="status">
        Lendo os catálogos dos provedores (grátis)…
      </p>
    )
  } else if (diagnosis.state === 'ready') {
    const { estimate, skipped, unread } = diagnosis.plan
    const nothing = estimate.byUse.length === 0
    body = (
      <div role="group" aria-label="Diagnóstico antes de rodar" className="rec-box">
        <b>{`Custo estimado: ${usd(estimate.total)}`}</b>
        <span>{`${nothing ? 'Nada novo para testar' : `${estimate.byUse.reduce((sum, row) => sum + row.tests, 0)} testes`} em ${where}`}</span>
        <EstimateLines estimate={estimate} />
        {unread.map(item => (
          <span key={item.providerId} className="rec-warn">{`${item.name}: não deu para ler o catálogo (${item.reason})`}</span>
        ))}
        {skipped.map(item => (
          <span key={item.use} className="rec-warn">{`${USES.find(use => use.id === item.use)?.label}: ${item.reason}`}</span>
        ))}
        <span className="rec-actions">
          <button className="btn primary" disabled={nothing} onClick={() => void run()}>
            {`Rodar · ~${usd(estimate.total)}`}
          </button>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
        </span>
      </div>
    )
  } else if (diagnosis.state === 'running') {
    const { progress } = diagnosis
    const done = progress?.done ?? 0
    const total = progress?.total ?? 0
    body = (
      <div role="status" aria-label="Diagnóstico rodando" className="rec-box">
        <b>{progress?.phase === 'pesquisa' ? 'Rodando · pesquisa na web' : 'Rodando · testes em miniatura'}</b>
        <progress value={done} max={Math.max(total, 1)} aria-label="Andamento do diagnóstico" />
        <span>{`${done} de ${total} · ${usd(progress?.spent ?? 0)} até agora`}</span>
        <span className="rec-actions">
          <button className="btn" onClick={stop}>
            Parar
          </button>
        </span>
      </div>
    )
  } else if (diagnosis.state === 'done') {
    const { result } = diagnosis
    const same = USES.filter(use => {
      const mine = recommendationOf(use.id, result.records).indicated?.pair
      const app = RECOMMENDATIONS.find(item => item.use === use.id)?.indicated?.pair
      return mine?.provider === app?.provider && mine?.model === app?.model
    }).length
    body = (
      <div role="group" aria-label="Resultado do diagnóstico" className="rec-box">
        <b>{`Resultado · ${dayAndYear(diagnosis.at, timeZone)}${result.stopped ? ' · Parado' : ''}`}</b>
        {result.stopped && <span>Parado por você: o que já rodou ficou guardado.</span>}
        <span>{`${same} de ${USES.length} usos iguais à lista`}</span>
        <span>{`${result.fresh.length} ${plural(result.fresh.length, 'resultado novo', 'resultados novos')} · gastou ${usd(result.spent)} · guardado por modelo e provedor, com data`}</span>
        {result.failed.length > 0 && <span className="rec-warn">{`${result.failed.length} ${plural(result.failed.length, 'chamada falhou', 'chamadas falharam')} e fica para a próxima vez`}</span>}
        <span>Só refaz com modelo novo ou a pedido.</span>
        <span className="rec-actions">
          <button className="btn" onClick={close}>
            Fechar
          </button>
        </span>
      </div>
    )
  } else {
    body = (
      <div className="rec-box" role="alert">
        <b>O diagnóstico não rodou</b>
        <span>{diagnosis.message}</span>
        <span className="rec-actions">
          <button className="btn" onClick={close}>
            Fechar
          </button>
        </span>
      </div>
    )
  }
  return (
    <section className="rec-diag" aria-label="Diagnóstico">
      {body}
    </section>
  )
}

/* ---------- the tab ---------- */

export function RecommendationsTab({ config, save }: { config: AiConfig; save(next: AiConfig): void }) {
  const settings = useLibraryStore(state => state.index.settings)
  const live = useModelsStore(state => state.live)
  const probes = useModelsStore(state => state.probes)
  const recUse = useModelsStore(state => state.ui.recUse ?? null)
  const setUi = useModelsStore(state => state.setUi)
  const tested = useMemo(() => settings.aiDiagnosis ?? [], [settings.aiDiagnosis])
  const timeZone = settings.timezone
  const situations = useMemo(
    () =>
      situationsOf(config, {
        tested,
        priceOf: ({ providerId, model }) => {
          const read = live[providerId]
          return priceFromCatalog(read?.state === 'ok' ? read.byId.get(model)?.price : null)
        },
        searchesWeb: uid => searchesWeb(config, live, probes, uid),
      }),
    [config, tested, live, probes],
  )
  const open = recUse ? situations.find(item => item.use === recUse) : undefined
  const differ = situations.filter(item => !item.same).length

  return (
    <div className="recs" data-screen={open ? 'ladder' : 'general'}>
      <p className="rec-list">
        <Icon name="star" />
        {open ? `Recomendação do app · lista de ${listDayOf(open.use)}` : LIST_TITLE}
      </p>
      <div className="rec-cols">
        <nav className="rec-nav" aria-label="Usos">
          <button className="rec-all" aria-current={!open} onClick={() => setUi({ recUse: null })}>
            <span>Geral · todos os usos</span>
            <small>{`${differ} ${plural(differ, 'difere', 'diferem')}`}</small>
          </button>
          {USE_GROUPS.map(group => {
            const mother = situations.find(item => item.use === group.uses[0].id)?.recommendation.indicated
            return (
              <div key={group.id} className="rec-group" role="group" aria-label={group.title}>
                <div className="rec-gh">{[group.title, mother?.pair.name, mother && providerName(mother.pair.provider)].filter(Boolean).join(' · ')}</div>
                {group.uses.map(use => {
                  const item = situations.find(situation => situation.use === use.id)!
                  const indicated = item.recommendation.indicated
                  const apart = mother && indicated && (indicated.pair.provider !== mother.pair.provider || indicated.pair.model !== mother.pair.model)
                  return (
                    <button key={use.id} className="rec-nav-use" aria-current={open?.use === use.id} onClick={() => setUi({ recUse: use.id })}>
                      <span>
                        {use.label}
                        {apart && indicated ? ` · ${providerName(indicated.pair.provider)}` : ''}
                        {item.difference?.kind === 'below' ? ` (você: ${item.difference.score})` : ''}
                      </span>
                      <small>{indicated ? `${indicated.score} · ${usd(indicated.cost).replace('US$ ', '')}` : '—'}</small>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>
        <div className="rec-main">
          <DiagnosisPanel scope={open?.use ?? null} timeZone={timeZone} />
          {open ? (
            <Ladder config={config} situation={open} timeZone={timeZone} tested={tested} onBack={() => setUi({ recUse: null })} onChoose={save} />
          ) : (
            <General config={config} situations={situations} timeZone={timeZone} tested={tested} onOpen={use => setUi({ recUse: use })} onChoose={save} />
          )}
        </div>
      </div>
    </div>
  )
}
