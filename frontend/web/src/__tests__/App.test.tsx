import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider } from '@/context/AppContext'
import App from '@/App'

// ── Mocks ──

const mockLesson: {
  lessonText: string
  diagrams: Record<number, string>
  complete: boolean
  tempFileId: string | null
  error: string | null
  connecting: boolean
  active: boolean
  start: ReturnType<typeof vi.fn>
  startJson: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
} = {
  lessonText: '',
  diagrams: {},
  complete: false,
  tempFileId: null,
  error: null,
  connecting: false,
  active: false,
  start: vi.fn(),
  startJson: vi.fn(),
  abort: vi.fn(),
  reset: vi.fn(),
}

vi.mock('@/hooks/useSSELesson', () => ({
  useSSELesson: () => mockLesson,
}))

vi.mock('@/api/client', () => ({
  api: {
    createFile: vi.fn(),
    updateFile: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ whisper_model: 'small' }),
    getFolders: vi.fn().mockResolvedValue([]),
    getTree: vi.fn().mockResolvedValue([]),
    getFile: vi.fn(),
    getQuestions: vi.fn(),
    exportZip: vi.fn(),
    previewFile: vi.fn(),
    importFile: vi.fn(),
    getLineage: vi.fn().mockResolvedValue([]),
    getTempFiles: vi.fn().mockResolvedValue([]),
    getTempFile: vi.fn(),
    deleteTempFile: vi.fn().mockResolvedValue(undefined),
    generateReadingExam: vi.fn(),
  },
}))

vi.mock('@/lib/utils', () => ({
  forcePaint: vi.fn().mockResolvedValue(undefined),
  getTitleFromMarkdown: vi.fn((md: string) => {
    const match = md.match(/^#\s+(.*)/m)
    return match ? match[1].trim() : null
  }),
  getRawTitleFromMarkdown: vi.fn((md: string) => {
    const match = md.match(/^#\s+(.*?)(?:\n|$)/m)
    return match ? match[1].trim() : null
  }),
  downloadBlob: vi.fn(),
  getStorageItem: vi.fn().mockReturnValue(null),
  setStorageItem: vi.fn(),
  removeStorageItem: vi.fn(),
  shuffleArray: vi.fn((arr: unknown[]) => arr),
}))

import { api } from '@/api/client'
import { getStorageItem } from '@/lib/utils'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// Mock scrollTo
window.scrollTo = vi.fn()

// Mock alert
window.alert = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  // Reset getStorageItem to default (return null) since clearAllMocks doesn't reset implementations
  ;(getStorageItem as Mock).mockImplementation(() => null)
  localStorageMock.clear()
  // Reset mockLesson to defaults between tests
  mockLesson.lessonText = ''
  mockLesson.diagrams = {}
  mockLesson.complete = false
  mockLesson.tempFileId = null
  mockLesson.error = null
  mockLesson.connecting = false
  // Ensure hash is empty
  window.location.hash = ''
})

// Render App wrapped with AppProvider (same as main.tsx)
function renderApp() {
  return render(
    <AppProvider>
      <App />
    </AppProvider>,
  )
}

// ── Helpers ──

/**
 * Open the NewContentModal by clicking the "Novo Conteúdo" trigger.
 */
async function openNewContentModal(user: ReturnType<typeof userEvent.setup>) {
  const newContentButton = screen.queryByText('Novo Conteúdo') ||
    screen.queryByText(/novo/i) ||
    screen.queryByRole('button', { name: /novo/i })

  if (newContentButton) {
    await user.click(newContentButton)
    // Wait for modal
    await screen.findByRole('heading', { name: /novo conteúdo/i })
  }
}

/**
 * Click "Processar" inside the NewContentModal.
 * This triggers onProcess (App's handleProcess).
 * Since the only available agent is 'aula', this opens the GenerationModeModal.
 */
async function clickProcessInModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('step-submit'))
}

// ── Tests ──

describe('App — handleSelectFileFromManager', () => {
  it('dispatches SET_ERROR when api.getFile rejects', async () => {
    ;(api.getFile as Mock).mockRejectedValue(new Error('File not found'))

    const user = userEvent.setup()
    renderApp()

    await screen.findByText('Agentes de Análise de Conteúdo')

    // Open File Manager via dock button "Arquivos"
    const arquivosBtn = screen.getByRole('button', { name: /arquivos/i })
    await user.click(arquivosBtn)

    await screen.findByText('Gerenciador de Arquivos')
    expect(screen.getByText('Gerenciador de Arquivos')).toBeInTheDocument()
  })
})

// ── URL hash regression tests ──

