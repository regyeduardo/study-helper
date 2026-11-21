import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultIndex } from '@/lib/defaults'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { installFetch, openAiStream } from '@/test/ai/fake-provider'
import { type Deferred, deferred, jobsNow, running, settle, slowLibrary } from '@/test/feedback/slow'

// "Gerar" closes its window at once. Until the real job starts (models read, media opened, notes read),
// the person must already see a line saying the click worked.

const UID = 'openrouter::google/gemini-2.5-flash-lite'

let slow: ReturnType<typeof slowLibrary>
let release: () => void
let modelsRead: Deferred

const jobs = () => useJobsStore.getState()

function configure() {
  const index = defaultIndex()
  index.settings.aiConfig = { providers: [{ id: 'openrouter', type: 'openrouter', name: 'OpenRouter', key: 'k', base: '' }], models: [{ uid: UID, pid: 'openrouter', mid: 'google/gemini-2.5-flash-lite', name: 'Gemini' }], defaults: { estudo: UID, ata: UID, aula: UID }, steps: {} }
  useLibraryStore.setState({ index })
}

/** The model catalog takes a while to answer; when it does, the model does not hear audio. */
function slowCatalog() {
  modelsRead = deferred()
  useModelsStore.setState({
    live: {},
    probes: {},
    read: async () => {
      await modelsRead.promise
      const model = { id: 'google/gemini-2.5-flash-lite', name: 'Gemini', media: { texto: true, imagem: true, audio: false, video: false, pdf: null } }
      useModelsStore.setState({ live: { openrouter: { state: 'ok', token: 1, at: Date.now(), list: [model], byId: new Map([[model.id, model]]) } } })
    },
  })
}

async function videoEntry(): Promise<string> {
  const meta = await useLibraryStore.getState().createFile({ name: 'Reunião de kickoff', type: 'reading', role: 'entrada', status: 'ready', folderId: null, origin: { input: 'file', name: 'kickoff.mp4', mime: 'video/mp4', durationSeconds: 60, storage: 'none' } }, 'Regy [00:01]: oi')
  useLibraryStore.setState(state => ({ localMedia: [...state.localMedia, { storedName: 'kick', name: 'kickoff.mp4', mime: 'video/mp4', durationSeconds: 60, size: 4, createdAt: '', fileIds: [meta.id] }] }))
  return meta.id
}

beforeEach(() => {
  slow = slowLibrary()
  configure()
  slowCatalog()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Gerar uma nota a partir de outra: a linha "Preparando" aparece na hora', () => {
  it('Aula: o job abre antes de a lista de modelos responder, e vira o erro se o modelo não serve', async () => {
    const id = await videoEntry()
    const done = jobs().generateFromNote(id, 'lesson', null, 'home', '', 'video')

    // nothing has resolved yet: the person already has a line on screen
    expect(running()).toHaveLength(1)
    expect(running()[0]).toMatchObject({ kind: 'generation', title: 'Aula: Reunião de kickoff', fileId: id, message: 'Preparando' })

    modelsRead.resolve()
    expect(await done).toBeNull()
    // the same line turns into the failure: one job, not a vanished one and a new one
    expect(jobsNow()).toHaveLength(1)
    expect(jobsNow()[0]).toMatchObject({ status: 'error', message: 'A geração não começou.' })
    expect(jobsNow()[0].error).toMatch(/não ouve a mídia/)
  })

  it('Ata: o job abre antes de a lista de modelos responder; um segundo pedido não começa outra Ata', async () => {
    const id = await videoEntry()
    const first = jobs().generateAta(id, ['resumo'], undefined, undefined, 'home', undefined, undefined, 'video')

    expect(running()).toHaveLength(1)
    expect(running()[0]).toMatchObject({ title: 'Ata: Reunião de kickoff', fileId: id, message: 'Preparando' })

    await jobs().generateAta(id, ['resumo'], undefined, undefined, 'home', undefined, undefined, 'video')
    expect(jobsNow()).toHaveLength(1)

    modelsRead.resolve()
    await first
    expect(jobsNow()).toHaveLength(1)
    expect(jobsNow()[0]).toMatchObject({ status: 'error', message: 'A ata não saiu.' })
  })

  it('"Cancelar" na linha de preparo para de verdade: nada é criado depois', async () => {
    const id = await videoEntry()
    const filesBefore = useLibraryStore.getState().files.length
    const done = jobs().generateFromNote(id, 'lesson', null, 'home', '', 'video')
    jobs().cancel(running()[0].id)
    modelsRead.resolve()
    expect(await done).toBeNull()
    expect(jobsNow()).toHaveLength(1)
    expect(jobsNow()[0]).toMatchObject({ status: 'cancelled', message: 'Cancelado por você.' })
    expect(useLibraryStore.getState().files).toHaveLength(filesBefore)
  })

  it('nota de texto com a leitura lenta: "Preparando" desde o clique; ao começar a escrever fica só o job da escrita', async () => {
    // what the AI answers is not the point here: the writing job exists and the preparation line is gone
    installFetch(() => openAiStream('# Aula\n\nTexto da aula.'))
    const note = await useLibraryStore.getState().createFile({ name: 'Pauta', type: 'reading', status: 'ready', folderId: null }, 'Vamos lançar em maio.')
    // the note is not in memory: reading it is a trip to the Drive
    useLibraryStore.setState({ opened: {} })
    release = slow.hold()

    const done = jobs().generateFromNote(note.id, 'lesson')
    expect(running()).toHaveLength(1)
    expect(running()[0]).toMatchObject({ title: 'Aula: Pauta', message: 'Preparando' })

    release()
    const created = await done
    expect(created).toBeTruthy()
    // no "Preparando" left over: the writing job replaced it
    expect(jobsNow().filter(job => job.message === 'Preparando')).toHaveLength(0)
    expect(jobsNow().filter(job => job.title === 'Aula: Pauta')).toHaveLength(1)
    await settle()
    expect(useLibraryStore.getState().files.some(file => file.id === created)).toBe(true)
  })

  it('a leitura da nota falha: a linha vira o erro, não fica girando para sempre', async () => {
    const note = await useLibraryStore.getState().createFile({ name: 'Pauta', type: 'reading', status: 'ready', folderId: null }, 'Vamos lançar em maio.')
    useLibraryStore.setState({ opened: {} })
    slow.breakWith(new Error('Drive fora do ar'))
    const done = jobs().generateFromNote(note.id, 'lesson')
    expect(running()).toHaveLength(1)
    expect(await done).toBeNull()
    expect(running()).toHaveLength(0)
    expect(jobsNow()[0]).toMatchObject({ status: 'error', message: 'A geração não começou.', error: 'Drive fora do ar' })
  })
})
