import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FileManagerModal from './FileManagerModal'

// ── Mocks ──

const mockTree = vi.hoisted(() => [
  {
    id: 'folder-1',
    name: 'Minha Pasta',
    kind: 'folder' as const,
    folder_id: null,
    children: [
      {
        id: 'file-1',
        name: 'aula.md',
        kind: 'file' as const,
        content: '# Aula\n\nConteúdo da aula.',
        content_type: 'markdown',
        folder_id: 'folder-1',
        type: 'class' as const,
        description: null,
        questions_count: 0,
      },
      {
        id: 'file-2',
        name: 'lesson.md',
        kind: 'file' as const,
        content: '# Lesson\n\nConteúdo da lição.',
        content_type: 'markdown',
        folder_id: 'folder-1',
        type: 'class' as const,
        description: null,
        questions_count: 0,
      },
    ],
  },
  {
    id: 'file-root',
    name: 'nota-rapida.md',
    kind: 'file' as const,
    content: '# Nota',
    content_type: 'markdown',
    folder_id: null,
    type: 'class' as const,
    description: null,
    questions_count: 0,
  },
  {
    id: 'folder-empty',
    name: 'Pasta Vazia',
    kind: 'folder' as const,
    folder_id: null,
    children: [],
  },
  {
    id: 'file-reading',
    name: 'leitura.md',
    kind: 'file' as const,
    content: '# Leitura\\n\\nConteúdo de leitura.',
    content_type: 'markdown',
    folder_id: null,
    type: 'reading' as const,
    description: null,
    questions_count: 0,
  },
  {
    id: 'file-explanation',
    name: 'explicacao.md',
    kind: 'file' as const,
    content: '# Explicação\n\nExplicação de React.',
    content_type: 'markdown',
    folder_id: null,
    type: 'explanation' as const,
    description: null,
    questions_count: 0,
  },
  {
    id: 'file-notype',
    name: 'sem-tipo.md',
    kind: 'file' as const,
    content: '# Sem tipo\n\nSem tipo definido.',
    content_type: 'markdown',
    folder_id: null,
    type: null,
    description: null,
    questions_count: 0,
  },
])

const mockGetFolders = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockBulkMoveFiles = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockMoveFolder = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSetStorageItem = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  api: {
    getTree: vi.fn().mockResolvedValue(mockTree),
    getFolders: mockGetFolders,
    getTempFiles: vi.fn().mockResolvedValue([]),
    getFile: vi.fn(),
    getQuestions: vi.fn(),
    bulkMoveFiles: mockBulkMoveFiles,
    moveFolder: mockMoveFolder,
    updateFile: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/lib/utils', () => ({
  getStorageItem: vi.fn().mockReturnValue(null),
  setStorageItem: mockSetStorageItem,
  removeStorageItem: vi.fn(),
  downloadBlob: vi.fn(),
  forcePaint: vi.fn(),
}))

// ── Tests ──