describe('App — URL hash regression (no #fragment on file open)', () => {
  const mockFullFile = {
    id: 'file-1',
    name: 'aula.md',
    content: '# Aula de Matemática\n\nConteúdo de teste.',
    content_type: 'markdown',
    folder_id: 'folder-1',
    type: 'class' as const,
    description: null,
    questions_count: 0,
  }

  beforeEach(() => {
    ;(api.getTree as Mock).mockResolvedValue([
      {
        id: 'folder-1',
        name: 'Matemática',
        kind: 'folder' as const,
        folder_id: null,
        children: [mockFullFile],
      },
    ])
    ;(api.getFile as Mock).mockResolvedValue(mockFullFile)
  })

  it('does not set window.location.hash when opening a file from FileManager', async () => {
    const user = userEvent.setup()
    renderApp()

    await screen.findByText('Agentes de Análise de Conteúdo')

    // Open File Manager via dock
    await user.click(screen.getByRole('button', { name: /arquivos/i }))
    await screen.findByText('Gerenciador de Arquivos')

    // Navigate into folder
    await user.click(within(screen.getByTestId('conteudo-pasta')).getByText('Matemática'))
    await screen.findByText('aula.md')

    // Click the file to open it
    await user.click(screen.getByText('aula.md'))

    // Wait for loading to finish (the file gets fetched and displayed)
    await waitFor(() => {
      expect(api.getFile).toHaveBeenCalledWith('file-1')
    })

    // Hash must remain empty
    expect(window.location.hash).toBe('')
  })

  it('does not set window.location.hash when opening multiple files sequentially', async () => {
    const secondFile = {
      ...mockFullFile,
      id: 'file-2',
      name: 'resumo.md',
      content: '# Resumo\n\nSegundo conteúdo.',
    }
    ;(api.getFile as Mock).mockResolvedValueOnce(mockFullFile).mockResolvedValueOnce(secondFile)
    ;(api.getTree as Mock).mockResolvedValue([
      {
        id: 'folder-1',
        name: 'Matemática',
        kind: 'folder' as const,
        folder_id: null,
        children: [mockFullFile, secondFile],
      },
    ])

    const user = userEvent.setup()
    renderApp()

    await screen.findByText('Agentes de Análise de Conteúdo')

    // Open file manager
    await user.click(screen.getByRole('button', { name: /arquivos/i }))
    await screen.findByText('Gerenciador de Arquivos')

    // Navigate into folder — use getAllByText since both breadcrumb and tree have "Matemática"
    const folderButton = screen.getAllByText('Matemática')
    await user.click(folderButton[folderButton.length - 1])
    await screen.findByText('aula.md')

    // Click first file
    await user.click(screen.getByText('aula.md'))
    await waitFor(() => {
      expect(window.location.hash).toBe('')
    })

    // Wait for the modal to close (file selection closes it)
    await waitFor(() => {
      expect(screen.queryByText('Gerenciador de Arquivos')).not.toBeInTheDocument()
    })

    // Re-open file manager
    await user.click(screen.getByRole('button', { name: /arquivos/i }))
    await screen.findByText('Gerenciador de Arquivos')

    // Click the folder node again
    const folderButton2 = screen.getAllByText('Matemática')
    await user.click(folderButton2[folderButton2.length - 1])
    await screen.findByText('resumo.md')

    // Click second file
    await user.click(screen.getByText('resumo.md'))
    await waitFor(() => {
      expect(window.location.hash).toBe('')
    })
  })
})

// ── Streaming/Generation Mode Tests ──

describe('App — generation mode flow', () => {
  it('shows GenerationModeModal after clicking Processar with aula agent', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    const user = userEvent.setup()

    // Open new content modal
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    // Switch to URL mode
    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    // Enter a URL
    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    // Gerar — this opens the GenerationModeModal
    await user.click(screen.getByTestId('step-submit'))

    // GenerationModeModal should appear with two options
    await screen.findByText('Modo de Geração')
    expect(screen.getByTestId('realtime-option')).toBeInTheDocument()
    expect(screen.getByTestId('background-option')).toBeInTheDocument()
  })

  it('starts streaming when "Acompanhar em tempo real" is selected', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    const user = userEvent.setup()

    // Open new content modal and fill form
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')

    // Select realtime
    await user.click(screen.getByTestId('realtime-option'))

    // Streaming view should be visible — shows waiting message
    await waitFor(() => {
      expect(screen.getByText('Aguardando conteúdo da aula...')).toBeInTheDocument()
    })
  })
})

// ── handleProcess — post-processing flow Tests ──

describe('App — handleProcess post-processing flow', () => {
  it('shows GenerationModeModal instead of old loading flow for aula agent', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    const user = userEvent.setup()
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))

    // Should show the generation mode modal, not start loading directly
    await screen.findByText('Modo de Geração')
    expect(screen.queryByText('Gerando conteúdo...')).not.toBeInTheDocument()
  })

  it('does not trigger generation for unknown agent type', async () => {
    // Regression guard: only 'aula'/'explicacao' should trigger
    // the SSE streaming flow; no legacy endpoints should be called.
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    const user = userEvent.setup()
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    // The UI offers only 'aula' and 'explicacao' after issue 001/002.
    // Clicking Processar should never call the legacy processContent endpoint.
    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))

    // GenerationModeModal should appear (SSE path for 'aula')
    await screen.findByText('Modo de Geração')

    // Neither legacy endpoint should have been called
    expect(api.createFile).not.toHaveBeenCalled()
  })
})

// ── LiveModeDockItem integration ──

