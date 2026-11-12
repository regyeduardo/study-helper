import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { FolderMeta, SourceMeta } from '@/types/domain'
import { Overlays } from '@/components/dialogs/Overlays'
import { EntryPage } from '@/components/reader/EntryPage'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { useLibraryStore } from '@/stores/library'
import { useSyncStore } from '@/stores/sync'
import { useUiStore } from '@/stores/ui'
import { FakeDrive, installMemoryStorage, uniqueAccount } from '@/test/storage/fake-drive'

const token = vi.fn(async () => 'tok')
const VIDEO: SourceMeta = { input: 'file', name: 'kickoff.mp4', sizeBytes: 184 * 1024 * 1024, mime: 'video/mp4', durationSeconds: 52 * 60, storage: 'none', expiresAt: null }

let drive: FakeDrive
let account: string
let aurora: FolderMeta
let atas: FolderMeta
let entryId: string

const library = () => useLibraryStore.getState()
const stored = (id: string) => library().files.find(file => file.id === id)!
const tree = (dialog: HTMLElement) => within(dialog).getByRole('tree', { name: 'Todas as pastas' })

async function seed(hidden: boolean) {
  installMemoryStorage()
  drive = new FakeDrive().install()
  drive.appDataGranted = hidden
  account = uniqueAccount()
  useUiStore.setState({ menu: null, overlay: null, selection: new Set(), toasts: [] })
  await library().connect(account, token)
  expect(library().loadError).toBeNull()
  aurora = await library().createFolder({ name: 'Projeto Aurora' })
  atas = await library().createFolder({ name: 'Atas' })
  const blob = new Blob(['video'], { type: 'video/mp4' })
  const ref = await library().repo!.putSource('x', blob, 'kickoff.mp4')
  const meta = await library().createFile({ name: 'Reunião de kickoff.mp4', role: 'entrada', kept: 'registro', type: 'reading', description: '', folderId: aurora.id, status: 'ready', pendingExcerpt: null, origin: { ...VIDEO, storage: 'drive', storedFileId: ref.ref } }, '')
  await library().updateSidecar(meta.id, sidecar => ({ ...sidecar, transcript: 'Bom dia a todos.' }))
  await library().updateFile(meta.id, { kept: 'arquivo' })
  entryId = meta.id
}

async function reload(otherDevice: boolean) {
  if (otherDevice) await (library().repo as DriveRepository).forget()
  await library().connect(account, token)
  expect(library().loadError).toBeNull()
}

afterEach(() => {
  useSyncStore.getState().stop()
  vi.unstubAllGlobals()
  useLibraryStore.setState({ repo: null })
})

async function moveOnPage() {
  render(
    <MemoryRouter>
      <EntryPage fileId={entryId} />
      <Overlays />
    </MemoryRouter>,
  )
  await waitFor(() => expect(library().opened[entryId]).toBeDefined())
  fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mover para…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Mover 1 item' })
  fireEvent.click(within(tree(dialog)).getByRole('treeitem', { name: 'Atas' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Mover' }))
  await waitFor(() => expect(useUiStore.getState().overlay).toBeNull(), { timeout: 3000 })
  expect(useUiStore.getState().toasts.at(-1)?.text).toBe('Movido para Atas')
  expect(stored(entryId).folderId).toBe(atas.id)
  const fresh = new DriveRepository(account, token, drive.appDataGranted ? 'appDataFolder' : 'drive')
  const snapshot = await fresh.load()
  expect(snapshot.files.find(file => file.id === entryId)?.folderId).toBe(atas.id)
}

for (const hidden of [true, false]) {
  for (const otherDevice of [false, true]) {
    for (const sync of [false, true]) {
      describe(`hidden=${hidden} otherDevice=${otherDevice} sync=${sync}`, () => {
        beforeEach(() => seed(hidden))
        it('moves', async () => {
          await reload(otherDevice)
          if (sync) {
            useSyncStore.getState().start()
            await waitFor(() => expect(useSyncStore.getState().lastSyncAt).not.toBeNull())
          }
          await moveOnPage()
        })
      })
    }
  }
}
