import { useState, useMemo, useEffect } from 'react'
import { X, FileText, Save, Folder, Home, FolderOpen } from 'lucide-react'
import FileManagerModal from '@/components/io/FileManagerModal'

export interface LiveModeSaveParams {
  name: string
  description: string
  folderId: string | null
  folderName: string | null
}

export interface LiveModeSaveModalProps {
  open: boolean
  lessonText: string
  tempFileId: string | null
  savedFolderId: string | null
  savedFolderName: string | null
  originalTitle?: string
  originalDescription?: string
  onSave: (params: LiveModeSaveParams) => Promise<void>
  onClose: () => void
}

/**
 * Extracts the first # Heading from markdown text.
 * Falls back to 'Aula sem título' if none found.
 */
function extractTitle(lessonText: string): string {
  const titleMatch = lessonText.match(/^#\s+(.+)$/m)
  return titleMatch ? titleMatch[1].trim() : 'Aula sem título'
}

export default function LiveModeSaveModal({
  open,
  lessonText,
  tempFileId,
  savedFolderId,
  savedFolderName,
  originalTitle,
  originalDescription,
  onSave,
  onClose,
}: LiveModeSaveModalProps) {
  const defaultTitle = useMemo(() => originalTitle ?? extractTitle(lessonText), [originalTitle, lessonText])

  const [name, setName] = useState(defaultTitle)
  // Sync name state when originalTitle changes (e.g., a new stream starts)
  useEffect(() => {
    setName(defaultTitle)
  }, [defaultTitle])
  const [description, setDescription] = useState(originalDescription ?? '')
  // Sync description when the source's own description arrives (e.g. the link that was pasted)
  useEffect(() => {
    if (originalDescription) setDescription(originalDescription)
  }, [originalDescription])
  const [folderId, setFolderId] = useState<string | null>(savedFolderId ?? null)
  const [folderName, setFolderName] = useState<string | null>(savedFolderName ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [nameError, setNameError] = useState('')
  const [folderModalOpen, setFolderModalOpen] = useState(false)

  // Reset form state when modal opens
  if (open) {
    // We use a pattern where state is initialized from props via key or effect,
    // but for simplicity we keep stable defaults and reset via the close handler.
  }

  const handleSubmit = async () => {
    // Validate
    if (!name.trim()) {
      setNameError('O nome não pode estar vazio.')
      return
    }
    setNameError('')
    setError('')
    setSaving(true)

    try {
      await onSave({
        name: name.trim(),
        description,
        folderId,
        folderName,
      })
      onClose()
    } catch (e) {
      setError('Erro ao salvar. Tente novamente.')
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    if (saving) return
    onClose()
  }

  const handleSelectFolder = (folder: { id: string | null; name: string }) => {
    setFolderId(folder.id)
    setFolderName(folder.name)
    setFolderModalOpen(false)
  }

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
        {/* Modal */}
        <div className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-md mx-4 shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Save size={18} className="text-emerald-400" />
              <h2 className="text-lg font-semibold text-white">Salvar aula</h2>
            </div>
            <button
              onClick={handleClose}
              disabled={saving}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="px-5 py-3 space-y-4">
            {/* Name field */}
            <div>
              <label
                htmlFor="live-save-name"
                className="block text-sm font-medium text-slate-300 mb-1"
              >
                Nome
              </label>
              <input
                id="live-save-name"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (nameError) setNameError('')
                }}
                disabled={saving}
                placeholder="Título da aula"
                className={`w-full bg-white/5 border rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 outline-none transition-colors disabled:opacity-50 ${
                  nameError
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-white/10 focus:border-violet-500/50'
                }`}
                autoFocus
              />
              {nameError && (
                <p className="mt-1 text-xs text-red-400" role="alert">
                  {nameError}
                </p>
              )}
            </div>

            {/* Description field */}
            <div>
              <label
                htmlFor="live-save-description"
                className="block text-sm font-medium text-slate-300 mb-1"
              >
                Descrição{' '}
                <span className="text-slate-500 font-normal">(opcional)</span>
              </label>
              <textarea
                id="live-save-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={saving}
                placeholder="Adicione uma descrição..."
                rows={3}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-violet-500/50 transition-colors resize-none disabled:opacity-50"
              />
            </div>

            {/* Folder selector */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Pasta
              </label>
              <button
                onClick={() => !saving && setFolderModalOpen(true)}
                disabled={saving}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-50"
              >
                {folderId ? (
                  <>
                    <FolderOpen size={16} className="text-cyan-400 shrink-0" />
                    <span className="truncate">{folderName}</span>
                  </>
                ) : (
                  <>
                    <Home size={16} className="text-slate-400 shrink-0" />
                    <span className="text-slate-500">Raiz</span>
                  </>
                )}
                <span className="ml-auto text-xs text-slate-500 shrink-0">
                  {folderId ? 'Trocar' : 'Selecionar'}
                </span>
              </button>
            </div>

            {/* Error message */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                <p className="text-xs text-red-300" role="alert">
                  {error}
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-white/10">
            <button
              onClick={handleClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              className="px-5 py-2 text-sm font-semibold rounded-xl text-white
                         bg-linear-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500
                         disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200
                         shadow-lg shadow-emerald-500/20 flex items-center gap-2"
            >
              {saving ? (
                <>
                  <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Salvando...
                </>
              ) : (
                <>
                  <Save size={16} />
                  Salvar
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Folder selector modal */}
      {folderModalOpen && (
        <FileManagerModal
          open={folderModalOpen}
          onClose={() => setFolderModalOpen(false)}
          initialFolderId={folderId}
          mode="select-folder"
          onSelectFolder={handleSelectFolder}
        />
      )}
    </>
  )
}