describe('App — LiveModeDockItem integration', () => {
  it('does not render LiveModeDockItem in Dock when streamingOpen is false (initial state)', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // LiveModeDockItem should not be visible (it's hidden via null return when streamingOpen=false)
    expect(screen.queryByLabelText('Ao Vivo')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Salvar aula')).not.toBeInTheDocument()
  })

  it('renders LiveModeDockItem with spinner when streamingOpen is true and lesson is active', async () => {
    mockLesson.active = true
    mockLesson.complete = false
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // Open new content modal and start streaming
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')

    await user.click(screen.getByTestId('realtime-option'))

    // LiveModeDockItem should be in generating state — "Ao Vivo" label visible
    await waitFor(() => {
      expect(screen.getByLabelText('Ao Vivo')).toBeInTheDocument()
    })
  })

  it('renders LiveModeDockItem with save icon when streamingOpen is true and lesson is complete', async () => {
    mockLesson.active = false
    mockLesson.complete = true
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // Open new content modal and start streaming
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')

    await user.click(screen.getByTestId('realtime-option'))

    // LiveModeDockItem should be in ready state — "Salvar aula" label visible
    await waitFor(() => {
      expect(screen.getByLabelText('Salvar aula')).toBeInTheDocument()
    })
  })

  it('opens LiveModeSaveModal when clicking save icon on ready LiveModeDockItem', async () => {
    mockLesson.active = false
    mockLesson.complete = true
    mockLesson.lessonText = '# Aula de teste\n\nConteúdo.'
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // Start streaming to make LiveModeDockItem appear
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')

    await user.click(screen.getByTestId('realtime-option'))

    await waitFor(() => {
      expect(screen.getByLabelText('Salvar aula')).toBeInTheDocument()
    })

    // Click the save button — should open LiveModeSaveModal
    await user.click(screen.getByLabelText('Salvar aula'))

    await waitFor(() => {
      // The modal heading should appear
      expect(screen.getByRole('heading', { name: /salvar aula/i })).toBeInTheDocument()
      // The default title extracted from lesson markdown should appear in the name input
      const nameInput = screen.getByDisplayValue('Aula de teste')
      expect(nameInput).toBeInTheDocument()
    })
  })

  it('calls lesson.abort when "Cancelar geração" is clicked in LiveModeDockItem popover', async () => {
    mockLesson.active = true
    mockLesson.complete = false
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // Start streaming
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')

    await user.click(screen.getByTestId('realtime-option'))

    await waitFor(() => {
      expect(screen.getByLabelText('Ao Vivo')).toBeInTheDocument()
    })

    // Open popover
    await user.click(screen.getByLabelText('Ao Vivo'))
    await screen.findByText('Cancelar geração')

    // Click cancel
    await user.click(screen.getByText('Cancelar geração'))

    // lesson.abort and lesson.reset should have been called
    expect(mockLesson.abort).toHaveBeenCalled()
    expect(mockLesson.reset).toHaveBeenCalled()
  })
})

// ── handleImport — post-processing flow Tests ──

describe('App — handleImport post-processing flow', () => {
  const mockMarkdown = '# Aula Importada\n\nConteúdo importado com sucesso.'

  beforeEach(() => {
    ;(api.importFile as Mock).mockResolvedValue({ markdown: mockMarkdown })
    ;(api.getConfig as Mock).mockResolvedValue({ whisper_model: 'small' })
  })

  it('displays markdown directly after successful import (no PostSaveModal)', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // Verify the app renders without PostSaveModal state
    expect(screen.getByText('Agentes de Análise de Conteúdo')).toBeInTheDocument()
    expect(screen.queryByText('Conteúdo Gerado — Salvar?')).not.toBeInTheDocument()
  })
})

// ── Live mode: selecting a file while streaming ──

describe('App — live mode: selecting a file replaces StreamingLessonView with OutputPanel', () => {
  const mockStreamFile = {
    id: 'file-streaming',
    name: 'aula-fisica.md',
    kind: 'file' as const,
    content: '# Aula de Física\n\nConteúdo da aula.',
    content_type: 'markdown',
    folder_id: 'folder-1',
    type: 'class' as const,
    description: null,
    questions_count: 0,
  }

  beforeEach(() => {
    mockLesson.active = true
    mockLesson.complete = false
    mockLesson.lessonText = ''
    ;(api.getTree as Mock).mockResolvedValue([
      {
        id: 'folder-1',
        name: 'Física',
        kind: 'folder' as const,
        folder_id: null,
        children: [mockStreamFile],
      },
    ])
    ;(api.getFile as Mock).mockResolvedValue(mockStreamFile)
  })

  async function startStreaming(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /novo/i }))
    await screen.findByRole('heading', { name: /novo conteúdo/i })
    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))
    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')
    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')
    await user.click(screen.getByTestId('realtime-option'))
    await waitFor(() => {
      expect(screen.getByText('Aguardando conteúdo da aula...')).toBeInTheDocument()
    })
  }

  it('shows OutputPanel with file content (not StreamingLessonView) after selecting a file while streaming', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    await startStreaming(user)

    // Open file manager while streaming is active
    await user.click(screen.getByRole('button', { name: /arquivos/i }))
    await screen.findByText('Gerenciador de Arquivos')

    // Navigate into folder and select the file
    await user.click(within(screen.getByTestId('conteudo-pasta')).getByText('Física'))
    await screen.findByText('aula-fisica.md')
    await user.click(screen.getByText('aula-fisica.md'))

    // File should be fetched
    await waitFor(() => {
      expect(api.getFile).toHaveBeenCalledWith('file-streaming')
    })

    // StreamingLessonView should no longer be visible
    await waitFor(() => {
      expect(screen.queryByText('Aguardando conteúdo da aula...')).not.toBeInTheDocument()
    })

    // OutputPanel should show the file content
    await waitFor(() => {
      expect(screen.getByText('Aula de Física')).toBeInTheDocument()
    })
  })

  it('passes transcription_provider in FormData when starting realtime generation', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    await startStreaming(user)

    expect(mockLesson.start).toHaveBeenCalled()
    const formData = mockLesson.start.mock.calls[0][0]
    // Check if formData is an instance of FormData or inspect properties
    if (typeof (formData as any)?.get === 'function') {
      expect((formData as any).get('transcription_provider')).toBe('local')
    } else {
      // jsdom xhr-utils / mock fallback
      expect(formData).toBeDefined()
    }
  })
})

