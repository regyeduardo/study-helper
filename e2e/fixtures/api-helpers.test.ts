import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createFolder,
  deleteFolder,
  createFile,
  deleteFile,
  createQuestion,
  deleteQuestion,
  BASE_URL,
} from './api-helpers'

const API_BASE = `${BASE_URL}/api/v1`

beforeEach(() => {
  vi.restoreAllMocks()
})

// ── Folder helpers ─────────────────────────────────────────────────────────────

describe('createFolder', () => {
  it('POSTs to /api/folders with the correct body and returns the folder', async () => {
    const mockFolder = { id: 'folder-1', name: 'Test Folder' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => mockFolder,
    } as Response)

    const result = await createFolder('Test Folder')

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Folder' }),
    })
    expect(result).toEqual(mockFolder)
  })

  it('POSTs with parentId when provided', async () => {
    const mockFolder = { id: 'folder-2', name: 'Child Folder' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => mockFolder,
    } as Response)

    await createFolder('Child Folder', 'parent-1')

    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/folders`,
      expect.objectContaining({
        body: JSON.stringify({ name: 'Child Folder', folder_id: 'parent-1' }),
      }),
    )
  })

  it('throws a descriptive error on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ message: 'Folder already exists' }),
    } as Response)

    await expect(createFolder('Duplicate')).rejects.toThrow(
      /409.*folder already exists/i,
    )
  })
})

describe('deleteFolder', () => {
  it('DELETEs /api/folders/:id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    await deleteFolder('folder-1')

    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/folders/folder-1`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    })
  })

  it('throws a descriptive error on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'Folder not found' }),
    } as Response)

    await expect(deleteFolder('nonexistent')).rejects.toThrow(
      /404.*folder not found/i,
    )
  })
})

// ── File helpers ───────────────────────────────────────────────────────────────

describe('createFile', () => {
  it('POSTs to /api/files with the correct body', async () => {
    const mockFile = { id: 'file-1', name: 'lesson.md' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => mockFile,
    } as Response)

    const result = await createFile({
      name: 'lesson.md',
      folderId: 'folder-1',
      content: '# Lesson',
      file_type: 'class',
    })

    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'lesson.md',
        folder_id: 'folder-1',
        content: '# Lesson',
        type: 'class',
      }),
    })
    expect(result).toEqual(mockFile)
  })

  it('throws a descriptive error on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ message: 'Invalid file type' }),
    } as Response)

    await expect(
      createFile({
        name: 'bad.md',
        folderId: 'folder-1',
        content: '',
        file_type: 'invalid' as any,
      }),
    ).rejects.toThrow(/400.*invalid file type/i)
  })
})

describe('deleteFile', () => {
  it('DELETEs /api/files/:id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    await deleteFile('file-1')

    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/files/file-1`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

// ── Question helpers ───────────────────────────────────────────────────────────

describe('createQuestion', () => {
  it('PUTs em /files/:id/questions e devolve o id da primeira questão', async () => {
    const mockQuestions = [{ id: 'q-1', statement: 'What is 2+2?' }]
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockQuestions,
    } as Response)

    const result = await createQuestion({
      fileId: 'file-1',
      question: 'What is 2+2?',
      options: ['3', '4', '5', '6', '7'],
      correctIndex: 1,
    })

    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/files/file-1/questions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions: [
          {
            statement: 'What is 2+2?',
            alternative_a: '3',
            alternative_b: '4',
            alternative_c: '5',
            alternative_d: '6',
            alternative_e: '7',
            right_alternative: 'B',
          },
        ],
      }),
    })
    expect(result).toEqual({ id: 'q-1' })
  })

  it('maps correctIndex to the right right_alternative letter', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 'q-2', statement: 'Test' }],
    } as Response)

    await createQuestion({
      fileId: 'file-1',
      question: 'Test',
      options: ['A', 'B', 'C', 'D', 'E'],
      correctIndex: 0, // should map to 'A'
    })

    const callBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    )
    expect(callBody.questions[0].right_alternative).toBe('A')
  })
})

describe('deleteQuestion', () => {
  it('DELETEs /api/questions?file_id=xxx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    await deleteQuestion('file-1')

    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE}/files/file-1/questions`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      },
    )
  })
})
