import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FileMeta, FileSidecar, RecordingData, SourceMeta } from '@/types/domain'
import { CommandPalette } from '@/components/dialogs/CommandPalette'
import { useLibraryView } from '@/hooks/use-library-view'
import { searchFile } from '@/lib/library-search'
import type { Repository } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import { FILES, renderAt, seedLibrary } from '@/test/library/explorer-fixture'

beforeEach(() => {
  seedLibrary()
})

const rows = () => within(screen.getByRole('table', { name: 'Notas e pastas' })).getAllByRole('row').slice(1)
const lit = () => rows().filter(row => row.classList.contains('hit')).map(row => row.textContent)

describe('search lights up the explorer itself', () => {
  it('finds the words ignoring accents and case, in the text and in what was said, with the minute', () => {
    const recording = { blocks: [{ speaker: 'mic', start: 40, end: 52, text: 'Aí o LIMITE da função não existe.' }], speakers: [], marks: [] }
    const hit = searchFile(FILES[1], { content: '', sidecar: { recording } as never }, 'limite nao existe')
    expect(hit?.at).toBe(40)
    expect(hit?.parts.filter(part => part.hit).map(part => part.text)).toEqual(['LIMITE', 'não', 'existe'])
    expect(hit?.parts.map(part => part.text).join('')).toBe('Aí o LIMITE da função não existe.')
    expect(searchFile(FILES[3], { content: 'A derivada é um limite.', sidecar: {} as never }, 'limite nao existe')).toBeNull()
  })

  it('the rows that match light up with the excerpt, the others stay, and a folder shows how many are inside', async () => {
    renderAt('/biblioteca/calc')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'limite não existe' } })
    await waitFor(() => expect(lit()).toHaveLength(3))
    expect(rows()).toHaveLength(6)
    const [integrais, limites, monitoria] = lit()
    expect(integrais).toContain('1 resultado dentro')
    expect(limites).toContain('Se os laterais diferem, o limite não existe.')
    expect(monitoria).toContain('00:40')
    expect(monitoria).toContain('Pode, e aí o limite da função não existe.')
    expect(within(rows()[4]).getAllByText(/./, { selector: 'mark' }).map(mark => mark.textContent)).toEqual(['limite', 'não', 'existe'])
    expect(within(screen.getByRole('tree', { name: 'Pastas' })).getByRole('treeitem', { name: 'Integrais' })).toHaveTextContent('(1)')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: '' } })
    expect(lit()).toHaveLength(0)
  })
})

const audio = (minutes: number): SourceMeta => ({ input: 'recording', name: 'gravacao.webm', mime: 'audio/webm', durationSeconds: minutes * 60, storage: 'none' })
const video = (minutes: number): SourceMeta => ({ input: 'file', name: 'seminario.mp4', mime: 'video/mp4', durationSeconds: minutes * 60, storage: 'none' })

function entrada(id: string, name: string, origin: SourceMeta, words: number): FileMeta {
  return { ...FILES[0], id, name, role: 'entrada', kept: 'registro', tags: [], mastery: null, words, origin }
}

const said: RecordingData = { blocks: [{ speaker: 'mic', start: 95, end: 110, text: 'A assíntota vertical aparece quando o denominador zera.' }], speakers: [], marks: [] }
/** The transcription lives in the entrada's sidecar: the blocks of a recording, or the plain text of a sent video. */
const TERCA = { meta: entrada('aula-terca', 'Aula de terça', audio(40), 9), sidecar: { transcript: said.blocks[0].text, recording: said } }
const SEMINARIO = { meta: entrada('seminario', 'Seminário de quinta', video(45), 12), sidecar: { transcript: 'No seminário a turma resolveu a assíntota vertical do exercício 3.' } }

/** Adds entradas to the library; the repo answers their sidecars, so the search has to load them. */
function addEntries(...entries: { meta: FileMeta; sidecar: Partial<FileSidecar> }[]) {
  const repo = useLibraryStore.getState().repo!
  const find = (id: string) => entries.find(entry => entry.meta.id === id)
  useLibraryStore.setState(state => ({
    files: [...state.files, ...entries.map(entry => entry.meta)],
    repo: {
      ...repo,
      readContent: async (id: string) => (find(id) ? (find(id)!.sidecar.transcript ?? '') : repo.readContent(id)),
      readSidecar: async (id: string) => (find(id) ? ({ meta: find(id)!.meta, highlights: [], questions: [], attempts: [], ...find(id)!.sidecar } as FileSidecar) : repo.readSidecar(id)),
    } as Repository,
  }))
}

const openedEntries = (...entries: { meta: FileMeta; sidecar: Partial<FileSidecar> }[]) =>
  useLibraryStore.setState(state => ({
    opened: { ...state.opened, ...Object.fromEntries(entries.map(entry => [entry.meta.id, { content: '', sidecar: { meta: entry.meta, highlights: [], questions: [], attempts: [], ...entry.sidecar } as FileSidecar }])) },
  }))

describe('the transcription of a media entrada is searched (FR-053)', () => {
  it('the explorer finds what was said in an entrada, with the minute, and in the text of a sent video', async () => {
    addEntries(TERCA, SEMINARIO)
    renderAt('/biblioteca/calc')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), { target: { value: 'assintota vertical' } })
    await waitFor(() => expect(lit()).toHaveLength(2))
    const [terca, seminario] = lit()
    expect(terca).toContain('Aula de terça')
    expect(terca).toContain('01:35')
    expect(terca).toContain('A assíntota vertical aparece quando o denominador zera.')
    expect(seminario).toContain('Seminário de quinta')
    expect(seminario).toContain('No seminário a turma resolveu a assíntota vertical do exercício 3.')
  })

  it('the palette finds an entrada by what was said in it', () => {
    addEntries(TERCA)
    openedEntries(TERCA)
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar arquivos, pastas e ações' }), { target: { value: 'denominador zera' } })
    expect(screen.getByText('Aula de terça')).toBeInTheDocument()
  })

  it('the filtered list of the other layouts keeps an entrada whose transcription has the words', () => {
    addEntries(TERCA, SEMINARIO)
    openedEntries(TERCA, SEMINARIO)
    useUiStore.getState().setQuery('exercício 3')
    const { result } = renderHook(() => useLibraryView('folder', 'calc'))
    expect(result.current.files.map(file => file.id)).toEqual(['seminario'])
  })

  it('"Gravações sem transcrição" lists the audio and video entradas still without transcription', () => {
    addEntries(
      TERCA,
      { meta: entrada('quinta', 'Gravação de quinta', audio(2), 0), sidecar: {} },
      { meta: entrada('video-cru', 'Vídeo do seminário', video(45), 0), sidecar: {} },
      { meta: entrada('link', 'Artigo sobre limites', { input: 'url', name: 'https://exemplo.com/limites', storage: 'none' }, 0), sidecar: {} },
    )
    renderAt('/')
    const region = screen.getByRole('region', { name: 'Gravações sem transcrição' })
    expect(within(region).getAllByRole('button').map(button => button.textContent)).toEqual(['Gravação de quintaÁudio · 2 min', 'Vídeo do seminárioVídeo · 45 min'])
  })
})