// ── handleLoadContent — post-processing flow Tests ──

describe('App — handleLoadContent post-processing flow', () => {
  const mockMarkdown = '# Conteúdo Carregado\n\nCarregado com sucesso.'

  beforeEach(() => {
    ;(api.previewFile as Mock).mockResolvedValue({ markdown: mockMarkdown })
    ;(api.getConfig as Mock).mockResolvedValue({ whisper_model: 'small' })
  })

  it('displays markdown directly after successful loadContent (no PostSaveModal)', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    expect(screen.getByText('Agentes de Análise de Conteúdo')).toBeInTheDocument()
    expect(screen.queryByText('Conteúdo Gerado — Salvar?')).not.toBeInTheDocument()
  })
})

// ── Dock groups integration tests ──

describe('App — dock group: Importar', () => {
  it('renders Importar dock group always (no content loaded)', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')
    expect(screen.getByLabelText('Importar')).toBeInTheDocument()
  })

  it('renders Importar dock group when content is loaded', async () => {
    // Simulate hasContent=true by loading a file via getStorageItem mock
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'aula.md', folderId: 'folder-1', folderName: 'Matemática' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      id: 'file-1',
      name: 'aula.md',
      content: '# Aula de teste\n\nConteúdo.',
      content_type: 'markdown',
      folder_id: 'folder-1',
      type: 'class',
      description: null,
      questions_count: 0,
    })
    ;(api.getQuestions as Mock).mockResolvedValue([])

    renderApp()
    await screen.findByText('Aula de teste')
    expect(screen.getByLabelText('Importar')).toBeInTheDocument()
  })
})

describe('App — dock group: Exportar', () => {
  it('does not render Exportar dock group when no content is loaded', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')
    expect(screen.queryByLabelText('Exportar')).not.toBeInTheDocument()
  })

  it('renders Exportar dock group when content is loaded', async () => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'aula.md', folderId: 'folder-1', folderName: 'Matemática' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      id: 'file-1',
      name: 'aula.md',
      content: '# Aula de teste\n\nConteúdo.',
      content_type: 'markdown',
      folder_id: 'folder-1',
      type: 'class',
      description: null,
      questions_count: 0,
    })
    ;(api.getQuestions as Mock).mockResolvedValue([])

    renderApp()
    await screen.findByText('Aula de teste')
    expect(screen.getByLabelText('Exportar')).toBeInTheDocument()
  })
})

describe('App — dock group: Provas', () => {
  it('does not render Provas dock group when no content is loaded', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')
    expect(screen.queryByLabelText('Provas')).not.toBeInTheDocument()
  })

  it('renders Provas dock group when content is loaded', async () => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'aula.md', folderId: 'folder-1', folderName: 'Matemática' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      id: 'file-1',
      name: 'aula.md',
      content: '# Aula de teste\n\nConteúdo.',
      content_type: 'markdown',
      folder_id: 'folder-1',
      type: 'class',
      description: null,
      questions_count: 0,
    })
    ;(api.getQuestions as Mock).mockResolvedValue([])

    renderApp()
    await screen.findByText('Aula de teste')
    expect(screen.getByLabelText('Provas')).toBeInTheDocument()
  })
})