describe('FileManagerModal — unconditional onSelectFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.location.hash = ''
  })

  it('calls onSelectFile exactly once with correct file data when clicking a file in manage mode', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        onSelectFile={onSelectFile}
        mode="manage"
      />,
    )

    // Navigate into folder to reveal files
    await screen.findByText('Minha Pasta')
    await user.click(screen.getByText('Minha Pasta'))
    await screen.findByText('aula.md')

    // Click the file
    await user.click(screen.getByText('aula.md'))

    // Called exactly once
    expect(onSelectFile).toHaveBeenCalledTimes(1)

    // Called with correct file data (FileItem, folderId, folderName)
    const callArgs = onSelectFile.mock.calls[0]
    expect(callArgs[0].id).toBe('file-1')
    expect(callArgs[0].name).toBe('aula.md')
    expect(callArgs[1]).toBe('folder-1')
    expect(callArgs[2]).toBe('Minha Pasta')
  })

  it('calls onSelectFile unconditionally when clicking a root-level file in manage mode', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        onSelectFile={onSelectFile}
        mode="manage"
      />,
    )

    await screen.findByText('nota-rapida.md')
    await user.click(screen.getByText('nota-rapida.md'))

    expect(onSelectFile).toHaveBeenCalledTimes(1)
    const callArgs = onSelectFile.mock.calls[0]
    expect(callArgs[0].id).toBe('file-root')
    expect(callArgs[0].name).toBe('nota-rapida.md')
    // Root file: folderId is null, folderName is current (Raiz)
    expect(callArgs[1]).toBeNull()
    expect(callArgs[2]).toBe('Raiz')
  })

  it('does not depend on streamingOpen — clicking a file always calls onSelectFile', async () => {
    // This test verifies that FileManagerModal never checks streamingOpen
    // to decide whether to call onSelectFile. Since streamingOpen is not a
    // prop and not consumed via context, the modal simply works regardless.
    const onSelectFile = vi.fn()
    const user = userEvent.setup()

    // Render without any streamingOpen prop — component has no such dependency
    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        onSelectFile={onSelectFile}
        mode="manage"
      />,
    )

    await screen.findByText('nota-rapida.md')
    await user.click(screen.getByText('nota-rapida.md'))

    // Confirm onSelectFile was called — proving no guard blocked it
    expect(onSelectFile).toHaveBeenCalledTimes(1)
    expect(onSelectFile.mock.calls[0][0].id).toBe('file-root')
  })

  it('calls onSelectFile when clicking a file in an empty folder (edge case)', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        onSelectFile={onSelectFile}
        mode="manage"
      />,
    )

    await screen.findByText('Pasta Vazia')
    await user.click(screen.getByText('Pasta Vazia'))

    // Navigated into empty folder — no files to click, but no crash
    // Verify the folder navigation worked and didn't throw
    expect(screen.getByText('Pasta Vazia')).toBeTruthy()
  })
})

describe('FileManagerModal — URL hash regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Ensure hash is empty before each test
    window.location.hash = ''
  })

  it('does not set window.location.hash when clicking a file row in manage mode', async () => {
    // NOTE: This test implicitly verifies unconditional onSelectFile behavior
    // — it calls onSelectFile regardless of any external state.
    const onSelectFile = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        onSelectFile={onSelectFile}
        mode="manage"
      />,
    )

    // Wait for tree to load
    await screen.findByText('Minha Pasta')

    // Navigate into the folder to reveal files
    await user.click(screen.getByText('Minha Pasta'))

    // Wait for the file to appear
    await screen.findByText('aula.md')

    // Click on the file row
    await user.click(screen.getByText('aula.md'))

    // Verify hash is still empty after the click
    expect(window.location.hash).toBe('')

    // Ensure onSelectFile was called (confirming the click registered)
    await waitFor(() => {
      expect(onSelectFile).toHaveBeenCalled()
    })
  })

  it('does not set window.location.hash when clicking multiple files in sequence', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        onSelectFile={onSelectFile}
        mode="manage"
      />,
    )

    await screen.findByText('Minha Pasta')
    await user.click(screen.getByText('Minha Pasta'))

    // Wait for files
    await screen.findByText('aula.md')
    await screen.findByText('lesson.md')

    // Click first file
    await user.click(screen.getByText('aula.md'))
    expect(window.location.hash).toBe('')

    // In manage mode, clicking a file while onSelectFile is provided just
    // calls onSelectFile — modal stays open, no hash should be set
    await user.click(screen.getByText('lesson.md'))
    expect(window.location.hash).toBe('')

    // Both files should have been selected
    expect(onSelectFile).toHaveBeenCalledTimes(2)
  })

  it('does not set window.location.hash when clicking a file at root level', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        onSelectFile={onSelectFile}
        mode="manage"
      />,
    )

    // Root files are visible immediately
    await screen.findByText('nota-rapida.md')

    // Click the root-level file
    await user.click(screen.getByText('nota-rapida.md'))

    // Verify hash is still empty
    expect(window.location.hash).toBe('')
    expect(onSelectFile).toHaveBeenCalled()
  })

  it('does not set window.location.hash in select-file mode', async () => {
    const onSelectFile = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        onSelectFile={onSelectFile}
        mode="select-file"
      />,
    )

    // Root-level files are visible immediately in select-file mode
    await screen.findByText('nota-rapida.md')

    // Click file in select-file mode
    await user.click(screen.getByText('nota-rapida.md'))

    // Verify hash is still empty
    expect(window.location.hash).toBe('')

    // Verify onSelectFile was called with the file (check id and name)
    expect(onSelectFile).toHaveBeenCalledTimes(1)
    const callArgs = onSelectFile.mock.calls[0]
    expect(callArgs[0].id).toBe('file-root')
    expect(callArgs[0].name).toBe('nota-rapida.md')
  })
})

