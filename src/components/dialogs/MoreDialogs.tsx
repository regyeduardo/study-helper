import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { CourseAnalysis } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { FolderField } from '@/components/dialogs/FolderChooser'
import { useGoToNew } from '@/components/dialogs/go-to-new'
import { useBusy } from '@/hooks/use-busy'
import { blocking, blockingFailure } from '@/lib/blocking'
import { DEFAULT_STORAGE_LIMIT_BYTES } from '@/lib/defaults'
import { storedFromRaw } from '@/lib/exam'
import { importDocument } from '@/lib/imports'
import { paths } from '@/lib/paths'
import { bringLocalToAccount, transferLocalToCurrent } from '@/lib/storage/transfer'
import { working } from '@/lib/working'
import { useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { dateTime, formatBytes } from '@/utils/format'

type Written = 'ready' | 'failed' | 'gone'

/** Resolves when the explanation stops being written. */
function written(id: string): Promise<Written> {
  const outcome = (): Written | null => {
    const file = useLibraryStore.getState().files.find(item => item.id === id)
    if (!file || file.deletedAt) return 'gone'
    return file.status === 'generating' ? null : file.status === 'ready' ? 'ready' : 'failed'
  }
  return new Promise(resolve => {
    const now = outcome()
    if (now) return resolve(now)
    const stop = useLibraryStore.subscribe(() => {
      const done = outcome()
      if (!done) return
      stop()
      resolve(done)
    })
  })
}

export function ExplainDialog({ fileId, excerpt }: { fileId: string; excerpt: string }) {
  const ui = useUiStore()
  const explainSelection = useJobsStore(state => state.explainSelection)
  const [mode, setMode] = useState<'context' | 'concept'>('context')
  const [prompt, setPrompt] = useState('')
  const choice = useModelChoice('explicacao')
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  // The person stays where she is reading: the passage shows it is being explained, and a toast opens the explanation when it is ready.
  const go = async () => {
    setError(null)
    // reading the note and making the file can take seconds in the Drive: the button answers at once and does not run twice
    const id = await run(async () => {
      try {
        return await explainSelection(fileId, excerpt, prompt, mode, choice.model || null)
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Não deu para gerar a explicação.')
        return undefined
      }
    })
    if (!id) return
    ui.close()
    ui.toast('Gerando a explicação. Você pode continuar lendo.')
    const result = await written(id)
    // Not written, it opens where "Tentar de novo" is.
    if (result !== 'gone') ui.toast(result === 'ready' ? 'Explicação pronta.' : 'A explicação não foi gerada.', { label: 'Abrir explicação', to: paths.file(id) })
  }
  return (
    <Dialog
      title="Explicar isto"
      onClose={ui.close}
      footer={
        <>
          <button className="btn quiet" onClick={ui.close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!choice.ready || busy} onClick={() => void go()}>
            {busy ? <Icon name="sync" className="spinning" /> : <Icon name="bulb" />}
            {busy ? 'Gerando…' : 'Gerar explicação'}
          </button>
        </>
      }
    >
      <div className="db">
        <div className="note">
          <q>{excerpt}</q>
        </div>
        <div className="opts" role="radiogroup">
          <button className="opt" role="radio" aria-checked={mode === 'context'} onClick={() => setMode('context')}>
            <span className="radio" />
            <span>
              <b>No contexto deste documento</b>
              <span>Explica o trecho considerando de onde ele veio. Fica na mesma pasta da origem.</span>
            </span>
          </button>
          <button className="opt" role="radio" aria-checked={mode === 'concept'} onClick={() => setMode('concept')}>
            <span className="radio" />
            <span>
              <b>O conceito geral</b>
              <span>Explica a ideia por trás do trecho, sem prender ao documento. Fica na raiz da Biblioteca.</span>
            </span>
          </button>
        </div>
        <div className="field">
          <label htmlFor="ex-prompt">O que você quer saber (opcional)</label>
          <textarea className="input" id="ex-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Ex.: por que isso vale só para índice composto?" />
        </div>
        <ModelPick choice={choice} />
        {error && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function OrderDialog({ folderId }: { folderId: string }) {
  const ui = useUiStore()
  const library = useLibraryStore()
  const course = library.folders.find(folder => folder.id === folderId)
  const modules = library.folders.filter(folder => folder.parentId === folderId && !folder.deletedAt).sort((a, b) => a.position - b.position)
  const lessonsOf = (id: string) => library.files.filter(file => file.folderId === id && !file.deletedAt).sort((a, b) => a.position - b.position)
  const [newModule, setNewModule] = useState('')

  const swapFiles = async (list: { id: string; position: number }[], index: number, direction: -1 | 1) => {
    const other = list[index + direction]
    if (!other) return
    const current = list[index]
    await library.updateFile(current.id, { position: other.position === current.position ? other.position + direction : other.position })
    await library.updateFile(other.id, { position: current.position })
  }
  const swapModules = async (index: number, direction: -1 | 1) => {
    const other = modules[index + direction]
    if (!other) return
    const current = modules[index]
    await library.updateFolder(current.id, { position: other.position === current.position ? other.position + direction : other.position })
    await library.updateFolder(other.id, { position: current.position })
  }

  const renderLessons = (parentId: string) => {
    const lessons = lessonsOf(parentId)
    return lessons.map((lesson, index) => (
      <div key={lesson.id} className="row" style={{ cursor: 'default', gridTemplateColumns: '1fr auto' }}>
        <div>
          <input className="input" aria-label="Nome da aula" defaultValue={lesson.name} onBlur={event => event.target.value.trim() && event.target.value !== lesson.name && void library.updateFile(lesson.id, { name: event.target.value.trim() })} />
          {lesson.description && (
            <input className="input" style={{ marginTop: 4 }} aria-label="Descrição da aula" defaultValue={lesson.description} onBlur={event => event.target.value !== lesson.description && void library.updateFile(lesson.id, { description: event.target.value })} />
          )}
        </div>
        <div className="side">
          <button className="ibtn" onClick={() => void swapFiles(lessons, index, -1)} disabled={index === 0} aria-label="Subir">
            <Icon name="up" />
          </button>
          <button className="ibtn" onClick={() => void swapFiles(lessons, index, 1)} disabled={index === lessons.length - 1} aria-label="Descer">
            <Icon name="down" />
          </button>
          <select className="input" style={{ width: 150 }} aria-label="Mover para o módulo" value={lesson.folderId ?? ''} onChange={event => void library.updateFile(lesson.id, { folderId: event.target.value || folderId, position: 999 })}>
            <option value={folderId}>{course?.name}</option>
            {modules.map(module => (
              <option key={module.id} value={module.id}>
                {module.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    ))
  }

  if (!course) return null
  return (
    <Dialog title={`Ordem das aulas · ${course.name}`} size="wide" onClose={ui.close} footer={<button className="btn primary" onClick={ui.close}>Pronto</button>}>
      <div className="db">
        <div className="field">
          <label htmlFor="course-desc">Descrição da pasta</label>
          <textarea className="input" id="course-desc" defaultValue={course.courseDescription ?? ''} onBlur={event => void library.updateFolder(course.id, { courseDescription: event.target.value })} />
        </div>
        {renderLessons(folderId)}
        {modules.map((module, index) => {
          const empty = !lessonsOf(module.id).length && !library.folders.some(folder => folder.parentId === module.id && !folder.deletedAt)
          return (
            <div key={module.id} className="q">
              <div className="qh" style={{ alignItems: 'center' }}>
                <Icon name="layers" />
                <input className="input" aria-label="Nome do módulo" defaultValue={module.name} onBlur={event => event.target.value.trim() && event.target.value !== module.name && void library.updateFolder(module.id, { name: event.target.value.trim() })} />
                <button className="ibtn" onClick={() => void swapModules(index, -1)} disabled={index === 0} aria-label="Subir o módulo">
                  <Icon name="up" />
                </button>
                <button className="ibtn" onClick={() => void swapModules(index, 1)} disabled={index === modules.length - 1} aria-label="Descer o módulo">
                  <Icon name="down" />
                </button>
                <button className="ibtn" disabled={!empty} title={empty ? 'Apagar o módulo' : 'Tire as aulas de dentro antes de apagar'} onClick={() => void working('Apagando o módulo…', () => library.deleteFolderForever(module.id))} aria-label="Apagar o módulo">
                  <Icon name="trash" />
                </button>
              </div>
              {module.description !== undefined && (
                <input className="input" aria-label="Descrição do módulo" placeholder="Descrição do módulo" defaultValue={module.description} onBlur={event => event.target.value !== module.description && void library.updateFolder(module.id, { description: event.target.value })} />
              )}
              {renderLessons(module.id)}
            </div>
          )
        })}
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" placeholder="Nome do novo módulo" aria-label="Nome do novo módulo" value={newModule} onChange={event => setNewModule(event.target.value)} />
          <button
            className="btn"
            disabled={!newModule.trim()}
            onClick={async () => {
              // the window holds the app until the folder exists: a second click does not make a second module
              if (await working('Criando o módulo…', () => library.createFolder({ name: newModule.trim(), parentId: folderId, position: modules.length }))) setNewModule('')
            }}
          >
            <Icon name="plus" />
            Novo módulo
          </button>
        </div>
      </div>
    </Dialog>
  )
}

export function ActivityDialog() {
  const ui = useUiStore()
  const activities = useLibraryStore(state => state.index.activities)
  const timeZone = useLibraryStore(state => state.index.settings.timezone)
  return (
    <Dialog title="O que o app fez" size="wide" onClose={ui.close}>
      <div className="db">
        {activities.length ? (
          <div className="list">
            {activities.map(activity => (
              <div key={activity.id} className="row" style={{ cursor: 'default', gridTemplateColumns: 'auto 1fr auto' }}>
                <span style={{ color: activity.status === 'done' ? 'var(--ok)' : activity.status === 'error' ? 'var(--bad)' : 'var(--fg-muted)' }}>
                  <Icon name={activity.status === 'done' ? 'check' : activity.status === 'error' ? 'warn' : activity.status === 'cancelled' ? 'x' : 'sync'} />
                </span>
                <div>
                  <div className="title">{activity.label}</div>
                  <div className="sub">
                    <span>de: {activity.origin}</span>
                    <span>para: {activity.destination}</span>
                    {activity.detail && <span>{activity.detail}</span>}
                  </div>
                </div>
                <span className="faint" style={{ fontSize: 12 }}>
                  {dateTime(activity.createdAt, timeZone)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <span className="muted">Nada ainda.</span>
        )}
      </div>
    </Dialog>
  )
}

export function ImportDialog() {
  const ui = useUiStore()
  const library = useLibraryStore()
  const navigate = useNavigate()
  const [folderId, setFolderId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const importFile = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const imported = await importDocument(file)
      const type = imported.type === 'class' || imported.type === 'explanation' || imported.type === 'meeting' || imported.type === 'reading' ? imported.type : 'reading'
      const meta = await library.createFile(
        { name: file.name.replace(/\.(md|zip|pdf|docx)$/i, ''), type, folderId, origin: { input: 'import', name: file.name, sizeBytes: file.size, mime: file.type, storage: 'none' } },
        imported.markdown,
      )
      const questions = Array.isArray(imported.questions) ? imported.questions : (imported.questions as { questions?: unknown[] } | undefined)?.questions
      if (Array.isArray(questions) && questions.length) await library.setQuestions(meta.id, questions.map(question => storedFromRaw(question as never)))
      ui.close()
      ui.toast(`"${meta.name}" importado`)
      navigate(paths.file(meta.id))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu para importar.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Importar" size="narrow" onClose={ui.close}>
      <div className="db">
        <label className="drop" htmlFor="imp-file" onDragOver={event => event.preventDefault()} onDrop={event => (event.preventDefault(), void importFile(event.dataTransfer.files[0] ?? null))}>
          <Icon name="upload" />
          <b>{busy ? 'Importando…' : 'Escolher arquivo'}</b>
          <span style={{ fontSize: 12.5 }}>.md, .zip exportado pelo app, PDF ou docx</span>
        </label>
        <input type="file" id="imp-file" hidden accept=".md,.zip,.pdf,.docx" onChange={event => void importFile(event.target.files?.[0] ?? null)} />
        <div className="field">
          <span className="lab">Pasta</span>
          <FolderField value={folderId} onChange={setFolderId} />
        </div>
        {error && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function CourseProposalDialog() {
  const proposal = useJobsStore(state => state.proposals[0])
  const { acceptCourse, declineCourse } = useJobsStore()
  // with a note or an entrada open, she stays there and a notice offers what was made
  const goToNew = useGoToNew()
  const [folderId, setFolderId] = useState<string | null>(proposal?.request.folderId ?? null)
  // which button was clicked, while the folders and notes are being made (many writes): it says what it is doing
  const [busy, setBusy] = useState<'one' | 'course' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!proposal) return null
  const analysis: CourseAnalysis = proposal.analysis
  return (
    <Dialog
      title="Isso rende uma pasta com aulas"
      footer={
        <>
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={async () => {
              setBusy('one')
              setError(null)
              try {
                // the proposal leaves the list (and this window the screen) at once: the window that holds the app stays until the end
                const id = await blocking('Criando a aula…', () => declineCourse(proposal))
                setBusy(null)
                goToNew(paths.file(id), 'Gerando a Aula')
              } catch (failure) {
                setBusy(null)
                setError(failure instanceof Error ? failure.message : 'Não deu para criar a aula.')
                if (!useJobsStore.getState().proposals.includes(proposal)) blockingFailure('Criando a aula…', failure)
              }
            }}
          >
            {busy === 'one' && <Icon name="sync" className="spinning" />}
            {busy === 'one' ? 'Criando a aula…' : 'Não, uma aula só'}
          </button>
          <button
            className="btn primary"
            disabled={Boolean(busy)}
            onClick={async () => {
              setBusy('course')
              setError(null)
              try {
                // the proposal leaves the list (and this window the screen) at once: the window that holds the app stays until the end
                const id = await blocking('Criando as aulas…', () => acceptCourse(proposal, folderId))
                setBusy(null)
                goToNew(paths.folder(id), 'A pasta com as aulas foi criada')
              } catch (failure) {
                setBusy(null)
                setError(failure instanceof Error ? failure.message : 'Não deu para criar as aulas.')
                if (!useJobsStore.getState().proposals.includes(proposal)) blockingFailure('Criando as aulas…', failure)
              }
            }}
          >
            {busy === 'course' && <Icon name="sync" className="spinning" />}
            {busy === 'course' ? 'Criando as aulas…' : 'Criar a pasta com as aulas'}
          </button>
        </>
      }
    >
      <div className="db">
        <span className="muted">
          “{analysis.name}” tem {analysis.modules.length} módulo(s) e {analysis.lessonCount} aula(s). {analysis.description}
        </span>
        <span className="faint" style={{ fontSize: 12.5 }}>
          O primeiro módulo é escrito agora; as outras aulas ficam guardadas para gerar quando você quiser.
        </span>
        <div className="field">
          <span className="lab">Onde criar a pasta</span>
          <FolderField value={folderId} onChange={setFolderId} title="Onde criar a pasta" />
        </div>
        {error && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function StorageLimitDialog() {
  const ui = useUiStore()
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const [limit, setLimit] = useState(DEFAULT_STORAGE_LIMIT_BYTES)
  const save = async () => {
    // the window holds the app until the limit is written; a failure stays in it with the reason, and this question stays open
    if (await working('Salvando o limite…', () => updateSettings({ storageLimitBytes: limit }))) ui.close()
  }
  return (
    <Dialog title="Quanto o app pode usar do seu Drive?" size="narrow" footer={<button className="btn primary" onClick={() => void save()}>Salvar</button>}>
      <div className="db">
        <span className="muted">O app confere antes de cada gravação e bloqueia o que passar do limite, dizendo quanto falta. Dá para mudar depois nas Configurações.</span>
        <div className="field">
          <label htmlFor="first-limit">Limite: {formatBytes(limit)}</label>
          <input type="range" id="first-limit" min={256 * 1024 * 1024} max={10240 * 1024 * 1024} step={256 * 1024 * 1024} value={limit} onChange={event => setLimit(Number(event.target.value))} />
        </div>
      </div>
    </Dialog>
  )
}

export function SendLocalDialog() {
  const ui = useUiStore()
  const account = useAccountStore(state => state.active())
  const ready = useLibraryStore(state => state.ready)
  // which button is working; the sending one counts on itself
  const [busy, setBusy] = useState<'send' | 'bring' | null>(null)
  const [sent, setSent] = useState<{ done: number; total: number } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (account.kind === 'local') ui.close()
  }, [account.kind])
  // not in the window that holds the app: a note on both sides can open the conflict window, which needs the person
  const send = async () => {
    setBusy('send')
    try {
      const count = await transferLocalToCurrent(({ done, total }) => setSent({ done, total }))
      setDone(`${count} item(ns) enviados para o seu Drive. O perfil Local continua com a cópia dele.`)
    } catch (error) {
      setDone(error instanceof Error ? error.message : 'O envio falhou.')
    } finally {
      setBusy(null)
      setSent(null)
    }
  }
  // T029: the profile becomes this account's Local, only in this browser, without sending anything
  const bring = async () => {
    setBusy('bring')
    try {
      const count = await blocking('Trazendo para esta conta…', blocker => bringLocalToAccount(blocker.progress))
      setDone(`${count} item(ns) agora estão no Local desta conta, só neste navegador. Nada foi enviado. Use “Sincronizar” quando quiser levar para o Drive.`)
    } catch (error) {
      setDone(error instanceof Error ? error.message : 'Não deu para trazer.')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog
      title="Enviar o que está neste navegador para o seu Drive?"
      size="narrow"
      footer={
        done ? (
          <button className="btn primary" onClick={ui.close}>
            Fechar
          </button>
        ) : (
          <>
            <button className="btn" onClick={ui.close} disabled={Boolean(busy)}>
              Manter no perfil sem login
            </button>
            <button className="btn" onClick={() => void bring()} disabled={Boolean(busy) || !ready}>
              {busy === 'bring' ? 'Trazendo…' : 'Trazer para esta conta, só neste navegador'}
            </button>
            <button className="btn primary" onClick={() => void send()} disabled={Boolean(busy) || !ready}>
              {busy === 'send' ? (sent ? `Enviando ${sent.done.toLocaleString('pt-BR')} de ${sent.total.toLocaleString('pt-BR')}…` : 'Enviando…') : 'Enviar para o Drive'}
            </button>
          </>
        )
      }
    >
      <div className="db">
        <span className="muted">{done ?? 'O perfil sem login tem arquivos. “Enviar para o Drive” copia tudo para o seu Google Drive; o que tiver o mesmo nome dos dois lados cai na janela de conflito. “Trazer para esta conta” copia tudo para o Local desta conta, sem enviar nada: fica só neste navegador. Em todos os casos o perfil sem login continua como está, no menu da conta.'}</span>
      </div>
    </Dialog>
  )
}
