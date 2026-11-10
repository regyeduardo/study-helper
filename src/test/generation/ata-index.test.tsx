import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

// The real viewer paints the Markdown into a shadow root and reports its headings through onHeadings (only when asked to).
vi.mock('@/components/reader/GithubMarkdownView', async importActual => {
  const actual = await importActual<typeof import('@/components/reader/GithubMarkdownView')>()
  return {
    ...actual,
    default: function FakeViewer({ markdown, onHeadings }: { markdown: string; onHeadings?: (headings: { id: string; level: number; text: string }[]) => void }) {
      const host = useRef<HTMLDivElement>(null)
      useEffect(() => {
        const root = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' })
        const found = [...markdown.matchAll(/^(#{1,3})\s+(.+)$/gm)].map((line, index) => ({ id: `secao-${index}`, level: line[1].length, text: line[2] }))
        root.innerHTML = found.map(item => `<h${item.level} id="${item.id}">${item.text}</h${item.level}>`).join('')
        onHeadings?.(found)
      }, [markdown])
      return <div ref={host} data-testid="github-viewer" />
    },
  }
})

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { TocPanel } from '@/components/reader/Inspector'
import { defaultIndex } from '@/lib/defaults'
import type { Repository } from '@/lib/storage/repository'
import { useDocumentStore } from '@/stores/document'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'
import type { FileSidecar, MeetingDocument } from '@/types/domain'

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

const markdown = '# Ata: Cardápio\n\n## Conclusões\n\n- O panetone entra no cardápio. [02:14]\n\n### Descartado na reunião\n\n- Sorteio → sem sorteio. [01:30] → [02:14]\n'
const ata: MeetingDocument = { id: 'ata-1', kind: 'ata', parts: [], ataModel: { id: 'fathom', name: 'Fathom' }, markdown, images: [], createdAt: '2026-11-10T12:00:00.000Z', models: {} }
const recording = { blocks: [{ speaker: 'mic', start: 0, end: 5, text: 'Bom dia.' }], speakers: [{ id: 'mic', name: 'Bruna Costa', suggested: false }], marks: [] }

let scrolled: Element[] = []

beforeEach(() => {
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  useLibraryStore.setState({ repo, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useJobsStore.setState({ jobs: [], live: {}, proposals: [] })
  useUiStore.setState({ menu: null, overlay: null })
  useDocumentStore.setState({ fileId: null, headings: [], scroller: null })
})

afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView
  vi.restoreAllMocks()
})

async function meetingWithAta() {
  const meta = await useLibraryStore.getState().createFile({ name: 'Reunião do cardápio', type: 'reading', status: 'ready', folderId: null, origin: { input: 'recording', name: 'gravacao.webm', mime: 'audio/webm', durationSeconds: 170, storage: 'none' } }, 'Bruna Costa [00:00]: Bom dia.')
  await useLibraryStore.getState().updateSidecar(meta.id, sidecar => ({ ...sidecar, recording, documents: [ata] }))
  render(
    <MemoryRouter>
      <DocumentBody fileId={meta.id} />
      <aside>
        <TocPanel />
      </aside>
    </MemoryRouter>,
  )
  await screen.findByTestId('github-viewer')
}

describe('the Índice on the "Ata" tab of the meeting note', () => {
  it('lists the headings of the Ata shown in the tab, not "Sem seções."', async () => {
    await meetingWithAta()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conclusões' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Descartado na reunião' })).toBeInTheDocument()
    expect(screen.queryByText('Sem seções.')).toBeNull()
  })

  it('clicking a heading of the Índice scrolls the Ata to it', async () => {
    await meetingWithAta()
    await userEvent.click(await screen.findByRole('button', { name: 'Descartado na reunião' }))
    expect(scrolled.map(element => element.textContent)).toEqual(['Descartado na reunião'])
  })

  it('leaving the tab takes the Ata sections out of the Índice', async () => {
    await meetingWithAta()
    await screen.findByRole('button', { name: 'Conclusões' })
    await act(async () => {
      await userEvent.click(screen.getByRole('tab', { name: 'Transcrição' }))
    })
    await waitFor(() => expect(screen.getByText('Sem seções.')).toBeInTheDocument())
  })
})
