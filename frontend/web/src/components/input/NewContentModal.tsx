import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  FileText,
  FileUp,
  GraduationCap,
  Lightbulb,
  Link2,
  Loader2,
  MessageSquareText,
  Mic,
  Sparkles,
  X,
} from "lucide-react";
import type { InputMode, AgentType, LoadingOperation, TranscriptionProvider } from "@/types";
import FileUpload from "@/components/input/FileUpload";
import { needsTranscription } from "@/lib/uploadKind";
import UrlInput from "@/components/input/UrlInput";
import LanguageSelector from "@/components/input/LanguageSelector";
import TranscriptionProviderSelector from "@/components/input/TranscriptionProviderSelector";

interface NewContentModalProps {
  open: boolean;
  onClose: () => void;
  mode: InputMode;
  setMode: (m: InputMode) => void;
  selectedFile: File | null;
  setSelectedFile: (f: File | null) => void;
  inputUrl: string;
  setInputUrl: (u: string) => void;
  inputUrlValid: boolean;
  setInputUrlValid: (v: boolean) => void;
  agent: AgentType;
  setAgent: (a: AgentType) => void;
  topic: string;
  setTopic: (t: string) => void;
  prompt: string;
  setPrompt: (p: string) => void;
  language: string;
  setLanguage: (l: string) => void;
  transcriptionProvider?: TranscriptionProvider;
  setTranscriptionProvider?: (p: TranscriptionProvider) => void;
  generationName: string;
  setGenerationName: (n: string) => void;
  generationDescription: string;
  setGenerationDescription: (d: string) => void;
  openaiAvailable?: boolean;
  loadingOperation?: LoadingOperation;
  onProcess: () => void;
  readingText: string;
  setReadingText: (t: string) => void;
  readingName: string;
  setReadingName: (n: string) => void;
  readingLoading: boolean;
  readingError: string;
  setReadingError: (e: string) => void;
  onCreateReading: (params: {
    mode: "text" | "url" | "file";
    content?: string;
    url?: string;
    file?: File;
    name: string;
  }) => Promise<void>;
}

const AGENTS: {
  value: AgentType;
  label: string;
  hint: string;
  Icon: typeof GraduationCap;
  accent: string;
}[] = [
  {
    value: "aula",
    label: "Aula",
    hint: "Transforma um vídeo, arquivo ou link em aula estruturada",
    Icon: GraduationCap,
    accent: "violet",
  },
  {
    value: "explicacao",
    label: "Explicação",
    hint: "Explica um tema ou conceito a fundo",
    Icon: Lightbulb,
    accent: "amber",
  },
  {
    value: "reuniao",
    label: "Reunião",
    hint: "Transforma a gravação de uma reunião em ata",
    Icon: Mic,
    accent: "emerald",
  },
  {
    value: "leitura",
    label: "Leitura",
    hint: "Salva um artigo, PDF ou texto para ler do jeito que veio",
    Icon: BookOpen,
    accent: "sky",
  },
];

const SOURCES: Record<
  AgentType,
  { value: InputMode; label: string; Icon: typeof FileUp }[]
> = {
  aula: [
    { value: "file", label: "Arquivo", Icon: FileUp },
    { value: "url", label: "Link", Icon: Link2 },
  ],
  explicacao: [
    { value: "topic", label: "Tema", Icon: MessageSquareText },
    { value: "file", label: "Arquivo", Icon: FileUp },
    { value: "url", label: "Link", Icon: Link2 },
  ],
  reuniao: [
    { value: "file", label: "Gravação", Icon: FileUp },
    { value: "url", label: "Link", Icon: Link2 },
  ],
  leitura: [
    { value: "text", label: "Texto", Icon: MessageSquareText },
    { value: "url", label: "Link", Icon: Link2 },
    { value: "file", label: "PDF", Icon: FileText },
  ],
};

const ACCENT_ACTIVE: Record<string, string> = {
  violet: "border-violet-500/70 bg-violet-500/10 text-violet-200",
  amber: "border-amber-500/70 bg-amber-500/10 text-amber-200",
  sky: "border-sky-500/70 bg-sky-500/10 text-sky-200",
};

