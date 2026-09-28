import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceMeta } from '@/types/domain'
import {
  deleteFromFilebinController,
  HOSTS,
  HostingError,
  isHostOnlineController,
  uploadToFilebinController,
  uploadToGofileController,
  uploadToLitterboxController,
  uploadToOnlyfilesController,
  uploadToTmpfilesController,
} from '@/controllers/hosting.controller'
import type { Repository } from '@/lib/storage/repository'
import { defaultStorage, downloadStoredSource, removeStoredSource, sourceExpired, storageOptions, storeSource } from '@/lib/storage/source-storage'

const MB = 1024 * 1024
const GB = 1024 * MB
const NOW = Date.parse('2026-09-27T12:00:00.000Z')

function textFile(name = 'notes.txt'): File {
  return new File(['study-helper test'], name, { type: 'text/plain' })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function fakeRepo(): Repository & { putSource: ReturnType<typeof vi.fn>; getSource: ReturnType<typeof vi.fn>; removeSource: ReturnType<typeof vi.fn> } {
  return {
    putSource: vi.fn(async () => ({ ref: 'drive-file-1' })),
    getSource: vi.fn(async () => new Blob(['original bytes'])),
    removeSource: vi.fn(async () => undefined),
  } as unknown as Repository & { putSource: ReturnType<typeof vi.fn>; getSource: ReturnType<typeof vi.fn>; removeSource: ReturnType<typeof vi.fn> }
}

function origin(patch: Partial<SourceMeta>): SourceMeta {
  return { input: 'file', name: 'lecture.mp4', storage: 'none', ...patch } as SourceMeta
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('storage options', () => {
  it('offers Drive, Gofile, Litterbox, filebin, tmpfiles, OnlyFiles and do-not-store', () => {
    expect(storageOptions(10, true, null).map(option => option.id)).toEqual(['drive', 'gofile', 'litterbox', 'filebin', 'tmpfiles', 'onlyfiles', 'none'])
  })

  it('caps Litterbox at 1 GB and tmpfiles at 100 MB', () => {
    expect(HOSTS.find(host => host.id === 'litterbox')?.maxBytes).toBe(GB)
    const fitsAt = (size: number) => Object.fromEntries(storageOptions(size, false, null).map(option => [option.id, option.fits]))
    expect(fitsAt(100 * MB)).toMatchObject({ tmpfiles: true, litterbox: true, gofile: true, filebin: true })
    expect(fitsAt(100 * MB + 1)).toMatchObject({ tmpfiles: false, litterbox: true })
    expect(fitsAt(GB)).toMatchObject({ litterbox: true })
    expect(fitsAt(GB + 1)).toMatchObject({ tmpfiles: false, litterbox: false, gofile: true, filebin: true, drive: true, none: true })
  })

  it('shows how long each host keeps the file', () => {
    const byId = Object.fromEntries(storageOptions(10, false, null).map(option => [option.id, option]))
    expect(byId.gofile.description).toMatch(/10 dias/)
    expect(byId.litterbox.description).toMatch(/1 h a 72 h/)
    expect(byId.litterbox.description).toMatch(/Até 1024 MB/)
    expect(byId.filebin.description).toMatch(/7 dias/)
    expect(byId.tmpfiles.description).toMatch(/1 hora/)
    expect(byId.none.description).toMatch(/fica só o nome/)
  })

  it('flags third-party hosts as unreliable and Drive as not', () => {
    const byId = Object.fromEntries(storageOptions(10, true, null).map(option => [option.id, option.thirdParty]))
    expect(byId).toEqual({ drive: false, gofile: true, litterbox: true, filebin: true, tmpfiles: true, onlyfiles: true, none: false })
  })

  it('disables Drive without login and when it does not fit the app limit', () => {
    const loggedOut = storageOptions(10, false, null).find(option => option.id === 'drive')!
    expect(loggedOut.enabled).toBe(false)
    expect(loggedOut.reason).toMatch(/Entre com o Google/)
    const full = storageOptions(50, true, 49).find(option => option.id === 'drive')!
    expect(full.enabled).toBe(false)
    expect(full.reason).toMatch(/Não cabe/)
    expect(storageOptions(49, true, 49).find(option => option.id === 'drive')!.enabled).toBe(true)
  })
})

describe('default storage', () => {
  it('picks Drive when logged in', () => {
    expect(defaultStorage(5 * GB, true, storageOptions(5 * GB, true, null))).toBe('drive')
  })

  it('falls back to a host when Drive has no room', () => {
    expect(defaultStorage(300 * MB, true, storageOptions(300 * MB, true, 10))).toBe('litterbox')
  })

  it.each([
    [1, 'onlyfiles'],
    [100 * MB, 'onlyfiles'],
    [100 * MB + 1, 'gofile'],
    [200 * MB, 'gofile'],
    [200 * MB + 1, 'litterbox'],
    [GB, 'litterbox'],
    [GB + 1, 'gofile'],
    [8 * GB, 'gofile'],
  ])('on the Local profile a %i byte file goes to %s', (size, expected) => {
    expect(defaultStorage(size, false, storageOptions(size, false, null))).toBe(expected)
  })
})

describe('OnlyFiles', () => {
  it('keeps the file forever, is capped at 100 MB and warns it may still disappear', () => {
    const onlyfiles = storageOptions(100 * MB + 1, false, null).find(option => option.id === 'onlyfiles')!
    expect(onlyfiles.fits).toBe(false)
    expect(onlyfiles.description).toMatch(/^Até 100 MB\. Fica para sempre, mas o OnlyFiles pode apagar por falta de espaço/)
    expect(onlyfiles.description).toMatch(/remover no app não apaga lá/)
  })

  it('stays with Drive when logged in', () => {
    expect(defaultStorage(10 * MB, true, storageOptions(10 * MB, true, null))).toBe('drive')
  })

  it('uploads with expire=0 and keeps the full link, with no expiry date', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: true, data: { file: { url: { full: 'https://onlyfiles.com/wswdwDwVA4DT/notes.txt', short: 'https://onlyfiles.com/wswdwDwVA4DT' } } } }))
    await expect(uploadToOnlyfilesController(textFile())).resolves.toEqual({ url: 'https://onlyfiles.com/wswdwDwVA4DT/notes.txt', expiresAt: null })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.onlyfiles.com/v1/upload')
    expect((init.body as FormData).get('expire')).toBe('0')
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
  })

  it('passes on the reason OnlyFiles gives for refusing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: false, error: { message: 'The file is too large. Max filesize: 100 MB', type: 'ERROR_FILE_SIZE_EXCEEDED', code: 31 } }))
    await expect(uploadToOnlyfilesController(textFile())).rejects.toThrow('O OnlyFiles recusou o arquivo: The file is too large. Max filesize: 100 MB')
  })

  it('stores a source there through the storage choice', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(jsonResponse({ status: true, data: { file: { url: { full: 'https://onlyfiles.com/abc/notes.txt' } } } }))
    await expect(storeSource(textFile(), 'onlyfiles', 'file-1', fakeRepo(), '72h')).resolves.toEqual({ storage: 'onlyfiles', storedUrl: 'https://onlyfiles.com/abc/notes.txt', expiresAt: null })
  })
})