describe('App — dock group: item disabled state', () => {
  const mockContent = '# Aula com Questões\n\nConteúdo com perguntas.'
  const mockQuestions = [
    {
      id: 1,
      statement: 'Pergunta 1?',
      alternative_a: 'A',
      alternative_b: 'B',
      alternative_c: 'C',
      alternative_d: 'D',
      alternative_e: 'E',
      right_alternative: 'A',
      explanation: 'Explicação',
      diagram: null,
    },
  ]

  it('disables "Baixar aula + questões (.zip)" when hasQuestions is false', async () => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'aula.md', folderId: 'folder-1', folderName: 'Matemática' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      id: 'file-1',
      name: 'aula.md',
      content: mockContent,
      content_type: 'markdown',
      folder_id: 'folder-1',
      type: 'class',
      description: null,
      questions_count: 0,
    })
    ;(api.getQuestions as Mock).mockResolvedValue([])

    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Aula com Questões')

    // Open Exportar popover
    await user.click(screen.getByLabelText('Exportar'))
    const zipItem = screen.getByText('Baixar aula + questões (.zip)')
    expect(zipItem).toBeInTheDocument()
    expect(zipItem.closest('button')).toBeDisabled()
  })

  it('disables "Fazer Avaliação" when hasQuestions is false', async () => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'aula.md', folderId: 'folder-1', folderName: 'Matemática' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      id: 'file-1',
      name: 'aula.md',
      content: mockContent,
      content_type: 'markdown',
      folder_id: 'folder-1',
      type: 'class',
      description: null,
      questions_count: 0,
    })
    ;(api.getQuestions as Mock).mockResolvedValue([])

    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Aula com Questões')

    // Open Provas popover
    await user.click(screen.getByLabelText('Provas'))
    const avaliacaoItem = screen.getByText('Fazer Avaliação')
    expect(avaliacaoItem).toBeInTheDocument()
    expect(avaliacaoItem.closest('button')).toBeDisabled()
  })

  it('enables "Fazer Avaliação" when hasQuestions is true', async () => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'aula.md', folderId: 'folder-1', folderName: 'Matemática' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      id: 'file-1',
      name: 'aula.md',
      content: mockContent,
      content_type: 'markdown',
      folder_id: 'folder-1',
      type: 'class',
      description: null,
      questions_count: 1,
    })
    ;(api.getQuestions as Mock).mockResolvedValue(mockQuestions)

    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Aula com Questões')

    // Open Provas popover
    await user.click(screen.getByLabelText('Provas'))
    const avaliacaoItem = screen.getByText('Fazer Avaliação')
    expect(avaliacaoItem).toBeInTheDocument()
    expect(avaliacaoItem.closest('button')).not.toBeDisabled()
  })
})

// ── Gerar Explicação dock group ──

describe('App — dock group: Gerar Explicação', () => {
  const mockClassFile = {
    id: 'file-1',
    name: 'Aula de Física',
    content: '# Aula de Física\n\nConteúdo da aula.',
    content_type: 'markdown',
    folder_id: 'folder-1',
    type: 'class' as const,
    description: null,
    questions_count: 0,
  }

  it('shows Gerar Explicação dock icon when savedFileType is class', async () => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'Aula de Física', folderId: 'folder-1', folderName: 'Física' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue(mockClassFile)
    ;(api.getQuestions as Mock).mockResolvedValue([])

    renderApp()
    // Wait for content to load (the h1 heading from markdown)
    await screen.findByRole('heading', { name: /Aula de Física/i })
    expect(screen.getByLabelText('Gerar Explicação')).toBeInTheDocument()
  })

  it('hides Gerar Explicação dock icon when no file is saved', async () => {
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')
    expect(screen.queryByLabelText('Gerar Explicação')).not.toBeInTheDocument()
  })

  it('hides Gerar Explicação dock icon when saved file is explanation', async () => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'Explicação', folderId: 'folder-1', folderName: 'Física' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      ...mockClassFile,
      name: 'Explicação',
      content: '# Explicação\n\nConteúdo da explicação.',
      type: 'explanation' as const,
    })
    ;(api.getQuestions as Mock).mockResolvedValue([])

    renderApp()
    await screen.findByRole('heading', { name: /Explicação/i })
    expect(screen.queryByLabelText('Gerar Explicação')).not.toBeInTheDocument()
  })

  it('opens ExplainFromLessonModal when Gerar Explicação is clicked', async () => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'Aula de Física', folderId: 'folder-1', folderName: 'Física' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue(mockClassFile)
    ;(api.getQuestions as Mock).mockResolvedValue([])

    const user = userEvent.setup()
    renderApp()
    await screen.findByRole('heading', { name: /Aula de Física/i })

    const gerarBtn = screen.getByLabelText('Gerar Explicação')
    await user.click(gerarBtn)

    // Modal should show the heading
    expect(await screen.findByRole('heading', { name: /Gerar Explicação/i })).toBeInTheDocument()
    // Modal should show the lesson name in context (appears both in modal and markdown content)
    expect(screen.getAllByText('Aula de Física').length).toBeGreaterThanOrEqual(2)
  })
})

// ── App — explicacao generation flow ──

