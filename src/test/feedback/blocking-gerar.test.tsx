import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { GenerateDialog } from '@/components/dialogs/GenerateDialog'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { defaultIndex } from '@/lib/defaults'
import { useBlockingStore } from '@/stores/blocking'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { installFetch, jsonResponse } from '@/test/ai/fake-provider'
import { deferred, running, settle, slowLibrary } from '@/test/feedback/slow'
import type { FileMeta } from '@/types/domain'

// Escolha F do dono: do clique até o job da geração abrir (gravar a escolha na nota, ler a nota, criar a nota no Drive) o app fica
// travado na janela. A geração em si continua em Tarefas e ao vivo na nota: a janela fecha quando o job abre.

const UID = 'openrouter::google/gemini-2.5-flash-lite'

let slow: ReturnType<typeof slowLibrary>

const jobs = () => useJobsStore.getState()
const ops = () => useBlockingStore.getState().ops
// the store's own actions, back before each test (one test puts a slow one in its place)
const actions = useJobsStore.getState()
const flush = () => act(async () => await settle())

function configure() {
  const index = defaultIndex()
  index.settings.aiConfig = { providers: [{ id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }], models: [{ uid: UID, pid: 'openrouter', mid: 'google/gemini-2.5-flash-lite', name: 'Gemini' }], defaults: { estudo: UID, ata: UID, aula: UID, explicacao: UID }, steps: {} }
  useLibraryStore.setState({ index })
}

/** What was running in Tarefas at the moment the window closed: the job must already be there, so the note never shows a free "Tentar de novo". */
function atClose() {
  const seen: (string | null)[][] = []
  const stop = useBlockingStore.subscribe((state, before) => {
    if (before.ops.length && !state.ops.length) seen.push(running().map(job => job.fileId))
  })
  return { seen, stop }
}

/** The app as the person has it: a note with its "Tentar de novo", and the window over it. */
function app() {
  return render(
    <>
      <main>
        <button>Tentar de novo</button>
      </main>
      <BlockingWindow />
    </>,
  )
}

async function course(names: string[]): Promise<FileMeta[]> {
  const folder = await useLibraryStore.getState().createFolder({ name: 'Cálculo', parentId: null, isCourse: true })
  const lessons: FileMeta[] = []
  for (const [position, name] of names.entries()) lessons.push(await useLibraryStore.getState().createFile({ name, type: 'class', folderId: folder.id, description: '', pendingExcerpt: `# ${name}`, status: 'pending', position }, ''))
  return lessons
}

