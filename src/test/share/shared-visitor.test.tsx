import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { InfoPanel } from '@/components/reader/Inspector'
import { defaultIndex } from '@/lib/defaults'
import { useLibraryStore } from '@/stores/library'
import type { SharedItem } from '@/types/domain'
import { downloadBlob } from '@/utils/download'

import { installMemoryStorage } from '../storage/fake-drive'

vi.mock('@/utils/download', async importOriginal => ({ ...(await importOriginal<typeof import('@/utils/download')>()), downloadBlob: vi.fn() }))
vi.mock('@/components/reader/GithubMarkdownView', () => ({ default: ({ markdown }: { markdown: string }) => <div data-testid="markdown">{markdown}</div> }))

const MEDIA_URL = 'https://share.test/media/Link1/f1'

// The real link of 29/10: the worker kept the media without its type (mime ""), the note says video/webm.
function sharedVideo(): SharedItem {
  return {
    version: 2,
    id: 'Link1',
    kind: 'file',
    title: 'Distribuição de receita',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
    mediaExpiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
    folders: [],
    files: [
      {
        id: 'f1',
        name: 'Distribuição de receita',
        folderId: null,
        type: 'reading',
        position: 0,
        description: '',
        tags: [],
        content: 'Henrique Souza [00:50]: Peraí.',
        questions: [],
        highlights: [],
        recording: { blocks: [{ speaker: 'speaker_0', start: 50, end: 51, text: 'Peraí.' }], speakers: [{ id: 'speaker_0', name: 'Henrique Souza', suggested: false }], marks: [] },
        media: { url: MEDIA_URL, mime: '', size: 90548032 },
        meta: { origin: { input: 'recording', name: 'Reunião 29-10-2026.webm', mime: 'video/webm', sizeBytes: 90548032, durationSeconds: 584, storage: 'drive', storedFileId: 'drive-do-dono' } },
      },
    ],
  } as SharedItem
}

beforeEach(() => {
  installMemoryStorage()
  vi.mocked(downloadBlob).mockClear()
  useLibraryStore.setState({ repo: null, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
  useLibraryStore.getState().enterShared(sharedVideo(), {})
})

afterEach(() => {
  useLibraryStore.getState().leaveShared()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('quem abre o link compartilhado', () => {
  it('vê o VÍDEO da gravação, mesmo com a mídia guardada sem tipo', async () => {
    render(
      <MemoryRouter>
        <DocumentBody fileId="f1" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', MEDIA_URL))
    expect(document.querySelector('audio')).toBeNull()
    // crossorigin BEFORE src: with src first Chrome starts the load without CORS and then fails every seek ("demuxer seek failed")
    const names = document.querySelector('video')!.getAttributeNames()
    expect(names.indexOf('crossorigin')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('crossorigin')).toBeLessThan(names.indexOf('src'))
  })

  it('quando a primeira carga do vídeo falha na rede (Chrome: "demuxer seek failed"), o player carrega de novo, até 3 vezes', async () => {
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    render(
      <MemoryRouter>
        <DocumentBody fileId="f1" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull())
    const video = document.querySelector('video')!
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 2, message: 'PIPELINE_ERROR_READ: FFmpegDemuxer: demuxer seek failed' } })
    vi.useFakeTimers()
    for (let i = 0; i < 4; i++) fireEvent.error(video)
    expect(load).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20000)
    vi.useRealTimers()
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('baixa a mídia do link, e não vê o que é do dono (Drive dele, Remover a fonte)', async () => {
    const video = new Blob(['webm'], { type: 'video/webm' })
    const fetching = vi.fn(async () => new Response(video, { status: 200, headers: { 'Content-Type': 'video/webm' } }))
    vi.stubGlobal('fetch', fetching)
    render(
      <MemoryRouter>
        <InfoPanel fileId="f1" />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('button', { name: /Remover a fonte/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Baixar a fonte/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Baixar a mídia/ }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    expect(fetching).toHaveBeenCalledWith(MEDIA_URL)
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('Reunião 29-10-2026.webm')
  })
})