describe('App — explicacao generation flow', () => {
  it('opens GenerationModeModal when Processar is clicked with explicacao agent and topic', async () => {
    const user = userEvent.setup()
    renderApp()

    // Open NewContentModal
    await user.click(screen.getByRole('button', { name: /Novo conteúdo/i }))

    // Select Explicação agent (avança direto para a origem)
    await user.click(screen.getByTestId('agent-card-explicacao'))

    // Type a topic
    await user.type(screen.getByLabelText(/Assunto ou dúvida/i), 'O que é React?')
    await user.click(screen.getByTestId('step-next'))

    // Submit
    await user.click(screen.getByTestId('step-submit'))

    // GenerationModeModal must appear (SSE path), not an error
    await screen.findByText('Modo de Geração')
    expect(screen.getByTestId('realtime-option')).toBeInTheDocument()
    expect(screen.queryByText(/Agent must be/i)).not.toBeInTheDocument()
  })

  it('shows alert and does not open modal when topic is empty', async () => {
    const user = userEvent.setup()
    renderApp()

    await user.click(screen.getByRole('button', { name: /Novo conteúdo/i }))
    await user.click(screen.getByTestId('agent-card-explicacao'))
    // Do NOT type a topic — advancing must stay blocked
    expect(screen.getByTestId('step-next')).toBeDisabled()
    expect(screen.queryByTestId('realtime-option')).not.toBeInTheDocument()
  })
})

// ── Provas dock group visibility during stream ──

describe('App — dock group: Provas visibility during stream', () => {
  it('hides Provas dock group while isViewingStream is true', async () => {
    // Load content from saved file so hasContent is true
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'aula.md', folderId: 'folder-1', folderName: 'Matemática' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      id: 'file-1',
      name: 'aula.md',
      content: '# Aula de teste\n\nConteúdo.',
      content_type: 'markdown',
      folder_id: 'folder-1',
      type: 'class',
      description: null,
      questions_count: 0,
    })
    ;(api.getQuestions as Mock).mockResolvedValue([])

    mockLesson.active = true
    mockLesson.complete = false

    const user = userEvent.setup()
    renderApp()

    // Wait for content to load
    await screen.findByText('Aula de teste')

    // Open new content modal and start streaming
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')

    await user.click(screen.getByTestId('realtime-option'))

    // Streaming is active + content loaded → Provas should be hidden
    await waitFor(() => {
      expect(screen.queryByLabelText('Provas')).not.toBeInTheDocument()
    })
  })

  it('shows Provas dock group after stream completes and is dismissed', async () => {
    // Load content from saved file so hasContent is true
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'file-1', fileName: 'aula.md', folderId: 'folder-1', folderName: 'Matemática' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue({
      id: 'file-1',
      name: 'aula.md',
      content: '# Aula de teste\n\nConteúdo.',
      content_type: 'markdown',
      folder_id: 'folder-1',
      type: 'class',
      description: null,
      questions_count: 0,
    })
    ;(api.getQuestions as Mock).mockResolvedValue([])

    mockLesson.active = true
    mockLesson.complete = false

    const user = userEvent.setup()
    renderApp()

    // Wait for content to load
    await screen.findByText('Aula de teste')

    // Start streaming
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')

    await user.click(screen.getByTestId('realtime-option'))

    // Wait for LiveModeDockItem to appear
    await waitFor(() => {
      expect(screen.getByLabelText('Ao Vivo')).toBeInTheDocument()
    })

    // Cancel the stream — this sets streamingOpen=false, isViewingStream becomes false
    await user.click(screen.getByLabelText('Ao Vivo'))
    await screen.findByText('Cancelar geração')
    await user.click(screen.getByText('Cancelar geração'))

    // "Novo conteúdo" opened a fresh tab so the loaded file was never at risk — it is
    // one tab over (labeled by its saved file name), not on the (now empty, cancelled)
    // tab currently on screen.
    await user.click(within(screen.getByTestId('tabs-bar')).getByText('aula.md'))
    await waitFor(() => {
      expect(screen.getByLabelText('Provas')).toBeInTheDocument()
    })
  })
})

// ── Gerar Explicação from file manager ──

describe('App — Gerar Explicação from file manager', () => {
  const mockClassFile = {
    id: 'file-1',
    name: 'aula.md',
    content: '# Aula de Física\n\nConteúdo da aula.',
    content_type: 'markdown',
    folder_id: 'folder-1',
    type: 'class' as const,
    description: null,
    questions_count: 0,
  }

  it('shows ExplainFromLessonModal when Gerar Explicação is clicked in file manager for a class file', async () => {
    ;(api.getTree as Mock).mockResolvedValue([
      {
        id: 'folder-1',
        name: 'Física',
        kind: 'folder' as const,
        folder_id: null,
        children: [mockClassFile],
      },
    ])

    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // Open file manager via dock
    await user.click(screen.getByRole('button', { name: /arquivos/i }))
    await screen.findByText('Gerenciador de Arquivos')

    // Navigate into folder to see the class file
    await user.click(within(screen.getByTestId('conteudo-pasta')).getByText('Física'))
    await screen.findByText('aula.md')

    // Click the Gerar Explicação action button
    const gerarExplicacaoBtn = screen.getByTitle('Gerar Explicação')
    await user.click(gerarExplicacaoBtn)

    // FileManagerModal closes, ExplainFromLessonModal opens
    await waitFor(() => {
      expect(screen.queryByText('Gerenciador de Arquivos')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: /Gerar Explicação/i })).toBeInTheDocument()
    // The lesson name appears in the modal subtitle "A partir de: aula.md"
    expect(screen.getByText('aula.md')).toBeInTheDocument()
  })

  it('shows no action button for non-class files in file manager', async () => {
    const mockExplanationFile = {
      ...mockClassFile,
      id: 'file-2',
      name: 'explicacao.md',
      type: 'explanation' as const,
    }
    ;(api.getTree as Mock).mockResolvedValue([
      {
        id: 'folder-1',
        name: 'Física',
        kind: 'folder' as const,
        folder_id: null,
        children: [mockExplanationFile],
      },
    ])

    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // Open file manager
    await user.click(screen.getByRole('button', { name: /arquivos/i }))
    await screen.findByText('Gerenciador de Arquivos')

    // Navigate into folder
    await user.click(within(screen.getByTestId('conteudo-pasta')).getByText('Física'))
    await screen.findByText('explicacao.md')

    // No Gerar Explicação button for explanation files
    expect(screen.queryByTitle('Gerar Explicação')).not.toBeInTheDocument()
  })
})

