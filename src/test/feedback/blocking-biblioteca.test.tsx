import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// the upload itself never runs here: the test holds it
vi.mock('@/lib/storage/source-storage', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/storage/source-storage')>()), saveToDrive: vi.fn() }))

import type { SourceMeta } from '@/types/domain'
import { CourseProposalDialog, OrderDialog } from '@/components/dialogs/MoreDialogs'
import { MoveDialog } from '@/components/dialogs/SimpleDialogs'
import { SaveToDrive } from '@/components/library/SaveToDrive'
import { SelectionBar } from '@/components/library/SelectionBar'
import { TrashList } from '@/components/library/TrashList'
import { DRAG_FILE, useFileActions } from '@/components/library/use-file-actions'
import { BlockingWindow } from '@/components/ui/BlockingWindow'
import { saveToDrive } from '@/lib/storage/source-storage'
import { useBlockingStore } from '@/stores/blocking'
import { type CourseProposal, useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { type Overlay, useUiStore } from '@/stores/ui'
import { deferred, fileNow, settle, slowLibrary, toastsNow } from '@/test/feedback/slow'

// Escolha F do dono (21/11/2026) na Biblioteca: o clique que espera o Drive trava o app na janela do meio, do clique até o fim,
// com "3 de 40" quando passa por vários itens, e o motivo quando falha.

const flush = () => act(async () => await Promise.resolve())
const shown = () => act(async () => vi.advanceTimersByTime(350))
const windowNamed = (name: string) => screen.getByRole('alertdialog', { name })
const noWindow = () => expect(screen.queryByRole('alertdialog')).toBeNull()
const store = () => useLibraryStore.getState()
const confirmOverlay = () => useUiStore.getState().overlay as Extract<Overlay, { kind: 'confirm' }>

let slow: ReturnType<typeof slowLibrary>

async function note(name: string, extra: object = {}) {
  return (await store().createFile({ name, type: 'class', status: 'ready', folderId: null, ...extra }, `# ${name}`)).id
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useBlockingStore.setState({ ops: [] })
  slow = slowLibrary()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Arrastar para outra pasta', () => {
  function DropOn({ folderId }: { folderId: string | null }) {
    const { dropTarget } = useFileActions()
    return <div data-testid="destino" {...dropTarget(folderId)} />
  }
  const carrying = (id: string) => ({ dataTransfer: { getData: (type: string) => (type === DRAG_FILE ? id : '') } })
  const open = (folderId: string) =>
    render(
      <MemoryRouter>
        <DropOn folderId={folderId} />
        <BlockingWindow />
      </MemoryRouter>,
    )

  it('três notas marcadas: a janela "Movendo 3 itens…" conta uma a uma e some no fim', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    const ids = [await note('Limites'), await note('Derivadas'), await note('Integrais')]
    useUiStore.setState({ selection: new Set(ids) })
    open(folder.id)
    const release = slow.hold()
    fireEvent.drop(screen.getByTestId('destino'), carrying(ids[0]))
    await flush()
    await shown()
    const window_ = windowNamed('Movendo 3 itens…')
    expect(window_).toHaveTextContent('0 de 3')
    expect(window_).toHaveTextContent('Limites')

    // the first write goes through; the next waits again
    let again!: () => void
    await act(async () => {
      release()
      again = slow.hold()
      await settle()
    })
    expect(windowNamed('Movendo 3 itens…')).toHaveTextContent('1 de 3')
    expect(windowNamed('Movendo 3 itens…')).toHaveTextContent('Derivadas')

    await act(async () => {
      again()
      await settle()
    })
    noWindow()
    for (const id of ids) expect(fileNow(id)?.folderId).toBe(folder.id)
    expect(toastsNow()).toContain('Movido para Cálculo')
  })

  it('o Drive falha: a nota volta para onde estava e o motivo aparece', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    const id = await note('Limites')
    open(folder.id)
    slow.breakWith(new Error('Drive fora do ar'))
    fireEvent.drop(screen.getByTestId('destino'), carrying(id))
    await act(async () => {
      await settle()
    })
    expect(useBlockingStore.getState().ops).toHaveLength(0)
    expect(fileNow(id)?.folderId).toBeNull()
    expect(toastsNow().join(' ')).toMatch(/Não deu para mover: Drive fora do ar/)
  })
})

