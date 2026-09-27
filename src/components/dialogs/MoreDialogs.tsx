import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { CourseAnalysis } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { FolderPicker } from '@/components/dialogs/SimpleDialogs'
import { DEFAULT_STORAGE_LIMIT_BYTES } from '@/lib/defaults'
import { storedFromRaw } from '@/lib/exam'
import { importDocument } from '@/lib/imports'
import { paths } from '@/lib/paths'
import { transferLocalToCurrent } from '@/lib/storage/transfer'
import { useAccountStore } from '@/stores/account'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { dateTime, formatBytes } from '@/utils/format'

export function ExplainDialog({ fileId, excerpt }: { fileId: string; excerpt: string }) {
  const ui = useUiStore()
  const navigate = useNavigate()
  const explainSelection = useJobsStore(state => state.explainSelection)
  const [mode, setMode] = useState<'context' | 'concept'>('context')
  const [prompt, setPrompt] = useState('')
  const go = async () => {
    const id = await explainSelection(fileId, excerpt, prompt, mode)
    ui.close()
    navigate(paths.file(id))
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
          <button className="btn primary" onClick={() => void go()}>
            <Icon name="bulb" />
            Gerar explicação
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
    <Dialog title={`Ordem do curso · ${course.name}`} size="wide" onClose={ui.close} footer={<button className="btn primary" onClick={ui.close}>Pronto</button>}>
      <div className="db">
        <div className="field">
          <label htmlFor="course-desc">Descrição do curso</label>
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
                <button className="ibtn" disabled={!empty} title={empty ? 'Apagar o módulo' : 'Tire as aulas de dentro antes de apagar'} onClick={() => void library.deleteFolderForever(module.id)} aria-label="Apagar o módulo">
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
              await library.createFolder({ name: newModule.trim(), parentId: folderId, position: modules.length })
              setNewModule('')
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
          <FolderPicker value={folderId} onChange={setFolderId} />
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
  const navigate = useNavigate()
  const [folderId, setFolderId] = useState<string | null>(proposal?.request.folderId ?? null)
  const [busy, setBusy] = useState(false)
  if (!proposal) return null
  const analysis: CourseAnalysis = proposal.analysis
  return (
    <Dialog
      title="Isso rende um curso"
      footer={
        <>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const id = await declineCourse(proposal)
              setBusy(false)
              navigate(paths.file(id))
            }}
          >
            Não, uma aula só
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const id = await acceptCourse(proposal, folderId)
              setBusy(false)
              navigate(paths.folder(id))
            }}
          >
            Criar o curso
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
          <span className="lab">Onde criar o curso</span>
          <FolderPicker value={folderId} onChange={setFolderId} />
        </div>
      </div>
    </Dialog>
  )
}

export function StorageLimitDialog() {
  const ui = useUiStore()
  const updateSettings = useLibraryStore(state => state.updateSettings)
  const [limit, setLimit] = useState(DEFAULT_STORAGE_LIMIT_BYTES)
  const save = async () => {
    await updateSettings({ storageLimitBytes: limit })
    ui.close()
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
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (account.kind === 'local') ui.close()
  }, [account.kind])
  const send = async () => {
    setBusy(true)
    try {
      const count = await transferLocalToCurrent()
      setDone(`${count} item(ns) enviados para o seu Drive. O perfil Local continua com a cópia dele.`)
    } catch (error) {
      setDone(error instanceof Error ? error.message : 'O envio falhou.')
    } finally {
      setBusy(false)
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
            <button className="btn" onClick={ui.close} disabled={busy}>
              Manter só aqui
            </button>
            <button className="btn primary" onClick={() => void send()} disabled={busy || !ready}>
              {busy ? 'Enviando…' : 'Enviar'}
            </button>
          </>
        )
      }
    >
      <div className="db">
        <span className="muted">{done ?? 'O perfil Local tem arquivos. Enviar copia tudo para a pasta .sync-study-helper; o que tiver o mesmo nome dos dois lados cai na janela de conflito. Não enviar mantém tudo no perfil Local, que continua no menu da conta.'}</span>
      </div>
    </Dialog>
  )
}