beforeEach(() => {
  useJobsStore.setState(actions)
  slow = slowLibrary()
  configure()
  useBlockingStore.setState({ ops: [] })
  // the AI never answers: the generation stays running in Tarefas, which is all these tests look at
  installFetch(() => new Promise<Response>(() => undefined))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Gerar: a janela cobre o preparo e fecha quando o job abre', () => {
  it('"Gerar" de uma aula do curso (e "Tentar de novo"): trava do clique até o job abrir; enquanto isso o app não recebe clique', async () => {
    const [lesson] = await course(['Limites'])
    const { container } = app()
    const closed = atClose()
    const release = slow.hold()

    const done = jobs().generatePending(lesson.id, null, '')
    await flush()
    // the choice is still being written to the note: no job yet, the window holds the app
    expect(ops()).toMatchObject([{ title: 'Aula: Limites', phase: 'Preparando' }])
    expect(running()).toHaveLength(0)
    expect(container).toHaveAttribute('inert')

    release()
    await flush()
    expect(ops()).toHaveLength(0)
    expect(closed.seen).toEqual([[lesson.id]])
    expect(container).not.toHaveAttribute('inert')
    closed.stop()
    void done
  })

  it('"Gerar as aulas que faltam…": uma janela só, contando "Preparando as aulas 3 de 3", e fecha com as três em Tarefas', async () => {
    const lessons = await course(['Limites', 'Derivadas', 'Integrais'])
    const folderId = lessons[0].folderId!
    const closed = atClose()
    const counts: number[] = []
    const watch = useBlockingStore.subscribe(state => state.ops[0]?.done !== undefined && counts.at(-1) !== state.ops[0].done && counts.push(state.ops[0].done!))
    const release = slow.hold()

    void jobs().generateRemaining(folderId, null, '')
    await flush()
    expect(ops()).toHaveLength(1)
    expect(ops()[0]).toMatchObject({ title: 'Gerando as aulas que faltam', phase: 'Preparando as aulas', total: 3 })
    expect(running()).toHaveLength(0)

    release()
    await flush()
    expect(counts).toEqual([1, 2, 3])
    expect(ops()).toHaveLength(0)
    expect(closed.seen).toHaveLength(1)
    expect(new Set(closed.seen[0])).toEqual(new Set(lessons.map(lesson => lesson.id)))
    watch()
    closed.stop()
  })

  it('"Refazer a Ata": trava enquanto a nota é lida e a escolha gravada, e fecha com a Ata em Tarefas', async () => {
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião de kickoff', type: 'audio', status: 'ready', folderId: null, origin: { input: 'recording', name: 'kickoff.webm', mime: 'audio/webm', durationSeconds: 60, storage: 'none' } }, '')
    const opened = useLibraryStore.getState().opened[meta.id]
    useLibraryStore.setState(state => ({ opened: { ...state.opened, [meta.id]: { ...opened, sidecar: { ...opened.sidecar, recording: { blocks: [{ speaker: 'mic', start: 0, end: 3, text: 'Vamos lançar em maio.' }], speakers: [], marks: [] } } } } }))
    const closed = atClose()
    const release = slow.hold()

    void jobs().generateSecondTab(meta.id, 'meeting', null, '')
    await flush()
    expect(ops()).toMatchObject([{ title: 'Ata: Reunião de kickoff', phase: 'Preparando' }])
    expect(running()).toHaveLength(0)

    release()
    await flush()
    expect(ops()).toHaveLength(0)
    expect(closed.seen).toEqual([[meta.id]])
    closed.stop()
  })

  it('"Gerar a partir disto" de um trecho: trava enquanto a nota nova é criada no Drive, e fecha com ela em Tarefas', async () => {
    const note = await useLibraryStore.getState().createFile({ name: 'Pauta', type: 'reading', status: 'ready', folderId: null }, 'Limites laterais existem quando os dois lados concordam.')
    const closed = atClose()
    const release = slow.hold()

    const done = jobs().generateFromSelection(note.id, 'Limites laterais existem quando os dois lados concordam.', 'lesson')
    await flush()
    expect(ops()).toMatchObject([{ title: 'Aula: Limites laterais existem quando os dois lados concordam.', phase: 'Preparando' }])
    expect(running()).toHaveLength(0)

    release()
    const id = await done
    await flush()
    expect(ops()).toHaveLength(0)
    expect(closed.seen).toEqual([[id]])
    closed.stop()
  })

  it('"Gerar a partir disto" de um link do YouTube: trava enquanto lê o título e cria a entrada; fecha quando a linha "Preparando" abre', async () => {
    const note = await useLibraryStore.getState().createFile({ name: 'Pauta', type: 'reading', status: 'ready', folderId: null }, 'veja https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    const title = deferred<Response>()
    installFetch(request => (request.url.includes('oembed') ? title.promise : new Promise<Response>(() => undefined)))
    const closed = atClose()

    void jobs().generateFromSelection(note.id, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'lesson')
    await flush()
    expect(ops()).toMatchObject([{ title: 'Aula: https://www.youtube.com/watch?v=dQw4w9WgXcQ', phase: 'Lendo o título do vídeo' }])
    expect(running()).toHaveLength(0)

    await act(async () => {
      title.resolve(jsonResponse({ title: 'Limites em 10 minutos' }))
      await settle()
    })
    expect(ops()).toHaveLength(0)
    const entry = useLibraryStore.getState().files.find(file => file.name === 'Limites em 10 minutos')!
    // the "Preparando" line of the note born of the video was already there when the window closed
    expect(closed.seen).toEqual([[entry.id]])
    expect(running()[0]).toMatchObject({ title: 'Aula: Limites em 10 minutos' })
    closed.stop()
  })

  it('"Gerar de novo" de uma Explicação: trava até a explicação existir e o job abrir', async () => {
    const note = await useLibraryStore.getState().createFile({ name: 'Pauta', type: 'reading', status: 'ready', folderId: null }, 'Limites laterais.')
    const before = await useLibraryStore.getState().createFile({ name: 'Explicação: Limites laterais', type: 'explanation', status: 'ready', folderId: null, parentFileId: note.id, sourceExcerpt: 'Limites laterais.' }, 'Texto.')
    const explaining = deferred<string>()
    let calls = 0
    useJobsStore.setState({
      explainSelection: () => {
        calls++
        return explaining.promise
      },
    })
    render(
      <MemoryRouter>
        <GenerateDialog fileId={note.id} agent="explanation" again={before.id} />
        <BlockingWindow />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    await flush()
    expect(calls).toBe(1)
    expect(ops()).toMatchObject([{ title: 'Explicação: Pauta', phase: 'Preparando' }])

    await act(async () => {
      explaining.resolve(before.id)
      await settle()
    })
    expect(ops()).toHaveLength(0)
  })
})