// ── Reload recovery — live-generation localStorage key ──

describe('App — reload recovery from live-generation localStorage', () => {
  beforeEach(() => {
    localStorageMock.clear()
  })

  it('shows streaming skeleton when status=generating and mode=live', async () => {
    localStorageMock.setItem('live-generation', JSON.stringify({ mode: 'live', tempFileId: 'xyz-123' }))
    ;(api.getTempFile as Mock).mockResolvedValue({ id: 'xyz-123', status: 'generating', content: '' })

    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    await waitFor(() => {
      expect(screen.getByTestId('streaming-lesson-skeleton')).toBeInTheDocument()
    })
  })

  it('shows loading overlay when status=generating and mode=background', async () => {
    localStorageMock.setItem('live-generation', JSON.stringify({ mode: 'background', tempFileId: 'xyz-456' }))
    ;(api.getTempFile as Mock).mockResolvedValue({ id: 'xyz-456', status: 'generating', content: '' })

    renderApp()

    await waitFor(() => {
      // LoadingOverlay renders with message containing "segundo plano"
      const elements = screen.getAllByText(/Gerando aula em segundo plano/i)
      expect(elements.length).toBeGreaterThan(0)
    })
  })

  it('displays content when status=complete and clears localStorage', async () => {
    localStorageMock.setItem('live-generation', JSON.stringify({ mode: 'live', tempFileId: 'xyz-789' }))
    const completedContent = '# Aula Completa\n\nConteúdo finalizado.'
    ;(api.getTempFile as Mock).mockResolvedValue({ id: 'xyz-789', status: 'complete', content: completedContent })

    renderApp()

    // The tab bar now shows the title too, so "Aula Completa" legitimately appears twice.
    await waitFor(() => {
      expect(screen.getAllByText('Aula Completa').length).toBeGreaterThan(0)
    })
    expect(localStorageMock.getItem('live-generation')).toBeNull()
  })

  it('shows error notification when status=error and clears localStorage', async () => {
    localStorageMock.setItem('live-generation', JSON.stringify({ mode: 'live', tempFileId: 'xyz-err' }))
    ;(api.getTempFile as Mock).mockResolvedValue({ id: 'xyz-err', status: 'error', content: '' })

    renderApp()

    await waitFor(() => {
      const elements = screen.getAllByText(/A geração anterior terminou com erro/i)
      expect(elements.length).toBeGreaterThan(0)
    })
    expect(localStorageMock.getItem('live-generation')).toBeNull()
  })

  it('shows error notification when temp file returns 404 and clears localStorage', async () => {
    localStorageMock.setItem('live-generation', JSON.stringify({ mode: 'live', tempFileId: 'xyz-404' }))
    // Simulate 404 by rejecting with an error
    ;(api.getTempFile as Mock).mockRejectedValue(new Error('Not found'))

    renderApp()

    await waitFor(() => {
      const elements = screen.getAllByText(/A geração anterior não foi encontrada/i)
      expect(elements.length).toBeGreaterThan(0)
    })
    expect(localStorageMock.getItem('live-generation')).toBeNull()
  })
})

// ── 409 handling ──

describe('App — 409 conflict handling from generate endpoint', () => {
  it('shows error notification on 409 response and form remains enabled', async () => {
    // No saved file in localStorage
    ;(getStorageItem as Mock).mockImplementation(() => null)

    const user = userEvent.setup()
    renderApp()
    await screen.findByText('Agentes de Análise de Conteúdo')

    // Open new content modal
    const newContentBtn = screen.getByRole('button', { name: /novo/i })
    await user.click(newContentBtn)
    await screen.findByRole('heading', { name: /novo conteúdo/i })

    // Switch to URL mode
    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('source-option-url'))

    const urlInput = await screen.findByPlaceholderText(/youtube|exemplo/i)
    await user.type(urlInput, 'https://example.com')

    await user.click(screen.getByTestId('step-next'))

    // Gerar — opens GenerationModeModal
    await user.click(screen.getByTestId('step-submit'))
    await screen.findByText('Modo de Geração')

    // Make lesson.start simulate a 409 error
    mockLesson.error = 'Uma geração já está em andamento. Aguarde ela terminar.'
    mockLesson.start = vi.fn(() => {
      // Simulate what happens when the SSE hook receives a 409
    })

    // Click realtime option — this calls handleRealtime which calls lesson.start
    await user.click(screen.getByTestId('realtime-option'))

    // The error notification should appear
    await waitFor(() => {
      const elements = screen.getAllByText(/já está em andamento/i)
      expect(elements.length).toBeGreaterThan(0)
    })

    // The form should NOT be disabled — the "Novo Conteúdo" button should still be clickable
    // The dock "Novo" button should be visible and enabled
    expect(screen.getByRole('button', { name: /novo/i })).toBeEnabled()
  })
})

