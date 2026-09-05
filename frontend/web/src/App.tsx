import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppState, useAppDispatch, useTabs } from '@/context/AppContext'
import type { TabsAction } from '@/context/AppContext'
import { api } from '@/api/client'
import { forcePaint, getTitleFromMarkdown, getRawTitleFromMarkdown, downloadBlob, getStorageItem, setStorageItem, removeStorageItem } from '@/lib/utils'
import { Home, FolderKanban, Bot, Sparkles, Upload, Download, ClipboardList, BookOpen, Settings } from 'lucide-react'
import type { InputMode, AgentType, DiagramBg, FileItem, FolderItem, QuestionsResponse, LastOpenedFile, LoadingOperation, TranscriptionProvider } from '@/types'
import { useSSELesson, type SSELessonState, type SSELessonActions } from '@/hooks/useSSELesson'

/**
 * Watches ONE generation slot for completion and for the "already running" conflict
 * error, and commits the result into whichever tab currently owns that slot — not
 * necessarily the active one, since the owning tab may no longer be on screen.
 */
function useSlotWatcher(params: {
  lesson: SSELessonState
  slotIndex: number
  slotOfTab: Record<string, number>
  backgroundCompleteByTab: Record<string, boolean>
  setBackgroundCompleteByTab: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setStreamingOpenByTab: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setLoadingOperation: (value: LoadingOperation) => void
  dispatch: React.Dispatch<TabsAction>
}) {
  const {
    lesson, slotIndex, slotOfTab, backgroundCompleteByTab,
    setBackgroundCompleteByTab, setStreamingOpenByTab, setLoadingOperation, dispatch,
  } = params
  const owningTabId = Object.keys(slotOfTab).find(id => slotOfTab[id] === slotIndex)
  const isBackground = owningTabId ? (backgroundCompleteByTab[owningTabId] ?? false) : false

  useEffect(() => {
    if (!owningTabId || !isBackground || !lesson.complete) return
    setBackgroundCompleteByTab(prev => ({ ...prev, [owningTabId]: false }))
    dispatch({ type: 'SET_LOADING', payload: { isLoading: false }, tabId: owningTabId })
    setLoadingOperation(null)
    const conteudo = lesson.finalMarkdown || (lesson.lessonText + '\n' + Object.values(lesson.diagrams).join('\n\n'))
    dispatch({ type: 'SET_MARKDOWN', payload: conteudo, tabId: owningTabId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.complete, isBackground, owningTabId])

  useEffect(() => {
    if (!owningTabId || !lesson.error) return
    // Any failure — not just the "já está em andamento" conflict — must surface and stop
    // the loading state; otherwise a plain 500 (bad upload, YouTube fetch failure, etc.)
    // leaves the tab spinning forever with no feedback at all.
    if (!lesson.lessonText && !lesson.complete) {
      dispatch({ type: 'SET_ERROR', payload: lesson.error, tabId: owningTabId })
      setStreamingOpenByTab(prev => ({ ...prev, [owningTabId]: false }))
    }
    if (isBackground) {
      dispatch({ type: 'SET_ERROR', payload: lesson.error, tabId: owningTabId })
      setBackgroundCompleteByTab(prev => ({ ...prev, [owningTabId]: false }))
      dispatch({ type: 'SET_LOADING', payload: { isLoading: false }, tabId: owningTabId })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson.error, lesson.lessonText, lesson.complete, owningTabId, isBackground])
}

/** Shown for a tab that has never started a generation — never a real slot's data. */
const IDLE_LESSON: SSELessonState & SSELessonActions = {
  lessonText: '',
  diagrams: {},
  finalMarkdown: '',
  suggestion: null,
  complete: false,
  tempFileId: null,
  error: null,
  connecting: false,
  active: false,
  originalTitle: '',
  originalDescription: '',
  start: () => {},
  startJson: () => {},
  abort: () => {},
  reset: () => {},
}
import Card from '@/components/layout/Card'
import Dock from '@/components/layout/Dock'
import NewContentModal from '@/components/input/NewContentModal'
import SettingsModal from '@/components/settings/SettingsModal'
import OutputPanel from '@/components/output/OutputPanel'
import ActionBar from '@/components/output/ActionBar'
import ExamModal from '@/components/exam/ExamModal'
import ResultModal from '@/components/exam/ResultModal'
import FolderExamDialog from '@/components/exam/FolderExamDialog'
import RegenerateDialog from '@/components/exam/RegenerateDialog'
import FileManagerPage from '@/components/io/FileManagerPage'
import BorderGlow from '@/components/reactbits/BorderGlow'
import NotificationBar from '@/components/ui/NotificationBar'
import LoadingOverlay from '@/components/ui/LoadingOverlay'
import GenerationModeModal from '@/components/lesson/GenerationModeModal'
import { ExplainFromLessonModal } from '@/components/lesson/ExplainFromLessonModal'
import StreamingLessonView from '@/components/lesson/StreamingLessonView'
import LiveModeDockItem from '@/components/layout/LiveModeDockItem'
import LiveModeSaveModal from '@/components/layout/LiveModeSaveModal'
import type { LiveModeSaveParams } from '@/components/layout/LiveModeSaveModal'
import ReadingViewer from '@/components/reading/ReadingViewer'
import SelectionMenu from '@/components/reading/SelectionMenu'
import ExplainSelectionModal from '@/components/lesson/ExplainSelectionModal'
import LineageTimeline from '@/components/output/LineageTimeline'
import TabsBar from '@/components/layout/TabsBar'

export default function App() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const { activeId, createTab } = useTabs()
  const [mode, setMode] = useState<InputMode>('file')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [inputUrl, setInputUrl] = useState('')
  const [inputUrlValid, setInputUrlValid] = useState(true)
  const [agent, setAgent] = useState<AgentType>('aula')
  const [selectionExcerpt, setSelectionExcerpt] = useState<string | null>(null)
  const [topic, setTopic] = useState('')
  const [prompt, setPrompt] = useState('')
  const [generationName, setGenerationName] = useState('')
  const [generationDescription, setGenerationDescription] = useState('')
  const [language, setLanguage] = useState('')
  const [transcriptionProvider, setTranscriptionProvider] = useState<TranscriptionProvider>('local')
  const [openaiAvailable, setOpenaiAvailable] = useState(false)
  const [generateQuestions, setGenerateQuestions] = useState(false)
  const [examOpen, setExamOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [loadingOperation, setLoadingOperation] = useState<LoadingOperation>(null)
  const [regenerating, setRegenerating] = useState(false)
  // Reading state
  const [readingText, setReadingText] = useState('')
  const [readingName, setReadingName] = useState('')
  const [readingLoading, setReadingLoading] = useState(false)
  const [readingError, setReadingError] = useState('')
  const [newContentOpen, setNewContentOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [folderExamOpen, setFolderExamOpen] = useState(false)
  const [folderExamTarget, setFolderExamTarget] = useState<{ folderId: string; folderName: string; totalQuestions: number } | null>(null)
  const [diagramBg, setDiagramBg] = useState<DiagramBg>(() => {
    try {
      const raw = localStorage.getItem('diagram-bg')
      if (!raw) return 'theme'
      return JSON.parse(raw) as DiagramBg
    } catch {
      return 'theme'
    }
  })

  // Every save used to hardcode 'class', so an explicação or an ata was filed as an aula.
  const TIPO_DO_AGENTE = {
    aula: 'class',
    explicacao: 'explanation',
    reuniao: 'meeting',
    leitura: 'reading',
  } as const

  // SSE streaming state — a small FIXED pool of independent connections, so up to
  // three tabs can generate at once. Each tab that starts a generation is assigned a
  // free slot; the slot keeps running regardless of which tab is active, because it
  // is a real hook instance mounted unconditionally, not something tied to the
  // currently-displayed tab. `lesson` below is only an ALIAS to whichever slot the
  // ACTIVE tab owns — every existing reference to `lesson.*` in this file therefore
  // keeps working unchanged, it just now follows the active tab instead of being global.
  const lessonSlots = [useSSELesson(), useSSELesson(), useSSELesson()] as const
  const [slotOfTab, setSlotOfTab] = useState<Record<string, number>>({})
  const [streamingOpenByTab, setStreamingOpenByTab] = useState<Record<string, boolean>>({})

  const acquireSlot = useCallback((tabId: string): number | null => {
    const jaAtribuido = slotOfTab[tabId]
    if (jaAtribuido !== undefined) return jaAtribuido
    const ocupados = new Set(Object.values(slotOfTab))
    const livre = [0, 1, 2].find(i => !ocupados.has(i))
    if (livre === undefined) return null
    setSlotOfTab(prev => ({ ...prev, [tabId]: livre }))
    return livre
  }, [slotOfTab])

  const lessonSlot = slotOfTab[activeId]
  const lesson = lessonSlot !== undefined ? lessonSlots[lessonSlot] : IDLE_LESSON
  // Final lesson markdown (diagrams already inlined by the backend); falls back to
  // the streamed text plus the diagrams when `lesson_complete` never arrived.
  const lessonMarkdown = () =>
    lesson.finalMarkdown || (lesson.lessonText + '\n' + Object.values(lesson.diagrams).join('\n\n'))
  const streamingOpen = streamingOpenByTab[activeId] ?? false
  const setStreamingOpen = useCallback((value: boolean) => {
    setStreamingOpenByTab(prev => ({ ...prev, [activeId]: value }))
  }, [activeId])
  const [generationModeOpen, setGenerationModeOpen] = useState(false)
  const [backgroundCompleteByTab, setBackgroundCompleteByTab] = useState<Record<string, boolean>>({})
  // Track the formData for SSE streaming
  const [pendingStreamData, setPendingStreamData] = useState<FormData | null>(null)

  // Polling interval ref for reload recovery
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Live mode state
  const [liveModeSaveModalOpen, setLiveModeSaveModalOpen] = useState(false)
  const [explainFromLessonTarget, setExplainFromLessonTarget] = useState<{ id: string; name: string } | null>(null)

  // Derived — true when the active tab itself is the one streaming. Selecting a
  // different saved file used to need a manual override to avoid hijacking the
  // stream view; now it simply opens in its own tab, so there is nothing to override.
  const isViewingStream = streamingOpen

  // Persist diagram bg to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('diagram-bg', JSON.stringify(diagramBg))
    } catch { /* ignore */ }
  }, [diagramBg])

  // Keep the browser URL in sync with whichever file the active tab has open — switching
  // tabs, or clearing/closing the one shown, updates the address bar accordingly. Skips its
  // first run so it doesn't fight the mount-time restore-from-URL effect above, which reads
  // the initial path asynchronously before this state settles.
  const urlSyncMountedRef = useRef(false)
  useEffect(() => {
    if (!urlSyncMountedRef.current) {
      urlSyncMountedRef.current = true
      return
    }
    const target = state.savedFileHash ? `/${state.savedFileHash}` : '/'
    if (window.location.pathname !== target) {
      window.history.replaceState({}, '', target)
    }
  }, [activeId, state.savedFileHash])
  const hasQuestions = (state.questionsData?.questions?.length ?? 0) > 0

  // Fetch config on mount
  useEffect(() => {
    api.getConfig().then((cfg) => {
      if (cfg.transcription_provider) {
        setTranscriptionProvider(cfg.transcription_provider)
      }
      if (typeof cfg.openai_available === 'boolean') {
        setOpenaiAvailable(cfg.openai_available)
      }
    }).catch(() => {})
  }, [])

  // Restore last opened file on mount
  const initialRestoreDoneRef = useRef(false)
  useEffect(() => {
    if (initialRestoreDoneRef.current) return
    initialRestoreDoneRef.current = true

    const codigoNaUrl = window.location.pathname.match(/^\/([a-z0-9]{8})$/)?.[1]
    if (codigoNaUrl) {
      setLoadingOperation('select-file')
      ;(async () => {
        try {
          const fullFile = await api.getFileByHash(codigoNaUrl)
          await syncFileToAppContext(fullFile, fullFile.folder_id ?? null, null)
        } catch {
          window.history.replaceState({}, '', '/')
        } finally {
          setLoadingOperation(null)
        }
      })()
      return
    }

    const lastFile = getStorageItem<LastOpenedFile | null>('last-opened-file', null)
    if (lastFile?.fileId) {
      setLoadingOperation('select-file')
      ;(async () => {
        try {
          const fullFile = await api.getFile(lastFile.fileId)
          await syncFileToAppContext(fullFile, lastFile.folderId, lastFile.folderName)
        } catch {
          removeStorageItem('last-opened-file')
        } finally {
          setLoadingOperation(null)
        }
      })()
    }

    const lastFolderId = getStorageItem<string | null>('last-folder-id', null)
    if (lastFolderId) {
      dispatch({ type: 'SET_LAST_OPENED_FOLDER', payload: lastFolderId })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Reload recovery: read live-generation from localStorage on mount ──
  useEffect(() => {
    const stored = localStorage.getItem('live-generation')
    if (!stored) return

    let parsed: { mode: string; tempFileId: string } | null = null
    try {
      parsed = JSON.parse(stored) as { mode: string; tempFileId: string }
    } catch {
      localStorage.removeItem('live-generation')
      return
    }

    if (!parsed?.tempFileId) {
      localStorage.removeItem('live-generation')
      return
    }

    const { mode, tempFileId } = parsed

    // Fetch the temp file to check its status
    ;(async () => {
      let tempFile
      try {
        tempFile = await api.getTempFile(tempFileId)
      } catch {
        // 404 or other error — stale state
        dispatch({ type: 'SET_ERROR', payload: 'A geração anterior não foi encontrada.' })
        localStorage.removeItem('live-generation')
        return
      }

      if (tempFile.status === 'generating') {
        // Still running — enter polling mode
        if (mode === 'live') {
          setStreamingOpen(true)
        } else {
          // background mode
          setBackgroundCompleteByTab(prev => ({ ...prev, [activeId]: true }))
          dispatch({ type: 'SET_LOADING', payload: { isLoading: true, message: 'Gerando aula em segundo plano...', subMessage: 'Você será notificado quando estiver pronta' } })
          setLoadingOperation('process')
        }

        // Start polling every 2 seconds
        const pollId = setInterval(async () => {
          try {
            const updated = await api.getTempFile(tempFileId)
            if (updated.status === 'complete') {
              dispatch({ type: 'SET_MARKDOWN', payload: updated.content })
              localStorage.removeItem('live-generation')
              setStreamingOpen(false)
              dispatch({ type: 'SET_LOADING', payload: { isLoading: false } })
              setLoadingOperation(null)
              setBackgroundCompleteByTab(prev => ({ ...prev, [activeId]: false }))
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current)
                pollIntervalRef.current = null
              }
            } else if (updated.status === 'error') {
              dispatch({ type: 'SET_ERROR', payload: 'A geração anterior terminou com erro.' })
              localStorage.removeItem('live-generation')
              setStreamingOpen(false)
              dispatch({ type: 'SET_LOADING', payload: { isLoading: false } })
              setLoadingOperation(null)
              setBackgroundCompleteByTab(prev => ({ ...prev, [activeId]: false }))
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current)
                pollIntervalRef.current = null
              }
            }
          } catch {
            // Poll failed — keep trying
          }
        }, 2000)
        pollIntervalRef.current = pollId
      } else if (tempFile.status === 'complete') {
        dispatch({ type: 'SET_MARKDOWN', payload: tempFile.content })
        localStorage.removeItem('live-generation')
      } else {
        // status === 'error'
        dispatch({ type: 'SET_ERROR', payload: 'A geração anterior terminou com erro.' })
        localStorage.removeItem('live-generation')
      }
    })()
  }, [])

  // Cleanup polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [])

  // One watcher per slot: a background tab's generation must land in ITS tab even
  // while a different tab is on screen, not just whichever tab happens to be active.
  useSlotWatcher({ lesson: lessonSlots[0], slotIndex: 0, slotOfTab, backgroundCompleteByTab, setBackgroundCompleteByTab, setStreamingOpenByTab, setLoadingOperation, dispatch })
  useSlotWatcher({ lesson: lessonSlots[1], slotIndex: 1, slotOfTab, backgroundCompleteByTab, setBackgroundCompleteByTab, setStreamingOpenByTab, setLoadingOperation, dispatch })
  useSlotWatcher({ lesson: lessonSlots[2], slotIndex: 2, slotOfTab, backgroundCompleteByTab, setBackgroundCompleteByTab, setStreamingOpenByTab, setLoadingOperation, dispatch })

  // Build the FormData for SSE streaming
  const buildStreamFormData = useCallback(() => {
    const formData = new FormData()
    const agentesDoBackend = { explicacao: 'explanation', reuniao: 'meeting' } as const
    formData.append('agent', agentesDoBackend[agent as keyof typeof agentesDoBackend] ?? 'lesson')
    formData.append('prompt', prompt)
    formData.append('language', language)
    formData.append('transcription_provider', transcriptionProvider)
    if (generationName.trim()) formData.append('name', generationName.trim())
    if (generationDescription.trim()) formData.append('description', generationDescription.trim())

    if (mode === 'topic') {
      formData.append('topic', topic)
    } else if (mode === 'url') {
      formData.append('url', inputUrl)
    } else if (selectedFile) {
      formData.append('file', selectedFile)
    }
    return formData
  }, [agent, prompt, language, transcriptionProvider, mode, topic, inputUrl, selectedFile, generationName, generationDescription])

  const handleProcess = async () => {
    // Validation
    if (mode === 'url' && (!inputUrl || !inputUrlValid)) {
      alert('Por favor, insira uma URL válida.')
      return
    }
    if (mode === 'file' && !selectedFile) {
      alert('Por favor, selecione um arquivo.')
      return
    }
    if (mode === 'topic' && !topic.trim()) {
      alert('Por favor, descreva o assunto ou tema.')
      return
    }

    // Streaming flow: every generating agent goes through it. Leaving 'reuniao' out
    // closed the modal and started nothing, with no error anywhere.
    if (agent === 'aula' || agent === 'explicacao' || agent === 'reuniao') {
      const formData = buildStreamFormData()
      setPendingStreamData(formData)
      setGenerationModeOpen(true)
      return
    }
  }

  const handleCreateReading = async (params: {
    mode: 'text' | 'url' | 'file'
    content?: string
    url?: string
    file?: File
    name: string
  }) => {
    setReadingLoading(true)
    setReadingError('')
    try {
      let content: string

      if (params.mode === 'text' && params.content) {
        // Texto mode: use content directly
        content = params.content
      } else if (params.mode === 'url' && params.url) {
        // Check for YouTube URLs
        const isYoutube = /youtube\.com|youtu\.be/i.test(params.url)
        if (isYoutube) {
          throw new Error('URLs do YouTube não são suportadas para arquivos de leitura.')
        }
        // URL mode: fetch via fetch-content endpoint
        const result = await api.fetchContent(params.url)
        content = result.content
        // Auto-fill name from fetched title if name is still the default
        if (result.title && params.name === 'leitura') {
          setReadingName(result.title)
        }
      } else if (params.mode === 'file' && params.file) {
        // PDF mode: upload via file-management
        const data = await api.previewFile(params.file)
        content = data.markdown || ''
      } else {
        throw new Error('Dados inválidos para criar arquivo de leitura.')
      }

      // Create the reading file via POST /files with type='reading'
      const file = await api.createFile({
        name: params.name,
        content,
        type: 'reading',
      })

      await syncFileToAppContext(file, file.folder_id ?? null, null)
    } catch (e: unknown) {
      setReadingError(`Erro ao criar leitura: ${(e as Error).message}`)
    } finally {
      setReadingLoading(false)
    }
  }

  const handleRealtime = () => {
    if (!pendingStreamData) return
    const slot = acquireSlot(activeId)
    if (slot === null) {
      dispatch({ type: 'SET_ERROR', payload: 'Já há 3 gerações rodando ao mesmo tempo. Espere uma terminar antes de começar outra.' })
      return
    }
    setStreamingOpen(true)
    lessonSlots[slot].start('/api/v1/generations/stream', pendingStreamData)
    setPendingStreamData(null)
  }

  const handleBackground = () => {
    if (!pendingStreamData) return
    const slot = acquireSlot(activeId)
    if (slot === null) {
      dispatch({ type: 'SET_ERROR', payload: 'Já há 3 gerações rodando ao mesmo tempo. Espere uma terminar antes de começar outra.' })
      return
    }
    setBackgroundCompleteByTab(prev => ({ ...prev, [activeId]: true }))
    setLoadingOperation('process')
    dispatch({ type: 'SET_LOADING', payload: { isLoading: true, message: 'Gerando aula em segundo plano...', subMessage: 'Você será notificado quando estiver pronta' } })
    lessonSlots[slot].start('/api/v1/generations/stream', pendingStreamData)
    setPendingStreamData(null)
  }

  const handleExplainFromLesson = ({ fileId, focus }: { fileId: string; focus: string }) => {
    setExplainFromLessonTarget(null)
    const form = new FormData()
    form.append('agent', 'explanation')
    form.append('source_file_id', fileId)
    if (focus) form.append('focus', focus)
    setPendingStreamData(form)
    setGenerationModeOpen(true)
  }

  const handleImport = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.zip'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setLoadingOperation('import')
      dispatch({ type: 'SET_LOADING', payload: { isLoading: true, message: 'Importando conteúdo...' } })
      await forcePaint()
      try {
        // Importing only shows the content — persisting is the user's call, in the folder
        // they choose. Using /imports/files here created a file behind their back, and the
        // later save created a second one with the same content.
        const data = await api.previewFile(file)
        dispatch({ type: 'SET_MARKDOWN', payload: data.markdown })
      } catch (e: unknown) {
        dispatch({ type: 'SET_ERROR', payload: `Erro ao importar: ${(e as Error).message}` })
      } finally {
        dispatch({ type: 'SET_LOADING', payload: { isLoading: false } })
        setLoadingOperation(null)
      }
    }
    input.click()
  }

  // "Carregar conteúdo" - load md/zip content without saving to DB
  const handleLoadContent = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.zip'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setLoadingOperation('load-content')
      dispatch({ type: 'SET_LOADING', payload: { isLoading: true, message: 'Carregando conteúdo...' } })
      await forcePaint()
      try {
        const data = await api.previewFile(file)
        // Load content is an explicit user action — show the content
        dispatch({ type: 'SET_MARKDOWN', payload: data.markdown })
      } catch (e: unknown) {
        dispatch({ type: 'SET_ERROR', payload: `Erro ao carregar: ${(e as Error).message}` })
      } finally {
        dispatch({ type: 'SET_LOADING', payload: { isLoading: false } })
        setLoadingOperation(null)
      }
    }
    input.click()
  }

  // Save content directly to a folder (no modal)
  const [saving, setSaving] = useState(false)
  const handleSaveToFolder = async (folderId: string | null, folderName: string | null) => {
    if (!state.generatedMarkdown) {
      alert('Nenhum conteúdo para salvar.')
      return
    }

    // Derive default name
    const rawTitle = getRawTitleFromMarkdown(state.generatedMarkdown)
    const slugTitle = getTitleFromMarkdown(state.generatedMarkdown)
    const fileName = rawTitle || slugTitle || 'conteudo'
    const description = mode === 'url' ? inputUrl : undefined

    setSaving(true)
    await forcePaint()
    try {
      const fileType = TIPO_DO_AGENTE[agent] ?? 'class'

      if (state.savedFileId) {
        // Update existing file
        await api.updateFile(state.savedFileId, {
          content: state.generatedMarkdown,
          folder_id: folderId,
          name: fileName,
          type: fileType,
          description,
        })
      } else {
        // Create new file
        const file = await api.createFile({
          name: fileName,
          content: state.generatedMarkdown,
          folder_id: folderId,
          content_type: 'markdown',
          type: fileType,
          description,
        })
        dispatch({
          type: 'SET_SAVED_FILE',
          payload: {
            fileId: file.id,
            fileName: file.name,
            fileType: 'class',
            fileHash: file.hash,
            folderId: file.folder_id ?? null,
            folderName: folderName,
          },
        })
        setStorageItem<LastOpenedFile>('last-opened-file', {
          fileId: file.id,
          fileName: file.name,
          folderId: file.folder_id ?? null,
          folderName,
        })
        return
      }

      dispatch({
        type: 'SET_SAVED_FILE',
        payload: {
          fileId: state.savedFileId,
          fileName: fileName,
          fileType: 'class',
          folderId: folderId,
          folderName: folderName,
        },
      })
      setStorageItem<LastOpenedFile>('last-opened-file', {
        fileId: state.savedFileId!,
        fileName,
        folderId,
        folderName,
      })
    } catch (e: unknown) {
      alert(`Erro ao salvar: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  /**
   * Regenerates the currently saved file's content.
   *
   * 1. Sends existing content to the generate-content backend for regeneration
   * 2. Updates the file via the file-management API (PATCH /api/files/:id)
   * 3. Updates the app state with the new content
   */
  const handleRegenerateContent = async () => {
    if (!state.savedFileId || !state.generatedMarkdown) return

    setRegenerating(true)
    dispatch({ type: 'SET_LOADING', payload: { isLoading: true, message: 'Regenerando conteúdo...', subMessage: 'Isso pode levar alguns segundos' } })
    await forcePaint()

    try {
      // 1. Call regenerate endpoint
      const result = await api.regenerateContent(state.generatedMarkdown, undefined, state.savedFileType ?? undefined)
      const newMarkdown = result.markdown

      // 2. Update file via file-management API
      await api.updateFile(state.savedFileId, {
        content: newMarkdown,
      })

      // 3. Update app state
      dispatch({ type: 'SET_MARKDOWN', payload: newMarkdown })

      // Save last-opened-file reference
      setStorageItem<LastOpenedFile>('last-opened-file', {
        fileId: state.savedFileId,
        fileName: state.savedFileName ?? 'conteudo',
        folderId: state.savedFolderId,
        folderName: state.savedFolderName,
      })
    } catch (e: unknown) {
      dispatch({ type: 'SET_ERROR', payload: `Erro ao regenerar: ${(e as Error).message}` })
    } finally {
      dispatch({ type: 'SET_LOADING', payload: { isLoading: false } })
      setRegenerating(false)
    }
  }

  // Save streaming lesson content to a temp file
  const handleSaveTemp = async () => {
    if (lesson.tempFileId) {
      // Temp file already exists from backend auto-save — nothing more to do
      return
    }
    const title = getTitleFromMarkdown(lesson.lessonText) || 'aula'
    await api.createTempFile({
      name: title,
      content: lessonMarkdown(),
      content_type: 'markdown',
      type: TIPO_DO_AGENTE[agent] ?? 'class',
    })
  }

  // Streaming save-to-folder handler — saves lesson content directly
  const handleStreamingSaveToFolder = async (folderId: string | null, folderName: string | null) => {
    const content = lessonMarkdown()
    if (!content.trim()) return

    // Dispatch content so app state is also populated
    dispatch({ type: 'SET_MARKDOWN', payload: content })

    const rawTitle = getRawTitleFromMarkdown(content)
    const slugTitle = getTitleFromMarkdown(content)
    const fileName = rawTitle || slugTitle || 'aula'

    const file = await api.createFile({
      name: fileName,
      content,
      folder_id: folderId,
      content_type: 'markdown',
      type: TIPO_DO_AGENTE[agent] ?? 'class',
    })

    dispatch({
      type: 'SET_SAVED_FILE',
      payload: {
        fileId: file.id,
        fileName: file.name,
        fileType: 'class',
        fileHash: file.hash,
        folderId: folderId,
        folderName: folderName,
      },
    })
  }

  // ── Tab system helpers ──

  /**
   * Sync a loaded file's content into AppContext so downstream
   * operations (save, regenerate, exam) continue to work.
   */
  const syncFileToAppContext = useCallback(async (fullFile: FileItem, folderId: string | null, folderName: string | null) => {
    let questions: QuestionsResponse | null = null
    if ((fullFile.questions_count ?? 0) > 0) {
      try {
        const dbQuestions = await api.getQuestions(fullFile.id)
        if (dbQuestions.length > 0) {
          questions = {
            questions: dbQuestions.map((q, idx) => ({
              id: idx,
              enunciado: q.statement,
              alternativas: {
                A: q.alternative_a,
                B: q.alternative_b,
                C: q.alternative_c,
                D: q.alternative_d,
                E: q.alternative_e,
              },
              correta: q.right_alternative,
              explicacao: q.explanation || '',
              diagrama: q.diagram || undefined,
            })),
          }
        }
      } catch {
        // questions fetch failure is non-fatal
      }
    }
    if (questions) {
      dispatch({ type: 'SET_MARKDOWN_AND_QUESTIONS', payload: { markdown: fullFile.content, questions } })
    } else {
      dispatch({ type: 'SET_MARKDOWN', payload: fullFile.content })
    }
    dispatch({
      type: 'SET_SAVED_FILE',
      payload: {
        fileId: fullFile.id,
        fileName: fullFile.name,
        fileType: fullFile.type,
        fileHash: fullFile.hash,
        folderId,
        folderName,
      },
    })
    setStorageItem<LastOpenedFile>('last-opened-file', {
      fileId: fullFile.id,
      fileName: fullFile.name,
      folderId,
      folderName,
    })
    if (fullFile.hash) {
      window.history.pushState({}, '', `/${fullFile.hash}`)
    }
  }, [dispatch])

  /**
   * Load a file's content for the active tab and sync to AppContext.
   */
  const loadFileContent = useCallback(async (fileId: string, _fileName: string) => {
    setLoadingOperation('select-file')
    dispatch({ type: 'SET_LOADING', payload: { isLoading: true, message: 'Carregando arquivo...' } })
    await forcePaint()
    try {
      const fullFile = await api.getFile(fileId)
      // Find folder info from saved state or localStorage
      const savedFolderId = getStorageItem<string | null>('last-folder-id', null)
      const savedFolderName = getStorageItem<string | null>('last-folder-name', null)
      await syncFileToAppContext(fullFile, savedFolderId, savedFolderName)
    } catch (e: unknown) {
      dispatch({ type: 'SET_ERROR', payload: `Erro ao carregar arquivo: ${(e as Error).message}` })
    } finally {
      dispatch({ type: 'SET_LOADING', payload: { isLoading: false } })
      setLoadingOperation(null)
    }
  }, [dispatch, syncFileToAppContext])

  // Open file manager in current file's folder
  const [paginaArquivosAberta, setPaginaArquivosAberta] = useState(false)

  const handleOpenFileManager = () => {
    setPaginaArquivosAberta(true)
  }

  // Select a file from the manager to open it in a tab
  const handleSelectFileFromManager = async (file: FileItem, folderId: string | null, folderName: string | null) => {
    // The tab you already had open keeps its content — this one just opens beside it.
    // A tab mid-stream has no generatedMarkdown/savedFileId yet, so isViewingStream
    // covers it too: opening a file must not hijack a generation still in progress.
    if (state.generatedMarkdown || state.savedFileId || isViewingStream) createTab()
    setLoadingOperation('select-file')
    dispatch({ type: 'SET_LOADING', payload: { isLoading: true, message: 'Carregando arquivo...' } })
    await forcePaint()
    try {
      const fullFile = await api.getFile(file.id)
      await syncFileToAppContext(fullFile, folderId, folderName)
    } catch (e: unknown) {
      dispatch({ type: 'SET_ERROR', payload: `Erro ao carregar arquivo: ${(e as Error).message}` })
    } finally {
      dispatch({ type: 'SET_LOADING', payload: { isLoading: false } })
      setLoadingOperation(null)
    }
  }

  const handleDownloadMd = () => {
    const conteudo = state.generatedMarkdown || lessonMarkdown()
    if (!conteudo) return
    const title = state.savedFileName || getTitleFromMarkdown(conteudo) || 'conteudo-gerado'
    const blob = new Blob([conteudo], { type: 'text/markdown' })
    downloadBlob(blob, `${title}.md`)
  }

  const handleDownloadPdf = async () => {
    const conteudo = state.generatedMarkdown || lessonMarkdown()
    if (!conteudo) return
    const title = state.savedFileName || getTitleFromMarkdown(conteudo) || 'conteudo-gerado'
    setLoadingOperation('export-pdf')
    await forcePaint()
    try {
      const { exportMarkdownToPdf } = await import('@/lib/pdf')
      await exportMarkdownToPdf(conteudo, title)
    } catch (e: unknown) {
      alert(`Erro ao exportar PDF: ${(e as Error).message}`)
    } finally {
      setLoadingOperation(null)
    }
  }

  const handleDownloadZip = async () => {
    if (!state.generatedMarkdown) { alert('Nenhum conteúdo para exportar.'); return }
    const title = state.savedFileName || getTitleFromMarkdown(state.generatedMarkdown) || 'conteudo'
    setLoadingOperation('export-zip')
    await forcePaint()
    try {
      const blob = await api.exportZip({ markdown: state.generatedMarkdown, questions: state.questionsData, filename: title })
      downloadBlob(blob, `${title}.zip`)
    } catch (e: unknown) {
      alert(`Erro ao exportar ZIP: ${(e as Error).message}`)
    } finally {
      setLoadingOperation(null)
    }
  }

  const [generatingExam, setGeneratingExam] = useState(false)
  const [readingExamLoading, setReadingExamLoading] = useState(false)

  const handleGenerateExam = async () => {
    if (!state.generatedMarkdown) { alert('Processe um conteúdo primeiro.'); return }
    if (generatingExam) return
    setGeneratingExam(true)
    try {
      if (hasQuestions) {
        setRegenerateOpen(true)
      } else {
        setExamOpen(true)
      }
    } finally {
      setGeneratingExam(false)
    }
  }

  const handleTakeExam = () => {
    if (!hasQuestions) { alert('Nenhuma questão disponível.'); return }
    setExamOpen(true)
  }

  const handleRegenerateRedo = async () => {
    dispatch({ type: 'SET_QUESTIONS', payload: { questions: [] } })
    setExamOpen(true)
  }

  const handleStartExam = (questionsResponse: QuestionsResponse) => {
    dispatch({ type: 'SET_QUESTIONS', payload: questionsResponse })
    setExamOpen(true)
  }

  const handleStartFolderExam = async (folder: FolderItem) => {
    try {
      // First fetch total count
      const allQuestions = await api.getQuestionsByFolder(folder.id, 'all')
      const total = allQuestions.length
      setFolderExamTarget({ folderId: folder.id, folderName: folder.name, totalQuestions: total })
      setFolderExamOpen(true)
    } catch (e: unknown) {
      alert(`Erro ao carregar questões da pasta: ${(e as Error).message}`)
    }
  }

  const handleFolderExamConfirm = async (count: number | 'all') => {
    if (!folderExamTarget) return
    setFolderExamOpen(false)
    setLoadingOperation('generate-exam')
    try {
      const dbQuestions = await api.getQuestionsByFolder(folderExamTarget.folderId, count)
      if (dbQuestions.length === 0) {
        alert('Nenhuma questão encontrada nos arquivos desta pasta.')
        return
      }
      const questionsResponse: QuestionsResponse = {
        questions: dbQuestions.map((q, idx) => ({
          id: idx,
          enunciado: q.statement,
          alternativas: {
            A: q.alternative_a,
            B: q.alternative_b,
            C: q.alternative_c,
            D: q.alternative_d,
            E: q.alternative_e,
          },
          correta: q.right_alternative,
          explicacao: q.explanation || '',
          diagrama: q.diagram || undefined,
        })),
      }
      dispatch({ type: 'SET_QUESTIONS', payload: questionsResponse })
      setExamOpen(true)
    } catch (e: unknown) {
      alert(`Erro ao carregar questões: ${(e as Error).message}`)
    } finally {
      setLoadingOperation(null)
      setFolderExamTarget(null)
    }
  }

  // ── Live mode handlers ──

  // Brings the StreamingLessonView into focus
  const handleViewStream = useCallback(() => {
    setStreamingOpen(true)
  }, [])

  // Aborts the stream and cleans up state
  const handleCancelStream = useCallback(() => {
    lesson.abort()
    lesson.reset()
    setStreamingOpen(false)
    // Clear any active polling interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    localStorage.removeItem('live-generation')
  }, [lesson])

  // Saves the lesson content via LiveModeSaveModal
  const handleLiveModeSave = useCallback(async (params: LiveModeSaveParams) => {
    const content = lessonMarkdown()

    const saved = await api.createFile({
      name: params.name,
      description: params.description || undefined,
      folder_id: params.folderId,
      content_type: 'markdown',
      type: TIPO_DO_AGENTE[agent] ?? 'class',
      content,
    })

    if (lesson.tempFileId) {
      try {
        await api.deleteTempFile(lesson.tempFileId)
      } catch {
        // ignora silenciosamente
      }
    }

    dispatch({ type: 'SET_MARKDOWN', payload: content })
    dispatch({
      type: 'SET_SAVED_FILE',
      payload: {
        fileId: saved.id,
        fileName: saved.name,
        fileType: 'class',
        fileHash: saved.hash,
        folderId: params.folderId,
        folderName: params.folderName,
      },
    })
    setStreamingOpen(false)
    lesson.reset()
    setLiveModeSaveModalOpen(false)
  }, [lesson, dispatch])

  /**
   * Generate a class from the current reading file content.
   * Triggers the existing SSE lesson generation pipeline with the
   * reading file's content as the input prompt.
   */
  const handleGenerateClassFromReading = useCallback(() => {
    if (!state.generatedMarkdown) return
    const formData = new FormData()
    formData.append('agent', 'lesson')
    formData.append('topic', state.generatedMarkdown)
    formData.append('language', language)
    setPendingStreamData(formData)
    setGenerationModeOpen(true)
  }, [state.generatedMarkdown, language])

  const handleGenerateReadingExam = useCallback(async () => {
    if (!state.generatedMarkdown || !state.savedFileName) return
    if (readingExamLoading) return
    setReadingExamLoading(true)
    try {
      const data = await api.generateReadingExam(state.generatedMarkdown, state.savedFileName)
      dispatch({ type: 'SET_QUESTIONS', payload: data })
      setExamOpen(true)
    } catch (e: unknown) {
      dispatch({ type: 'SET_ERROR', payload: `Erro ao gerar prova: ${(e as Error).message}` })
    } finally {
      setReadingExamLoading(false)
    }
  }, [state.generatedMarkdown, state.savedFileName, readingExamLoading])

  const handleOpenLineageFile = useCallback(async (fileId: string) => {
    setLoadingOperation('select-file')
    dispatch({ type: 'SET_LOADING', payload: { isLoading: true, message: 'Carregando arquivo...' } })
    try {
      const fullFile = await api.getFile(fileId)
      await syncFileToAppContext(fullFile, fullFile.folder_id ?? null, null)
    } catch (e: unknown) {
      dispatch({ type: 'SET_ERROR', payload: `Erro ao abrir arquivo: ${(e as Error).message}` })
    } finally {
      dispatch({ type: 'SET_LOADING', payload: { isLoading: false } })
      setLoadingOperation(null)
    }
  }, [dispatch, syncFileToAppContext])

  const handleExplainSelection = useCallback(({ excerpt, prompt: userPrompt }: { excerpt: string; prompt: string }) => {
    if (!state.savedFileId) return
    setSelectionExcerpt(null)
    setStreamingOpen(true)
    lesson.startJson('/api/v1/generations/explanations', {
      file_id: state.savedFileId,
      excerpt,
      prompt: userPrompt || null,
    })
  }, [lesson, state.savedFileId])

  const hasContent = !!state.generatedMarkdown
  const isReadingFile = state.savedFileType === 'reading'
  const currentFileName = state.savedFileName

  const dockItems = [
    {
      icon: <Home size={18} />,
      label: 'Home',
      color: 'text-violet-400',
      onClick: () => {
        // The dock stays visible above every full-screen page/modal, so "Home" means
        // closing whatever is open and returning to the main view.
        setPaginaArquivosAberta(false)
        setSettingsOpen(false)
        setExamOpen(false)
        setResultOpen(false)
        setRegenerateOpen(false)
        setNewContentOpen(false)
        setFolderExamOpen(false)
        setGenerationModeOpen(false)
        setLiveModeSaveModalOpen(false)
      },
    },
    {
      icon: <FolderKanban size={18} />,
      label: 'Arquivos',
      color: 'text-cyan-400',
      testId: 'file-manager-trigger',
      onClick: () => setPaginaArquivosAberta(true),
    },
    {
      icon: <Settings size={18} />,
      label: 'Configurações',
      color: 'text-slate-400',
      onClick: () => setSettingsOpen(true),
    },
  ]

  const dockGroups = [
    {
      icon: <Upload size={18} />,
      label: 'Importar',
      show: true,
      items: [
        { label: 'Carregar conteúdo', onClick: handleLoadContent },
        { label: 'Importar (.md/.zip)', onClick: handleImport },
      ],
    },
    {
      icon: <Download size={18} />,
      label: 'Exportar',
      show: hasContent || isViewingStream,
      items: [
        { label: 'Baixar aula (.md)', onClick: handleDownloadMd },
        { label: 'Baixar aula (.pdf)', onClick: handleDownloadPdf },
        { label: 'Baixar aula + questões (.zip)', onClick: handleDownloadZip, disabled: isViewingStream || !hasQuestions },
      ],
    },
    {
      icon: <ClipboardList size={18} />,
      label: 'Provas',
      show: hasContent && !isViewingStream,
      items: [
        { label: 'Gerar Prova', onClick: handleGenerateExam },
        { label: 'Fazer Avaliação', onClick: handleTakeExam, disabled: !hasQuestions },
      ],
    },
    {
      icon: <BookOpen size={20} />,
      label: 'Gerar Explicação',
      show: state.savedFileType === 'class',
      items: [],           // no popover — direct action
      onClick: () => setExplainFromLessonTarget({ id: state.savedFileId!, name: state.savedFileName! }),
    },
    {
      icon: <BookOpen size={20} />,
      label: 'Leitura',
      show: isReadingFile,
      items: [
        { label: 'Gerar Aula', onClick: handleGenerateClassFromReading },
        { label: 'Gerar Prova', onClick: handleGenerateReadingExam, disabled: readingExamLoading, loading: readingExamLoading },
      ],
    },
  ]

  return (
    <div className="min-h-screen bg-[#0a0a0f] pb-24">
      {/* Background effect */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.12)_0%,transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,rgba(6,182,212,0.08)_0%,transparent_50%)]" />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto px-4 pb-12">
        {/* Header */}
        {/* The app name is not the page heading: the note's own title is. Keeping it
            small also stops the loudest element on screen from being something the
            user already knows the moment they open the app. */}
        <header className="flex items-center gap-2 pt-6 pb-4 text-sm font-medium text-slate-400">
          <Bot size={16} />
          Agentes de Análise de Conteúdo
        </header>

        {/* Output Area — full width */}
        <div className="relative z-10 max-w-6xl mx-auto px-4">
          <TabsBar />
          <BorderGlow
            colors={['#c084fc', '#f472b6', '#38bdf8']}
            backgroundColor="#0d0d15"
            borderRadius={16}
            glowIntensity={0.6}
            edgeSensitivity={35}
            className="border-white/5! min-h-100"
          >
            <Card title="" className="min-h-100">
              {/* Show streaming view OR normal action bar + output panel */}
              {isViewingStream ? (
                <>
                  <ActionBar
                    hasContent={false}
                    savedFileId={state.savedFileId}
                    savedFileName={state.savedFileName}
                    savedFolderId={state.savedFolderId}
                    savedFolderName={state.savedFolderName}
                    onSaveToFolder={handleSaveToFolder}
                    onOpenFileManager={handleOpenFileManager}
                    saving={saving}
                    loadingOperation={loadingOperation}
                    onNewContent={() => {
                      // Generation is not yet tab-isolated (that is the next session),
                      // so a stream started from here still has to be aborted — but at
                      // least you land on a fresh tab instead of overwriting this one.
                      lesson.abort()
                      setStreamingOpen(false)
                      createTab()
                      setNewContentOpen(true)
                    }}
                    onRegenerate={handleRegenerateContent}
                    regenerating={regenerating}
                    currentFileName={currentFileName}
                    isViewingStream={isViewingStream}
                    isReadingFile={isReadingFile}
                  />
                  <div className="mt-3 px-4">
                    <StreamingLessonView lesson={lesson} agentLabel={agent === 'explicacao' ? 'Explicação' : agent === 'reuniao' ? 'Ata' : 'Aula'} />
                  </div>
                </>
              ) : (
                <>
                  <ActionBar
                    hasContent={!!state.generatedMarkdown}
                    savedFileId={state.savedFileId}
                    savedFileName={state.savedFileName}
                    savedFolderId={state.savedFolderId}
                    savedFolderName={state.savedFolderName}
                    onSaveToFolder={handleSaveToFolder}
                    onOpenFileManager={handleOpenFileManager}
                    saving={saving}
                    loadingOperation={loadingOperation}
                    onNewContent={() => {
                      // The generation on screen is abandoned, not lost: it stays as a
                      // temp file and can be reopened from the manager.
                      if (isViewingStream) handleCancelStream()
                      else if (state.generatedMarkdown || state.savedFileId) createTab()
                      setNewContentOpen(true)
                    }}
                    invitationVisible={!state.generatedMarkdown && !state.isLoading && !state.errorMessage}
                    onRegenerate={handleRegenerateContent}
                    regenerating={regenerating}
                    currentFileName={currentFileName}
                    isViewingStream={isViewingStream}
                    isReadingFile={isReadingFile}
                  />
                  <LineageTimeline fileId={state.savedFileId} onOpenFile={handleOpenLineageFile} />
                  <div id="output-content" className="mt-3">
                    <SelectionMenu
                      canExplain={!!state.savedFileId && hasContent}
                      onExplainSelection={(excerpt) => setSelectionExcerpt(excerpt)}
                    >
                      {isReadingFile ? <ReadingViewer /> : <OutputPanel onNewContent={() => setNewContentOpen(true)} />}
                    </SelectionMenu>
                  </div>
                </>
              )}
            </Card>
          </BorderGlow>
        </div>
      </div>

      {/* Dock */}
      <Dock items={dockItems} groups={dockGroups}>
        <LiveModeDockItem
          streamingOpen={streamingOpen}
          active={lesson.active}
          complete={lesson.complete}
          onViewStream={handleViewStream}
          onCancelStream={handleCancelStream}
          onOpenSaveModal={() => setLiveModeSaveModalOpen(true)}
        />
      </Dock>

      {/* Live Mode Save Modal */}
      {liveModeSaveModalOpen && (
        <LiveModeSaveModal
          open={liveModeSaveModalOpen}
          lessonText={lesson.lessonText}
          tempFileId={lesson.tempFileId}
          originalTitle={lesson.originalTitle || lesson.suggestion?.name}
          originalDescription={lesson.originalDescription}
          savedFolderId={state.savedFolderId}
          savedFolderName={state.savedFolderName}
          onSave={handleLiveModeSave}
          onClose={() => setLiveModeSaveModalOpen(false)}
        />
      )}

      {/* Novo conteúdo modal */}
      <NewContentModal
        open={newContentOpen}
        onClose={() => {
          setNewContentOpen(false)
          setReadingText('')
          setReadingName('')
          setReadingError('')
          setGenerationName('')
          setGenerationDescription('')
        }}
        mode={mode}
        setMode={setMode}
        selectedFile={selectedFile}
        setSelectedFile={setSelectedFile}
        inputUrl={inputUrl}
        setInputUrl={setInputUrl}
        inputUrlValid={inputUrlValid}
        setInputUrlValid={setInputUrlValid}
        agent={agent}
        setAgent={setAgent}
        topic={topic}
        setTopic={setTopic}
        prompt={prompt}
        setPrompt={setPrompt}
        language={language}
        setLanguage={setLanguage}
        transcriptionProvider={transcriptionProvider}
        setTranscriptionProvider={setTranscriptionProvider}
        generationName={generationName}
        setGenerationName={setGenerationName}
        generationDescription={generationDescription}
        setGenerationDescription={setGenerationDescription}
        openaiAvailable={openaiAvailable}
        loadingOperation={loadingOperation}
        onProcess={handleProcess}
        readingText={readingText}
        setReadingText={setReadingText}
        readingName={readingName}
        setReadingName={setReadingName}
        readingLoading={readingLoading}
        readingError={readingError}
        setReadingError={setReadingError}
        onCreateReading={handleCreateReading}
      />

      {/* Generation mode modal — shown before SSE streaming starts */}
      <GenerationModeModal
        open={generationModeOpen}
        onRealtime={handleRealtime}
        onBackground={handleBackground}
        onClose={() => setGenerationModeOpen(false)}
      />

      {/* Explain Selection Modal */}
      {selectionExcerpt && (
        <ExplainSelectionModal
          excerpt={selectionExcerpt}
          sourceName={state.savedFileName ?? 'documento atual'}
          onClose={() => setSelectionExcerpt(null)}
          onSubmit={handleExplainSelection}
        />
      )}

      {/* Explain From Lesson Modal */}
      {explainFromLessonTarget && (
        <ExplainFromLessonModal
          lessonName={explainFromLessonTarget.name}
          lessonFileId={explainFromLessonTarget.id}
          onClose={() => setExplainFromLessonTarget(null)}
          onSubmit={handleExplainFromLesson}
        />
      )}

      {examOpen && (
        <ExamModal
          markdown={state.generatedMarkdown}
          fileId={state.savedFileId}
          onClose={() => setExamOpen(false)}
          onFinish={() => { setExamOpen(false); setTimeout(() => setResultOpen(true), 300) }}
        />
      )}
      {resultOpen && <ResultModal onClose={() => setResultOpen(false)} />}

      {regenerateOpen && (
        <RegenerateDialog
          onRedo={handleRegenerateRedo}
          onClose={() => setRegenerateOpen(false)}
        />
      )}

      {/* Settings Modal */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
        }}
        agent={agent}
        setAgent={setAgent}
        generateQuestions={generateQuestions}
        setGenerateQuestions={setGenerateQuestions}
        diagramBg={diagramBg}
        setDiagramBg={setDiagramBg}
      />

      {/* File Manager */}
      {paginaArquivosAberta && (
        <FileManagerPage
          onClose={() => setPaginaArquivosAberta(false)}
          onSelectFile={async (file, folderId, folderName) => {
            setPaginaArquivosAberta(false)
            await handleSelectFileFromManager(file, folderId, folderName)
          }}
          onExplainFromLesson={(file) => {
            setPaginaArquivosAberta(false)
            setExplainFromLessonTarget({ id: file.id, name: file.name })
          }}
          onDeleteFile={(fileId) => {
            if (state.savedFileId === fileId) {
              dispatch({ type: 'RESET' })
              removeStorageItem('last-opened-file')
            }
          }}
          onStartExam={handleStartExam}
          onStartFolderExam={handleStartFolderExam}
          openFileId={state.savedFileId}
        />
      )}

      {/* NotificationBar — loading/error floating bar, does NOT affect OutputPanel */}
      <NotificationBar />

      {/* Folder Exam Dialog */}
      {folderExamOpen && folderExamTarget && (
        <FolderExamDialog
          folderName={folderExamTarget.folderName}
          totalQuestions={folderExamTarget.totalQuestions}
          onConfirm={handleFolderExamConfirm}
          onCancel={() => {
            setFolderExamOpen(false)
            setFolderExamTarget(null)
          }}
        />
      )}

      {/* Save name dialog — removed, saves directly */}
    </div>
  )
}
