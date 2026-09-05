import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/api/client'
import type { TreeNode, FolderItem, FileItem, QuestionsResponse, DbQuestion, TempFileItem, CreateFileDto } from '@/types'
import { Folder, FolderOpen, FileText, Home, ChevronRight, Plus, X, Pencil, Trash2, ArrowUpToLine, FolderKanban, FileDown, CheckSquare, Square, Download, GraduationCap, Eye, Info, RotateCcw, History, Sparkles, Search, BookOpen } from 'lucide-react'
import { ClipboardList } from 'lucide-react'
import { downloadBlob, getStorageItem, setStorageItem } from '@/lib/utils'

interface FileManagerModalProps {
  open: boolean
  onClose: () => void
  onSelectFile?: (file: FileItem, folderId: string | null, folderName: string | null) => void
  onSelectFolder?: (folder: { id: string | null; name: string }) => void
  onStartExam?: (questionsResponse: QuestionsResponse) => void
  onStartFolderExam?: (folder: FolderItem) => void
  onDeleteFile?: (fileId: string) => void
  onExplainFromLesson?: (file: FileItem) => void
  initialFolderId?: string | null
  mode?: 'manage' | 'select-folder' | 'select-file'
  openFileId?: string | null
  onOpenFileMoved?: (folderId: string | null, folderName: string) => void
}

