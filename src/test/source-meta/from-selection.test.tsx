import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// "Gerar a partir disto": a link or a passage selected in a note. The new note is a child of the note and keeps what was selected
// as its source; a YouTube link becomes an entrada inside the note, and the new note is born of it.

import type { FileMeta } from '@/types/domain'
import { FromSelectionDialog } from '@/components/dialogs/FromSelectionDialog'
import { DocumentBody } from '@/components/reader/DocumentArticle'
import { newFileMeta } from '@/lib/defaults'
import { linkIn } from '@/lib/note-source'
import { paths } from '@/lib/paths'
import { useJobsStore } from '@/stores/jobs'
import { useUiStore } from '@/stores/ui'
import { entradas, fileOf, files, memoryLibrary, PAGE_TITLE, PAGE_URL, ready, SAID, VIDEO_TITLE, YOUTUBE_URL } from '@/test/source-meta/fixture'

const STAMP = { at: '2026-11-14T10:00:00.000Z', deviceId: 'd1', deviceName: 'Notebook' }
const PASSAGE = 'Se os laterais diferem, o limite não existe.'
const BODY = `# Limites\n\n${PASSAGE} Veja ${PAGE_URL} e ${YOUTUBE_URL}.`

// the window's test puts a fake in the store: the real one comes back after each test
const realGenerate = useJobsStore.getState().generateFromSelection

const mother = (): FileMeta => newFileMeta({ id: 'mae', name: 'Limites', type: 'class', status: 'ready', folderId: 'calculo', created: STAMP, updated: STAMP })

afterEach(() => {
  useJobsStore.setState({ generateFromSelection: realGenerate })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('o que é um link selecionado', () => {
  it('só um endereço, sem pontuação em volta', () => {
    expect(linkIn(` ${PAGE_URL}. `)).toBe(PAGE_URL)
    expect(linkIn(`(${YOUTUBE_URL})`)).toBe(YOUTUBE_URL)
    expect(linkIn(PASSAGE)).toBeNull()
    expect(linkIn(`veja ${PAGE_URL}`)).toBeNull()
  })
})

const rect = { left: 40, top: 300, width: 200, height: 22, right: 240, bottom: 322, x: 40, y: 300, toJSON: () => ({}) } as DOMRect

async function selecting(text: string) {
  memoryLibrary({ files: [mother()], contents: { mae: BODY } })
  render(
    <MemoryRouter initialEntries={[paths.file('mae')]}>
      <DocumentBody fileId="mae" />
    </MemoryRouter>,
  )
  let root: ShadowRoot | null = null
  await waitFor(() => {
    root = document.querySelector('[data-testid="github-viewer"]')?.shadowRoot ?? null
    expect(root?.textContent).toContain('laterais')
  })
  vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => text, rangeCount: 1, getRangeAt: () => ({ getBoundingClientRect: () => rect }) } as unknown as Selection)
  await waitFor(() => {
    fireEvent.mouseUp((root as unknown as ShadowRoot).querySelector('p')!)
    expect(screen.getByRole('toolbar', { name: 'Trecho selecionado' })).toBeInTheDocument()
  })
}

describe('na barra do trecho selecionado', () => {
  it('"Gerar a partir disto" fica ao lado de "Explicar isto" e abre a escolha com o trecho', async () => {
    await selecting(PASSAGE)
    const bar = screen.getByRole('toolbar', { name: 'Trecho selecionado' })
    const buttons = within(bar).getAllByRole('button').map(button => button.textContent)
    expect(buttons.indexOf('Gerar a partir disto')).toBe(buttons.indexOf('Explicar isto') + 1)
    fireEvent.click(within(bar).getByRole('button', { name: 'Gerar a partir disto' }))
    expect(useUiStore.getState().overlay).toEqual({ kind: 'from-selection', fileId: 'mae', excerpt: PASSAGE })
  })
})

function dialog(excerpt: string) {
  return render(
    <MemoryRouter initialEntries={[paths.file('mae')]}>
      <FromSelectionDialog fileId="mae" excerpt={excerpt} />
    </MemoryRouter>,
  )
}

