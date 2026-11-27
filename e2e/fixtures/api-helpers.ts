import { expect, test as base } from '@playwright/test'

// ── Constants ──────────────────────────────────────────────────────────────────

export const BASE_URL = 'http://localhost:8000'
const API_BASE = `${BASE_URL}/api/v1`

const INDEX_TO_LETTER = ['A', 'B', 'C', 'D', 'E'] as const

// ── Internal helper ────────────────────────────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })

  if (!res.ok) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = await res.text().catch(() => '(empty body)')
    }
    throw new Error(
      `API error ${res.status} for ${options.method ?? 'GET'} ${url}: ${JSON.stringify(body)}`,
    )
  }

  // 204 No Content — nothing to parse
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}

// ── Folder helpers ─────────────────────────────────────────────────────────────

export async function createFolder(
  name: string,
  parentId?: string,
): Promise<{ id: string; name: string }> {
  const body: Record<string, string> = { name }
  if (parentId) body.folder_id = parentId

  return request<{ id: string; name: string }>('/folders', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function deleteFolder(id: string): Promise<void> {
  return request<void>(`/folders/${id}`, { method: 'DELETE' })
}

// ── File helpers ───────────────────────────────────────────────────────────────

export type FileType = 'class' | 'explanation' | 'reading'

/** Shape of a file returned by GET /api/files */
export interface ApiFileItem {
  id: string
  name: string
  content: string
  content_type: string | null
  folder_id: string | null
  type: string | null
  description: string | null
  created_at: string
  updated_at: string
  questions_count?: number
  parent_file_id?: string | null
  source_excerpt?: string | null
}

interface CreateFilePayload {
  name: string
  folderId: string
  content: string
  file_type: FileType
}

export async function createFile(
  payload: CreateFilePayload,
): Promise<{ id: string; name: string }> {
  // The backend uses 'type' for the file type discriminator, and it's an
  // optional field. We map file_type -> type for the API.
  const body: Record<string, string | undefined> = {
    name: payload.name,
    folder_id: payload.folderId,
    content: payload.content,
  }
  if (payload.file_type) body.type = payload.file_type

  return request<{ id: string; name: string }>('/files', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getFiles(): Promise<ApiFileItem[]> {
  return request<ApiFileItem[]>('/files')
}

export async function deleteFile(id: string): Promise<void> {
  return request<void>(`/files/${id}`, { method: 'DELETE' })
}

// ── Question helpers ───────────────────────────────────────────────────────────

interface CreateQuestionPayload {
  fileId: string
  question: string
  options: string[]
  correctIndex: number
}

export async function createQuestion(
  payload: CreateQuestionPayload,
): Promise<{ id: string }> {
  const { fileId, question, options, correctIndex } = payload

  // Map the array of 5 options to alternative_a … alternative_e
  const alternatives = {
    alternative_a: options[0] ?? '',
    alternative_b: options[1] ?? '',
    alternative_c: options[2] ?? '',
    alternative_d: options[3] ?? '',
    alternative_e: options[4] ?? '',
  }

  const right_alternative = INDEX_TO_LETTER[correctIndex] ?? 'A'

  const questions = await request<Array<{ id: string }>>(`/files/${fileId}/questions`, {
    method: 'PUT',
    body: JSON.stringify({
      questions: [
        {
          statement: question,
          ...alternatives,
          right_alternative,
        },
      ],
    }),
  })

  return { id: questions[0]?.id ?? '' }
}

/**
 * Creates multiple questions in a single bulk API call.
 *
 * IMPORTANT: PUT /files/:id/questions REPLACES all questions of the file.
 * Always pass ALL desired questions in a single call.
 */
export async function createQuestionsBulk(
  fileId: string,
  questions: Array<{
    question: string
    options: string[]
    correctIndex: number
  }>,
): Promise<void> {
  const mapped = questions.map((q) => {
    const alternatives = {
      alternative_a: q.options[0] ?? '',
      alternative_b: q.options[1] ?? '',
      alternative_c: q.options[2] ?? '',
      alternative_d: q.options[3] ?? '',
      alternative_e: q.options[4] ?? '',
    }
    const right_alternative = INDEX_TO_LETTER[q.correctIndex] ?? 'A'
    return {
      statement: q.question,
      ...alternatives,
      right_alternative,
    }
  })

  await request<Array<{ id: string }>>(`/files/${fileId}/questions`, {
    method: 'PUT',
    body: JSON.stringify({ questions: mapped }),
  })
}

export async function deleteQuestion(fileId: string): Promise<void> {
  return request<void>(`/files/${fileId}/questions`, { method: 'DELETE' })
}

// ── Question retrieval ─────────────────────────────────────────────────────────

export interface DbQuestion {
  id: string
  file_id: string
  statement: string
  alternative_a: string
  alternative_b: string
  alternative_c: string
  alternative_d: string
  alternative_e: string
  right_alternative: string
  explanation: string | null
  diagram: string | null
  created_at: string
  updated_at: string
}

export async function getQuestions(fileId: string): Promise<DbQuestion[]> {
  return request<DbQuestion[]>(`/files/${fileId}/questions`)
}

// ── Playwright fixture ─────────────────────────────────────────────────────────

/**
 * Asserts that a file was persisted in the given folder via GET /api/files.
 *
 * Calls `getFiles()` internally, finds the file whose `folder_id` matches,
 * verifies that `content` is non-empty, and returns the file ID for teardown.
 *
 * @throws {Error} via Playwright `expect` if no file is found or content is empty.
 */
export async function expectFileSavedInFolder(folderId: string): Promise<string> {
  const allFiles = await getFiles()
  const savedFile = allFiles.find((f) => f.folder_id === folderId)

  expect(savedFile, `Expected a file saved in folder ${folderId}`).toBeDefined()
  expect(savedFile!.content, 'Saved file content should not be empty').not.toBe('')

  return savedFile!.id
}

/**
 * Fetches a single file by its ID via GET /api/files/:id.
 *
 * Returns the full ApiFileItem including created_at and updated_at timestamps.
 */
export async function getFileById(id: string): Promise<ApiFileItem> {
  return request<ApiFileItem>(`/files/${id}`)
}

export interface LineageStep {
  id: string
  name: string
  type: string | null
  source_excerpt: string | null
}

export async function getLineage(fileId: string): Promise<LineageStep[]> {
  return request<LineageStep[]>(`/files/${fileId}/lineage`)
}

export interface ApiHelpers {
  createFolder: typeof createFolder
  deleteFolder: typeof deleteFolder
  createFile: typeof createFile
  getFiles: typeof getFiles
  getFileById: typeof getFileById
  deleteFile: typeof deleteFile
  createQuestion: typeof createQuestion
  createQuestionsBulk: typeof createQuestionsBulk
  deleteQuestion: typeof deleteQuestion
  getQuestions: typeof getQuestions
  expectFileSavedInFolder: typeof expectFileSavedInFolder
  getLineage: typeof getLineage
}

export const test = base.extend<{ apiHelpers: ApiHelpers }>({
  apiHelpers: async ({}, use) => {
    use({
      createFolder,
      deleteFolder,
      createFile,
      getFiles,
      getFileById,
      deleteFile,
      createQuestion,
      createQuestionsBulk,
      deleteQuestion,
      getQuestions,
      expectFileSavedInFolder,
      getLineage,
    })
  },
})
