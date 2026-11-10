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
  /** Questões da web: the page the real question was found on. */
  fonte?: string
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

export type SourceInput = 'file' | 'url' | 'youtube' | 'topic' | 'text' | 'recording' | 'import' | 'shared'

export type SourceStorage = 'none' | 'drive' | 'gofile' | 'litterbox' | 'filebin' | 'tmpfiles' | 'onlyfiles'

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

export interface StageTime {
  stage: string
  ms: number
}

export interface GenerationMeta {
  stages?: StageTime[]
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

/** What the generation dialog picked for a note made from another. */
/** What the AI analyzes of a video (FR-046): only the media, only the transcription, or both in the same call. An audio always goes by its transcription. */
export type MediaAnalysis = 'video' | 'transcricao' | 'ambos'

export interface GenerationChoice {
  /** "Modelo da IA" (uid): the one picked, or the default of that moment. */
  model?: string
  everyStep?: boolean
  /** The Ata of a recording: its "Modelo da ata", or the parts of Padrão. */
  ataModel?: AtaModelId
  parts?: AtaPart[]
  /** "Instrução extra para a IA": where to focus, as typed. */
  instruction?: string
  /** What the AI analyzed of a video, for "Gerar de novo". Absent: the note did not come from a choice. */
  analyze?: MediaAnalysis
  at: string
}

export interface StampedChange {
  at: string
  deviceId: string
  deviceName: string
}

export interface FileMeta {
  id: string
  name: string
  /** Ausente = nota. */
  role?: 'entrada'
  /** Só em entrada: o que foi guardado da fonte. */
  kept?: 'registro' | 'arquivo'
  /** Id da raiz de um "Apagar tudo": restaurar traz todos com a mesma marca. */
  trashedWith?: string
  /** Só em entrada importada de um link: o id do compartilhamento, para a próxima importação virar "(cópia N)". */
  sharedFrom?: string
  folderId: string | null
  type: FileType
  description: string
  status: FileStatus
  position: number
  favorite: boolean
  tags: string[]
  suggestedTags?: string[]
  /** Due dates of the cards of every deck of the note. */
  cardDue?: string[]
  hasMindmap?: boolean
  artifacts?: ArtifactSummary[]
  parentFileId: string | null
  sourceExcerpt: string | null
  pendingExcerpt: string | null
  origin: SourceMeta | null
  generation: GenerationMeta | null
  /** Note made from another: the choices of its last generation, for "Gerar de novo". */
  made?: GenerationChoice
  created: StampedChange
  updated: StampedChange
  deletedAt: string | null
  words: number
  readingMinutes: number
  mastery: number | null
  lastReviewedAt: string | null
  questionCount: number
}

export interface TranscriptBlock {
  speaker: string
  start: number
  end: number
  text: string
  original?: string
}

export interface RecordingSpeaker {
  id: string
  name: string
  suggested: boolean
}

export interface RecordingMark {
  id: string
  kind: 'mark' | 'note'
  at: number
  text: string
}

export interface ScreenFrame {
  at: number
  image: string
  text: string
}

/** The screens the transcription found in the recorded video (visão 4.1), kept so the Ata does not look again. No images. */
export interface ScreenIndex {
  /** Size of the video it was found in: the area is in these pixels. */
  width: number
  height: number
  /** The shared area. */
  area: { x: number; y: number; w: number; h: number }
  /** Each distinct screen from `at` to `end` (seconds), with what the local OCR read on it; no `texts` when it was not read. */
  screens: { at: number; end: number; texts?: { text: string; confidence: number }[] }[]
}

export interface RecordingData {
  blocks: TranscriptBlock[]
  speakers: RecordingSpeaker[]
  marks: RecordingMark[]
  warning?: string
  frames?: ScreenFrame[]
  /** Terms the local OCR read on the screen with certainty (voted across frames): the review corrects by them. */
  screenTerms?: string[]
  /** The distinct screens of the video and their OCR, found by the transcription; the Ata reuses it. */
  screenIndex?: ScreenIndex
}

export type AtaPart = 'resumo' | 'tarefas' | 'perguntas' | 'linha' | 'um-a-um'

/** Known minutes models (modelos-de-ata/01..15): the Ata comes out as ONE document in that skeleton. */
export type AtaModelId = 'fathom' | 'fireflies' | 'google-meet' | 'zoom-ai' | 'read-ai' | 'tldv' | 'ata-executiva' | 'confluence' | 'adi' | 'decision-first' | 'decisoes-proximos-passos' | 'kt' | 'cornell' | 'adr' | 'raid'

export interface AtaImage {
  name: string
  dataUrl: string
}

export interface MeetingDocument {
  id: string
  kind: 'ata'
  parts: AtaPart[]
  /** The model chosen in "Modelo da ata"; absent for "Padrão" (the parts). */
  ataModel?: { id: AtaModelId; name: string }
  markdown: string
  images: AtaImage[]
  createdAt: string
  models: Record<string, string>
  costUsd?: number
  stages?: StageTime[]
}

export interface FileSidecar {
  meta: FileMeta
  questions: StoredQuestion[]
  attempts: Attempt[]
  highlights: Highlight[]
  transcript?: string
  recording?: RecordingData
  /** Old single deck: read once and moved into `artifacts`. */
  cards?: StudyCard[]
  /** Old single map: read once and moved into `artifacts`. */
  mindmap?: MindNode
  documents?: MeetingDocument[]
  artifacts?: Artifact[]
}

export interface StudyCard {
  id: string
  front: string
  back: string
  box: number
  due: string
}

export interface MindNode {
  title: string
  children: MindNode[]
}

/** How a map is drawn: the AI picks it per note, from what the content asks for. */
export type MapForm = 'radial' | 'arvore' | 'fluxo' | 'linha-do-tempo'

/** A node of a map. The shape is free: any depth, any number of children; `mark` only when the content has one (✅, 📌…). */
export interface MapNode {
  id: string
  text: string
  mark?: string
  /** Drawn as a box around its children in the "fluxo" form. */
  group?: boolean
  /** Extra arrows to other nodes, in the "fluxo" form. */
  links?: { to: string; label?: string }[]
  children: MapNode[]
}

export interface MapDiagram {
  form: MapForm
  root: MapNode
}

export interface MapChatTurn {
  who: 'você' | 'ia'
  text: string
  at: string
  /** Ids of the nodes this answer changed in the map. */
  changed?: string[]
}

export type ArtifactKind = 'mapa' | 'cartoes' | 'tutor'

interface ArtifactBase {
  id: string
  kind: ArtifactKind
  name: string
  /** True while the name is the placeholder ("Mapa mental"), until the AI names it. */
  provisionalName?: boolean
  createdAt: string
  updatedAt: string
  /** Model and instruction of its last generation, for "Gerar de novo". */
  made?: GenerationChoice
}

export interface MapArtifact extends ArtifactBase {
  kind: 'mapa'
  diagram: MapDiagram
  /** Earlier diagrams, newest last: "Desfazer" pops one. */
  versions: MapDiagram[]
  /** The map's own conversation (a subartefato). */
  chat: MapChatTurn[]
  /** Nodes changed by the last request: they blink until the next one. */
  highlight?: string[]
}

export interface CardsArtifact extends ArtifactBase {
  kind: 'cartoes'
  cards: StudyCard[]
}

export interface TutorArtifact extends ArtifactBase {
  kind: 'tutor'
  turns: { who: 'você' | 'tutor'; text: string }[]
}

export type Artifact = MapArtifact | CardsArtifact | TutorArtifact

/** What the library knows of a note's artifacts without opening it. */
export interface ArtifactSummary {
  id: string
  kind: ArtifactKind
  name: string
  updatedAt: string
}

/** Ausente = cor padrão. */
export type FolderColor = 'vermelho' | 'laranja' | 'amarelo' | 'verde' | 'azul' | 'roxo' | 'cinza'

export interface FolderMeta {
  id: string
  name: string
  parentId: string | null
  position: number
  description: string
  favorite?: boolean
  color?: FolderColor
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

/** Provider types of Configurações › Inteligência artificial › Provedores (all OpenAI format but Anthropic). */
export type AiProviderId =
  | 'deepinfra'
  | 'openrouter'
  | 'vercel'
  | 'deepseek'
  | 'xai'
  | 'anthropic'
  | 'mistral'
  | 'openai'
  | 'gemini'
  | 'groq'
  | 'together'
  | 'custom'

/** One provider the user added: its own key; custom ones also their base URL. */
export interface AiProvider {
  id: string
  type: AiProviderId
  name: string
  key: string
  base: string
}

/** One of "Meus modelos". What it accepts and what it costs are never stored: always read live from the provider. */
export interface AiModel {
  uid: string
  pid: string
  mid: string
  name: string
}

export type AiUse = 'estudo' | 'aula' | 'explicacao' | 'prova' | 'web' | 'cartoes' | 'mapa' | 'tutor' | 'curso' | 'titulo' | 'midia' | 'transcricao' | 'tela' | 'ata'

/** Steps of the Ata ("Avançado: modelo por passo"). */
export type AiStep = 'contexto' | 'tarefas' | 'revisar' | 'semdono' | 'escrever'

export interface AiConfig {
  providers: AiProvider[]
  models: AiModel[]
  /** Model uid per use; absent = inherits (or, for the mothers, no default: chosen at generation time). */
  defaults: Partial<Record<AiUse, string>>
  steps: Partial<Record<AiStep, string>>
}

export interface AiSettings {
  provider: AiProviderId
  baseUrl: string
  apiKey: string
  model: string
}

/** "chat": a model that hears through chat/completions (input_audio), like the video models. */
export type ProviderEngine = 'openai' | 'deepinfra' | 'gemini' | 'custom' | 'chat'

export type TranscriptionEngine = ProviderEngine

export type SpeakersEngine = '' | Exclude<ProviderEngine, 'gemini'>

export interface TranscriptionCredential {
  apiKey: string
  baseUrl: string
  model: string
  extra: string
}

export interface TranscriptionSettings {
  engine: TranscriptionEngine
  language: string
  credentials: Partial<Record<ProviderEngine, TranscriptionCredential>>
  speakersEngine: SpeakersEngine
  terms?: string
}

export type YoutubeReader = 'youtube-transcript' | 'gemini'

export type LayoutId = 'reader' | 'columns' | 'commands' | 'focus'

export type AiCredential = Pick<AiSettings, 'apiKey' | 'model' | 'baseUrl'>

export interface VisionSettings {
  provider: AiProviderId | ''
  model: string
}

export interface AiPassModels {
  context?: string
  candidates?: string
  review?: string
  pending?: string
  write?: string
}

/** One result of "Rodar meu diagnóstico" (data-model.md): one per use + provider + model. */
export interface DiagnosisRecord {
  use: AiUse
  provider: AiProviderId
  model: string
  /** 0 to 10; null when the model was out before the miniature test (catalog or research). */
  score: number | null
  /** US$ per typical note, by the use's ruler; null when the provider does not report a price ("?"). */
  costPerNote: number | null
  at: string
  /** Why it passed or was left out, in one sentence. */
  reason?: string
}

export interface Settings {
  /** Providers, models and defaults per use. Absent in old indexes: derived from the old fields below on load. */
  aiConfig?: AiConfig
  aiDiagnosis?: DiagnosisRecord[]
  /** Old single AI: now kept in step with the Tutor model of aiConfig (read only by old code). */
  ai: AiSettings
  aiCredentials: Partial<Record<AiProviderId, AiCredential>>
  aiPasses?: AiPassModels
  vision?: VisionSettings
  transcription: TranscriptionSettings
  youtube: { reader: YoutubeReader; geminiApiKey: string }
  timezone: string
  layout: LayoutId
  storageLimitBytes: number | null
  examOneAtATime: boolean
}

export interface TrashEntry {
  kind: 'file' | 'folder'
  id: string
  deletedAt: string
}

export type ShareKind = 'file' | 'folder' | 'entrada'

export interface ShareRecord {
  id: string
  kind: ShareKind
  itemId: string
  title: string
  bytes: number
  withExams: boolean
  createdAt: string
  expiresAt: string
}

export interface SharedLink {
  id: string
  kind: ShareKind
  title: string
  openedAt: string
  expiresAt: string
}

export interface SharedFolder {
  id: string
  name: string
  parentId: string | null
  position: number
  isCourse: boolean
  description: string
}

export interface SharedMedia {
  url: string
  mime: string
  size: number
}

export interface SharedFile {
  id: string
  name: string
  folderId: string | null
  type: FileType
  position: number
  description: string
  tags: string[]
  content: string
  questions: StoredQuestion[]
  highlights: Highlight[]
  transcript?: string
  recording?: RecordingData
  documents?: MeetingDocument[]
  /** Só os tipos marcados ao compartilhar: o mapa vai sem conversa, versões nem destaque, com o código Mermaid pronto; os cartões, sem o progresso de revisão. */
  artifacts?: (
    | (Pick<MapArtifact, 'id' | 'kind' | 'name' | 'diagram'> & { mermaid: string })
    | (Pick<CardsArtifact, 'id' | 'kind' | 'name'> & { cards: Pick<StudyCard, 'id' | 'front' | 'back'>[] })
    | Pick<TutorArtifact, 'id' | 'kind' | 'name' | 'turns'>
  )[]
  media?: SharedMedia
  meta?: Partial<FileMeta>
}

export interface ShareContent {
  kind: ShareKind
  title: string
  folders: SharedFolder[]
  files: SharedFile[]
}

export interface SharedItem extends ShareContent {
  version: number
  id: string
  createdAt: string
  expiresAt: string
  mediaExpiresAt?: string
}

export interface LibraryIndex {
  version: number
  settings: Settings
  tags: string[]
  activities: Activity[]
  shares: ShareRecord[]
  sharedWithMe: SharedLink[]
  /** Marca a migração de entradas como feita. */
  entriesMigratedAt?: string
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
