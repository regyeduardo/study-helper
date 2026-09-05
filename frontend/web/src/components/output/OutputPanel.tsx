import { useAppState, useAppDispatch } from "@/context/AppContext";
import { FileText, Loader2, AlertTriangle, X } from "lucide-react";
import MarkdownViewer from "@/components/output/MarkdownViewer";

/**
 * OutputPanel — renders the document content.
 *
 * CORE PRINCIPLE: The document content is NEVER replaced or hidden.
 * Loading and error states are shown as NON-intrusive overlays
 * that appear above/alongside the content without replacing it.
 *
 * Even during loading or errors, if content exists, it stays visible.
 * Loading/error are also shown in NotificationBar (floating bar)
 * for additional visibility outside the panel.
 */
interface OutputPanelProps {
  /** Opens the new-content wizard from the empty state. */
  onNewContent?: () => void
}

export default function OutputPanel({ onNewContent }: OutputPanelProps = {}) {
  const {
    generatedMarkdown,
    isLoading,
    loadingMessage,
    loadingSubMessage,
    errorMessage,
  } = useAppState();
  const dispatch = useAppDispatch();

  const hasContent = !!generatedMarkdown;

  // ── Empty state: shown only when there is genuinely no content at all ──
  if (!hasContent) {
    return (
      <div className="text-center py-12 text-slate-500">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-8 text-slate-400">
            <Loader2 size={24} className="text-violet-400 animate-spin mb-3" />
            <p className="text-sm font-medium text-violet-300">
              {loadingMessage || "Processando..."}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {loadingSubMessage || "Isso pode levar alguns segundos"}
            </p>
          </div>
        ) : errorMessage ? (
          <div className="flex flex-col items-center py-8 text-slate-400">
            <AlertTriangle size={24} className="text-red-400 mb-2" />
            <p className="text-sm text-red-300">{errorMessage}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 min-h-[60vh]">
            <FileText size={40} className="text-slate-600" />
            <h2 className="text-xl font-semibold text-slate-200">
              O que você quer estudar?
            </h2>
            <p className="text-sm text-slate-500">
              Comece de um arquivo, um link ou um tema.
            </p>
            {onNewContent && (
              <button
                onClick={onNewContent}
                className="mt-2 px-6 py-3 rounded-xl text-sm font-semibold text-white
                           bg-violet-600 hover:bg-violet-500 transition-colors"
              >
                Novo conteúdo
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Content EXISTS — always render it, with inline overlays if needed ──

  return (
    <div className="relative">
      {/* Inline error banner (dismissible) */}
      {errorMessage && (
        <div className="sticky top-0 z-10 flex items-start gap-2 px-3 py-2 mb-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
          <span className="text-xs text-red-300 flex-1">{errorMessage}</span>
          <button
            onClick={() => dispatch({ type: "SET_ERROR", payload: null })}
            className="p-0.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 shrink-0"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Document content — ALWAYS rendered, never hidden */}
      <MarkdownViewer markdown={generatedMarkdown} />
    </div>
  );
}
