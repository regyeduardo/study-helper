import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { moveWithArrows } from '@/components/langs/cards/ListenCard'
import { ReaderShell } from '@/components/layout/ReaderShell'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { ApiError } from '@/controllers/api.controller'
import { addLanguage, type LanguageDetail, type LanguageSummary, langsMessage, type TextRow } from '@/controllers/langs.controller'
import { paths } from '@/lib/paths'
import { useLangsStore } from '@/stores/langs'
import { useLangsPlace } from '@/lib/langs/browser'
import { useUiStore } from '@/stores/ui'
import '@/styles/langs.css'

/** Idiomas (spec 004, wireframe A of 21/11): each language with its next step a touch away, and the base in short. */

/** The languages that come with their name and voice (the same list as the server's). */
export const KNOWN_LANGUAGES: { code: string; name: string; locale: string }[] = [
  { code: 'de', name: 'Alemão', locale: 'de-DE' },
  { code: 'zh', name: 'Chinês', locale: 'zh-CN' },
  { code: 'ko', name: 'Coreano', locale: 'ko-KR' },
  { code: 'es', name: 'Espanhol', locale: 'es-ES' },
  { code: 'fr', name: 'Francês', locale: 'fr-FR' },
  { code: 'nl', name: 'Holandês', locale: 'nl-NL' },
  { code: 'en', name: 'Inglês', locale: 'en-US' },
  { code: 'it', name: 'Italiano', locale: 'it-IT' },
  { code: 'ja', name: 'Japonês', locale: 'ja-JP' },
  { code: 'ru', name: 'Russo', locale: 'ru-RU' },
  { code: 'sv', name: 'Sueco', locale: 'sv-SE' },
]

/** The text to continue (or to start) of a language. */
export function nextText(detail: LanguageDetail | undefined): { text: TextRow; verb: string } | null {
  const texts = detail?.texts ?? []
  const going = texts.find(text => text.status === 'ready' && text.progress === 'continue')
  if (going) return { text: going, verb: 'Continuar' }
  const fresh = texts.find(text => text.status === 'ready' && text.progress === 'start')
  if (fresh) return { text: fresh, verb: 'Começar' }
  const done = [...texts].reverse().find(text => text.status === 'ready' && text.progress === 'done')
  if (done) return { text: done, verb: 'Estudar de novo' }
  return null
}

export function summary(counts: Pick<LanguageSummary, 'seen' | 'fixed' | 'due'>): string {
  return [`${counts.seen} ${counts.seen === 1 ? 'visto' : 'vistos'}`, `${counts.fixed} ${counts.fixed === 1 ? 'fixado' : 'fixados'}`, `${counts.due} para revisar`].join(' · ')
}

function NoStructure() {
  const open = useUiStore(state => state.open)
  return (
    <section className="lg-empty" aria-labelledby="lg-need">
      <Icon name="globe" />
      <h3 id="lg-need">Os idiomas usam a estrutura do app</h3>
      <p>As frases, a voz e o que você já sabe ficam guardados no app. Ligue “Usar a estrutura do app” para começar.</p>
      <button className="btn primary" onClick={() => open({ kind: 'settings', tab: 'others' })}>
        Abrir Configurações › Outros
      </button>
    </section>
  )
}