describe('"Apagar" da seleção com uma nota que tem filhas', () => {
  const open = () =>
    render(
      <MemoryRouter>
        <SelectionBar />
        <BlockingWindow />
      </MemoryRouter>,
    )

  it('as pastas marcadas vão para a lixeira dentro da janela; só depois abre a pergunta da família', async () => {
    const mother = await note('Limites')
    await note('Resumo', { parentFileId: mother })
    const folder = await store().createFolder({ name: 'Velha' })
    useUiStore.setState({ selection: new Set([mother, folder.id]) })
    open()
    const release = slow.hold()
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: 'Apagar' }))
    await flush()
    await shown()
    const window_ = windowNamed('Apagando 1 pasta…')
    expect(window_).toHaveTextContent('0 de 1')
    expect(window_).toHaveTextContent('Velha')
    expect(useUiStore.getState().overlay).toBeNull()

    await act(async () => {
      release()
      await settle()
    })
    noWindow()
    expect(store().folders.find(item => item.id === folder.id)?.deletedAt).toBeTruthy()
    expect(useUiStore.getState().overlay).toMatchObject({ kind: 'delete-family', fileId: mother })
  })

  it('não deu para apagar a pasta: a janela diz o motivo e a pergunta da família não abre', async () => {
    const mother = await note('Limites')
    await note('Resumo', { parentFileId: mother })
    const folder = await store().createFolder({ name: 'Velha' })
    useUiStore.setState({ selection: new Set([mother, folder.id]) })
    open()
    slow.breakWith(new Error('Drive fora do ar'))
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Seleção' })).getByRole('button', { name: 'Apagar' }))
    await act(async () => {
      await settle()
    })
    expect(windowNamed('Apagando 1 pasta…')).toHaveTextContent('Drive fora do ar')
    expect(useUiStore.getState().overlay).toBeNull()
  })
})

describe('"Mover" (janela Mover para…)', () => {
  const open = (ids: string[]) => {
    useUiStore.setState({ overlay: { kind: 'move', fileIds: ids, folderIds: [] } })
    render(
      <MemoryRouter>
        <MoveDialog fileIds={ids} folderIds={[]} />
        <BlockingWindow />
      </MemoryRouter>,
    )
  }
  const moveTo = async (name: RegExp) => {
    fireEvent.click(await screen.findByRole('treeitem', { name }))
    fireEvent.click(screen.getByRole('button', { name: 'Mover' }))
    await flush()
    await shown()
  }

  it('a janela "Movendo 3 itens…" diz para onde e conta quantos já foram', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    const ids = [await note('Limites'), await note('Derivadas'), await note('Integrais')]
    open(ids)
    const release = slow.hold()
    await moveTo(/Cálculo/)
    expect(useUiStore.getState().overlay).toBeNull()
    const window_ = windowNamed('Movendo 3 itens…')
    expect(window_).toHaveTextContent('Levando para Cálculo')
    expect(window_).toHaveTextContent('0 de 3')
    expect(window_).toHaveTextContent('Limites')

    await act(async () => {
      release()
      await settle()
    })
    noWindow()
    for (const id of ids) expect(fileNow(id)?.folderId).toBe(folder.id)
    expect(toastsNow()).toContain('Movido para Cálculo')
  })

  it('"Cancelar" para depois do item da vez: o que já foi fica na pasta nova, o resto fica onde estava', async () => {
    const folder = await store().createFolder({ name: 'Cálculo' })
    const ids = [await note('Limites'), await note('Derivadas'), await note('Integrais')]
    open(ids)
    const release = slow.hold()
    await moveTo(/Cálculo/)
    fireEvent.click(within(windowNamed('Movendo 3 itens…')).getByRole('button', { name: 'Cancelar' }))
    await act(async () => {
      release()
      await settle()
    })
    noWindow()
    expect(fileNow(ids[0])?.folderId).toBe(folder.id)
    expect(fileNow(ids[1])?.folderId).toBeNull()
    expect(fileNow(ids[2])?.folderId).toBeNull()
    expect(toastsNow()).toContain('1 de 3 movidos para Cálculo')
  })
})

