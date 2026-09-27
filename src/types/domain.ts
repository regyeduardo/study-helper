export type FileType = 'class' | 'explanation' | 'reading' | 'meeting'

export type FileStatus = 'ready' | 'pending' | 'generating'

export type QuestionType = 'unica' | 'multipla' | 'certo_errado' | 'ordenar' | 'associar' | 'lacuna'

export type BloomLevel = 'lembrar' | 'aplicar' | 'analisar'

export type Certainty = 1 | 2 | 3

export type UserAnswer = string | string[]

export interface MatchPair {
  esquerda: string
  direita: string
}

export interface ClozeGap {
  opcoes: string[]
  correta: string
}

export interface Question {
  id: number
  storedId?: string
  tipo?: QuestionType
  formato?: string
  nivel?: BloomLevel | null
  enunciado: string
  alternativas: Record<string, string>
  correta?: string
  corretas?: string[]
  certo?: boolean
  passos?: string[]
  pares?: MatchPair[]
  lacunas?: ClozeGap[]
  explicacao: string
  explicacao_das_erradas?: Record<string, string>
  diagrama?: string | null
  letraOriginal?: Record<string, string>
  ordemInicial?: string[]
  direitas?: string[]
}

export type StoredQuestion = Omit<Question, 'id' | 'letraOriginal' | 'ordemInicial' | 'direitas'> & { storedId: string }

export interface AttemptAnswer {
  questionId: string
  answer: string | null
  score: number
  certainty: Certainty | null
}

export interface Attempt {
  id: string
  createdAt: string
  deviceId: string
  total: number
  correct: number
  answers: AttemptAnswer[]
}

export type HighlightColor = 'yellow' | 'green' | 'pink'

export interface Highlight {
  id: string
  kind: 'highlight' | 'note'
  quote: string
  text: string
  color: HighlightColor
  startOffset: number | null
  endOffset: number | null
  createdAt: string
  updatedAt: string
}

export type SourceInput = 'file' | 'url' | 'youtube' | 'topic' | 'text' | 'recording' | 'import'

export type SourceStorage = 'none' | 'drive' | 'gofile' | 'litterbox' | 'filebin' | 'tmpfiles'

export interface SourceMeta {
  input: SourceInput
  name: string
  url?: string
  sizeBytes?: number
  mime?: string
  durationSeconds?: number
  storage: SourceStorage
  storedUrl?: string
  storedFileId?: string
  expiresAt?: string | null
  removedAt?: string | null
}

export interface GenerationMeta {
  provider: string
  model: string
  startedAt: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  estimatedTokens: boolean
  transcriptionEngine?: string
  language?: string
}

export interface StampedChange {
  at: string
  deviceId: string
  deviceName: string
}

export interface FileMeta {
  id: string
  name: string
  folderId: string | null
  type: FileType
  description: string
  status: FileStatus
  position: number
  favorite: boolean
  tags: string[]
  parentFileId: string | null
  sourceExcerpt: string | null
  pendingExcerpt: string | null
  origin: SourceMeta | null
  generation: GenerationMeta | null
  created: StampedChange
  updated: StampedChange
  deletedAt: string | null
  words: number
  readingMinutes: number
  mastery: number | null
  lastReviewedAt: string | null
  questionCount: number
}

export interface FileSidecar {
  meta: FileMeta
  questions: StoredQuestion[]
  attempts: Attempt[]
  highlights: Highlight[]
}

export interface FolderMeta {
  id: string
  name: string
  parentId: string | null
  position: number
  description: string
  isCourse: boolean
  courseOrigin: string | null
  courseDescription: string | null
  courseMaterial: string | null
  created: StampedChange
  updated: StampedChange
  deletedAt: string | null
}

export type ActivityStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface Activity {
  id: string
  kind: string
  label: string
  origin: string
  destination: string
  fileId: string | null
  status: ActivityStatus
  detail: string
  createdAt: string
  finishedAt: string | null
  deviceId: string
}

export type AiProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'groq'
  | 'openrouter'
  | 'xai'
  | 'ollama'
  | 'pollinations'
  | 'llm7'
  | 'custom'

export interface AiSettings {
  provider: AiProviderId
  baseUrl: string
  apiKey: string
  model: string
}

export type TranscriptionEngine = 'whisper' | 'parakeet' | 'groq' | 'puter'

export interface TranscriptionSettings {
  engine: TranscriptionEngine
  groqApiKey: string
  language: string
  separateSpeakers: boolean
}

export type YoutubeReader = 'youtube-transcript' | 'gemini'

export type LayoutId = 'reader' | 'columns' | 'commands' | 'focus'

export interface Settings {
  ai: AiSettings
  transcription: TranscriptionSettings
  youtube: { reader: YoutubeReader; geminiApiKey: string }
  timezone: string
  githubToken: string
  layout: LayoutId
  storageLimitBytes: number | null
}

export interface TrashEntry {
  kind: 'file' | 'folder'
  id: string
  deletedAt: string
}

export interface LibraryIndex {
  version: number
  settings: Settings
  tags: string[]
  activities: Activity[]
  updated: StampedChange
}

export interface DeviceRecord {
  id: string
  name: string
  lastSeen: string
  accountId: string
}

export interface Snapshot {
  folders: FolderMeta[]
  files: FileMeta[]
  index: LibraryIndex
}

export interface CoursePlanLesson {
  title: string
  covers: string
  excerpt: string
}

export interface CoursePlanModule extends CoursePlanLesson {
  lessons: CoursePlanLesson[]
}

export interface CourseAnalysis {
  isCourse: boolean
  name: string
  description: string
  modules: CoursePlanModule[]
  lessonCount: number
}
