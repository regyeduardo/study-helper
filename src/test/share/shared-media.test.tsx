import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { DocumentBody } from '@/components/reader/DocumentArticle'
import { fetchSharedItemController } from '@/controllers/share.controller'
import { defaultIndex } from '@/lib/defaults'
import { env } from '@/lib/env'
import { useLibraryStore } from '@/stores/library'
import type { RecordingData } from '@/types/domain'

import { installMemoryStorage } from '../storage/fake-drive'

vi.mock('@/components/reader/GithubMarkdownView', () => ({
  default: ({ markdown }: { markdown: string }) => (
    <div data-testid="markdown">
      {markdown.split(/(\[[^\]]+\]\(#t=\d+\))/).map((part, index) => {
        const link = /^\[([^\]]+)\]\((#t=\d+)\)$/.exec(part)
        return link ? (
          <a key={index} href={link[2]}>
            {link[1]}
          </a>
        ) : (
          part
        )
      })}
    </div>
  ),
}))

const SHARE_ID = 'ReuniaoReuniaoReuniao1'

const recording: RecordingData = {
  blocks: [
    { speaker: 'mic', start: 0, end: 4, text: 'Bom dia, vamos ao preço.' },
    { speaker: 'speaker_0', start: 72, end: 80, text: 'Custou dois mil.' },
  ],
  speakers: [
    { id: 'mic', name: 'Você', suggested: false },
    { id: 'speaker_0', name: 'Marina', suggested: false },
  ],
  marks: [],
}

const play = vi.fn(async () => undefined)

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function serveMeeting(mediaExpiresAt: string) {
  const files: Record<string, () => Response> = {
    'share.json': () =>
      json({ version: 2, id: SHARE_ID, kind: 'file', title: 'Reunião', createdAt: new Date(Date.now() - 3600_000).toISOString(), expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(), mediaExpiresAt, folders: [], files: [{ id: 'f1', path: 'Reunião', media: { key: `shared-media/${SHARE_ID}/f1`, mime: 'audio/webm', size: 1000 } }] }),
    'Reuni%C3%A3o.md': () => new Response('# Ata\n\n- O preço fica em dois mil. [▸ 01:12](#t=72)'),
    'Reuni%C3%A3o.json': () => json({ meta: { id: 'f1', name: 'Reunião', folderId: null, type: 'meeting', position: 0, description: '', tags: [], status: 'ready', origin: { input: 'recording', name: 'Reunião.webm', mime: 'audio/webm', storage: 'drive', storedFileId: 'drive-da-ana' } }, questions: [], attempts: [], highlights: [], recording }),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const name = String(input).replace(`https://files.test/shared/${SHARE_ID}/`, '')
      return files[name]?.() ?? new Response('not found', { status: 404 })
    }),
  )
}

async function openShared(mediaExpiresAt: string) {
  serveMeeting(mediaExpiresAt)
  const item = await fetchSharedItemController(SHARE_ID)
  expect(item).not.toBeNull()
  useLibraryStore.getState().enterShared(item!, {})
  render(
    <MemoryRouter>
      <DocumentBody fileId="f1" />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  installMemoryStorage()
  env.shareWorkerUrl = 'https://share.test'
  env.sharedFilesUrl = 'https://files.test'
  play.mockClear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  useLibraryStore.setState({ repo: null, accountId: 'local', ready: true, folders: [], files: [], index: defaultIndex(), opened: {}, openedAt: {}, localMedia: [], sharedView: null })
})

afterEach(() => {
  useLibraryStore.getState().leaveShared()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mídia no link compartilhado', () => {
  it('toca do Worker: o momento da Ata e a fala da Transcrição levam o player ao ponto certo', async () => {
    await openShared(new Date(Date.now() + 2 * 24 * 3600_000).toISOString())
    const audio = document.querySelector('audio')!
    expect(audio).toHaveAttribute('src', `https://share.test/media/${SHARE_ID}/f1`)
    expect(audio).toHaveAttribute('crossorigin', 'anonymous')
    fireEvent.click(await screen.findByText('▸ 01:12'))
    expect(audio.currentTime).toBe(72)
    expect(play).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('tab', { name: 'Transcrição' }))
    fireEvent.click(screen.getByText('Bom dia, vamos ao preço.'))
    expect(audio.currentTime).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Tocar a partir de 01:12' }))
    expect(audio.currentTime).toBe(72)
    expect(play).toHaveBeenCalledTimes(3)
    expect(screen.queryByText(/expirou/)).not.toBeInTheDocument()
  })

  it('depois de 3 dias a mídia expira: a nota continua, sem player, com o aviso', async () => {
    await openShared(new Date(Date.now() - 1000).toISOString())
    expect(await screen.findByText('A mídia deste compartilhamento expirou (fica 3 dias).')).toBeInTheDocument()
    expect(document.querySelector('audio')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Player da gravação' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Transcrição' }))
    expect(screen.getByText('Custou dois mil.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Tocar a partir de/ })).not.toBeInTheDocument()
  })
})
