import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// "Detalhes" of a note shows where it came from (a link, a text, a topic) and "Guardar como nota": the entrada is made as Novo conteúdo
// made it before ("Só o registro"), the note becomes its child, and it shows in Entradas and in "O que nasceu daqui".

import type { FileMeta, NoteSource, SourceMeta } from '@/types/domain'
import { EntryList } from '@/components/library/EntryList'
import { DocumentHead } from '@/components/reader/DocumentArticle'
import { EntryPage } from '@/components/reader/EntryPage'
import { newFileMeta, newFolderMeta } from '@/lib/defaults'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { entradas, fileOf, memoryLibrary, PAGE_TITLE, PAGE_URL } from '@/test/source-meta/fixture'

const AT = '2026-11-14T10:00:00.000Z'
const STAMP = { at: AT, deviceId: 'd1', deviceName: 'Notebook' }
const LINK: NoteSource = { kind: 'link', url: PAGE_URL, title: PAGE_TITLE, at: AT }
const PASTED = 'Fotossíntese\n\nA planta usa luz para fazer glicose.'
const TEXT: NoteSource = { kind: 'text', text: PASTED, title: 'Fotossíntese', at: AT }
const TOPIC: NoteSource = { kind: 'topic', text: 'Juros compostos', at: AT }

const ORIGIN: Record<NoteSource['kind'], SourceMeta> = {
  link: { input: 'url', name: PAGE_TITLE, url: PAGE_URL, storage: 'none' },
  text: { input: 'text', name: 'texto colado', sizeBytes: new Blob([PASTED]).size, mime: 'text/plain', storage: 'none' },
  topic: { input: 'topic', name: 'Juros compostos', storage: 'none' },
}

function note(source: NoteSource, fields: Partial<FileMeta> = {}): FileMeta {
  return newFileMeta({ id: 'aula', name: 'Aula de fotossíntese', type: 'class', status: 'ready', folderId: 'biologia', origin: ORIGIN[source.kind], source, created: STAMP, updated: STAMP, ...fields })
}

const turn = (id = 'aula') => useJobsStore.getState().turnIntoEntry(id)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('"Guardar como nota" faz a entrada como antes', () => {
  it('de um link: entrada "Só o registro" com o link, na mesma pasta, e a nota vira filha dela', async () => {
    memoryLibrary({ files: [note(LINK)] })
    const id = await turn()
    const [entry] = entradas()
    expect(id).toBe(entry.id)
    expect(entry).toMatchObject({ kept: 'registro', type: 'link', name: PAGE_TITLE, folderId: 'biologia', parentFileId: null, status: 'ready', origin: ORIGIN.link })
    expect(fileOf('aula')).toMatchObject({ parentFileId: entry.id, source: LINK })
  })

  it('de um texto: a entrada guarda o texto, com o nome da primeira linha', async () => {
    const library = memoryLibrary({ files: [note(TEXT)] })
    const id = await turn()
    expect(fileOf(id!)).toMatchObject({ kept: 'registro', name: 'Fotossíntese', origin: { input: 'text', mime: 'text/plain' } })
    expect(library.contents.get(id!)).toBe(PASTED)
    expect(fileOf('aula').parentFileId).toBe(id)
  })

  it('de um tema: a entrada é o tema', async () => {
    memoryLibrary({ files: [note(TOPIC, { type: 'explanation' })] })
    const id = await turn()
    expect(fileOf(id!)).toMatchObject({ name: 'Juros compostos', origin: { input: 'topic', name: 'Juros compostos' } })
  })

  it('clicar de novo não faz outra entrada', async () => {
    memoryLibrary({ files: [note(LINK)] })
    const first = await turn()
    const second = await turn()
    expect(second).toBe(first)
    expect(entradas()).toHaveLength(1)
  })

  it('já havendo a entrada do mesmo link, a nota vai para ela', async () => {
    const old = newFileMeta({ id: 'antiga', name: PAGE_TITLE, role: 'entrada', kept: 'registro', type: 'reading', origin: ORIGIN.link, created: STAMP, updated: STAMP })
    memoryLibrary({ files: [old, note(LINK)] })
    expect(await turn()).toBe('antiga')
    expect(entradas()).toHaveLength(1)
    expect(fileOf('aula').parentFileId).toBe('antiga')
  })

  it('uma nota que nasceu de outra leva a entrada para dentro da mãe', async () => {
    const mother = newFileMeta({ id: 'mae', name: 'Botânica', type: 'class', status: 'ready', folderId: 'biologia', created: STAMP, updated: STAMP })
    memoryLibrary({ files: [mother, note(LINK, { parentFileId: 'mae' })] })
    const id = await turn()
    expect(fileOf(id!).parentFileId).toBe('mae')
    expect(fileOf('aula').parentFileId).toBe(id)
  })
})