export default function FileManagerModal({
  open,
  onClose,
  onSelectFile,
  onSelectFolder,
  onStartExam,
  onStartFolderExam,
  onDeleteFile,
  onExplainFromLesson,
  initialFolderId,
  mode = 'manage',
  openFileId,
  onOpenFileMoved,
}: FileManagerModalProps) {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(initialFolderId ?? null)
  const [currentFolderName, setCurrentFolderName] = useState('Raiz')
  // getStorageItem can hand back null instead of the fallback, so each default is pinned here.
  const [tiposFiltrados, setTiposFiltrados] = useState<string[]>(
    () => getStorageItem<string[]>('manager-tipos', []) ?? [],
  )
  const [ocultarPastas, setOcultarPastas] = useState(() => getStorageItem('manager-ocultar-pastas', false) ?? false)
  const [modoBloco, setModoBloco] = useState(() => getStorageItem('manager-modo-bloco', false) ?? false)
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [draggedItems, setDraggedItems] = useState<TreeNode[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showQuestionViewer, setShowQuestionViewer] = useState<string | null>(null)
  const [questionsCache, setQuestionsCache] = useState<Record<string, { questions: any[]; loading: boolean }>>({})
  const [operating, setOperating] = useState(false)
  const [operatingLabel, setOperatingLabel] = useState('')
  const [actionError, setActionError] = useState('')
  const [descriptionModal, setDescriptionModal] = useState<{ fileId: string; fileName: string; description: string } | null>(null)
  const [descriptionText, setDescriptionText] = useState('')
  const [showMovePicker, setShowMovePicker] = useState(false)
  const [movePickerFolders, setMovePickerFolders] = useState<FolderItem[]>([])
  const [movePickerLoading, setMovePickerLoading] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const [activeTab, setActiveTab] = useState<'files' | 'temp'>('files')

  // ── Temp file state ──
  const [tempFiles, setTempFiles] = useState<TempFileItem[]>([])
  const [tempLoading, setTempLoading] = useState(false)
  const [restoreDialog, setRestoreDialog] = useState<{
    id: string
    name: string
    description?: string | null
    folders: FolderItem[]
    folderId: string | null
    folderName: string
  } | null>(null)
  const [restoreName, setRestoreName] = useState('')
  const [restoreDesc, setRestoreDesc] = useState('')
  const [operatingTemp, setOperatingTemp] = useState(false)
  const [viewTempFile, setViewTempFile] = useState<TempFileItem | null>(null)

  const loadTempFiles = useCallback(async () => {
    setTempLoading(true)
    try {
      const data = await api.getTempFiles()
      setTempFiles(data)
    } catch {
      // ignore
    } finally {
      setTempLoading(false)
    }
  }, [])

  const handleDeleteTemp = async (id: string) => {
    if (!confirm('Excluir permanentemente este arquivo temporário?')) return
    setOperatingTemp(true)
    try {
      await api.deleteTempFile(id)
      setTempFiles((prev) => prev.filter((f) => f.id !== id))
    } catch {
      // ignore
    } finally {
      setOperatingTemp(false)
    }
  }

  const handleOpenRestore = async (file: TempFileItem) => {
    setRestoreName(file.name)
    setRestoreDesc(file.description || '')
    setRestoreDialog({
      id: file.id,
      name: file.name,
      description: file.description,
      folders: [],
      folderId: null,
      folderName: 'Raiz',
    })
    try {
      const folders = await api.getFolders()
      setRestoreDialog(prev => prev ? { ...prev, folders } : null)
    } catch {
      // ignore
    }
  }

  const handleRestoreConfirm = async () => {
    if (!restoreDialog || !restoreName.trim()) return
    setOperatingTemp(true)
    try {
      await api.restoreTempFile(restoreDialog.id, {
        name: restoreName.trim(),
        folder_id: restoreDialog.folderId,
        description: restoreDesc || undefined,
      })
      setTempFiles((prev) => prev.filter((f) => f.id !== restoreDialog.id))
      setRestoreDialog(null)
      loadTree()
    } catch {
      // ignore
    } finally {
      setOperatingTemp(false)
    }
  }

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr)
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch {
      return dateStr
    }
  }

  const loadTree = useCallback(async (): Promise<TreeNode[]> => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getTree()
      setTree(data)
      return data
    } catch (e: unknown) {
      setError((e as Error).message)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  // Find folder name in tree recursively by ID
  const findFolderNameIn = useCallback((nodes: TreeNode[], targetId: string): string | null => {
    for (const n of nodes) {
      if (n.kind === 'folder' && n.id === targetId) return n.name
      if (n.kind === 'folder') {
        const found = findFolderNameIn(n.children, targetId)
        if (found !== null) return found
      }
    }
    return null
  }, [])

  useEffect(() => {
    if (open) {
      loadTree().then((data) => {
        const folderId = initialFolderId ?? getStorageItem<string | null>('last-folder-id', null)
        setCurrentFolderId(folderId)
        const resolvedName = folderId ? (findFolderNameIn(data, folderId) ?? 'Raiz') : 'Raiz'
        setCurrentFolderName(resolvedName)
      })
    }
  }, [open, initialFolderId, loadTree, findFolderNameIn])

  const getCurrentChildren = (): TreeNode[] => {
    if (!currentFolderId) {
      return tree
    }
    const find = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.kind === 'folder' && n.id === currentFolderId) return n
        if (n.kind === 'folder') {
          const found = find(n.children)
          if (found) return found
        }
      }
      return null
    }
    const folder = find(tree)
    return folder && folder.kind === 'folder' ? folder.children : []
  }

  /** Type filter applies to files only: folders are governed by their own toggle. */
  const aplicarFiltros = (nodes: TreeNode[]): TreeNode[] =>
    nodes.filter(node => {
      if (node.kind === 'folder') return !ocultarPastas
      if (tiposFiltrados.length === 0) return true
      return tiposFiltrados.includes((node as FileItem).type ?? '')
    })

  // Escape closes the modal, matching NewContentModal. Until now the key only
  // cancelled inline editing, so the modal itself could not be dismissed by keyboard.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const navigateTo = (folderId: string | null, folderName: string) => {
    setCurrentFolderId(folderId)
    setCurrentFolderName(folderName)
    setSelectedIds(new Set())
    setStorageItem('last-folder-id', folderId)
    setStorageItem('last-folder-name', folderName)
  }

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return
    setOperating(true)
    setOperatingLabel('Criando pasta...')
    setActionError('')
    try {
      await api.createFolder({ name: newFolderName.trim(), folder_id: currentFolderId })
      setNewFolderName('')
      setShowCreateFolder(false)
      await loadTree()
    } catch (e: unknown) {
      setActionError(`Erro ao criar pasta: ${(e as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  const handleRename = async (item: TreeNode) => {
    if (!editingName.trim()) {
      setEditingId(null)
      return
    }
    setOperating(true)
    setOperatingLabel('Renomeando...')
    setActionError('')
    try {
      if (item.kind === 'folder') {
        await api.updateFolder(item.id, { name: editingName.trim() })
      } else {
        await api.updateFile(item.id, { name: editingName.trim() })
      }
      setEditingId(null)
      await loadTree()
    } catch (e: unknown) {
      setActionError(`Erro ao renomear: ${(e as Error).message}`)
      setEditingId(null)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  const handleDelete = async (item: TreeNode) => {
    if (!confirm(`Deseja excluir "${item.name}"?`)) return
    setOperating(true)
    setOperatingLabel('Excluindo...')
    setActionError('')
    try {
      if (item.kind === 'folder') {
        await api.deleteFolder(item.id)
      } else {
        await api.deleteFile(item.id)
        onDeleteFile?.(item.id)
      }
      await loadTree()
    } catch (e: unknown) {
      setActionError(`Erro ao excluir: ${(e as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  const handleImport = async () => {
    importRef.current?.click()
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setOperating(true)
    setOperatingLabel('Importando...')
    setActionError('')
    try {
      await api.importFile(file, currentFolderId)
      await loadTree()
    } catch (err: unknown) {
      setActionError(`Erro ao importar: ${(err as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
    // Reset input
    e.target.value = ''
  }

  // --- Drag and Drop ---

  // Check if candidateId is a descendant of ancestorId in the tree
  const isDescendantOf = (ancestorId: string, candidateId: string, nodes: TreeNode[]): boolean => {
    const findFolder = (n: TreeNode[], id: string): FolderItem | null => {
      for (const item of n) {
        if (item.kind === 'folder' && item.id === id) return item
        if (item.kind === 'folder') {
          const found = findFolder(item.children, id)
          if (found) return found
        }
      }
      return null
    }
    const folder = findFolder(nodes, ancestorId)
    if (!folder) return false
    // BFS/DFS to check if candidateId is anywhere inside folder's subtree
    const contains = (n: TreeNode[], target: string): boolean => {
      for (const item of n) {
        if (item.id === target) return true
        if (item.kind === 'folder' && contains(item.children, target)) return true
      }
      return false
    }
    return contains(folder.children, candidateId)
  }

  const handleDragStart = (e: React.DragEvent, item: TreeNode) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.id)

    // If dragging an already-selected item AND there are multiple selected,
    // move all selected items together
    if (selectedIds.has(item.id) && selectedIds.size > 1) {
      setDraggedItems(getSelectedItems())
    } else {
      setDraggedItems([item])
    }
  }

  const handleDragEnd = () => {
    setDraggedItems([])
    setDragOverFolderId(null)
  }

  // --- Folder drop-target handlers ---

  const handleFolderDragEnter = (e: React.DragEvent, folder: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    if (folder.kind !== 'folder') return

    // Cannot drop on itself or any item being dragged
    if (draggedItems.some((d) => d.id === folder.id)) return

    // Cannot drop a folder into its own descendant (circular)
    if (draggedItems.some((d) => d.kind === 'folder' && isDescendantOf(d.id, folder.id, tree))) return

    setDragOverFolderId(folder.id)
  }

  const handleFolderDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    // Do NOT clear dragOverFolderId here — when moving between siblings
    // or back to the root area, dragEnter on the new target will set the
    // correct ID. Clearing here causes flicker and lost state.
    // State is cleaned up on drop or dragEnd.
  }

  const handleFolderDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleFolderDrop = async (e: React.DragEvent, targetFolder: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderId(null)

    if (draggedItems.length === 0) return
    if (targetFolder.kind !== 'folder') return
    if (draggedItems.some((d) => d.id === targetFolder.id)) return
    if (draggedItems.some((d) => d.kind === 'folder' && isDescendantOf(d.id, targetFolder.id, tree))) return

    const targetId = targetFolder.id

    setOperating(true)
    setOperatingLabel('Movendo...')
    setActionError('')
    try {
      const fileIds = draggedItems.filter((d) => d.kind === 'file').map((d) => d.id)
      const folderItems = draggedItems.filter((d) => d.kind === 'folder')

      if (fileIds.length > 0) {
        await api.bulkMoveFiles(fileIds, targetId)
        // Notify parent if the moved batch includes the currently-open file
        if (openFileId && fileIds.includes(openFileId)) {
          onOpenFileMoved?.(targetId, targetFolder.name)
        }
      }
      for (const f of folderItems) await api.moveFolder(f.id, targetId)

      setDraggedItems([])
      setSelectedIds(new Set())
      await loadTree()
    } catch (err: unknown) {
      setActionError(`Erro ao mover: ${(err as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  // --- Root drop-zone handlers ---

  const handleRootDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOverFolderId('__root__')
  }

  const handleRootDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    // Detect if the cursor is over a folder row by climbing the DOM
    let el = e.target as HTMLElement | null
    while (el && el !== e.currentTarget) {
      const folderId = el.getAttribute('data-folder-id')
      if (folderId) {
        // Validate: not self, not descendant of dragged folder
        if (draggedItems.some((d) => d.id === folderId)) break
        if (draggedItems.some((d) => d.kind === 'folder' && isDescendantOf(d.id, folderId, tree))) break
        setDragOverFolderId(folderId)
        return
      }
      el = el.parentElement
    }
    // Not over any valid folder — show root drop indicator
    setDragOverFolderId('__root__')
  }

  const handleRootDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    // Do NOT clear here — root dragEnter will set __root__ when appropriate.
    // State is cleaned up on drop or dragEnd.
  }

  const handleRootDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOverFolderId(null)

    if (draggedItems.length === 0) return

    setOperating(true)
    setOperatingLabel('Movendo...')
    setActionError('')
    try {
      const fileIds = draggedItems.filter((d) => d.kind === 'file').map((d) => d.id)
      const folderItems = draggedItems.filter((d) => d.kind === 'folder')

      if (fileIds.length > 0) {
        await api.bulkMoveFiles(fileIds, null)
        // Notify parent if the moved batch includes the currently-open file
        if (openFileId && fileIds.includes(openFileId)) {
          onOpenFileMoved?.(null, 'Raiz')
        }
      }
      for (const f of folderItems) await api.moveFolder(f.id, null)

      setDraggedItems([])
      setSelectedIds(new Set())
      await loadTree()
    } catch (err: unknown) {
      setActionError(`Erro ao mover: ${(err as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  const handleSelectItem = (item: TreeNode) => {
    if (mode === 'select-folder' && item.kind === 'folder') {
      onSelectFolder?.(item as FolderItem)
      handleClose()
    } else if (mode === 'select-file' && item.kind === 'file') {
      onSelectFile?.(item as FileItem, currentFolderId, currentFolderName)
      handleClose()
    }
  }

  // --- Selection / Bulk ---
  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    const allIds = new Set(currentChildren.map((c) => c.id))
    setSelectedIds(allIds)
  }

  const deselectAll = () => setSelectedIds(new Set())

  const getSelectedItems = (): TreeNode[] => {
    const result: TreeNode[] = []
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (selectedIds.has(n.id)) result.push(n)
        if (n.kind === 'folder') collect(n.children)
      }
    }
    collect(currentChildren)
    return result
  }

  const handleBulkDelete = async () => {
    const selected = getSelectedItems()
    if (selected.length === 0) return
    const names = selected.map((s) => s.name).join(', ')
    if (!confirm(`Deseja excluir permanentemente ${selected.length} item(ns)?\n\n${names}`)) return

    setOperating(true)
    setOperatingLabel('Excluindo...')
    setActionError('')
    try {
      const fileIds = selected.filter((s) => s.kind === 'file').map((s) => s.id)
      const folderIds = selected.filter((s) => s.kind === 'folder').map((s) => s.id)

      if (fileIds.length > 0) await api.bulkDeleteFiles(fileIds)
      for (const fid of folderIds) await api.deleteFolder(fid)

      setSelectedIds(new Set())
      await loadTree()
    } catch (e: unknown) {
      setActionError(`Erro ao excluir: ${(e as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  const handleBulkMove = async (folderId: string | null, folderName: string) => {
    const selected = getSelectedItems()
    if (selected.length === 0) return

    setShowMovePicker(false)
    setOperating(true)
    setOperatingLabel('Movendo...')
    setActionError('')
    try {
      const fileIds = selected.filter((s) => s.kind === 'file').map((s) => s.id)
      if (fileIds.length > 0) {
        await api.bulkMoveFiles(fileIds, folderId)
        // Notify parent if the moved batch includes the currently-open file
        if (openFileId && fileIds.includes(openFileId)) {
          onOpenFileMoved?.(folderId, folderName)
        }
      }

      const folderItems = selected.filter((s) => s.kind === 'folder')
      for (const f of folderItems) await api.moveFolder(f.id, folderId)

      setSelectedIds(new Set())
      await loadTree()
    } catch (e: unknown) {
      setActionError(`Erro ao mover: ${(e as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  const openMovePicker = async () => {
    const selected = getSelectedItems()
    if (selected.length === 0) return
    setMovePickerLoading(true)
    setShowMovePicker(true)
    try {
      const folders = await api.getFolders()
      setMovePickerFolders(folders)
    } catch {
      setMovePickerFolders([])
    } finally {
      setMovePickerLoading(false)
    }
  }

  const handleBulkExport = async () => {
    const selected = getSelectedItems()
    const fileItems = selected.filter((s) => s.kind === 'file')
    if (fileItems.length === 0) {
      setActionError('Selecione pelo menos um arquivo para exportar.')
      return
    }

    setOperating(true)
    setOperatingLabel('Exportando...')
    setActionError('')
    try {
      const ids = fileItems.map((f) => f.id)
      const blob = await api.bulkExportZip(ids)
      downloadBlob(blob, 'export.zip')
    } catch (e: unknown) {
      setActionError(`Erro ao exportar: ${(e as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  // --- Questions from file manager ---
  const handleGenerateQuestionsForFile = async (file: FileItem) => {
    const hasQuestions = (file.questions_count ?? 0) > 0
    if (hasQuestions) {
      if (!confirm(`O arquivo "${file.name}" já possui ${file.questions_count} questão(ões). Deseja substituí-las por novas questões?`)) {
        return
      }
    }

    setOperating(true)
    setOperatingLabel('Gerando questões...')
    setActionError('')
    try {
      // Get full file with content
      const fullFile = await api.getFile(file.id)
      const title = fullFile.name.replace(/\.md$/i, '')
      // Pass file.id so the backend auto-saves questions via persistQuestions
      const questionsData = await api.generateQuestions(fullFile.content, title, file.id)

      if (!questionsData.questions?.length) {
        const raw = questionsData.raw
        if (raw) {
          setActionError(`A IA não retornou questões no formato esperado. Resposta bruta: ${raw.slice(0, 200)}...`)
        } else {
          setActionError('Nenhuma questão foi gerada. Tente novamente.')
        }
        return
      }

      // Questions are auto-saved by the backend (generate-content → file-management)
      await loadTree()
      setActionError(`${questionsData.questions.length} questão(ões) gerada(s) com sucesso!`)
      // Clear success message after 3s
      setTimeout(() => setActionError(''), 3000)
    } catch (e: unknown) {
      setActionError(`Erro ao gerar questões: ${(e as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  const handleOpenQuestions = async (fileId: string) => {
    setShowQuestionViewer(fileId)
  }

  const handleStartExam = async (file: FileItem) => {
    if (!onStartExam) return
    setOperating(true)
    setOperatingLabel('Preparando prova...')
    try {
      const dbQuestions = await api.getQuestions(file.id)
      if (dbQuestions.length === 0) {
        setActionError('Nenhuma questão encontrada para este arquivo.')
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
      onStartExam(questionsResponse)
    } catch (e: unknown) {
      setActionError(`Erro ao carregar questões: ${(e as Error).message}`)
    } finally {
      setOperating(false)
      setOperatingLabel('')
    }
  }

  const isSelected = (id: string) => selectedIds.has(id)

  const renderTreeNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    const isDragOver = dragOverFolderId === node.id
    const isBeingDragged = draggedItems.some((d) => d.id === node.id)

    if (node.kind === 'folder') {
      return (
        <div key={node.id} className="relative">
          <div
            data-testid="folder-row"
            data-folder-id={node.id}
            className={`flex items-center gap-1 py-1 px-2 rounded-md cursor-pointer
                       transition-colors text-sm group
                       ${isDragOver ? 'bg-violet-500/20 ring-1 ring-violet-400' : 'hover:bg-white/5'}
                       ${mode !== 'manage' ? 'hover:bg-violet-500/10' : ''}
                       ${isBeingDragged ? 'opacity-40' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            draggable={mode === 'manage'}
            onDragStart={(e) => handleDragStart(e, node)}
            onDragEnd={handleDragEnd}
            onDragEnter={(e) => handleFolderDragEnter(e, node)}
            onDragOver={handleFolderDragOver}
            onDragLeave={handleFolderDragLeave}
            onDrop={(e) => handleFolderDrop(e, node)}
            onClick={() => {
              if (mode !== 'manage') {
                handleSelectItem(node)
                return
              }
              navigateTo(node.id, node.name)
            }}
          >
            {mode === 'manage' && (
              <span data-testid="select-check" onClick={(e) => { e.stopPropagation(); toggleSelection(node.id) }}>
                {isSelected(node.id) ? <CheckSquare size={14} className="text-violet-400" /> : <Square size={14} className="text-slate-500" />}
              </span>
            )}
            <span className="text-xs"><Folder size={14} className="text-amber-400" /></span>
            {editingId === node.id ? (
              <input
                data-testid="rename-input"
                className="bg-white/10 border border-white/20 rounded px-1 py-0 text-xs text-white flex-1 min-w-0"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={() => handleRename(node)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename(node)
                  if (e.key === 'Escape') setEditingId(null)
                }}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="text-slate-300 truncate flex-1">{node.name}</span>
            )}
            {mode === 'manage' && (
              <div className="hidden group-hover:flex items-center gap-0.5 ml-auto">
                <button
                  className="p-0.5 text-slate-500 hover:text-violet-400 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    onStartFolderExam?.(node as FolderItem)
                  }}
                  title="Prova da pasta"
                >
                  <ClipboardList size={12} />
                </button>
                <button
                  data-testid="rename-btn"
                  className="p-0.5 text-slate-500 hover:text-white transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingId(node.id)
                    setEditingName(node.name)
                  }}
                  title="Renomear"
                >
                  <Pencil size={12} />
                </button>
                <button
                  data-testid="delete-btn"
                  className="p-0.5 text-slate-500 hover:text-red-400 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete(node)
                  }}
                  title="Excluir"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )}
          </div>

        </div>
      )
    }

    // File
    const fileNode = node as FileItem
    const questionCount = fileNode.questions_count ?? 0

    return (
      <div
        data-testid="file-row"
        key={node.id}
        className={`flex items-center gap-1 py-1 px-2 rounded-md cursor-pointer
                   transition-colors text-sm group
                   hover:bg-white/5
                   ${mode === 'select-file' ? 'hover:bg-violet-500/10' : ''}
                   ${isBeingDragged ? 'opacity-40' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        draggable={mode === 'manage'}
        onDragStart={(e) => handleDragStart(e, node)}
        onDragEnd={handleDragEnd}
        onClick={() => {
          if (mode === 'select-file') {
            handleSelectItem(node)
          } else if (mode === 'manage' && onSelectFile) {
            onSelectFile(fileNode, currentFolderId, currentFolderName)
          }
        }}
      >
        {mode === 'manage' && (
          <span data-testid="select-check" onClick={(e) => { e.stopPropagation(); toggleSelection(node.id) }}>
            {isSelected(node.id) ? <CheckSquare size={14} className="text-violet-400" /> : <Square size={14} className="text-slate-500" />}
          </span>
        )}
        <span className="text-xs"><FileText size={14} className="text-cyan-400" /></span>
        {editingId === node.id ? (
          <input
            data-testid="rename-input"
            className="bg-white/10 border border-white/20 rounded px-1 py-0 text-xs text-white flex-1 min-w-0"
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={() => handleRename(node)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename(node)
              if (e.key === 'Escape') setEditingId(null)
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <span className="text-slate-400 truncate flex-1">{node.name}</span>
            {/* File type badge */}
            {renderFileTypeBadge(fileNode.type)}
            {/* Questions badge */}
            {questionCount > 0 && (
              <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 border border-violet-500/20">
                {questionCount}Q
              </span>
            )}
          </>
        )}
        {mode === 'manage' && (
          <div className="flex items-center gap-0.5 ml-auto">
            {/* Gerar Explicação — only for class files */}
            {fileNode.type === 'class' && onExplainFromLesson && (
              <button
                className="p-0.5 text-slate-500 hover:text-violet-400 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  onExplainFromLesson(fileNode)
                  onClose()
                }}
                title="Gerar Explicação"
              >
                <Sparkles size={12} />
              </button>
            )}
            {/* Generate questions button (always visible) */}
            <button
              className="p-0.5 text-slate-500 hover:text-amber-400 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                handleGenerateQuestionsForFile(fileNode)
              }}
              title="Gerar questões"
            >
              <GraduationCap size={12} />
            </button>
            {/* Open questions button (only if questions exist) */}
            {questionCount > 0 && (
              <>
                <button
                  className="p-0.5 text-slate-500 hover:text-emerald-400 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStartExam(fileNode)
                  }}
                  title="Fazer prova"
                >
                  <ClipboardList size={12} />
                </button>

              </>
            )}
            {/* Description button */}
            <button
              className="p-0.5 text-slate-500 hover:text-amber-400 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                setDescriptionModal({
                  fileId: fileNode.id,
                  fileName: fileNode.name,
                  description: fileNode.description || '',
                })
                setDescriptionText(fileNode.description || '')
              }}
              title={fileNode.description ? 'Ver descrição' : 'Adicionar descrição'}
            >
              <Info size={12} />
            </button>
            <button
              data-testid="rename-btn"
              className="p-0.5 text-slate-500 hover:text-white transition-colors text-xs"
              onClick={(e) => {
                e.stopPropagation()
                setEditingId(node.id)
                setEditingName(node.name)
              }}
              title="Renomear"
            >
              <Pencil size={12} />
            </button>
            <button
              data-testid="delete-btn"
              className="p-0.5 text-slate-500 hover:text-red-400 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                handleDelete(node)
              }}
              title="Excluir"
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>
    )
  }

  // --- Helpers ---
  function renderFileTypeBadge(fileType: string | null | undefined): React.ReactNode {
    if (!fileType) return null
    if (fileType === 'class') {
      return (
        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300 border border-violet-500/30">
          🎓 Aula
        </span>
      )
    }
    if (fileType === 'explanation') {
      return (
        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
          💡 Explicação
        </span>
      )
    }
    if (fileType === 'reading') {
      return (
        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
          📖 Leitura
        </span>
      )
    }
    if (fileType === 'meeting') {
      return (
        <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
          🎙 Reunião
        </span>
      )
    }
    return null
  }

  function getContentTypeBadge(contentType: string | null | undefined): React.ReactNode {
    if (!contentType) return null
    const ct = contentType.toLowerCase()
    let label = ''
    let colorClass = ''

    if (ct === 'markdown' || ct === 'text/markdown') {
      label = 'MD'
      colorClass = 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/20'
    } else if (ct.startsWith('video/')) {
      label = 'Vídeo'
      colorClass = 'bg-red-500/15 text-red-300 border border-red-500/20'
    } else if (ct.startsWith('audio/')) {
      label = 'Áudio'
      colorClass = 'bg-yellow-500/15 text-yellow-300 border border-yellow-500/20'
    } else if (ct === 'application/pdf' || ct === 'pdf') {
      label = 'PDF'
      colorClass = 'bg-red-500/15 text-red-300 border border-red-500/20'
    } else if (ct === 'text/plain' || ct === 'txt') {
      label = 'TXT'
      colorClass = 'bg-slate-500/15 text-slate-300 border border-slate-500/20'
    } else if (ct === 'application/zip' || ct === 'zip') {
      label = 'ZIP'
      colorClass = 'bg-amber-500/15 text-amber-300 border border-amber-500/20'
    } else {
      // Fallback: show the content type itself, truncated
      label = ct.length > 8 ? ct.slice(0, 8) + '…' : ct
      colorClass = 'bg-white/5 text-slate-400 border border-white/10'
    }

    return (
      <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${colorClass}`}>
        {label}
      </span>
    )
  }

  const currentChildren = aplicarFiltros(getCurrentChildren())

  if (!open) return null

  const handleClose = () => {
    setSelectedIds(new Set())
    onClose()
  }

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />

      {/* Modal */}
      <div
        data-testid="file-manager-modal"
        className="relative z-10 w-full max-w-4xl max-h-[85vh] mx-4
                      bg-[#0d0d15] border border-white/10 rounded-2xl
                      shadow-2xl shadow-black/50 flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <FolderKanban size={20} className="text-violet-400" />
                {mode === 'select-folder' ? 'Selecionar Pasta' :
                 mode === 'select-file' ? 'Selecionar Arquivo' :
                 'Gerenciador de Arquivos'}
              </h2>
              {mode === 'manage' && (
                <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5 border border-white/10">
                  <button
                    onClick={() => setActiveTab('files')}
                    className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                      activeTab === 'files'
                        ? 'bg-violet-500/20 text-violet-200'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    <Folder size={10} className="inline mr-0.5" />
                    Arquivos
                  </button>
                  <button
                    onClick={() => { setActiveTab('temp'); loadTempFiles() }}
                    className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                      activeTab === 'temp'
                        ? 'bg-amber-500/20 text-amber-200'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    <History size={10} className="inline mr-0.5" />
                    Temporários
                  </button>
                </div>
              )}
            </div>
            {/* Breadcrumb — only show for files tab */}
            {activeTab === 'files' && (
              <nav className="flex items-center gap-1 mt-1 text-xs text-slate-500 overflow-x-auto scrollbar-none">
                {buildBreadcrumb(tree, currentFolderId).map((crumb, idx, arr) => (
                  <span key={crumb.id ?? '__root'} className="flex items-center gap-1 whitespace-nowrap">
                    {idx > 0 && <ChevronRight size={12} className="text-slate-600 shrink-0" />}
                    {crumb.id === null ? (
                      <button
                        onClick={() => navigateTo(null, 'Raiz')}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
                          arr.length === 1 ? 'text-slate-400' : 'hover:text-violet-400 hover:bg-white/5'
                        }`}
                      >
                        <Home size={12} />
                        <span>Raiz</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => navigateTo(crumb.id!, crumb.name)}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
                          idx === arr.length - 1
                            ? 'text-violet-300 font-medium'
                            : 'hover:text-violet-400 hover:bg-white/5'
                        }`}
                      >
                        <FolderOpen size={12} />
                        <span className="truncate max-w-30">{crumb.name}</span>
                      </button>
                    )}
                  </span>
                ))}
              </nav>
            )}
          </div>
          <button
            data-testid="modal-close"
            onClick={handleClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        {/* Toolbar — only for files tab */}
        {mode === 'manage' && activeTab === 'files' && (
          <>
            <div className="flex items-center gap-2 px-5 py-2 border-b border-white/5">
              <button
                onClick={() => navigateTo(null, 'Raiz')}
                disabled={operating}
                className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10
                           text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Home size={14} /> Raiz
              </button>
              {currentFolderId && (
                <button
                  onClick={async () => {
                    const folder = findFolderById(tree, currentFolderId)
                    if (folder?.folder_id !== undefined) {
                      navigateTo(folder.folder_id ?? null, '...')
                    } else {
                      navigateTo(null, 'Raiz')
                    }
                  }}
                  disabled={operating}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10
                             text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ArrowUpToLine size={14} /> Subir
                </button>
              )}
              <div className="flex items-center gap-1 ml-1">
                {([
                  ['class', 'Aula'],
                  ['explanation', 'Explicação'],
                  ['meeting', 'Reunião'],
                  ['reading', 'Leitura'],
                ] as const).map(([tipo, rotulo]) => {
                  const ativo = tiposFiltrados.includes(tipo)
                  return (
                    <button
                      key={tipo}
                      onClick={() => {
                        const proximo = ativo
                          ? tiposFiltrados.filter(t => t !== tipo)
                          : [...tiposFiltrados, tipo]
                        setTiposFiltrados(proximo)
                        setStorageItem('manager-tipos', proximo)
                      }}
                      className={`px-2 py-1 text-[11px] rounded-lg border transition-colors ${
                        ativo
                          ? 'bg-violet-500/20 border-violet-500/40 text-violet-200'
                          : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {rotulo}
                    </button>
                  )
                })}
              </div>

              <div className="flex-1" />

              <button
                onClick={() => { setOcultarPastas(!ocultarPastas); setStorageItem('manager-ocultar-pastas', !ocultarPastas) }}
                className={`px-2 py-1 text-[11px] rounded-lg border transition-colors ${
                  ocultarPastas
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
                    : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
                }`}
              >
                {ocultarPastas ? 'Mostrar pastas' : 'Ocultar pastas'}
              </button>
              <button
                onClick={() => { setModoBloco(!modoBloco); setStorageItem('manager-modo-bloco', !modoBloco) }}
                className="px-2 py-1 text-[11px] rounded-lg border bg-white/5 border-white/10 text-slate-400 hover:text-slate-200 transition-colors"
              >
                {modoBloco ? 'Lista' : 'Bloco'}
              </button>

              {/* Operating indicator */}
              {operating && (
                <span className="flex items-center gap-1.5 text-xs text-violet-400">
                  <span className="inline-block w-3 h-3 border-2 border-violet-400/30 border-t-violet-400 rounded-full animate-spin" />
                  {operatingLabel}
                </span>
              )}
              {/* Select controls */}
              {selectedIds.size > 0 ? (
                <button
                  onClick={deselectAll}
                  disabled={operating}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10
                             text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Square size={14} /> Desmarcar ({selectedIds.size})
                </button>
              ) : (
                <button
                  data-testid="fm-select-all"
                  onClick={selectAll}
                  disabled={operating}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10
                             text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <CheckSquare size={14} /> Selecionar
                </button>
              )}
              <button
                data-testid="fm-new-folder"
                onClick={() => setShowCreateFolder(!showCreateFolder)}
                disabled={operating}
                className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-violet-500/20 border border-violet-500/30
                           text-violet-300 hover:bg-violet-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus size={14} /> Nova Pasta
              </button>
              <button
                onClick={handleImport}
                disabled={operating}
                className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-cyan-500/20 border border-cyan-500/30
                           text-cyan-300 hover:bg-cyan-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FileDown size={14} /> Importar
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".md,.zip"
                className="hidden"
                onChange={handleImportFile}
              />
            </div>
            {/* Action error / success message */}
            {actionError && (
              <div className={`px-5 py-2 border-b ${actionError.includes('sucesso') ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
                <p className={`text-xs ${actionError.includes('sucesso') ? 'text-emerald-300' : 'text-red-300'}`}>
                  {actionError}
                </p>
              </div>
            )}
            {/* Bulk action bar */}
            {selectedIds.size > 0 && (
              <div className="flex items-center gap-2 px-5 py-2 border-b border-white/5 bg-violet-500/5">
                <span className="text-xs text-slate-400">
                  {selectedIds.size} selecionado(s)
                </span>
                <div className="flex-1" />
                <button
                  data-testid="fm-bulk-export"
                  onClick={handleBulkExport}
                  disabled={operating}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-emerald-500/20 border border-emerald-500/30
                             text-emerald-300 hover:bg-emerald-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {operating && operatingLabel === 'Exportando...' ? (
                    <><span className="inline-block w-3 h-3 border-2 border-emerald-300/30 border-t-emerald-300 rounded-full animate-spin" /> Exportando</>
                  ) : (
                    <><Download size={14} /> Exportar</>
                  )}
                </button>
                <button
                  data-testid="fm-bulk-move"
                  onClick={openMovePicker}
                  disabled={operating}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-amber-500/20 border border-amber-500/30
                             text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ArrowUpToLine size={14} /> Mover
                </button>
                <button
                  data-testid="fm-bulk-delete"
                  onClick={handleBulkDelete}
                  disabled={operating}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-red-500/20 border border-red-500/30
                             text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 size={14} /> Excluir
                </button>
              </div>
            )}
          </>
        )}

        {/* Create folder input */}
        {showCreateFolder && mode === 'manage' && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-white/5">
            <input
              data-testid="fm-folder-name"
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5
                         text-sm text-white placeholder-slate-500 outline-none
                         focus:border-violet-500/50 transition-colors"
              placeholder="Nome da nova pasta..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder()
                if (e.key === 'Escape') setShowCreateFolder(false)
              }}
              autoFocus
              disabled={operating}
            />
            <button
              data-testid="fm-folder-submit"
              onClick={handleCreateFolder}
              disabled={operating}
              className="px-3 py-1.5 text-xs rounded-lg bg-violet-500/20 border border-violet-500/30
                         text-violet-300 hover:bg-violet-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {operating && operatingLabel === 'Criando pasta...' ? (
                <><span className="inline-block w-3 h-3 border-2 border-violet-300/30 border-t-violet-300 rounded-full animate-spin" /> Criando</>
              ) : (
                'Criar'
              )}
            </button>
            <button
              onClick={() => { setShowCreateFolder(false); setNewFolderName('') }}
              disabled={operating}
              className="px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10
                         text-slate-400 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancelar
            </button>
          </div>
        )}

        {/* Content */}
        <div
          className="flex-1 overflow-y-auto p-4 relative"
          onDragEnter={activeTab === 'files' ? handleRootDragEnter : undefined}
          onDragOver={activeTab === 'files' ? handleRootDragOver : undefined}
          onDragLeave={activeTab === 'files' ? handleRootDragLeave : undefined}
          onDrop={activeTab === 'files' ? handleRootDrop : undefined}
        >
          {/* ── TEMP FILES TAB ── */}
          {activeTab === 'temp' && (
            <>
              {tempLoading ? (
                <div className="text-center py-8 text-slate-500">
                  <span className="animate-pulse">Carregando...</span>
                </div>
              ) : tempFiles.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <History size={40} className="mx-auto mb-2 text-slate-600" />
                  <p className="text-sm">Nenhum arquivo temporário.</p>
                  <p className="text-xs mt-1 text-slate-600">
                    Arquivos gerados automaticamente aparecerão aqui.
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {tempFiles.map((tf) => (
                    <div
                      key={tf.id}
                      className="flex items-center gap-2 py-2 px-3 rounded-md bg-white/2 border border-white/5
                                 hover:bg-white/5 transition-colors group"
                    >
                      <History size={14} className="text-amber-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-slate-300 truncate">
                          {tf.name}
                          <span className="ml-1.5 inline-flex items-center gap-0.5">
                            {renderFileTypeBadge(tf.type ?? null)}
                          </span>
                        </p>
                        <p className="text-[10px] text-slate-500">{formatDate(tf.created_at)}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => setViewTempFile(tf)}
                          className="p-1 text-slate-500 hover:text-cyan-400 transition-colors"
                          title="Visualizar"
                        >
                          <Eye size={12} />
                        </button>
                        <button
                          onClick={() => handleOpenRestore(tf)}
                          disabled={operatingTemp}
                          className="p-1 text-slate-500 hover:text-emerald-400 transition-colors"
                          title="Restaurar"
                        >
                          <RotateCcw size={12} />
                        </button>
                        <button
                          onClick={() => handleDeleteTemp(tf.id)}
                          disabled={operatingTemp}
                          className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                          title="Excluir"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── FILES TAB ── */}
          {activeTab === 'files' && (
            <>
              {/* Root drop indicator */}
              {dragOverFolderId === '__root__' && draggedItems.length > 0 && (
                <div className="absolute inset-2 border-2 border-dashed border-violet-500/30
                                rounded-xl flex items-center justify-center
                                bg-violet-500/5 pointer-events-none z-10">
                  <p className="text-violet-400 text-sm flex items-center gap-2">
                    <ArrowUpToLine size={16} />
                    Solte aqui para mover para a raiz
                  </p>
                </div>
              )}
              {loading && (
                <div className="text-center py-8 text-slate-500">
                  <span className="animate-pulse">Carregando...</span>
                </div>
              )}

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-4">
                  <p className="text-red-300 text-sm">{error}</p>
                  <button
                    onClick={loadTree}
                    className="mt-2 text-xs text-red-400 hover:text-red-300 underline"
                  >
                    Tentar novamente
                  </button>
                </div>
              )}

              {!loading && !error && currentChildren.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                  <FolderOpen size={40} className="mx-auto mb-2 text-slate-600" />
                  <p className="text-sm">Esta pasta está vazia.</p>
                  {mode === 'manage' && (
                    <p className="text-xs mt-1 text-slate-600">
                      Crie uma pasta ou importe arquivos .md/.zip
                    </p>
                  )}
                </div>
              )}

              {!loading && !error && (
                modoBloco ? (
                  <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                    {currentChildren.map((child) => (
                      <button
                        key={child.id}
                        onClick={() => handleSelectItem(child)}
                        className="flex flex-col gap-2 p-3 text-left rounded-xl bg-white/5 border border-white/10
                                   hover:bg-white/10 hover:border-white/20 transition-colors"
                      >
                        <div className="flex items-center gap-1.5">
                          {child.kind === 'folder'
                            ? <Folder size={14} className="text-cyan-400 shrink-0" />
                            : <FileText size={14} className="text-slate-400 shrink-0" />}
                          {child.kind === 'file' && renderFileTypeBadge((child as FileItem).type)}
                        </div>
                        <span className="text-xs text-slate-200 line-clamp-2">{child.name}</span>
                        {child.kind === 'file' && (child as FileItem).updated_at && (
                          <span className="text-[10px] text-slate-500">
                            {new Date((child as FileItem).updated_at as string).toLocaleDateString('pt-BR')}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {currentChildren.map((child) => renderTreeNode(child))}
                  </div>
                )
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {mode !== 'manage' && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10">
            {/* The root is not a row in the list, so confirming the current location is the
                only way to choose it. */}
            {mode === 'select-folder' && (
              <button
                onClick={() => {
                  onSelectFolder?.({ id: currentFolderId, name: currentFolderId ? currentFolderName : 'Raiz' })
                  handleClose()
                }}
                className="mr-auto px-4 py-1.5 text-xs rounded-lg bg-emerald-500/15 border border-emerald-500/30
                           text-emerald-300 hover:bg-emerald-500/25 transition-colors"
              >
                Salvar nesta pasta: {currentFolderId ? currentFolderName : 'Raiz'}
              </button>
            )}
            <button
              onClick={handleClose}
              className="px-4 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10
                         text-slate-400 hover:bg-white/10 transition-colors"
            >
              Cancelar
            </button>
          </div>
        )}
      </div>

      {/* Question Viewer Modal */}
      {showQuestionViewer && (
        <QuestionViewerModal
          fileId={showQuestionViewer}
          onClose={() => setShowQuestionViewer(null)}
        />
      )}

      {/* Move Picker Modal */}
      {showMovePicker && (
        <div data-testid="fm-move-picker" className="fixed inset-0 z-120 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
              <h3 className="text-md font-semibold text-white flex items-center gap-2">
                <ArrowUpToLine size={18} className="text-amber-400" />
                Mover para pasta
              </h3>
              <button
                onClick={() => setShowMovePicker(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-2 max-h-64 overflow-y-auto">
              {movePickerLoading ? (
                <div className="text-center py-6 text-slate-500 text-sm">
                  <span className="animate-pulse">Carregando pastas...</span>
                </div>
              ) : (
                <>
                  {/* Raiz option */}
                  <button
                    data-testid="fm-move-to-root"
                    onClick={() => handleBulkMove(null, 'Raiz')}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-violet-500/10 hover:text-white transition-colors"
                  >
                    <Home size={16} className="text-slate-500" />
                    <span>Raiz</span>
                  </button>
                  {movePickerFolders.map((f) => (
                    <button
                      data-testid="fm-move-folder"
                      key={f.id}
                      onClick={() => handleBulkMove(f.id, f.name)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-slate-300 hover:bg-violet-500/10 hover:text-white transition-colors"
                    >
                      <Folder size={16} className="text-amber-400" />
                      <span className="truncate">{f.name}</span>
                    </button>
                  ))}
                  {movePickerFolders.length === 0 && (
                    <div className="text-center py-6 text-slate-500 text-sm">
                      <FolderOpen size={24} className="mx-auto mb-1 text-slate-600" />
                      <p>Nenhuma pasta encontrada</p>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10">
              <button
                onClick={() => setShowMovePicker(false)}
                className="px-4 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Description Modal */}
      {descriptionModal && (
        <div className="fixed inset-0 z-130 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-lg mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
              <h3 className="text-md font-semibold text-white flex items-center gap-2">
                <Info size={18} className="text-amber-400" />
                Descrição: {descriptionModal.fileName}
              </h3>
              <button
                onClick={() => setDescriptionModal(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4">
              <textarea
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-violet-500/50 transition-colors resize-none min-h-24"
                placeholder="Adicione uma descrição ou comentário..."
                value={descriptionText}
                onChange={(e) => setDescriptionText(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10">
              <button
                onClick={() => setDescriptionModal(null)}
                className="px-4 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={async () => {
                  if (!descriptionModal) return
                  try {
                    await api.updateFile(descriptionModal.fileId, { description: descriptionText })
                    setDescriptionModal(null)
                    await loadTree()
                  } catch (e: unknown) {
                    setActionError(`Erro ao salvar descrição: ${(e as Error).message}`)
                  }
                }}
                className="px-4 py-1.5 text-xs rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30 transition-colors"
              >
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Restore Dialog ── */}
      {restoreDialog && (
        <div className="fixed inset-0 z-140 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-md mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
              <h3 className="text-md font-semibold text-white flex items-center gap-2">
                <RotateCcw size={18} className="text-emerald-400" />
                Restaurar Arquivo
              </h3>
              <button
                onClick={() => setRestoreDialog(null)}
                disabled={operatingTemp}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Nome</label>
                <input
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-violet-500/50 transition-colors"
                  value={restoreName}
                  onChange={(e) => setRestoreName(e.target.value)}
                  disabled={operatingTemp}
                  autoFocus
                />
              </div>
              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Descrição <span className="text-slate-600">(opcional)</span>
                </label>
                <textarea
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-violet-500/50 transition-colors resize-none"
                  value={restoreDesc}
                  onChange={(e) => setRestoreDesc(e.target.value)}
                  rows={2}
                  disabled={operatingTemp}
                />
              </div>
              {/* Folder selector */}
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Pasta de destino</label>
                <div className="relative">
                  <button
                    onClick={() => {
                      const next = !restoreDialog.folderId ? null : restoreDialog.folderId
                      // Simple toggle: show folder picker inline
                      const el = document.getElementById('restore-folder-list')
                      if (el) el.classList.toggle('hidden')
                    }}
                    disabled={operatingTemp}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-50"
                  >
                    {restoreDialog.folderId ? (
                      <><FolderOpen size={14} className="text-cyan-400" /><span>{restoreDialog.folderName}</span></>
                    ) : (
                      <><Home size={14} className="text-slate-400" /><span className="text-slate-500">Raiz</span></>
                    )}
                    <span className="ml-auto text-xs text-slate-500">Trocar</span>
                  </button>
                  <div id="restore-folder-list" className="hidden absolute left-0 top-full mt-1 z-50 w-full bg-[#0d0d15] border border-white/10 rounded-xl shadow-2xl max-h-48 overflow-y-auto p-1">
                    <button
                      onClick={() => {
                        setRestoreDialog(prev => prev ? { ...prev, folderId: null, folderName: 'Raiz' } : null)
                        document.getElementById('restore-folder-list')?.classList.add('hidden')
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 rounded-lg transition-colors"
                    >
                      <Home size={14} /> Raiz
                    </button>
                    {restoreDialog.folders.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => {
                          setRestoreDialog(prev => prev ? { ...prev, folderId: f.id, folderName: f.name } : null)
                          document.getElementById('restore-folder-list')?.classList.add('hidden')
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 rounded-lg transition-colors"
                      >
                        <Folder size={14} /> {f.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10">
              <button
                onClick={() => setRestoreDialog(null)}
                disabled={operatingTemp}
                className="px-4 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleRestoreConfirm}
                disabled={operatingTemp || !restoreName.trim()}
                className="px-5 py-1.5 text-xs font-semibold rounded-xl text-white
                           bg-linear-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500
                           disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200
                           shadow-lg shadow-emerald-500/20 flex items-center gap-2"
              >
                {operatingTemp ? (
                  <><span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Restaurando</>
                ) : (
                  <><RotateCcw size={14} /> Restaurar</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Quick View Temp File Modal ── */}
      {viewTempFile && (
        <div className="fixed inset-0 z-140 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <History size={18} className="text-amber-400 shrink-0" />
                <div className="min-w-0">
                  <h3 className="text-md font-semibold text-white truncate">{viewTempFile.name}</h3>
                  <p className="text-[10px] text-slate-500">{formatDate(viewTempFile.created_at)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => {
                    setViewTempFile(null)
                    handleOpenRestore(viewTempFile)
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30 transition-colors"
                >
                  <RotateCcw size={12} />
                  Restaurar
                </button>
                <button
                  onClick={() => setViewTempFile(null)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5">
              <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                {viewTempFile.content}
              </pre>
            </div>
            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10 shrink-0">
              <button
                onClick={() => setViewTempFile(null)}
                className="px-4 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function QuestionViewerModal({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const [questions, setQuestions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const data = await api.getQuestions(fileId)
        setQuestions(data)
      } catch (e: unknown) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [fileId])

  const letters = ['A', 'B', 'C', 'D', 'E']

  return (
    <div className="fixed inset-0 z-110 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
          <h3 className="text-md font-semibold text-white flex items-center gap-2">
            <Eye size={18} className="text-violet-400" />
            Questões do Arquivo
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && (
            <div className="text-center py-8 text-slate-500 animate-pulse">Carregando questões...</div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-300">{error}</div>
          )}

          {!loading && !error && questions.length === 0 && (
            <div className="text-center py-8 text-slate-500">Nenhuma questão encontrada.</div>
          )}

          {questions.map((q: any, idx: number) => (
            <div key={q.id} className="bg-white/5 rounded-xl p-4 border border-white/10">
              <p className="text-sm text-white font-medium mb-2">
                {idx + 1}. {q.statement}
              </p>
              <div className="space-y-1">
                {letters.map((letter) => {
                  const altText = q[`alternative_${letter.toLowerCase()}`]
                  if (!altText) return null
                  const isCorrect = letter === q.right_alternative
                  return (
                    <div
                      key={letter}
                      className={`p-2 rounded-lg text-sm ${
                        isCorrect
                          ? 'bg-emerald-500/10 border border-emerald-500/20'
                          : 'bg-white/5 border border-white/10'
                      }`}
                    >
                      <strong className={isCorrect ? 'text-emerald-300' : 'text-white'}>{letter})</strong>{' '}
                      <span className="text-slate-300">{altText}</span>
                      {isCorrect && <span className="float-right text-emerald-400 font-bold">✓</span>}
                    </div>
                  )
                })}
              </div>
              {q.explanation && (
                <div className="mt-2 bg-white/5 rounded-lg p-2.5 text-xs text-slate-400">
                  <strong className="text-slate-300">💡 Explicação:</strong> {q.explanation}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 transition-colors"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}

function findFolderById(nodes: TreeNode[], id: string): FolderItem | null {
  for (const n of nodes) {
    if (n.kind === 'folder' && n.id === id) return n
    if (n.kind === 'folder') {
      const found = findFolderById(n.children, id)
      if (found) return found
    }
  }
  return null
}

interface BreadcrumbItem {
  id: string | null
  name: string
}

function buildBreadcrumb(tree: TreeNode[], currentId: string | null): BreadcrumbItem[] {
  const crumbs: BreadcrumbItem[] = [{ id: null, name: 'Raiz' }]
  if (!currentId) return crumbs

  const findPath = (nodes: TreeNode[], targetId: string, path: BreadcrumbItem[]): boolean => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        if (n.id === targetId) {
          path.push({ id: n.id, name: n.name })
          return true
        }
        path.push({ id: n.id, name: n.name })
        if (findPath(n.children, targetId, path)) return true
        path.pop()
      }
    }
    return false
  }

  findPath(tree, currentId, crumbs)
  return crumbs
}