describe('service availability check', () => {
  it('reports online when the probe answers, even opaquely', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await expect(isHostOnlineController(HOSTS[0])).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://gofile.io', expect.objectContaining({ mode: 'no-cors', cache: 'no-store' }))
  })

  it('reports offline when the probe fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(isHostOnlineController(HOSTS[1])).resolves.toBe(false)
  })

  it('refuses to upload to a host that is down', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(storeSource(textFile(), 'litterbox', 'f1', fakeRepo(), '1h')).rejects.toThrow('O Litterbox parece fora do ar agora')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('uploads', () => {
  it('uploads to Gofile and keeps the download page with no expiry', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', data: { downloadPage: 'https://gofile.io/d/abc' } }))
    await expect(uploadToGofileController(textFile())).resolves.toEqual({ url: 'https://gofile.io/d/abc', expiresAt: null })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://upload.gofile.io/uploadfile')
    expect((init.body as FormData).get('file')).toBeInstanceOf(File)
  })

  it('uploads to Litterbox with the chosen expiry', async () => {
    fetchMock.mockResolvedValue(new Response('https://litter.catbox.moe/xyz.txt\n'))
    await expect(uploadToLitterboxController(textFile(), '12h')).resolves.toEqual({
      url: 'https://litter.catbox.moe/xyz.txt',
      expiresAt: new Date(NOW + 12 * 3600 * 1000).toISOString(),
    })
    const form = fetchMock.mock.calls[0][1].body as FormData
    expect(form.get('reqtype')).toBe('fileupload')
    expect(form.get('time')).toBe('12h')
    expect((form.get('fileToUpload') as File).name).toBe('notes.txt')
  })

  it('uploads to filebin with a 7 day expiry', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }))
    const hosted = await uploadToFilebinController(textFile('my notes.txt'))
    expect(hosted.url).toMatch(/^https:\/\/filebin\.net\/study-helper-[0-9a-f-]{12}\/my%20notes\.txt$/)
    expect(hosted.expiresAt).toBe(new Date(NOW + 7 * 24 * 3600 * 1000).toISOString())
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'text/plain' } })
  })

  it('uploads to tmpfiles and returns the direct download link', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'success', data: { url: 'https://tmpfiles.org/123/notes.txt' } }))
    await expect(uploadToTmpfilesController(textFile())).resolves.toEqual({
      url: 'https://tmpfiles.org/dl/123/notes.txt',
      expiresAt: new Date(NOW + 3600 * 1000).toISOString(),
    })
  })

  it('reports refusals and missing links as HostingError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 413 }))
    await expect(uploadToGofileController(textFile())).rejects.toThrow(new HostingError('O Gofile recusou o arquivo (413).'))
    fetchMock.mockResolvedValueOnce(new Response('error page'))
    await expect(uploadToLitterboxController(textFile(), '1h')).rejects.toThrow('O Litterbox não devolveu o link.')
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await expect(uploadToTmpfilesController(textFile())).rejects.toThrow('O tmpfiles não respondeu.')
  })

  it('stores through the chosen host after the availability probe', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null)).mockResolvedValueOnce(new Response('https://litter.catbox.moe/a.txt'))
    await expect(storeSource(textFile(), 'litterbox', 'f1', fakeRepo(), '72h')).resolves.toEqual({
      storage: 'litterbox',
      storedUrl: 'https://litter.catbox.moe/a.txt',
      expiresAt: new Date(NOW + 72 * 3600 * 1000).toISOString(),
    })
    expect(fetchMock.mock.calls[0][0]).toBe('https://litterbox.catbox.moe')
  })

  it('stores in Drive through the repository without calling any host', async () => {
    const repo = fakeRepo()
    const file = textFile()
    await expect(storeSource(file, 'drive', 'f1', repo, '1h')).resolves.toEqual({ storage: 'drive', storedFileId: 'drive-file-1', expiresAt: null })
    expect(repo.putSource).toHaveBeenCalledWith('f1', file, 'notes.txt')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stores nothing when ignoring the file', async () => {
    await expect(storeSource(textFile(), 'none', 'f1', fakeRepo(), '1h')).resolves.toEqual({ storage: 'none' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('removing and downloading a stored source', () => {
  it('deletes the Drive file but keeps the name', async () => {
    const repo = fakeRepo()
    const next = await removeStoredSource(origin({ storage: 'drive', storedFileId: 'drive-file-1', expiresAt: null }), repo)
    expect(repo.removeSource).toHaveBeenCalledWith('drive-file-1')
    expect(next.name).toBe('lecture.mp4')
    expect(next.storage).toBe('drive')
    expect(next.storedFileId).toBeUndefined()
    expect(next.removedAt).toBe(new Date(NOW).toISOString())
  })

  it('deletes the filebin file with DELETE', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    const url = 'https://filebin.net/study-helper-abc/lecture.mp4'
    const next = await removeStoredSource(origin({ storage: 'filebin', storedUrl: url }), fakeRepo())
    expect(fetchMock).toHaveBeenCalledWith(url, { method: 'DELETE' })
    expect(next).toMatchObject({ name: 'lecture.mp4', storedUrl: undefined, removedAt: new Date(NOW).toISOString() })
  })

  it('forgets the link of hosts that cannot delete, keeping the name', async () => {
    const next = await removeStoredSource(origin({ storage: 'gofile', storedUrl: 'https://gofile.io/d/abc' }), fakeRepo())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(next).toMatchObject({ name: 'lecture.mp4', storedUrl: undefined })
  })

  it('reports filebin delete failure without throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    await expect(deleteFromFilebinController('https://filebin.net/x/y')).resolves.toBe(false)
  })

  it('downloads the Drive source as a blob', async () => {
    const repo = fakeRepo()
    const source = await downloadStoredSource(origin({ storage: 'drive', storedFileId: 'drive-file-1' }), repo)
    expect(repo.getSource).toHaveBeenCalledWith('drive-file-1')
    expect(source).toBeInstanceOf(Blob)
  })

  it('downloads a hosted source as its link', async () => {
    await expect(downloadStoredSource(origin({ storage: 'litterbox', storedUrl: 'https://litter.catbox.moe/a.mp4' }), fakeRepo())).resolves.toBe('https://litter.catbox.moe/a.mp4')
  })

  it('refuses to download a removed source', async () => {
    const removed = await removeStoredSource(origin({ storage: 'gofile', storedUrl: 'https://gofile.io/d/abc' }), fakeRepo())
    await expect(downloadStoredSource(removed, fakeRepo())).rejects.toThrow('A fonte não está mais guardada.')
  })

  it('knows when a hosted source expired', () => {
    expect(sourceExpired(origin({ expiresAt: new Date(NOW - 1).toISOString() }))).toBe(true)
    expect(sourceExpired(origin({ expiresAt: new Date(NOW + 1000).toISOString() }))).toBe(false)
    expect(sourceExpired(origin({ expiresAt: null }))).toBe(false)
    expect(sourceExpired(null)).toBe(false)
  })
})
