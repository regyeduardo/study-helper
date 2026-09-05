import type {
  AiStatus,
  ApiConfig,
  CreateFileDto,
  CreateFolderDto,
  CreateTempFileDto,
  DbQuestion,
  ExportZipRequest,
  FileItem,
  FolderItem,
  ImportResponse,
  LineageStep,
  QuestionsResponse,
  RestoreTempFileDto,
  TempFileItem,
  TreeNode,
  UpdateFileDto,
  UpdateFolderDto,
  FileType,
} from '@/types'

const API_BASE = '/api/v1'

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init)

  if (response.status === 204) {
    return null as T
  }

  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      if (!response.ok) throw new ApiError(`Erro interno do servidor. (HTTP ${response.status})`, response.status)
      throw new ApiError('Resposta inválida do servidor.', response.status)
    }
  }

  if (!response.ok) {
    const detail = (data as { detail?: string } | null)?.detail
    throw new ApiError(detail || `Erro HTTP ${response.status}`, response.status)
  }

  return data as T
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

async function blob(path: string, init: RequestInit): Promise<Blob> {
  const response = await fetch(`${API_BASE}${path}`, init)
  if (!response.ok) throw new ApiError(`Erro HTTP ${response.status}`, response.status)
  return response.blob()
}

export const api = {
  // ── Meta ──
  getConfig(): Promise<ApiConfig> {
    return request<ApiConfig>('/config')
  },

  getAiStatus(): Promise<AiStatus> {
    return request<AiStatus>('/ai/status')
  },

  // ── Folders ──
  getTree(): Promise<TreeNode[]> {
    return request<TreeNode[]>('/folders/tree')
  },

  getFolders(): Promise<FolderItem[]> {
    return request<FolderItem[]>('/folders')
  },

  createFolder(data: CreateFolderDto): Promise<FolderItem> {
    return request<FolderItem>('/folders', json('POST', data))
  },

  updateFolder(id: string, data: UpdateFolderDto): Promise<FolderItem> {
    return request<FolderItem>(`/folders/${id}`, json('PATCH', data))
  },

  moveFolder(id: string, folderId: string | null): Promise<FolderItem> {
    return request<FolderItem>(`/folders/${id}/move`, json('PATCH', { folder_id: folderId }))
  },

  deleteFolder(id: string): Promise<void> {
    return request<void>(`/folders/${id}`, { method: 'DELETE' })
  },

  getQuestionsByFolder(folderId: string, limit?: number | 'all'): Promise<DbQuestion[]> {
    return request<DbQuestion[]>(`/folders/${folderId}/questions`).then((questions) => {
      if (!limit || limit === 'all') return questions
      return questions.slice(0, limit)
    })
  },

  // ── Files ──
  getFiles(): Promise<FileItem[]> {
    return request<FileItem[]>('/files')
  },

  getFile(id: string): Promise<FileItem> {
    return request<FileItem>(`/files/${id}`)
  },

  createFile(data: CreateFileDto): Promise<FileItem> {
    return request<FileItem>('/files', json('POST', data))
  },

  getFileByHash(hash: string): Promise<FileItem> {
    return request<FileItem>(`/files/by-hash/${hash}`)
  },

  updateFile(id: string, data: UpdateFileDto): Promise<FileItem> {
    return request<FileItem>(`/files/${id}`, json('PATCH', data))
  },

  moveFile(id: string, folderId: string | null): Promise<FileItem> {
    return request<FileItem>(`/files/${id}/move`, json('PATCH', { folder_id: folderId }))
  },

  deleteFile(id: string): Promise<void> {
    return request<void>(`/files/${id}`, { method: 'DELETE' })
  },

  getLineage(id: string): Promise<LineageStep[]> {
    return request<LineageStep[]>(`/files/${id}/lineage`)
  },

  bulkDeleteFiles(ids: string[]): Promise<void> {
    return request<void>('/files/bulk-delete', json('POST', { ids }))
  },

  bulkMoveFiles(ids: string[], folderId: string | null): Promise<void> {
    return request<void>('/files/bulk-move', json('POST', { ids, folder_id: folderId }))
  },

  bulkExportZip(ids: string[]): Promise<Blob> {
    return blob('/files/bulk-export', json('POST', { ids }))
  },

  // ── Questions ──
  getQuestions(fileId: string): Promise<DbQuestion[]> {
    return request<DbQuestion[]>(`/files/${fileId}/questions`)
  },

  saveQuestions(
    fileId: string,
    questions: Omit<DbQuestion, 'id' | 'file_id' | 'created_at' | 'updated_at'>[],
  ): Promise<DbQuestion[]> {
    return request<DbQuestion[]>(`/files/${fileId}/questions`, json('PUT', { questions }))
  },

  deleteQuestions(fileId: string): Promise<void> {
    return request<void>(`/files/${fileId}/questions`, { method: 'DELETE' })
  },

  // ── Temp files ──
  getTempFiles(): Promise<TempFileItem[]> {
    return request<TempFileItem[]>('/temp-files')
  },

  getTempFile(id: string): Promise<TempFileItem> {
    return request<TempFileItem>(`/temp-files/${id}`)
  },

  getActiveTempFile(): Promise<TempFileItem | null> {
    return request<TempFileItem | null>('/temp-files/active')
  },

  createTempFile(data: CreateTempFileDto): Promise<TempFileItem> {
    return request<TempFileItem>('/temp-files', json('POST', data))
  },

  updateTempFile(id: string, data: { content?: string; status?: string; name?: string }): Promise<TempFileItem> {
    return request<TempFileItem>(`/temp-files/${id}`, json('PATCH', data))
  },

  deleteTempFile(id: string): Promise<void> {
    return request<void>(`/temp-files/${id}`, { method: 'DELETE' })
  },

  lookupTempFile(data: { name?: string; content_type?: string; description?: string }): Promise<TempFileItem[]> {
    return request<TempFileItem[]>('/temp-files/lookup', json('POST', data))
  },

  restoreTempFile(id: string, data: RestoreTempFileDto): Promise<{ file_id: string; file_name: string }> {
    return request<{ file_id: string; file_name: string }>(`/temp-files/${id}/restore`, json('POST', data))
  },

  // ── Generations ──
  generateLesson(content: string, title: string): Promise<{ markdown: string; temp_file_id?: string }> {
    return request<{ markdown: string; temp_file_id?: string }>('/generations/lessons', json('POST', { content, title }))
  },

  regenerateContent(content: string, title?: string, type?: FileType): Promise<{ markdown: string }> {
    return request<{ markdown: string }>('/generations/regenerations', json('POST', { content, title, type }))
  },

  generateQuestions(markdown: string, title: string, fileId?: string, type?: string): Promise<QuestionsResponse> {
    return request<QuestionsResponse>(
      '/generations/questions',
      json('POST', { markdown, title, file_id: fileId, type }),
    )
  },

  generateReadingExam(content: string, title: string): Promise<QuestionsResponse> {
    return request<QuestionsResponse>('/generations/reading-exams', json('POST', { content, title }))
  },

  // ── Sources ──
  fetchContent(url: string, language = 'en'): Promise<{ title: string; content: string }> {
    const body = new FormData()
    body.append('url', url)
    body.append('language', language)
    return request<{ title: string; content: string }>('/sources/fetch', { method: 'POST', body })
  },

  // ── Imports / exports ──
  previewFile(file: File): Promise<ImportResponse> {
    const body = new FormData()
    body.append('file', file)
    return request<ImportResponse>('/imports/preview', { method: 'POST', body })
  },

  importFile(file: File, folderId?: string | null): Promise<ImportResponse> {
    const body = new FormData()
    body.append('file', file)
    if (folderId) body.append('folder_id', folderId)
    return request<ImportResponse>('/imports/files', { method: 'POST', body })
  },

  exportZip(data: ExportZipRequest): Promise<Blob> {
    return blob('/exports/zip', json('POST', data))
  },
}