describe('"Esvaziar a lixeira"', () => {
  const open = async () => {
    const ids = [await note('Limites'), await note('Derivadas'), await note('Integrais')]
    await store().trashFiles(ids)
    render(
      <MemoryRouter>
        <TrashList />
        <BlockingWindow />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Esvaziar a lixeira' }))
    return ids
  }

  it('a janela conta "1 de 3" enquanto apaga de vez, um por um, e some no fim', async () => {
    const ids = await open()
    const release = slow.hold()
    void confirmOverlay().onConfirm()
    await flush()
    await shown()
    expect(windowNamed('Esvaziando a lixeira…')).toHaveTextContent('0 de 3')

    let again!: () => void
    await act(async () => {
      release()
      again = slow.hold()
      await settle()
    })
    expect(windowNamed('Esvaziando a lixeira…')).toHaveTextContent('1 de 3')

    await act(async () => {
      again()
      await settle()
    })
    noWindow()
    for (const id of ids) expect(fileNow(id)).toBeUndefined()
    expect(toastsNow()).toContain('Lixeira vazia')
  })

  it('"Cancelar" para entre um item e outro; o que falta continua na lixeira', async () => {
    const ids = await open()
    const release = slow.hold()
    void confirmOverlay().onConfirm()
    await flush()
    await shown()
    fireEvent.click(within(windowNamed('Esvaziando a lixeira…')).getByRole('button', { name: 'Cancelar' }))
    await act(async () => {
      release()
      await settle()
    })
    noWindow()
    expect(ids.filter(id => fileNow(id))).toHaveLength(2)
    expect(toastsNow()).toContain('1 de 3 apagados de vez')
  })
})

describe('"Salvar no meu Drive"', () => {
  const RECORDED: SourceMeta = { input: 'recording', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 60, sizeBytes: 1024, storage: 'none' }

  it('a janela "Salvando no Drive…" fica do clique até o envio acabar', async () => {
    const id = await note('Aula 3', { origin: RECORDED })
    Object.assign(slow.repo, { kind: 'drive' })
    useLibraryStore.setState({ localMedia: [{ storedName: 'aula3.webm', name: 'aula3.webm', mime: 'audio/webm', durationSeconds: 60, size: 1024, createdAt: '2026-11-21T10:00:00.000Z', fileIds: [id] }] })
    const upload = deferred()
    vi.mocked(saveToDrive).mockReturnValueOnce(upload.promise)
    render(
      <>
        <SaveToDrive fileId={id} />
        <BlockingWindow />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Salvar no meu Drive/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: /^Salvar no meu Drive/ })).getByRole('button', { name: 'Salvar no meu Drive' }))
    await flush()
    await shown()
    expect(windowNamed('Salvando no Drive…')).toBeInTheDocument()

    await act(async () => {
      upload.resolve()
      await settle()
    })
    noWindow()
    expect(toastsNow()).toContain('Salvo no seu Drive. Agora ele está disponível em qualquer aparelho.')
  })
})