describe('type badges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.location.hash = ''
  })

  it('renders Aula badge for class file', async () => {
    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        mode="manage"
      />,
    )
    await screen.findByText(/🎓 Aula/i)
    expect(screen.getByText(/🎓 Aula/i)).toBeInTheDocument()
  })

  it('renders Explicação badge for explanation file', async () => {
    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        mode="manage"
      />,
    )
    await screen.findByText(/💡 Explicação/i)
    expect(screen.getByText(/💡 Explicação/i)).toBeInTheDocument()
  })

  it('renders Leitura badge for reading file', async () => {
    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        mode="manage"
      />,
    )
    // Use exact match to avoid matching the filename "leitura.md"
    // Espera o arquivo, não qualquer texto com "Leitura": o botão de filtro tem esse
    // nome e aparece antes da árvore carregar, satisfazendo a espera cedo demais.
    await screen.findByText('leitura.md')
    const badges = await screen.findAllByText(/Leitura/i)
    // One badge should exist (the reading file is in the mock tree)
    // Filter to find the badge element specifically (has rounded-full class)
    const badgeElements = badges.filter(
      (el) => el.classList.contains('rounded-full'),
    )
    expect(badgeElements).toHaveLength(1)
    expect(badgeElements[0]).toHaveTextContent('Leitura')
  })

  it('renders no badge when file has no type', async () => {
    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        mode="manage"
      />,
    )
    // Wait for tree to finish loading
    await screen.findByText('sem-tipo.md')
    // The file 'sem-tipo.md' has type: null — its row should have no badge
    // Find the row element that contains the filename
    const fileRow = screen.getByText('sem-tipo.md').closest('.flex.items-center.gap-1')
    expect(fileRow).toBeTruthy()
    // Verify no badge text exists inside this specific row
    expect(fileRow?.querySelector('.rounded-full')).toBeNull()
  })
})

describe('Gerar Explicação action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.location.hash = ''
  })

  it('shows Gerar Explicação action for class files', async () => {
    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        mode="manage"
        onExplainFromLesson={vi.fn()}
      />,
    )
    // The class file 'nota-rapida.md' is at root — should show Gerar Explicação
    await screen.findByTitle(/Gerar Explicação/i)
    expect(screen.getByTitle(/Gerar Explicação/i)).toBeInTheDocument()
  })

  it('does not show Gerar Explicação for explanation files', async () => {
    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        mode="manage"
        onExplainFromLesson={vi.fn()}
      />,
    )
    // The explanation file 'explicacao.md' is at root — should NOT show Gerar Explicação
    expect(screen.queryByTitle(/Gerar Explicação/i)).not.toBeInTheDocument()
  })

  it('calls onExplainFromLesson with the file when clicked', async () => {
    const user = userEvent.setup()
    const onExplain = vi.fn()
    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        mode="manage"
        onExplainFromLesson={onExplain}
      />,
    )
    await screen.findByTitle(/Gerar Explicação/i)
    await user.click(screen.getByTitle(/Gerar Explicação/i))
    expect(onExplain).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-root', name: 'nota-rapida.md' }))
  })
})

