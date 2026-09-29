import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import 'fake-indexeddb/auto'

import type { FileMeta, FileSidecar, SourceMeta } from '@/types/domain'
import { newFileMeta, newFolderMeta, newSidecar } from '@/lib/defaults'
import { addLocalMedia, linkLocalMedia, removeLocalMedia } from '@/lib/recording/media-library'
import { DriveRepository } from '@/lib/storage/drive-repository'
import { fileBytes, folderBytes } from '@/lib/storage/file-sizes'
import { useLibraryView } from '@/hooks/use-library-view'
import { LocalRepository } from '@/lib/storage/local-repository'
import { bytesOf } from '@/lib/storage/repository'
import { useLibraryStore } from '@/stores/library'

import { FakeDrive, installMemoryStorage, uniqueAccount } from './fake-drive'

const token = vi.fn(async () => 'tok')

function installMemoryOpfs() {
  const entries = new Map<string, string>()
  const handle = (name: string) => ({
    getFile: async () => ({ text: async () => entries.get(name)! }),
    createWritable: async () => {
      const parts: string[] = []
      return { write: async (data: string) => void parts.push(data), close: async () => void entries.set(name, parts.join('')) }
    },
  })
  const root = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!entries.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError')
      return handle(name)
    },
    removeEntry: async (name: string) => void entries.delete(name),
  }
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => root } })
}

function withOrigin(sidecar: FileSidecar, origin: Partial<SourceMeta>): FileSidecar {
  return { ...sidecar, meta: { ...sidecar.meta, origin: { input: 'file', name: 'aula.mp3', storage: 'none', ...origin } } }
}

beforeEach(() => {
  installMemoryStorage()
  installMemoryOpfs()
})

afterEach(() => {
  vi.unstubAllGlobals()
  useLibraryStore.setState({ repo: null, sizes: {}, localMedia: [], files: [], folders: [] })
})

describe('file size', () => {
  it('is the note text plus its sidecar with questions, attempts, highlights and transcript', async () => {
    const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
    await repo.load()
    const base = newSidecar(newFileMeta({ name: 'Célula', type: 'reading' }))
    const sidecar: FileSidecar = { ...base, transcript: 'fala do professor', questions: [{ storedId: 'q1', enunciado: 'O que é?', alternativas: { a: 'x' }, explicacao: 'porque' }] }
    await repo.saveFile(sidecar, '# Célula\n\nconteúdo')
    const sizes = await repo.fileSizes()
    expect(sizes[base.meta.id]).toEqual({ noteBytes: bytesOf('# Célula\n\nconteúdo') + bytesOf(JSON.stringify(sidecar)), sourceBytes: 0 })
    expect(fileBytes(sidecar.meta, sizes[base.meta.id], [])).toBe(sizes[base.meta.id].noteBytes)
  })

  it('counts the source kept in Google Drive and never the one on a free hosting service', async () => {
    new FakeDrive().install()
    const repo = new DriveRepository(uniqueAccount(), token)
    await repo.load()
    const inDrive = newSidecar(newFileMeta({ name: 'No Drive', type: 'class' }))
    const stored = await repo.putSource(inDrive.meta.id, new Blob(['a'.repeat(5000)]), 'aula.mp3')
    const driveSidecar = withOrigin(inDrive, { storage: 'drive', storedFileId: stored.ref, sizeBytes: 5000 })
    await repo.saveFile(driveSidecar, 'texto')
    const hosted = withOrigin(newSidecar(newFileMeta({ name: 'No Gofile', type: 'class' })), { storage: 'gofile', storedUrl: 'https://gofile.io/d/x', sizeBytes: 9_000_000 })
    await repo.saveFile(hosted, 'texto')

    const sizes = await repo.fileSizes()
    const driveNote = sizes[inDrive.meta.id]
    expect(driveNote.sourceBytes).toBe(5000)
    expect(fileBytes(driveSidecar.meta, driveNote, [])).toBe(driveNote.noteBytes + 5000)
    expect(fileBytes(hosted.meta, sizes[hosted.meta.id], [])).toBe(sizes[hosted.meta.id].noteBytes)

    await repo.removeSource(stored.ref)
    const removed = { ...driveSidecar.meta, origin: { ...driveSidecar.meta.origin!, storedFileId: undefined, removedAt: '2026-09-28T00:00:00Z' } }
    expect(fileBytes(removed, (await repo.fileSizes([inDrive.meta.id]))[inDrive.meta.id], [])).toBe(driveNote.noteBytes)
  })

  it('counts the recording kept in Mídias and stops counting once it is removed from there', async () => {
    const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
    useLibraryStore.setState({ repo, files: [], folders: [], sizes: {}, localMedia: [] })
    const meta = await useLibraryStore.getState().createFile({ name: 'Reunião', type: 'meeting' }, 'ata')
    await vi.waitFor(() => expect(useLibraryStore.getState().sizes[meta.id]).toBeDefined())
    const noteBytes = useLibraryStore.getState().sizes[meta.id].noteBytes
    const sizeNow = () => fileBytes(meta, useLibraryStore.getState().sizes[meta.id], useLibraryStore.getState().localMedia)

    await addLocalMedia({ storedName: 'gravacao-1.webm', name: 'Reunião.webm', mime: 'audio/webm', durationSeconds: 60, size: 700_000, createdAt: '2026-09-28T10:00:00Z', fileIds: [] })
    await linkLocalMedia('gravacao-1.webm', meta.id)
    await vi.waitFor(() => expect(sizeNow()).toBe(noteBytes + 700_000))

    await removeLocalMedia('gravacao-1.webm')
    await vi.waitFor(() => expect(sizeNow()).toBe(noteBytes))
  })

  it('follows saves and forgets the file deleted forever', async () => {
    const repo = new LocalRepository(`study-helper-local-test-${crypto.randomUUID()}`)
    useLibraryStore.setState({ repo, files: [], folders: [], sizes: {}, localMedia: [] })
    const meta = await useLibraryStore.getState().createFile({ name: 'Nota', type: 'reading' }, 'curto')
    await vi.waitFor(() => expect(useLibraryStore.getState().sizes[meta.id]).toBeDefined())
    const before = useLibraryStore.getState().sizes[meta.id].noteBytes
    await useLibraryStore.getState().saveContent(meta.id, 'um texto bem mais comprido que o primeiro')
    await vi.waitFor(() => expect(useLibraryStore.getState().sizes[meta.id].noteBytes).toBeGreaterThan(before))
    await useLibraryStore.getState().deleteFileForever(meta.id)
    expect(useLibraryStore.getState().sizes[meta.id]).toBeUndefined()
  })
})