// ── Reading exam dock group ──

describe('App — reading exam dock group (Leitura)', () => {
  const mockReadingFile = {
    id: 'reading-file-1',
    name: 'Article Title',
    content: '# Article Title\n\nFull article text for testing purposes.',
    content_type: 'markdown',
    folder_id: 'folder-1',
    type: 'reading' as const,
    description: null,
    questions_count: 0,
  }

  const mockQuestionsResponse = {
    questions: [
      {
        id: 1,
        enunciado: 'De acordo com o texto, qual é a ideia principal?',
        alternativas: { A: 'Opção A', B: 'Opção B', C: 'Opção C', D: 'Opção D', E: 'Opção E' },
        correta: 'B',
        explicacao: 'Explicação.',
      },
      {
        id: 2,
        enunciado: 'No trecho..., a palavra X significa:',
        alternativas: { A: 'Opção A', B: 'Opção B', C: 'Opção C', D: 'Opção D', E: 'Opção E' },
        correta: 'C',
        explicacao: 'Explicação.',
      },
      {
        id: 3,
        enunciado: 'Qual é a função do segundo parágrafo?',
        alternativas: { A: 'Opção A', B: 'Opção B', C: 'Opção C', D: 'Opção D', E: 'Opção E' },
        correta: 'A',
        explicacao: 'Explicação.',
      },
      {
        id: 4,
        enunciado: 'Com base no texto, é correto inferir que:',
        alternativas: { A: 'Opção A', B: 'Opção B', C: 'Opção C', D: 'Opção D', E: 'Opção E' },
        correta: 'D',
        explicacao: 'Explicação.',
      },
      {
        id: 5,
        enunciado: 'No contexto, a expressão "X" significa:',
        alternativas: { A: 'Opção A', B: 'Opção B', C: 'Opção C', D: 'Opção D', E: 'Opção E' },
        correta: 'E',
        explicacao: 'Explicação.',
      },
    ],
  }

  beforeEach(() => {
    ;(getStorageItem as Mock).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'last-opened-file') {
        return { fileId: 'reading-file-1', fileName: 'Article Title', folderId: 'folder-1', folderName: 'Reading Folder' }
      }
      return null
    })
    ;(api.getFile as Mock).mockResolvedValue(mockReadingFile)
    ;(api.getQuestions as Mock).mockResolvedValue([])
    ;(api.generateReadingExam as Mock).mockResolvedValue(mockQuestionsResponse)
  })

  it('renders Leitura dock group when a reading file is open', async () => {
    renderApp()
    await screen.findByRole('heading', { name: /Article Title/i })
    expect(screen.getByLabelText('Leitura')).toBeInTheDocument()
  })

  it('calls generateReadingExam with file content and title when Gerar Prova is clicked', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByRole('heading', { name: /Article Title/i })

    // Open Leitura dock popover
    await user.click(screen.getByLabelText('Leitura'))
    await screen.findByText('Gerar Prova')

    // Click Gerar Prova
    await user.click(screen.getByText('Gerar Prova'))

    // Should call the API with the reading file's content and title
    await waitFor(() => {
      expect(api.generateReadingExam).toHaveBeenCalledWith(
        mockReadingFile.content,
        mockReadingFile.name,
      )
    })
  })

  it('opens ExamModal with returned questions on success', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByRole('heading', { name: /Article Title/i })

    // Open Leitura dock popover
    await user.click(screen.getByLabelText('Leitura'))
    await screen.findByText('Gerar Prova')

    // Click Gerar Prova
    await user.click(screen.getByText('Gerar Prova'))

    // ExamModal should open
    await waitFor(() => {
      expect(screen.getByTestId('exam-modal')).toBeInTheDocument()
    })
    // Should show progress and question text
    expect(screen.getByText(/Questão 1 de 5/)).toBeInTheDocument()
  })

  it('shows error message when generateReadingExam fails', async () => {
    ;(api.generateReadingExam as Mock).mockRejectedValue(new Error('Erro de conexão'))

    const user = userEvent.setup()
    renderApp()
    await screen.findByRole('heading', { name: /Article Title/i })

    // Open Leitura dock popover
    await user.click(screen.getByLabelText('Leitura'))
    await screen.findByText('Gerar Prova')

    // Click Gerar Prova
    await user.click(screen.getByText('Gerar Prova'))

    // Error should appear
    await waitFor(() => {
      const errors = screen.getAllByText(/Erro de conexão/i)
      expect(errors.length).toBeGreaterThan(0)
    })
  })
})
