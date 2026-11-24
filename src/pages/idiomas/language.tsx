import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { ReaderShell } from '@/components/layout/ReaderShell'
import { NewTextDialog } from '@/components/langs/NewTextDialog'
import { Icon } from '@/components/ui/Icon'
import { type Area, deleteText, failedReason, type LanguageDetail, langsMessage, retryText, type TextRow } from '@/controllers/langs.controller'
import { paths } from '@/lib/paths'
import { useLangsStore } from '@/stores/langs'
import { langPlace, useLangsPlace } from '@/lib/langs/browser'
import { useUiStore } from '@/stores/ui'
import '@/styles/langs.css'

/** The page of a language (spec 004, wireframe D of 21/11): the base by area in state colors, and each text with how much of it is known. */

export const AREAS: [Area, string][] = [
  ['lexico', 'Léxico'],
  ['gramatica', 'Gramática'],
  ['semantica', 'Sentidos'],
  ['fonologia', 'Pronúncia'],
  ['ortografia', 'Escrita'],
  ['registro', 'Registro'],
  ['pragmatica', 'Uso e discurso'],
]

function Base({ detail }: { detail: LanguageDetail }) {
  const rows = AREAS.map(([area, name]) => ({ area, name, ...(detail.areas[area] ?? { total: 0, seen: 0, fixed: 0 }) })).filter(row => row.total > 0)
  if (!rows.length) return null
  return (
    <section className="blk lg-base" aria-labelledby="lg-base-h">
      <h3 className="blk-h" id="lg-base-h">
        O que você já sabe
      </h3>
      <div className="lg-legend" aria-hidden="true">
        <span className="fixed">Fixado</span>
        <span className="learning">Aprendendo</span>
        <span className="unseen">Não visto</span>
      </div>
      <table className="lg-areas">
        <thead>
          <tr>
            <th scope="col">Área</th>
            <th scope="col">Fixado</th>
            <th scope="col">Aprendendo</th>
            <th scope="col">Não visto</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const learning = row.seen - row.fixed
            const unseen = row.total - row.seen
            return (
              <tr key={row.area}>
                <th scope="row">
                  {row.name}
                  <span className="lg-bar" aria-hidden="true">
                    <i className="fixed" style={{ flexGrow: row.fixed }} />
                    <i className="learning" style={{ flexGrow: learning }} />
                    <i className="unseen" style={{ flexGrow: unseen }} />
                  </span>
                </th>
                <td>{row.fixed}</td>
                <td>{learning}</td>
                <td>{unseen}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function TextLine({ code, text, onChanged }: { code: string; text: TextRow; onChanged: () => void }) {
  const navigate = useNavigate()
  const ui = useUiStore()
  const [busy, setBusy] = useState(false)
  const retry = async () => {
    setBusy(true)
    try {
      await retryText(code, text.id)
      onChanged()
    } catch (error) {
      ui.toast(langsMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const remove = () =>
    ui.open({
      kind: 'confirm',
      title: 'Apagar o texto?',
      text: `“${text.title}” sai da lista. O que você já aprendeu com ele continua na sua base.`,
      ok: 'Apagar',
      danger: true,
      onConfirm: async () => {
        try {
          await deleteText(code, text.id)
          onChanged()
        } catch (error) {
          ui.toast(langsMessage(error))
        }
      },
    })
  return (
    <li className={`lg-text ${text.status}`}>
      <div className="lg-text-main">
        <b>{text.title}</b>
        {text.status === 'generating' && (
          <span className="lg-text-sub" role="status">
            <span className="spin" aria-hidden="true" />
            <span className="lg-gen">
              {generationLines(text.generation, Date.now()).map(line => (
                <span key={line}>{line}</span>
              ))}
            </span>
          </span>
        )}
        {text.status === 'failed' && <span className="lg-text-sub bad">Não deu para gerar: {failedReason(text.error)}</span>}
        {text.status === 'ready' && <span className="lg-text-sub">você já sabe {text.known}%{text.progress === 'done' ? ' · terminado' : ''}</span>}
      </div>
      <div className="lg-text-act">
        {text.status === 'ready' && (
          <button className={`btn ${text.progress === 'done' ? '' : 'primary'}`} onClick={() => navigate(paths.study(code, text.id))}>
            <Icon name="play" />
            {text.progress === 'continue' ? 'Continuar' : text.progress === 'done' ? 'Estudar de novo' : 'Começar'}
          </button>
        )}
        {/* in the Drive and Local the AI is the person's: the fix is one tap away (design review, 24/11) */}
        {text.status === 'failed' && text.error === 'ai_not_configured' && langPlace() !== 'app' && (
          <button className="btn primary" onClick={() => ui.open({ kind: 'settings', tab: 'ai' })}>
            Escolher o modelo
          </button>
        )}
        {text.status === 'failed' && (
          <button className="btn" disabled={busy} onClick={() => void retry()}>
            <Icon name="sync" />
            {busy ? 'Pedindo…' : 'Tentar de novo'}
          </button>
        )}
        {text.status !== 'generating' && (
          <button className="ibtn" aria-label={`Apagar “${text.title}”`} title="Apagar o texto" onClick={remove}>
            <Icon name="trash" />
          </button>
        )}
      </div>
    </li>
  )
}

export default function LanguagePage() {
  const { code = '' } = useParams()
  const { place, ready } = useLangsPlace()
  const { details, error, open, follow } = useLangsStore()
  const detail = details[code]
  const [writing, setWriting] = useState(false)
  useEffect(() => {
    if (!ready) return
    void open(code)
    return follow(code)
  }, [code, ready, place])
  return (
    <ReaderShell>
      <div className="libwrap">
        <div className="libhead">
          <Link className="ibtn" to={paths.languages} aria-label="Voltar a Idiomas" title="Idiomas">
            <Icon name="back" />
          </Link>
          <h2>{detail?.name ?? 'Idioma'}</h2>
          {detail && (
            <span style={{ marginLeft: 'auto' }}>
              <button className="btn primary" onClick={() => setWriting(true)}>
                <Icon name="plus" />
                Novo texto
              </button>
            </span>
          )}
        </div>
        {!detail ? (
          error ? (
            <p className="lg-error" role="alert">
              {error === 'not_found' ? 'Este idioma não está na sua lista.' : error === 'app_disabled' ? 'Os idiomas usam a estrutura do app. Ligue em Configurações › Outros.' : 'Não deu para abrir agora. Tente de novo.'}
            </p>
          ) : (
            <p className="faint">Abrindo…</p>
          )
        ) : (
          <div className="libbody lg-page">
            <Base detail={detail} />
            <section className="blk" aria-labelledby="lg-texts-h">
              <h3 className="blk-h" id="lg-texts-h">
                Textos <span>{detail.texts.length}</span>
              </h3>
              {detail.texts.length ? (
                <ul className="lg-texts">
                  {[...detail.texts].reverse().map(text => (
                    <TextLine key={text.id} code={code} text={text} onChanged={() => void open(code)} />
                  ))}
                </ul>
              ) : (
                <div className="lg-empty small">
                  <p>Mande um texto que você quer entender: uma música, um artigo, um diálogo. Ele vira frases para ouvir e cards.</p>
                  <button className="btn primary" onClick={() => setWriting(true)}>
                    <Icon name="plus" />
                    Novo texto
                  </button>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
      {writing && detail && (
        <NewTextDialog
          code={code}
          languageName={detail.name}
          onClose={() => setWriting(false)}
          onSent={() => {
            setWriting(false)
            void open(code)
          }}
        />
      )}
    </ReaderShell>
  )
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  return `${minutes} min`
}

/** Constitution IV: what is happening, how far it is, around when it ends and that it did not stall (or that it is taking long). */
export function generationLines(generation: TextRow['generation'], now: number): string[] {
  if (!generation) return ['Na fila: começa quando o texto anterior terminar.']
  const { done, total, startedAt, lastAt, endsAt } = generation
  const since = now - Date.parse(lastAt ?? startedAt)
  const head = `Gerando os cards: ${done} de ${total} ${total === 1 ? 'parte pronta' : 'partes prontas'}`
  const lines = [endsAt ? `${head} · termina por volta de ${clock(endsAt)}` : `${head} · começou às ${clock(startedAt)}`]
  if (since > 8 * 60_000) lines.push(`A IA está demorando nesta parte (há ${ago(since)}); o app continua tentando.`)
  else lines.push(lastAt ? `Andando: a última parte saiu há ${ago(since)}.` : `Andando: a primeira parte está sendo feita há ${ago(since)}.`)
  return lines
}