describe('folder size', () => {
  it('sums every file inside, subfolders included', () => {
    const top = newFolderMeta({ name: 'Curso' })
    const middle = newFolderMeta({ name: 'Módulo', parentId: top.id })
    const deep = newFolderMeta({ name: 'Aula', parentId: middle.id })
    const other = newFolderMeta({ name: 'Outra' })
    const file = (folderId: string): FileMeta => newFileMeta({ name: 'x', type: 'reading', folderId })
    const files = [file(top.id), file(middle.id), file(deep.id), file(deep.id), file(other.id)]
    const bytes = new Map(files.map((item, index) => [item.id, (index + 1) * 100]))
    const folders = [top, middle, deep, other]
    expect(folderBytes(top.id, folders, files, item => bytes.get(item.id)!)).toBe(100 + 200 + 300 + 400)
    expect(folderBytes(deep.id, folders, files, item => bytes.get(item.id)!)).toBe(700)
    expect(folderBytes(other.id, folders, files, item => bytes.get(item.id)!)).toBe(500)
  })
})

describe('course module size', () => {
  it('each module of a course carries the size of its lessons', () => {
    const course = newFolderMeta({ name: 'Curso', isCourse: true })
    const first = newFolderMeta({ name: 'Módulo 1', parentId: course.id, position: 0 })
    const second = newFolderMeta({ name: 'Módulo 2', parentId: course.id, position: 1 })
    const lessons = [
      newFileMeta({ name: 'Aula 1', type: 'class', folderId: first.id }),
      newFileMeta({ name: 'Aula 2', type: 'class', folderId: first.id }),
      newFileMeta({ name: 'Aula 3', type: 'class', folderId: second.id }),
    ]
    const [a, b, c] = lessons
    useLibraryStore.setState({
      folders: [course, first, second],
      files: lessons,
      localMedia: [],
      sizes: { [a.id]: { noteBytes: 1000, sourceBytes: 0 }, [b.id]: { noteBytes: 2000, sourceBytes: 0 }, [c.id]: { noteBytes: 500, sourceBytes: 0 } },
    })
    const { result } = renderHook(() => useLibraryView('folder', course.id))
    expect(result.current.courseGroups.map(group => [group.module?.name, group.bytes])).toEqual([
      ['Módulo 1', 3000],
      ['Módulo 2', 500],
    ])
  })
})