describe('Ordem das aulas: módulos', () => {
  const open = (folderId: string) =>
    render(
      <MemoryRouter>
        <OrderDialog folderId={folderId} />
        <BlockingWindow />
      </MemoryRouter>,
    )

  it('"Novo módulo": a janela "Criando o módulo…" até a pasta existir, e só um módulo sai', async () => {
    const course = await store().createFolder({ name: 'Cálculo', isCourse: true })
    open(course.id)
    fireEvent.change(screen.getByLabelText('Nome do novo módulo'), { target: { value: 'Limites' } })
    const release = slow.hold()
    fireEvent.click(screen.getByRole('button', { name: 'Novo módulo' }))
    await flush()
    await shown()
    expect(windowNamed('Criando o módulo…')).toBeInTheDocument()

    await act(async () => {
      release()
      await settle()
    })
    noWindow()
    expect(store().folders.filter(folder => folder.name === 'Limites' && folder.parentId === course.id)).toHaveLength(1)
    expect(screen.getByLabelText('Nome do novo módulo')).toHaveValue('')
  })

  it('"Apagar o módulo": a janela "Apagando o módulo…" até ele sair; se falhar, o motivo fica na janela', async () => {
    const course = await store().createFolder({ name: 'Cálculo', isCourse: true })
    const module = await store().createFolder({ name: 'Limites', parentId: course.id })
    const removing = deferred()
    Object.assign(slow.repo, { removeFolder: vi.fn(() => removing.promise) })
    open(course.id)
    fireEvent.click(screen.getByRole('button', { name: 'Apagar o módulo' }))
    await flush()
    await shown()
    expect(windowNamed('Apagando o módulo…')).toBeInTheDocument()
    expect(store().folders.some(folder => folder.id === module.id)).toBe(true)

    await act(async () => {
      removing.reject(new Error('Drive fora do ar'))
      await settle()
    })
    expect(windowNamed('Apagando o módulo…')).toHaveTextContent('Drive fora do ar')
    fireEvent.click(within(windowNamed('Apagando o módulo…')).getByRole('button', { name: 'Fechar' }))
    noWindow()
  })
})

describe('Gerar: proposta de curso', () => {
  const proposal = {
    analysis: { isCourse: true, name: 'Cálculo', description: 'Limites e derivadas.', lessonCount: 3, modules: [{ title: 'Limites', lessons: [] }] },
    request: { agent: 'lesson', input: { kind: 'topic', topic: 'Cálculo' }, name: 'Cálculo', description: '', folderId: null, prompt: '', storage: 'none', litterboxTime: '72h' },
    resolved: { content: 'x', title: 'Cálculo', description: '', origin: { input: 'topic', name: 'Cálculo', storage: 'none' }, transcription: null },
  } as unknown as CourseProposal
  // as the real store does: the proposal leaves the list on the first line, and the window of the proposal goes with it
  const leaves = (work: Promise<string>) => () => {
    useJobsStore.setState({ proposals: [] })
    return work
  }
  const open = () =>
    render(
      <MemoryRouter>
        <CourseProposalDialog />
        <BlockingWindow />
      </MemoryRouter>,
    )

  it('"Criar a pasta com as aulas": a janela "Criando as aulas…" fica até tudo ser criado, mesmo com a proposta fora da tela', async () => {
    const creating = deferred<string>()
    useJobsStore.setState({ proposals: [proposal], acceptCourse: leaves(creating.promise) })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Criar a pasta com as aulas' }))
    await flush()
    await shown()
    expect(windowNamed('Criando as aulas…')).toBeInTheDocument()

    await act(async () => {
      creating.resolve('pasta-1')
      await settle()
    })
    noWindow()
  })

  it('"Não, uma aula só": a janela "Criando a aula…"', async () => {
    const creating = deferred<string>()
    useJobsStore.setState({ proposals: [proposal], declineCourse: leaves(creating.promise) })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Não, uma aula só' }))
    await flush()
    await shown()
    expect(windowNamed('Criando a aula…')).toBeInTheDocument()
    await act(async () => {
      creating.resolve('aula-1')
      await settle()
    })
    noWindow()
  })

  it('não deu certo com a proposta já fora da tela: o motivo fica na janela', async () => {
    const creating = deferred<string>()
    useJobsStore.setState({ proposals: [proposal], acceptCourse: leaves(creating.promise) })
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Criar a pasta com as aulas' }))
    await act(async () => {
      creating.reject(new Error('Sem espaço no Drive'))
      await settle()
    })
    expect(windowNamed('Criando as aulas…')).toHaveTextContent('Sem espaço no Drive')
  })
})
