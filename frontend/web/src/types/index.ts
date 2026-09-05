export type InputMode = 'file' | 'url' | 'topic' | 'text'

export type AgentType = 'aula' | 'explicacao' | 'leitura' | 'reuniao'


export type LoadingOperation = 'process' | 'import' | 'load-content' | 'save' | 'export-zip' | 'export-pdf' | 'generate-exam' | 'select-file' | null

export type DiagramBg = 'theme' | 'white' | 'gray' | 'slate' | 'zinc'

export type TempFileStatus = 'generating' | 'complete' | 'error'

export type FileType = 'class' | 'explanation' | 'reading' | 'meeting'

export type TranscriptionProvider = 'local' | 'openai'

export interface ApiConfig {
  whisper_model: string
  transcription_provider?: TranscriptionProvider
  openai_available?: boolean
}

export interface AiStatus {
  available: boolean
  text_model: string | null
}

export interface QuestionsResponse {
  questions: Question[]
  raw?: string
}

export interface Question {
  id: number
  enunciado: string
  alternativas: Record<string, string>
  correta: string
  explicacao: string
  diagrama?: string
}

export interface ImportResponse {
  markdown: string
  questions?: QuestionsResponse
  type?: string
  file_id?: string
}

export interface ExportZipRequest {
  markdown: string
  questions: QuestionsResponse | null
  filename: string
  type?: string
}

export interface FileItem {
  id: string
  hash: string
  name: string
  content: string
  content_type?: string | null
  folder_id?: string | null
  kind: 'file'
  type?: FileType | null
  description?: string | null
  parent_file_id?: string | null
  source_excerpt?: string | null
  questions_count?: number
  created_at: string
  updated_at: string
}

export interface FolderItem {
  id: string
  name: string
  folder_id?: string | null
  kind: 'folder'
  children: TreeNode[]
}

export type TreeNode = FileItem | FolderItem

export interface LineageStep {
  id: string
  name: string
  type?: FileType | null
  source_excerpt?: string | null
}

export interface CreateFolderDto {
  name: string
  folder_id?: string | null
}

export interface UpdateFolderDto {
  name?: string
  folder_id?: string | null
}

export interface CreateFileDto {
  name: string
  content: string
  folder_id?: string | null
  content_type?: string
  type?: FileType
  description?: string
  parent_file_id?: string | null
  source_excerpt?: string | null
}

export interface UpdateFileDto {
  name?: string
  content?: string
  folder_id?: string | null
  content_type?: string
  type?: FileType
  description?: string
}

export interface DbQuestion {
  id: string
  statement: string
  alternative_a: string
  alternative_b: string
  alternative_c: string
  alternative_d: string
  alternative_e: string
  right_alternative: 'A' | 'B' | 'C' | 'D' | 'E'
  explanation?: string | null
  diagram?: string | null
  file_id: string
  created_at: string
  updated_at: string
}

export interface TempFileItem {
  id: string
  name: string
  content: string
  content_type?: string | null
  type?: FileType | null
  description?: string | null
  status?: TempFileStatus | null
  parent_file_id?: string | null
  source_excerpt?: string | null
  created_at: string
}

export interface CreateTempFileDto {
  name: string
  content: string
  content_type?: string
  type?: FileType
  description?: string
  parent_file_id?: string | null
  source_excerpt?: string | null
}

export interface RestoreTempFileDto {
  name?: string
  folder_id?: string | null
  description?: string
}

export interface ContextMenuItem {
  id: string
  label: string
  kind: 'app' | 'browser' | 'divider'
  onClick?: () => void
}

export interface LastOpenedFile {
  fileId: string
  fileName: string
  folderId: string | null
  folderName: string | null
}

export interface AppState {
  generatedMarkdown: string
  questionsData: QuestionsResponse | null
  userAnswers: Record<number, string>
  currentQuestionIndex: number
  isLoading: boolean
  loadingMessage: string
  loadingSubMessage: string
  errorMessage: string | null
  savedFileId: string | null
  savedFileName: string | null
  savedFileType: FileType | null
  savedFileHash: string | null
  savedFolderId: string | null
  savedFolderName: string | null
  lastOpenedFolderId: string | null
}

export type AppAction =
  | { type: 'SET_MARKDOWN'; payload: string }
  | { type: 'SET_QUESTIONS'; payload: QuestionsResponse }
  | { type: 'SET_MARKDOWN_AND_QUESTIONS'; payload: { markdown: string; questions: QuestionsResponse | null } }
  | { type: 'SET_USER_ANSWER'; payload: { questionId: number; answer: string } }
  | { type: 'SET_CURRENT_QUESTION_INDEX'; payload: number }
  | { type: 'SET_LOADING'; payload: { isLoading: boolean; message?: string; subMessage?: string } }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_SAVED_FILE'; payload: { fileId: string | null; fileName: string | null; fileType?: FileType | null; fileHash?: string | null; folderId: string | null; folderName: string | null } }
  | { type: 'SET_LAST_OPENED_FOLDER'; payload: string | null }
  | { type: 'RESET' }