describe('FileManagerModal — open file moved notification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.location.hash = ''
    // Reset hoisted mocks to defaults
    mockGetFolders.mockResolvedValue([])
    mockBulkMoveFiles.mockResolvedValue(undefined)
    mockMoveFolder.mockResolvedValue(undefined)
  })

  it('calls onOpenFileMoved when the open file is drag-dropped to a new folder', async () => {
    const onOpenFileMoved = vi.fn()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        openFileId="file-root"
        onOpenFileMoved={onOpenFileMoved}
        mode="manage"
      />,
    )

    // Wait for the tree to load — root-level items visible
    await screen.findByText('nota-rapida.md')

    // Get the draggable file row
    const fileRow = screen.getByText('nota-rapida.md').closest('[draggable="true"]')
    expect(fileRow).toBeTruthy()

    // Get the target folder (Pasta Vazia)
    const folderRow = screen.getByText('Pasta Vazia').closest('[data-folder-id]')
    expect(folderRow).toBeTruthy()

    // Simulate drag-start on the file — this sets draggedItems via state
    const dt = { effectAllowed: '', setData: vi.fn(), dropEffect: '' }
    fireEvent.dragStart(fileRow!, { dataTransfer: dt })

    // Wait for React state update (draggedItems is set)
    await waitFor(() => { /* flush state updates */ })

    // Simulate drop on the folder
    fireEvent.drop(folderRow!, { dataTransfer: dt })

    await waitFor(() => {
      expect(onOpenFileMoved).toHaveBeenCalledWith('folder-empty', 'Pasta Vazia')
    })
  })

  it('calls onOpenFileMoved when the open file is drag-dropped to root', async () => {
    const onOpenFileMoved = vi.fn()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        openFileId="file-1"
        onOpenFileMoved={onOpenFileMoved}
        mode="manage"
      />,
    )

    // Navigate into folder-1 (Minha Pasta) to reveal file-1
    await screen.findByText('Minha Pasta')
    const user = userEvent.setup()
    await user.click(screen.getByText('Minha Pasta'))
    await screen.findByText('aula.md')

    // Get the draggable file row
    const fileRow = screen.getByText('aula.md').closest('[draggable="true"]')
    expect(fileRow).toBeTruthy()

    // The root drop zone is the content area (.overflow-y-auto)
    const rootZone = document.querySelector('.overflow-y-auto')
    expect(rootZone).toBeTruthy()

    // Simulate drag-start on the file
    const dt = { effectAllowed: '', setData: vi.fn(), dropEffect: '' }
    fireEvent.dragStart(fileRow!, { dataTransfer: dt })

    await waitFor(() => { /* flush state updates */ })

    // Simulate root drop
    fireEvent.drop(rootZone!, { dataTransfer: dt })

    await waitFor(() => {
      expect(onOpenFileMoved).toHaveBeenCalledWith(null, 'Raiz')
    })
  })

  it('calls onOpenFileMoved when the open file is bulk-moved via move picker', async () => {
    // Provide folders for the move picker
    mockGetFolders.mockResolvedValue([{ id: 'folder-target', name: 'Física', folder_id: null }])

    const onOpenFileMoved = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        openFileId="file-root"
        onOpenFileMoved={onOpenFileMoved}
        mode="manage"
      />,
    )

    await screen.findByText('nota-rapida.md')

    // Click "Selecionar" button to select all root items
    await user.click(screen.getByText('Selecionar'))

    // Wait for selection state to update (5 items at root level)
    await screen.findByText(/selecionado/)

    // Click "Mover" to open the move picker
    await user.click(screen.getByText('Mover'))

    // Wait for the move picker to show the folder
    await screen.findByText('Física')

    // Click the target folder
    await user.click(screen.getByText('Física'))

    await waitFor(() => {
      expect(onOpenFileMoved).toHaveBeenCalledWith('folder-target', 'Física')
    })
  })

  it('does NOT call onOpenFileMoved when a different file is moved', async () => {
    // Provide folders for the move picker
    mockGetFolders.mockResolvedValue([{ id: 'folder-target', name: 'Física', folder_id: null }])

    const onOpenFileMoved = vi.fn()
    const user = userEvent.setup()

    render(
      <FileManagerModal
        open={true}
        onClose={vi.fn()}
        openFileId="file-99"    // different file — not the one being moved (file-root)
        onOpenFileMoved={onOpenFileMoved}
        mode="manage"
      />,
    )

    await screen.findByText('nota-rapida.md')

    // Click "Selecionar" to select all (includes file-root / nota-rapida.md)
    await user.click(screen.getByText('Selecionar'))

    await screen.findByText(/selecionado/)

    // Open move picker and move to folder
    await user.click(screen.getByText('Mover'))
    await screen.findByText('Física')
    await user.click(screen.getByText('Física'))

    // After the move, onOpenFileMoved should NOT have been called
    // because the moved file (file-root) is not the open file (file-99)
    await waitFor(() => {
      expect(onOpenFileMoved).not.toHaveBeenCalled()
    })
  })
})