function NewLanguageDialog({ studying, onClose, onMade }: { studying: string[]; onClose: () => void; onMade: (code: string) => void }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [other, setOther] = useState(false)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const found = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('pt-BR')
    return KNOWN_LANGUAGES.filter(language => !q || language.name.toLocaleLowerCase('pt-BR').includes(q) || language.code.startsWith(q))
  }, [query])
  const can = other ? name.trim() !== '' && code.trim() !== '' : picked !== null
  const create = async () => {
    if (!can || busy) return
    setBusy(true)
    setError(null)
    try {
      const made = await addLanguage(other ? { code: code.trim(), name: name.trim() } : { code: picked! })
      onMade(made.code)
    } catch (failure) {
      setError(langsMessage(failure))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Novo idioma"
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button className="btn quiet" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!can || busy} onClick={() => void create()}>
            {busy ? 'Criando…' : 'Criar'}
          </button>
        </>
      }
    >
      <div className="db lg-new">
        <input className="input" type="search" placeholder="Buscar idioma" aria-label="Buscar idioma" autoFocus value={query} onChange={event => setQuery(event.target.value)} />
        <div className="lg-pick" role="radiogroup" aria-label="Idiomas" onKeyDown={moveWithArrows}>
          {found.map(language => {
            const already = studying.includes(language.code)
            return (
              <button
                key={language.code}
                type="button"
                role="radio"
                aria-checked={!other && picked === language.code}
                disabled={already}
                className="lg-pick-row"
                onClick={() => (setPicked(language.code), setOther(false))}
              >
                <b>{language.name}</b>
                <span>{already ? 'já estuda' : !other && picked === language.code ? <Icon name="check" /> : language.locale}</span>
              </button>
            )
          })}
          {!found.length && <p className="faint lg-none">Nenhum idioma da lista com “{query}”. Use “Outro idioma”.</p>}
        </div>
        <fieldset className={`lg-other ${other ? 'on' : ''}`}>
          <legend>
            <button type="button" className="btn quiet" aria-expanded={other} onClick={() => (setOther(!other), setPicked(null))}>
              <Icon name={other ? 'down' : 'chevr'} />
              Outro idioma
            </button>
          </legend>
          {other && (
            <div className="lg-other-fields">
              <label>
                Nome
                <input className="input" placeholder="Ex.: Tupi antigo" value={name} onChange={event => setName(event.target.value)} />
              </label>
              <label>
                Código
                <input className="input" placeholder="Ex.: tpw" autoCapitalize="none" autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} />
              </label>
            </div>
          )}
        </fieldset>
        {error && (
          <p className="lg-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  )
}

export default function LanguagesPage() {
  const navigate = useNavigate()
  // 24/11 (FR-040): in the account's default place; the App waits for the server's session, the Drive and Local for the library
  const { place, ready } = useLangsPlace()
  const { languages, details, error, load, open } = useLangsStore()
  const [making, setMaking] = useState(false)
  useEffect(() => {
    if (ready) void load()
  }, [ready, place])
  useEffect(() => {
    for (const language of languages ?? []) void open(language.code)
  }, [languages?.map(language => language.code).join(',')])
  const blocked = place === 'app' && error === 'app_disabled'
  return (
    <ReaderShell>
      <div className="libwrap">
        <div className="libhead">
          <h2>Idiomas</h2>
          {!blocked && Boolean(languages?.length) && (
            <span style={{ marginLeft: 'auto' }}>
              <button className="btn" onClick={() => setMaking(true)}>
                <Icon name="plus" />
                Novo idioma
              </button>
            </span>
          )}
        </div>
        {blocked ? (
          <NoStructure />
        ) : error && !languages ? (
          <p className="lg-error" role="alert">
            {langsMessage(new ApiError(0, error))}
          </p>
        ) : !languages ? (
          <p className="faint">Abrindo os seus idiomas…</p>
        ) : !languages.length ? (
          <section className="lg-empty">
            <Icon name="globe" />
            <h3>Escolha o primeiro idioma</h3>
            <p>Depois, mande um texto (uma música, um artigo) e estude ouvindo as frases dele.</p>
            <button className="btn primary" onClick={() => setMaking(true)}>
              <Icon name="plus" />
              Novo idioma
            </button>
          </section>
        ) : (
          <ul className="lg-list" aria-label="Seus idiomas">
            {languages.map(language => {
              const next = nextText(details[language.code])
              return (
                <li key={language.code} className="lg-row">
                  <button className="lg-row-main" onClick={() => navigate(paths.language(language.code))}>
                    <b>{language.name}</b>
                    <span className="lg-row-sub">{summary(language)}</span>
                  </button>
                  {next ? (
                    <button className="btn lg-next" onClick={() => navigate(paths.study(language.code, next.text.id))}>
                      <Icon name="play" />
                      <span>
                        {next.verb}: <b>{next.text.title}</b>
                      </span>
                    </button>
                  ) : (
                    <button className="btn quiet lg-next" onClick={() => navigate(paths.language(language.code))}>
                      {language.texts ? 'Ver os textos' : 'Mande o primeiro texto'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {making && (
        <NewLanguageDialog
          studying={(languages ?? []).map(language => language.code)}
          onClose={() => setMaking(false)}
          onMade={code => {
            setMaking(false)
            void load()
            navigate(paths.language(code))
          }}
        />
      )}
    </ReaderShell>
  )
}
