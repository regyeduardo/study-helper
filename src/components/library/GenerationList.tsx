// Gerações (003, FR-065): tabs Gerando, Falharam and Prontas, with the count; each line with the note, what is being made, how far it is and what to do.
import type { CSSProperties } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { Icon } from '@/components/ui/Icon'
import { useIsNarrow } from '@/hooks/use-is-narrow'
import { paths } from '@/lib/paths'
import { type Generation, type GenerationState, retryOf, useGenerationsStore } from '@/stores/generations'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileMeta, FileType } from '@/types/domain'
import '@/styles/generations.css'

/** Each tab with its name and its address (`?aba=`), so a link or "Voltar" lands on the same tab. */
const TABS: [GenerationState, string, string][] = [
  ['running', 'Gerando', 'gerando'],
  ['failed', 'Falharam', 'falharam'],
  ['ready', 'Prontas', 'prontas'],
]

const STATUS_HEAD: Record<GenerationState, string> = { running: 'Andamento', failed: 'Motivo', ready: 'Quando' }

/** The start of a job title that says what is made ("Ata: Reunião de 03/11"). */
const BY_PREFIX: Record<string, string> = {
  Aula: 'Aula',
  Ata: 'Ata',
  Explicação: 'Explicação',
  Leitura: 'Leitura',
  Prova: 'Prova',
  Reforço: 'Prova',
  'Prova de leitura': 'Prova',
  'Refazer a transcrição': 'Transcrição',
  'Guardar a mídia': 'Mídia',
  Mapa: 'Mapa',
  Cartões: 'Cartões',
}

const BY_TYPE: Partial<Record<FileType, string>> = { class: 'Aula', explanation: 'Explicação', meeting: 'Ata', reading: 'Leitura' }

const BY_KIND: Record<Generation['kind'], string> = { generation: 'Nota', transcription: 'Transcrição', questions: 'Prova', course: 'Curso', sync: 'Tarefa', artifact: 'Artefato' }

/** What is being made, and the name of the note when the note itself is not at hand. */
function describe(item: Generation, file: FileMeta | undefined): { what: string; note: string } {
  const at = item.title.indexOf(': ')
  const prefix = at > 0 ? item.title.slice(0, at) : ''
  if (BY_PREFIX[prefix]) return { what: BY_PREFIX[prefix], note: item.title.slice(at + 2) }
  const byType = item.kind === 'generation' && file ? BY_TYPE[file.type] : undefined
  return { what: byType ?? BY_KIND[item.kind], note: item.title }
}

const newestFirst = (state: GenerationState) => (a: Generation, b: Generation) => (state === 'running' ? b.startedAt - a.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0))

/** "Hoje, 14:02" or "20/11/2026, 14:02", in the library's time zone. */
function when(at: number, timeZone: string): string {
  const date = new Date(at)
  const format = (value: Date) => value.toLocaleDateString('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' })
  const day = format(date)
  return `${day === format(new Date()) ? 'Hoje' : day}, ${date.toLocaleTimeString('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' })}`
}

function Status({ item }: { item: Generation }) {
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  if (item.state === 'failed') return <span className="gen-reason">{item.error || item.message}</span>
  if (item.state === 'ready') return <span className="gen-when">{when(item.endedAt ?? item.startedAt, timeZone)}</span>
  const percent = item.fraction === null ? null : Math.round(item.fraction * 100)
  return (
    <div className="gen-progress">
      <span>
        {percent !== null && <b>{percent}%</b>}
        {percent !== null && ' · '}
        {item.message}
      </span>
      {percent !== null && (
        <div className="bar" role="progressbar" aria-label={item.message} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <i style={{ '--v': `${percent}%` } as CSSProperties} />
        </div>
      )}
    </div>
  )
}

function Actions({ item, file }: { item: Generation; file: FileMeta | undefined }) {
  const { cancel, retry, dismiss } = useGenerationsStore()
  const files = useLibraryStore(state => state.files)
  const navigate = useNavigate()
  if (item.state === 'running') {
    // a plain task of the app (saving, moving) has nothing to cancel
    return item.kind === 'sync' ? null : (
      <button className="btn quiet danger" onClick={() => cancel(item.id)}>
        Cancelar
      </button>
    )
  }
  if (item.state === 'ready') {
    if (!file) return null
    // a map or a deck opens on the note, in itself
    const open = () => {
      navigate(paths.file(file.id))
      if (item.open) useUiStore.getState().open(item.open)
    }
    return (
      <button className="btn" onClick={open}>
        Abrir
      </button>
    )
  }
  return (
    <>
      {retryOf(item, files) && (
        <button className="btn" onClick={() => retry(item.id)}>
          Tentar de novo
        </button>
      )}
      <button className="btn quiet" onClick={() => dismiss(item.id)}>
        Dispensar
      </button>
    </>
  )
}