const AULA_ACCEPT =
  ".mp4,.webm,.avi,.mkv,.mov,.mp3,.wav,.ogg,.m4a,.pdf,.doc,.docx,.txt,.md,.csv,.json,.xml,.html,.srt,.vtt,.sbv,.ass";

export default function NewContentModal({
  open,
  onClose,
  mode,
  setMode,
  selectedFile,
  setSelectedFile,
  inputUrl,
  setInputUrl,
  inputUrlValid,
  setInputUrlValid,
  agent,
  setAgent,
  topic,
  setTopic,
  prompt,
  setPrompt,
  language,
  setLanguage,
  transcriptionProvider,
  setTranscriptionProvider,
  generationName,
  setGenerationName,
  generationDescription,
  setGenerationDescription,
  openaiAvailable = true,
  loadingOperation,
  onProcess,
  readingText,
  setReadingText,
  readingName,
  setReadingName,
  readingLoading,
  readingError,
  setReadingError,
  onCreateReading,
}: NewContentModalProps) {
  const [step, setStep] = useState(0);
  const [internalProvider, setInternalProvider] = useState<TranscriptionProvider>("local");
  const currentProvider = transcriptionProvider ?? internalProvider;
  const handleProviderChange = setTranscriptionProvider ?? setInternalProvider;
  const bodyRef = useRef<HTMLDivElement>(null);

  const processing = loadingOperation === "process";
  const isReading = agent === "leitura";
  const stepCount = isReading ? 2 : 3;
  const stepNames = isReading
    ? ["Tipo", "Conteúdo"]
    : ["Tipo", "Origem", "Ajustes"];
  const isLastStep = step === stepCount - 1;

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [step]);

  const sourceLabel = useMemo(
    () => SOURCES[agent].find((option) => option.value === mode)?.label ?? "",
    [agent, mode],
  );

  const agentMeta = AGENTS.find((item) => item.value === agent) ?? AGENTS[0];

  const sourceFilled = (() => {
    if (isReading) {
      if (mode === "text") return readingText.trim().length > 0;
      if (mode === "url") return inputUrl.trim().length > 0;
      return selectedFile !== null;
    }
    if (mode === "topic") return topic.trim().length > 0;
    if (mode === "url") return inputUrl.trim().length > 0 && inputUrlValid;
    return selectedFile !== null;
  })();

  const transcribes =
    mode === "url" ? true : mode === "file" && needsTranscription(selectedFile);
  const busy = processing || readingLoading;
  const canAdvance = step === 0 || (sourceFilled && !busy);

  const handleAgentChange = (next: AgentType) => {
    setAgent(next);
    setReadingError("");
    setSelectedFile(null);
    setInputUrl("");
    if (next === "leitura") setMode("text");
    else if (next === "explicacao") setMode("topic");
    else setMode("file");
    setStep(1);
  };

  const handleModeChange = (next: InputMode) => {
    setMode(next);
    setSelectedFile(null);
    setInputUrl("");
    setReadingError("");
  };

  const handleSubmit = async () => {
    if (isReading) {
      setReadingError("");
      await onCreateReading({
        mode: mode as "text" | "url" | "file",
        content: mode === "text" ? readingText : undefined,
        url: mode === "url" ? inputUrl : undefined,
        file: mode === "file" ? (selectedFile ?? undefined) : undefined,
        name:
          readingName ||
          readingText.split("\n")[0]?.replace(/^#\s*/, "").trim() ||
          "leitura",
      });
      if (!readingError) onClose();
      return;
    }
    onProcess();
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        data-testid="new-content-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-content-title"
        className="bg-[#0d0d15] border border-white/10 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        <header className="px-5 pt-4 pb-3 border-b border-white/10">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles size={18} className="text-emerald-400 shrink-0" />
              <h2
                id="new-content-title"
                className="text-base font-semibold text-white truncate"
              >
                Novo conteúdo
              </h2>
            </div>
            <button
              data-testid="modal-close"
              onClick={onClose}
              aria-label="Fechar"
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors motion-reduce:transition-none"
            >
              <X size={16} />
            </button>
          </div>

          <p
            data-testid="step-indicator"
            aria-live="polite"
            className="text-xs text-slate-400 mt-2"
          >
            Passo {step + 1} de {stepCount} · {stepNames[step]}
          </p>

          <ol className="flex items-center gap-1.5 mt-2" aria-label="Progresso">
            {stepNames.map((name, index) => (
              <li
                key={name}
                data-testid={`progress-dot-${index}`}
                aria-current={index === step ? "step" : undefined}
                className={`h-1 flex-1 rounded-full transition-colors duration-200 motion-reduce:transition-none ${
                  index < step
                    ? "bg-emerald-500/70"
                    : index === step
                      ? "bg-emerald-400"
                      : "bg-white/10"
                }`}
              >
                <span className="sr-only">{name}</span>
              </li>
            ))}
          </ol>
        </header>

        <div ref={bodyRef} className="px-5 py-4 overflow-y-auto min-h-60">
          {step > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-4">
              <button
                data-testid="summary-chip-agent"
                onClick={() => setStep(0)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-slate-300 hover:border-white/25 hover:text-white transition-colors motion-reduce:transition-none"
              >
                <agentMeta.Icon size={12} />
                {agentMeta.label}
              </button>
              {step > 1 && sourceLabel && (
                <button
                  data-testid="summary-chip-source"
                  onClick={() => setStep(1)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-slate-300 hover:border-white/25 hover:text-white transition-colors motion-reduce:transition-none"
                >
                  {sourceLabel}
                </button>
              )}
            </div>
          )}

          {step === 0 && (
            <div className="space-y-2">
              <p className="text-sm text-slate-400">O que você quer criar?</p>
              {AGENTS.map(({ value, label, hint, Icon, accent }) => {
                // const active = agent === value;
                return (
                  <button
                    key={value}
                    data-testid={`agent-card-${value}`}
                    onClick={() => handleAgentChange(value)}
                    // aria-pressed={active}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors duration-200 motion-reduce:transition-none ${"border-white/10 bg-white/5 text-slate-200 hover:border-white/25 hover:bg-white/10"}`}
                  >
                    <span className="shrink-0 w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center">
                      <Icon size={18} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">
                        {label}
                      </span>
                      <span className="block text-xs text-slate-400 leading-snug">
                        {hint}
                      </span>
                    </span>
                    <ArrowRight
                      size={14}
                      className="ml-auto shrink-0 text-slate-500"
                    />
                  </button>
                );
              })}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <div
                data-testid="source-selector"
                role="radiogroup"
                aria-label="Origem do conteúdo"
                className="flex gap-1 bg-white/5 rounded-xl p-1"
              >
                {SOURCES[agent].map(({ value, label, Icon }) => (
                  <button
                    key={value}
                    data-testid={`source-option-${value}`}
                    role="radio"
                    aria-checked={mode === value}
                    onClick={() => handleModeChange(value)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-200 motion-reduce:transition-none ${
                      mode === value
                        ? "bg-white/10 text-white shadow-sm"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>

              {mode === "file" && (
                <FileUpload
                  accept={isReading ? ".pdf" : AULA_ACCEPT}
                  onFile={setSelectedFile}
                />
              )}

              {mode === "url" && (
                <UrlInput
                  value={inputUrl}
                  onChange={setInputUrl}
                  onValidChange={setInputUrlValid}
                />
              )}

              {mode === "topic" && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="topic-input"
                    className="text-xs font-medium text-slate-400"
                  >
                    Assunto ou dúvida
                  </label>
                  <textarea
                    id="topic-input"
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="Ex.: como funciona o garbage collector do Go"
                    rows={3}
                    className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white placeholder-slate-500 resize-y outline-none focus:border-violet-500/60 transition-colors motion-reduce:transition-none"
                  />
                </div>
              )}

              {mode === "text" && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="reading-text"
                    className="text-xs font-medium text-slate-400"
                  >
                    Cole o texto
                  </label>
                  <textarea
                    id="reading-text"
                    value={readingText}
                    onChange={(event) => setReadingText(event.target.value)}
                    placeholder="Cole aqui o artigo que você quer guardar"
                    rows={5}
                    className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white placeholder-slate-500 resize-y outline-none focus:border-sky-500/60 transition-colors motion-reduce:transition-none"
                  />
                </div>
              )}

              {isReading && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="reading-name"
                    className="text-xs font-medium text-slate-400"
                  >
                    Nome do arquivo
                  </label>
                  <input
                    id="reading-name"
                    type="text"
                    value={readingName}
                    onChange={(event) => setReadingName(event.target.value)}
                    placeholder="Como você quer encontrar isso depois"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-sky-500/60 transition-colors motion-reduce:transition-none"
                  />
                </div>
              )}

              {readingError && (
                <p
                  role="alert"
                  className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
                >
                  <AlertCircle size={14} className="shrink-0" />
                  {readingError}
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              {!isReading && (
                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="generation-name"
                      className="text-xs font-medium text-slate-400"
                    >
                      Nome (opcional)
                    </label>
                    <input
                      id="generation-name"
                      type="text"
                      value={generationName}
                      onChange={(event) => setGenerationName(event.target.value)}
                      placeholder="Deixe em branco pra usar o sugerido"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-violet-500/60 transition-colors motion-reduce:transition-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="generation-description"
                      className="text-xs font-medium text-slate-400"
                    >
                      Descrição (opcional)
                    </label>
                    <input
                      id="generation-description"
                      type="text"
                      value={generationDescription}
                      onChange={(event) => setGenerationDescription(event.target.value)}
                      placeholder="Deixe em branco pra usar o sugerido"
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none focus:border-violet-500/60 transition-colors motion-reduce:transition-none"
                    />
                  </div>
                </div>
              )}
              {transcribes && (
                <>
                  <TranscriptionProviderSelector
                    value={currentProvider}
                    onChange={handleProviderChange}
                    openaiAvailable={openaiAvailable}
                  />
                  <div data-testid="language-selector">
                    <LanguageSelector
                      value={language}
                      onChange={setLanguage}
                      visible
                    />
                  </div>
                </>
              )}

              <div className="space-y-1.5">
                <label
                  htmlFor="extra-prompt"
                  className="text-xs font-medium text-slate-400"
                >
                  Instruções adicionais (opcional)
                </label>
                <textarea
                  id="extra-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={3}
                  placeholder="Ex.: foque em exemplos práticos de arquitetura"
                  className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-white placeholder-slate-500 resize-none outline-none focus:border-violet-500/60 transition-colors motion-reduce:transition-none"
                />
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 px-5 py-3 border-t border-white/10">
          {step === 0 ? (
            <button
              data-testid="modal-cancel"
              onClick={onClose}
              className="px-4 py-2.5 text-sm font-medium rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-colors motion-reduce:transition-none"
            >
              Cancelar
            </button>
          ) : (
            <button
              data-testid="step-back"
              onClick={() => setStep((current) => Math.max(0, current - 1))}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-xl text-slate-300 hover:text-white hover:bg-white/5 transition-colors motion-reduce:transition-none disabled:opacity-50"
            >
              <ArrowLeft size={14} /> Voltar
            </button>
          )}

          {isLastStep ? (
            <button
              data-testid="step-submit"
              onClick={handleSubmit}
              disabled={!sourceFilled || busy}
              className={`flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl text-white transition-colors duration-200 motion-reduce:transition-none disabled:opacity-50 disabled:cursor-not-allowed ${
                isReading
                  ? "bg-sky-600 hover:bg-sky-500"
                  : "bg-violet-600 hover:bg-violet-500"
              }`}
            >
              {busy && (
                <Loader2
                  size={14}
                  className="animate-spin motion-reduce:animate-none"
                />
              )}
              {readingLoading
                ? "Salvando..."
                : processing
                  ? "Processando..."
                  : isReading
                    ? "Salvar leitura"
                    : "Gerar"}
            </button>
          ) : (
            <button
              data-testid="step-next"
              onClick={() =>
                setStep((current) => Math.min(stepCount - 1, current + 1))
              }
              disabled={!canAdvance}
              className="flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold rounded-xl bg-white/10 text-white hover:bg-white/15 transition-colors duration-200 motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continuar <ArrowRight size={14} />
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
