import SaveFolderSelector from '@/components/io/SaveFolderSelector'
import { Sparkles, RefreshCw } from 'lucide-react'
import type { LoadingOperation } from '@/types'
import { truncateLabel } from '@/utils/truncateLabel'

interface ActionBarProps {
  hasContent: boolean
  // File management
  savedFileId: string | null
  savedFileName: string | null
  savedFolderId: string | null
  savedFolderName: string | null
  onSaveToFolder: (folderId: string | null, folderName: string | null) => void
  onOpenFileManager: () => void
  saving?: boolean
  // New content button
  loadingOperation?: LoadingOperation
  onNewContent?: () => void
  /** True while OutputPanel shows the empty-state invitation, which already carries this action. */
  invitationVisible?: boolean
  // Regenerate content
  onRegenerate?: () => void
  regenerating?: boolean
  /** Current file name to display subtly in the center */
  currentFileName?: string | null
  /** When true, disables export items and hides filename label (e.g. during streaming) */
  isViewingStream: boolean
  /** When true, hides the Regenerar button (e.g. for reading files) */
  isReadingFile?: boolean
}

export default function ActionBar({
  hasContent,
  savedFileId,
  savedFileName,
  savedFolderId,
  savedFolderName,
  onSaveToFolder,
  onOpenFileManager,
  saving,
  loadingOperation,
  onNewContent,
  invitationVisible,
  onRegenerate,
  regenerating,
  currentFileName,
  isViewingStream,
  isReadingFile,
}: ActionBarProps) {
  const processing = loadingOperation === 'process'

  return (
    <div className="flex items-center justify-between gap-2 w-full">
      {/* Left: new content + regenerate buttons */}
      <div className="flex items-center gap-2">
        {/* Hidden only while the empty-state invitation is on screen, which already
            carries this action. On error or while loading the invitation is not
            rendered, so the button must stay — otherwise there is no way to retry. */}
        {!invitationVisible && (
        <button
          data-testid="new-content-trigger"
          onClick={onNewContent}
          disabled={processing}
          className="px-3 py-1.5 text-xs font-medium rounded-lg
                     bg-emerald-500/15 border border-emerald-500/30 text-emerald-300
                     hover:bg-emerald-500/25 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          {processing ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-emerald-300/30 border-t-emerald-300 rounded-full animate-spin" />
              Processando...
            </>
          ) : (
            <>
              <Sparkles size={14} />
              Novo conteúdo
            </>
          )}
        </button>
        )}

        {/* Regenerate button — only shown when viewing a saved file and NOT a reading file */}
        {savedFileId && !isViewingStream && !isReadingFile && onRegenerate && (
          <button
            data-testid="regenerate-content"
            onClick={onRegenerate}
            disabled={regenerating}
            className="px-3 py-1.5 text-xs font-medium rounded-lg
                       bg-amber-500/15 border border-amber-500/30 text-amber-300
                       hover:bg-amber-500/25 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {regenerating ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-amber-300/30 border-t-amber-300 rounded-full animate-spin" />
                Regenerando...
              </>
            ) : (
              <>
                <RefreshCw size={14} />
                Regenerar
              </>
            )}
          </button>
        )}
      </div>

      {/* Center: current file name — subtle (hidden during streaming) */}
      {!isViewingStream && currentFileName && (
        <span className="text-xs text-slate-500 hidden sm:block max-w-[12rem] overflow-hidden text-ellipsis whitespace-nowrap">
          {truncateLabel(currentFileName)}
        </span>
      )}

      {/* Right: folder management */}
      <SaveFolderSelector
        savedFileId={savedFileId}
        savedFileName={savedFileName}
        savedFolderId={savedFolderId}
        savedFolderName={savedFolderName}
        hasContent={hasContent}
        saving={saving}
        onSave={onSaveToFolder}
        onOpenManager={onOpenFileManager}
      />
    </div>
  )
}