const STATE_ICON: Record<GenerationState, Parameters<typeof Icon>[0]['name']> = { running: 'sync', failed: 'warn', ready: 'check' }

function Row({ item, narrow }: { item: Generation; narrow: boolean }) {
  const file = useLibraryStore(state => (item.fileId ? state.files.find(entry => entry.id === item.fileId && !entry.deletedAt) : undefined))
  const { what, note } = describe(item, file)
  const name = file?.name ?? note
  const title = (
    <>
      <Icon name={STATE_ICON[item.state]} className={`gen-ic ${item.state} ${item.state === 'running' ? 'spinning' : ''}`} />
      <span className="ex-title">{name}</span>
    </>
  )
  return (
    <tr aria-label={name}>
      <td>
        {file ? (
          <Link className="ex-name" to={paths.file(file.id)}>
            {title}
          </Link>
        ) : (
          <div className="ex-name">{title}</div>
        )}
        {/* on a phone the line is one column: what, how far, then the actions in a row, so the reason keeps the whole width */}
        {narrow && (
          <div className="gen-sub">
            <span className="gen-what">{what}</span>
            <Status item={item} />
            <div className="gen-act-row">
              <Actions item={item} file={file} />
            </div>
          </div>
        )}
      </td>
      {!narrow && <td className="gen-what">{what}</td>}
      {!narrow && (
        <td className="gen-status">
          <Status item={item} />
        </td>
      )}
      {!narrow && (
        <td className="gen-act">
          <div>
            <Actions item={item} file={file} />
          </div>
        </td>
      )}
    </tr>
  )
}

function Table({ state, label, items }: { state: GenerationState; label: string; items: Generation[] }) {
  const narrow = useIsNarrow()
  return (
    <table className="ex-table gen-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Nota</th>
          {!narrow && <th scope="col">O que</th>}
          {!narrow && <th scope="col">{STATUS_HEAD[state]}</th>}
          {!narrow && (
            <th scope="col">
              <span className="sr-only">Ações</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {items.map(item => (
          <Row key={item.id} item={item} narrow={narrow} />
        ))}
      </tbody>
    </table>
  )
}

const EMPTY: Record<GenerationState, [string, string]> = {
  running: ['Nada gerando agora', 'O que você pedir à IA aparece aqui enquanto é feito.'],
  failed: ['Nenhuma falha', 'Uma falha fica aqui até você tentar de novo ou dispensar.'],
  ready: ['Nada pronto nos últimos 7 dias', 'O que a IA terminar fica aqui por 7 dias.'],
}

function Empty({ state }: { state: GenerationState }) {
  const [title, text] = EMPTY[state]
  return (
    <div className="empty gen-empty">
      <Icon name={STATE_ICON[state]} />
      <div>
        <b>{title}</b>
        <div className="muted">{text}</div>
      </div>
    </div>
  )
}

export function GenerationList() {
  const items = useGenerationsStore(state => state.items)
  const [params, setParams] = useSearchParams()
  const tab = TABS.find(([, , address]) => address === params.get('aba'))?.[0] ?? 'running'
  const of = (state: GenerationState) => items.filter(item => item.state === state).sort(newestFirst(state))
  const shown = of(tab)
  const failed = of('failed')
  return (
    <>
      <div className="libhead">
        <h2>Gerações</h2>
      </div>
      <div className="libbody gen">
        <div className="seg gen-tabs" role="group" aria-label="Gerações">
          {TABS.map(([state, label, address]) => (
            <button key={state} aria-pressed={tab === state} onClick={() => setParams(state === 'running' ? {} : { aba: address }, { replace: true })}>
              {label}
              <b>{items.filter(item => item.state === state).length}</b>
            </button>
          ))}
        </div>
        {shown.length ? <Table state={tab} label={TABS.find(([state]) => state === tab)![1]} items={shown} /> : <Empty state={tab} />}
        {/* as in the chosen drawing: what failed stays in sight under what is generating */}
        {tab === 'running' && failed.length > 0 && (
          <section className="gen-failed">
            <h3 className="blk-h">
              <Icon name="warn" />
              Falharam <span>{failed.length}</span>
            </h3>
            <Table state="failed" label="Falharam" items={failed} />
          </section>
        )}
      </div>
    </>
  )
}
