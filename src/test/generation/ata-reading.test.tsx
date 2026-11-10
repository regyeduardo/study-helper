import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div>,
}))

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { defaultIndex } from '@/lib/defaults'
import { forReading } from '@/lib/generation/ata-reading'
import type { Repository } from '@/lib/storage/repository'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileSidecar, MeetingDocument } from '@/types/domain'

/** The no-break space that holds "▸" and the time on one line. */
const NB = ' '

afterEach(() => {
  vi.restoreAllMocks()
})

describe('forReading: the Ata as the reader shows it (T101)', () => {
  it('a bare [mm:ss] of the Ata models plays the recording from there, like the links of the standard Ata', () => {
    expect(forReading('Marta fechou o formato. [02:14]')).toBe(`Marta fechou o formato. [▸${NB}02:14](#t=134)`)
    expect(forReading('[1:05] e [64:28] = 1:04:28')).toBe(`[▸${NB}01:05](#t=65) e [▸${NB}64:28](#t=3868) = 1:04:28`)
  })

  it('leaves alone what is already a link and what is not a minute', () => {
    expect(forReading('[ver](#t1) [02:14](https://exemplo.dev) [12] [tarefa 3:15 pm] [▸ 01:05](#t=65)')).toBe(`[ver](#t1) [02:14](https://exemplo.dev) [12] [tarefa 3:15 pm] [▸${NB}01:05](#t=65)`)
  })

  it('a minute link never breaks between "▸" and the time', () => {
    expect(forReading('Base: [▸ 02:14](#t=134) Marta')).toBe(`Base: [▸${NB}02:14](#t=134) Marta`)
  })

  it('in "Descartado na reunião" the arrow stays with the minute that follows it, and the words keep a normal space', () => {
    expect(forReading('- Sorteio no Instagram → este ano não tem sorteio. [01:30] → [02:14]')).toBe(`- Sorteio no Instagram → este ano não tem sorteio. [▸${NB}01:30](#t=90) →${NB}[▸${NB}02:14](#t=134)`)
    expect(forReading('- Sorteio → sem sorteio. [▸ 01:30](#t=90) → [▸ 02:14](#t=134)')).toBe(`- Sorteio → sem sorteio. [▸${NB}01:30](#t=90) →${NB}[▸${NB}02:14](#t=134)`)
  })

  it('the header lines of a model Ata (date and duration, then the participants) do not run into one line', () => {
    const model = '# Ata: Cardápio\n\n09/11/2026 · cerca de 3 min · cardápio de fim de ano\nMarta (dona), Joel (cozinha)\n\n_Correções pela tela: nenhuma._\n\n## Conclusões\n\n- Uma conclusão.\n- Outra.\n'
    expect(forReading(model)).toBe('# Ata: Cardápio\n\n09/11/2026 · cerca de 3 min · cardápio de fim de ano  \nMarta (dona), Joel (cozinha)\n\n_Correções pela tela: nenhuma._\n\n## Conclusões\n\n- Uma conclusão.\n- Outra.\n')
  })

  it('only the header: from the first section on, lines keep the way the model wrote them', () => {
    const body = '# Ata\n\n## Assuntos\n\nPrimeira linha\nsegunda linha do mesmo parágrafo\n'
    expect(forReading(body)).toBe(body)
  })

  it('the standard Ata, which opens with the quote of the participants, comes out as it was', () => {
    const standard = '> Participantes: Marta Oliveira, Joel Pinheiro.\n\n# Panetone de cupuaçu\n\n## Tarefas\n\nTexto.\n'
    expect(forReading(standard)).toBe(standard)
  })
})

describe('the Ata note shows its minutes as links', () => {
  const memory = (() => {
    const sidecars = new Map<string, FileSidecar>()
    const contents = new Map<string, string>()
    const repo = {
      kind: 'local',
      accountId: 'local',
      readContent: async (id: string) => contents.get(id) ?? '',
      readSidecar: async (id: string) => sidecars.get(id)!,
      saveFile: async (sidecar: FileSidecar, content?: string) => {
        sidecars.set(sidecar.meta.id, sidecar)
        if (content !== undefined) contents.set(sidecar.meta.id, content)
        return sidecar
      },
      saveFolder: async () => undefined,
      saveIndex: async () => undefined,
      fileSizes: async () => ({}),
    } as unknown as Repository
    return { repo }
  })()

  beforeEach(() => {
    useLibraryStore.setState({ repo: memory.repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
    useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
    useUiStore.setState({ menu: null, overlay: null })
  })

  const markdown = '# Ata: Cardápio\n\n## Conclusões\n\n- O panetone entra no cardápio. [02:14]\n\n### Descartado na reunião\n\n- Sorteio → sem sorteio. [01:30] → [02:14]\n'
  const document: MeetingDocument = { id: 'ata-1', kind: 'ata', parts: [], ataModel: { id: 'fathom', name: 'Fathom' }, markdown, images: [], createdAt: '2026-11-10T12:00:00.000Z', models: {} }

  it('the Ata that is a note of its own', async () => {
    const meta = await useLibraryStore.getState().createFile({ name: 'Ata: Reunião do cardápio', type: 'meeting', status: 'ready', folderId: null, origin: { input: 'text', name: 'Reunião do cardápio', storage: 'none' } }, markdown)
    await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, documents: [document] }))
    render(
      <MemoryRouter>
        <DocumentBody fileId={meta.id} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByTestId('markdown').textContent).toContain(`[▸${NB}02:14](#t=134)`))
    expect(screen.getByTestId('markdown').textContent).toContain(`[▸${NB}01:30](#t=90) →${NB}[▸${NB}02:14](#t=134)`)
    expect(screen.getByTestId('markdown').textContent).not.toMatch(/\[\d{2}:\d{2}\]/)
  })

  it('the Ata inside the meeting note (the "Ata" tab)', async () => {
    const recording = { blocks: [{ speaker: 'mic', start: 0, end: 5, text: 'Bom dia.' }], speakers: [{ id: 'mic', name: 'Bruna Costa', suggested: false }], marks: [] }
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião do cardápio', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'gravacao.webm', mime: 'audio/webm', durationSeconds: 170, storage: 'none' } }, 'Bruna Costa [00:00]: Bom dia.')
    await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording, documents: [document] }))
    render(
      <MemoryRouter>
        <DocumentBody fileId={meta.id} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByTestId('markdown').textContent).toContain(`[▸${NB}02:14](#t=134)`))
    expect(screen.getByTestId('markdown').textContent).not.toMatch(/\[\d{2}:\d{2}\]/)
  })
})