function head(meta: FileMeta) {
  return render(
    <MemoryRouter initialEntries={[paths.file(meta.id)]}>
      <Routes>
        <Route path="/arquivo/:fileId" element={<DocumentHead meta={meta} onInfo={() => undefined} />} />
        <Route path="/entrada/:fileId" element={<div>página da entrada</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

/** The head of the note as the store has it now. */
function Head({ id }: { id: string }) {
  const meta = useLibraryStore(state => state.files.find(file => file.id === id))
  return meta ? <DocumentHead meta={meta} onInfo={() => undefined} /> : null
}

const details = () => fireEvent.click(screen.getByRole('button', { name: /Detalhes/ }))

describe('em "Detalhes", de onde veio', () => {
  beforeEach(() => {
    memoryLibrary({ files: [note(LINK)] })
  })

  it('um link aparece como "De onde veio", clicável, com "Guardar como nota"', () => {
    head(note(LINK))
    details()
    expect(screen.getByText('De onde veio')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: PAGE_TITLE })
    expect(link).toHaveAttribute('href', PAGE_URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByRole('button', { name: 'Guardar como nota' })).toBeInTheDocument()
    expect(screen.queryByText('Origem')).not.toBeInTheDocument()
  })

  it('um texto aparece como "Pedido", e um tema como "Tema"', () => {
    const { unmount } = head(note(TEXT))
    details()
    expect(screen.getByText('Pedido')).toBeInTheDocument()
    expect(screen.getByText(/A planta usa luz para fazer glicose/)).toBeInTheDocument()
    unmount()
    head(note(TOPIC))
    details()
    expect(screen.getByText('Tema')).toBeInTheDocument()
    expect(screen.getByText('Juros compostos')).toBeInTheDocument()
  })

  it('"Guardar como nota" faz a entrada e o botão vira "Ver a nota da fonte", que abre a página dela', async () => {
    render(
      <MemoryRouter initialEntries={[paths.file('aula')]}>
        <Routes>
          <Route path="/arquivo/:fileId" element={<Head id="aula" />} />
          <Route path="/entrada/:fileId" element={<div>página da entrada</div>} />
        </Routes>
      </MemoryRouter>,
    )
    details()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar como nota' }))
    const see = await screen.findByRole('button', { name: 'Ver a nota da fonte' })
    expect(entradas()).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Guardar como nota' })).not.toBeInTheDocument()
    fireEvent.click(see)
    expect(await screen.findByText('página da entrada')).toBeInTheDocument()
  })

  it('uma nota sem fonte guardada continua mostrando a Origem, sem "Guardar como nota"', () => {
    head(newFileMeta({ id: 'velha', name: 'Velha', type: 'class', origin: ORIGIN.link, created: STAMP, updated: STAMP }))
    details()
    expect(screen.getByText('Origem')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Guardar como nota' })).not.toBeInTheDocument()
  })
})

describe('a entrada nova aparece como as outras', () => {
  it('é nota de Link (não Gravação) e, na página dela, tem a nota em "O que nasceu daqui"', async () => {
    memoryLibrary({ files: [note(LINK)], folders: [newFolderMeta({ id: 'biologia', name: 'Biologia' })] })
    const id = (await turn())!
    const list = render(
      <MemoryRouter>
        <EntryList />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Nenhuma gravação ainda')).toBeInTheDocument()
    expect(fileOf(id)).toMatchObject({ type: 'link' })
    list.unmount()
    render(
      <MemoryRouter initialEntries={[paths.entry(id)]}>
        <EntryPage fileId={id} />
      </MemoryRouter>,
    )
    const family = await screen.findByRole('region', { name: 'O que nasceu daqui' })
    await waitFor(() => expect(within(family).getByRole('link', { name: /Aula de fotossíntese/ })).toBeInTheDocument())
  })
})