describe('a janela "Gerar a partir disto"', () => {
  it('mostra o trecho, o que gerar, o modelo e a instrução, e manda o pedido', async () => {
    memoryLibrary({ files: [mother()] })
    const generateFromSelection = vi.fn(async () => 'nova')
    useJobsStore.setState({ generateFromSelection })
    dialog(PASSAGE)
    expect(screen.getByText(PASSAGE)).toBeInTheDocument()
    const goals = within(screen.getByRole('radiogroup', { name: 'O que gerar' }))
    expect(goals.getAllByRole('radio').map(radio => radio.querySelector('b')!.textContent)).toEqual(['Aula', 'Explicação', 'Ata'])
    fireEvent.click(goals.getByRole('radio', { name: /Explicação/ }))
    expect(screen.getByText('Modelo da IA')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Mais opções'))
    fireEvent.change(screen.getByLabelText(/Instrução extra/), { target: { value: 'com exemplo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }))
    await waitFor(() => expect(generateFromSelection).toHaveBeenCalled())
    expect(generateFromSelection.mock.calls[0]).toEqual(['mae', PASSAGE, 'explanation', 'custom::default', { folderId: 'calculo' }, 'com exemplo', undefined])
    expect(useUiStore.getState().overlay).toBeNull()
  })

  it('um link do YouTube diz que vira entrada dentro da nota e oferece o que a IA analisa', () => {
    memoryLibrary({ files: [mother()] })
    dialog(YOUTUBE_URL)
    expect(screen.getByText(/vira uma nota de vídeo dentro desta/)).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /O que a IA analisa/ })).toBeInTheDocument()
  })
})

describe('a nota nova', () => {
  it('de um trecho: filha da nota, com o trecho como fonte', async () => {
    memoryLibrary({ files: [mother()], contents: { mae: BODY } })
    const id = await useJobsStore.getState().generateFromSelection('mae', PASSAGE, 'lesson', null, { folderId: 'calculo' }, '')
    const note = await ready(id)
    expect(entradas()).toHaveLength(0)
    expect(note).toMatchObject({ type: 'class', parentFileId: 'mae', folderId: 'calculo', source: { kind: 'text', text: PASSAGE } })
  })

  it('de um link: lê a página e guarda o link e o título como fonte', async () => {
    const library = memoryLibrary({ files: [mother()], contents: { mae: BODY } })
    const id = await useJobsStore.getState().generateFromSelection('mae', PAGE_URL, 'explanation', null, { folderId: 'calculo' }, '')
    const note = await ready(id)
    expect(library.calls.some(call => call.url.startsWith('https://r.jina.ai/'))).toBe(true)
    expect(note).toMatchObject({ type: 'explanation', parentFileId: 'mae', origin: { input: 'url', url: PAGE_URL }, source: { kind: 'link', url: PAGE_URL, title: PAGE_TITLE } })
  })

  it('a nota de um trecho também pode virar entrada, que fica dentro da nota de onde saiu', async () => {
    memoryLibrary({ files: [mother()], contents: { mae: BODY } })
    const id = (await useJobsStore.getState().generateFromSelection('mae', PASSAGE, 'lesson', null, { folderId: 'calculo' }, ''))!
    await ready(id)
    const entry = await useJobsStore.getState().turnIntoEntry(id)
    expect(fileOf(entry!)).toMatchObject({ parentFileId: 'mae' })
    expect(fileOf(id).parentFileId).toBe(entry)
  })

  it('de um link do YouTube: vira entrada dentro da nota, e a nota nova nasce dela', async () => {
    const library = memoryLibrary({ files: [mother()], contents: { mae: BODY } })
    const id = await useJobsStore.getState().generateFromSelection('mae', YOUTUBE_URL, 'lesson', null, { folderId: 'calculo' }, '', 'transcricao')
    const note = await ready(id)
    const [entry] = entradas()
    expect(entry).toMatchObject({ kept: 'registro', parentFileId: 'mae', folderId: 'calculo', name: VIDEO_TITLE, origin: { input: 'youtube', url: YOUTUBE_URL } })
    expect(note).toMatchObject({ parentFileId: entry.id, type: 'class' })
    expect(library.calls.some(call => call.url.startsWith('https://youtube-transcript.ai/'))).toBe(true)
    expect(files().length).toBe(3)
    expect(SAID).toBeTruthy()
  })
})
