import { useState, useEffect, useCallback } from "react";
import { api } from "@/api/client";
import type { FolderItem } from "@/types";
import { FolderOpen, Save, Home, Folder, FolderPlus } from "lucide-react";
import { truncateLabel } from "@/utils/truncateLabel";

interface SaveFolderSelectorProps {
  savedFileId: string | null;
  savedFileName: string | null;
  savedFolderId: string | null;
  savedFolderName: string | null;
  hasContent: boolean;
  onSave: (folderId: string | null, folderName: string | null) => void;
  onOpenManager: () => void;
  saving?: boolean;
}

export default function SaveFolderSelector({
  savedFileId,
  savedFileName,
  savedFolderId,
  savedFolderName,
  hasContent,
  onSave,
  onOpenManager,
  saving,
}: SaveFolderSelectorProps) {
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [savingNewFolder, setSavingNewFolder] = useState(false);

  const loadFolders = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getFolders();
      setFolders(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (showDropdown) loadFolders();
  }, [showDropdown, loadFolders]);

  const handleSaveClick = (folderId: string | null, folderName: string) => {
    // The parent's onSave only passes folder info. Description is handled via the PostSaveModal.
    onSave(folderId, folderName);
    setShowDropdown(false);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setSavingNewFolder(true);
    try {
      const created = await api.createFolder({ name });
      setCreatingFolder(false);
      setNewFolderName("");
      handleSaveClick(created.id, created.name);
    } catch (e: unknown) {
      alert(`Erro ao criar pasta: ${(e as Error).message}`);
    } finally {
      setSavingNewFolder(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Current folder indicator + manage button */}
      {hasContent && (
        <div className="flex items-center gap-1">
          {savedFileId ? (
            <button
              onClick={onOpenManager}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg
                         bg-emerald-500/15 border border-emerald-500/30 text-emerald-300
                         hover:bg-emerald-500/25 transition-colors"
              title="Abrir gerenciador de arquivos na pasta atual"
            >
              <span>
                <FolderOpen size={14} />
              </span>
              <span className="max-w-30 truncate">
                {truncateLabel(savedFolderName ?? "") || "Raiz"}
              </span>
            </button>
          ) : (
            <span className="px-2.5 py-1.5 text-xs text-slate-500">
              Não salvo
            </span>
          )}
        </div>
      )}

      {/* Folder dropdown — also shown after the first save, where picking a folder
          moves the file (the parent PATCHes folder_id) instead of creating a new one. */}
      {hasContent && (
        <div className="relative">
          <button
            onClick={() => !saving && setShowDropdown(!showDropdown)}
            disabled={saving}
            className="flex items-center gap-2 px-2.5 py-1.5 text-xs font-medium rounded-lg
                       bg-cyan-500/15 border border-cyan-500/30 text-cyan-300
                       hover:bg-cyan-500/25 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-cyan-300/30 border-t-cyan-300 rounded-full animate-spin mr-1" />{" "}
                Salvando...
              </>
            ) : (
              <>
                <Save size={14} />
                {savedFileId ? "Mover para..." : "Salvar em..."}
              </>
            )}
          </button>

          {showDropdown && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowDropdown(false)}
              />
              <div
                className="absolute right-0 top-full mt-1 z-50 min-w-55
                              bg-[#0d0d15] border border-white/10 rounded-xl
                              shadow-2xl shadow-black/50 overflow-hidden"
              >
                <div className="max-h-60 overflow-y-auto p-1">
                  {creatingFolder ? (
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <input
                        data-testid="new-folder-input"
                        autoFocus
                        type="text"
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleCreateFolder();
                          if (e.key === "Escape") setCreatingFolder(false);
                        }}
                        placeholder="Nome da pasta"
                        disabled={savingNewFolder}
                        className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg
                                   px-2 py-1 text-xs text-white placeholder-slate-500 outline-none
                                   focus:border-violet-500/60"
                      />
                      <button
                        data-testid="new-folder-confirm"
                        onClick={handleCreateFolder}
                        disabled={savingNewFolder || !newFolderName.trim()}
                        className="px-2 py-1 text-xs font-medium rounded-lg text-emerald-300
                                   hover:bg-emerald-500/15 disabled:opacity-40 transition-colors"
                      >
                        Criar
                      </button>
                    </div>
                  ) : (
                    <button
                      data-testid="new-folder-button"
                      onClick={() => setCreatingFolder(true)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300
                                 hover:bg-white/5 rounded-lg transition-colors"
                    >
                      <span>
                        <FolderPlus size={14} />
                      </span>
                      Nova pasta
                    </button>
                  )}
                  <button
                    onClick={() => handleSaveClick(null, "Raiz")}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300
                               hover:bg-white/5 rounded-lg transition-colors"
                  >
                    <span>
                      <Home size={14} />
                    </span>{" "}
                    Raiz
                  </button>
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => handleSaveClick(f.id, f.name)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300
                                 hover:bg-white/5 rounded-lg transition-colors
                                 ${f.id === savedFolderId ? "bg-violet-500/10" : ""}`}
                    >
                      <span>
                        <Folder size={14} />
                      </span>
                      <span className="truncate">{f.name}</span>
                    </button>
                  ))}
                </div>
                {loading && (
                  <div className="px-3 py-2 text-xs text-slate-500">
                    Carregando...
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
