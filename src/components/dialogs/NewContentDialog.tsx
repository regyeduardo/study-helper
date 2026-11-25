import { type ReactNode, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { AtaModelId, AtaPart, SourceStorage } from "@/types/domain";
import {
  AtaPartsFields,
  toggledPart,
} from "@/components/dialogs/AtaPartsDialog";
import { FolderField } from "@/components/dialogs/FolderChooser";
import { goToNew, readingAt } from "@/components/dialogs/go-to-new";
import { AtaStepsField, useAtaSteps } from "@/components/dialogs/AtaSteps";
import {
  MediaAnalysisField,
  useMediaAnalysis,
} from "@/components/dialogs/MediaAnalysisField";
import { ModelPick, useModelChoice } from "@/components/dialogs/ModelPick";
import { WaitStatus } from "@/components/ui/WaitStatus";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import {
  KeepLevelPicker,
  SourceStoragePicker,
} from "@/components/dialogs/SourceStoragePicker";
import type { LitterboxTime } from "@/controllers/hosting.controller";
import { youtubeId } from "@/controllers/sources.controller";
import { ATA_MODELS, PART_ORDER } from "@/lib/generation/ata";
import type { ContentInput } from "@/lib/generation/inputs";
import { detectKind } from "@/lib/generation/uploads";
import { paths } from "@/lib/paths";
import { sideForNew } from "@/lib/storage/combined-repository";
import { defaultStorage, storageOptions } from "@/lib/storage/source-storage";
import { useAccountStore } from "@/stores/account";
import { useGenerationsStore } from "@/stores/generations";
import {
  type Agent,
  defaultKeep,
  type KeepLevel,
  useJobsStore,
} from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useSyncStore } from "@/stores/sync";
import { type NewContentForm, type Overlay, useUiStore } from "@/stores/ui";
import { formatBytes } from "@/utils/format";

type Tab = "link" | "file" | "text" | "topic";

const AGENTS: { id: Agent; label: string; hint: string }[] = [
  {
    id: "lesson",
    label: "Aula",
    hint: "Vira uma aula estruturada; se render mais de uma, o app propõe uma pasta com as aulas.",
  },
  {
    id: "meeting",
    label: "Ata de reunião",
    hint: "Transcrição de reunião vira ata com decisões e encaminhamentos.",
  },
  {
    id: "reading",
    label: "Só guardar para ler",
    hint: "Guarda o texto como veio, sem IA.",
  },
];

const KEPT_IN_NOTE: Record<Tab, string> = {
  link: "O link fica guardado na nota.",
  text: "O texto fica guardado na nota.",
  topic: "O tema fica guardado na nota.",
  file: "",
};

const WRITTEN_LABEL: Record<Agent, string> = {
  lesson: "Gerando a Aula",
  explanation: "Gerando a Explicação",
  meeting: "Gerando a Ata",
  reading: "Guardado para ler",
};

/** "Mais opções", open from the start when it holds something typed (the window came back filled in). */
function MoreDetails({
  filled,
  children,
}: {
  filled: boolean;
  children: ReactNode;
}) {
  const [open] = useState(filled);
  return <details open={open}>{children}</details>;
}

const ACCEPT =
  ".mp4,.webm,.avi,.mkv,.mov,.mp3,.wav,.ogg,.m4a,.aac,.flac,.opus,.pdf,.docx,.txt,.md,.csv,.json,.xml,.html,.srt,.vtt,.sbv,.ass";

/** `onBack`: after a failure, the same window comes back with everything as it was. */
function GenerationProgress({
  jobId,
  onHide,
  onBack,
}: {
  jobId: string;
  onHide(): void;
  onBack(): void;
}) {
  const job = useJobsStore((state) =>
    state.jobs.find((item) => item.id === jobId),
  );
  const cancel = useJobsStore((state) => state.cancel);
  // spec 007 (FR-060): the same wait as Gerações, with the clock time and "sem travar"; never an invented percentage
  const wait = useGenerationsStore(
    (state) => state.items.find((item) => item.id === jobId)?.wait,
  );
  if (!job) return null;
  return (
    <Dialog
      title={`Lendo “${job.title}”`}
      size="narrow"
      footer={
        job.status === "running" ? (
          <>
            <button className="btn danger" onClick={() => cancel(job.id)}>
              Cancelar
            </button>
            <button className="btn" onClick={onHide}>
              Continuar em segundo plano
            </button>
          </>
        ) : job.status === "error" || job.status === "cancelled" ? (
          <>
            <button className="btn quiet" onClick={onHide}>
              Fechar
            </button>
            <button className="btn primary" onClick={onBack}>
              Voltar e tentar de novo
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onHide}>
            Fechar
          </button>
        )
      }
    >
      <div className="db">
        {job.status === "running" && wait ? (
          <WaitStatus wait={wait} onCancel={() => cancel(job.id)} />
        ) : (
          <>
            <div className="bar">
              <i
                style={
                  {
                    "--v": `${Math.round((job.fraction ?? (job.status === "running" ? 0 : 1)) * 100)}%`,
                  } as React.CSSProperties
                }
              />
            </div>
            <div className="progress">
              <div
                className={`step ${job.status === "running" ? "now" : job.status === "error" ? "done failed" : "done"}`}
              >
                {job.status === "running" ? (
                  <Icon name="sync" className="spinning" />
                ) : job.status === "done" ? (
                  <Icon name="check" />
                ) : (
                  <Icon name={job.status === "error" ? "warn" : "x"} />
                )}
                {job.message}
              </div>
            </div>
          </>
        )}
        {job.error && (
          <div className="banner" role="alert">
            <Icon name="warn" />
            <span>{job.error}</span>
          </div>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          Dá para fechar: o trabalho continua e aparece no canto quando acabar.
        </span>
      </div>
    </Dialog>
  );
}

/** `prefill`: the window as it was when that generation failed ("Tentar de novo" in the corner). */
export function NewContentDialog({
  folderId: initialFolder,
  prefill,
}: {
  folderId?: string | null;
  prefill?: NewContentForm;
}) {
  const ui = useUiStore();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const settings = useLibraryStore((state) => state.index.settings);
  const account = useAccountStore((state) => state.active());
  const usage = useSyncStore((state) => state.usage);
  const startNewContent = useJobsStore((state) => state.startNewContent);
  const dismiss = useJobsStore((state) => state.dismiss);
  const [tab, setTab] = useState<Tab>(prefill?.tab ?? "link");
  const [agent, setAgent] = useState<Agent>(prefill?.agent ?? "lesson");
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [text, setText] = useState(prefill?.text ?? "");
  const [topic, setTopic] = useState(prefill?.topic ?? "");
  const [file, setFile] = useState<File | null>(prefill?.file ?? null);
  const [isMedia, setIsMedia] = useState(prefill?.isMedia ?? false);
  const [keep, setKeep] = useState<KeepLevel | null>(prefill?.keep ?? null);
  const [storage, setStorage] = useState<SourceStorage | null>(
    prefill?.storage ?? null,
  );
  const [litterboxTime, setLitterboxTime] = useState<LitterboxTime>(
    prefill?.litterboxTime ?? "24h",
  );
  const [name, setName] = useState(prefill?.name ?? "");
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [prompt, setPrompt] = useState(prefill?.prompt ?? "");
  const [folderId, setFolderId] = useState<string | null>(
    prefill ? prefill.folderId : (initialFolder ?? null),
  );
  const [jobId, setJobId] = useState<string | null>(null);
  const [ataParts, setAtaParts] = useState<AtaPart[]>(
    prefill?.ataParts ?? ["resumo"],
  );
  const [ataModel, setAtaModel] = useState<AtaModelId | null>(
    prefill?.ataModel ?? null,
  );
  const input = useRef<HTMLInputElement>(null);

  const driveAvailable = account.kind === "google";
  // the note is born in the App with the structure on, and the file kept with it goes there too
  const inApp = useLibraryStore(
    (state) => sideForNew(state.repo, folderId) === "app",
  );
  const room =
    usage && settings.storageLimitBytes
      ? settings.storageLimitBytes - usage.appBytes
      : null;
  const options = useMemo(
    () => (file ? storageOptions(file.size, driveAvailable, room, inApp) : []),
    [file, driveAvailable, room, inApp],
  );
  const writes: Agent =
    tab === "topic" && agent === "lesson" ? "explanation" : agent;
  // under "Registro e arquivo", not keeping the file would be "Só o registro"; for media, 'none' is Mídias, on this computer
  const places = options.filter((option) => isMedia || option.id !== "none");
  const chosen = file
    ? storage &&
      places.find(
        (option) => option.id === storage && option.fits && option.enabled,
      )
      ? storage
      : defaultStorage(driveAvailable || inApp, places)
    : "none";
  const fileReason =
    tab !== "file"
      ? "Só para arquivo e mídia."
      : places.some((option) => option.fits && option.enabled)
        ? null
        : (places.find((option) => option.reason)?.reason ??
          "Não há onde guardar este arquivo.");
  const wanted = keep ?? defaultKeep(tab, writes);
  // an Ata always has an entrada (FR-055)
  const level: KeepLevel =
    writes === "meeting" && wanted === "sem-rastro"
      ? "registro"
      : wanted === "arquivo" && fileReason
        ? "registro"
        : wanted;
  const isYoutube = Boolean(youtubeId(url));
  // a link (not YouTube), a text or a topic stays in the note: there is nothing to choose of what to keep
  const inNote =
    tab === "text" || tab === "topic" || (tab === "link" && !isYoutube);
  const choosesParts =
    agent === "meeting" && tab === "file" && Boolean(file) && isMedia;
  const media = tab === "file" && Boolean(file) && isMedia;
  // a window that comes back after a failure has the models it had
  const was = (uid: string | undefined, videoWrites = false) => ({
    ...(uid ? { pick: uid } : {}),
    ...(videoWrites && prefill?.models.videoWrites
      ? { videoWrites: true }
      : {}),
  });
  const choices = {
    aula: useModelChoice("aula", media, was(prefill?.models.aula, true)),
    explicacao: useModelChoice(
      "explicacao",
      media,
      was(prefill?.models.explicacao, true),
    ),
    ata: useModelChoice("ata", false, was(prefill?.models.ata)),
  };
  const heardBy = useModelChoice(
    "transcricao",
    false,
    was(prefill?.models.transcricao),
  );
  const writer =
    agent === "reading"
      ? null
      : (tab === "topic" && agent === "lesson") || agent === "explanation"
        ? choices.explicacao
        : agent === "meeting"
          ? choices.ata
          : choices.aula;
  // a YouTube link is a video too: the writer may watch it by the link
  const watchesLink = tab === "link" && isYoutube && Boolean(writer);
  // only a video has the choice; the type is what the store goes by too
  const analyzes =
    (media && Boolean(writer) && Boolean(file?.type.startsWith("video/"))) ||
    watchesLink;
  // the Ata of a video goes step by step, each step with its model, or all in one call (FR-072)
  const ataOfVideo = analyzes && agent === "meeting" && !watchesLink;
  const analysis = useMediaAnalysis(writer, analyzes, null, {
    ata: ataOfVideo,
    youtube: watchesLink,
    initial: prefill?.analyze,
  });
  const steps = useAtaSteps(
    choices.ata,
    ataOfVideo,
    prefill?.steps ?? {},
    ataModel ? ATA_MODELS[ataModel].name : undefined,
  );
  const stepByStep = ataOfVideo && analysis.value === "transcricao";

  const pickFile = async (picked: File | null) => {
    setFile(picked);
    setStorage(null);
    if (!picked) return;
    const kind = detectKind(
      picked.name,
      new Uint8Array(await picked.slice(0, 16384).arrayBuffer()),
    );
    setIsMedia(kind === "media");
    if (
      kind === "media" &&
      agent === "lesson" &&
      /reuni|meet|call|grava/i.test(picked.name)
    )
      setAgent("meeting");
  };

  const contentInput = (): ContentInput | null => {
    if (tab === "link")
      return /^https?:\/\//.test(url.trim())
        ? { kind: "link", url: url.trim() }
        : null;
    if (tab === "file") return file ? { kind: "file", file } : null;
    if (tab === "text")
      return text.trim().length > 10 ? { kind: "text", text } : null;
    return topic.trim().length > 2 ? { kind: "topic", topic } : null;
  };

  /** Everything the window holds now: a failure brings it back like this. */
  const formNow = (): NewContentForm => ({
    tab,
    agent,
    url,
    text,
    topic,
    file,
    isMedia,
    keep,
    storage,
    litterboxTime,
    name,
    description,
    prompt,
    folderId,
    ataParts,
    ataModel,
    models: {
      ...(choices.aula.touched ? { aula: choices.aula.pick } : {}),
      ...(choices.explicacao.touched
        ? { explicacao: choices.explicacao.pick }
        : {}),
      ...(choices.ata.touched ? { ata: choices.ata.pick } : {}),
      ...(heardBy.touched ? { transcricao: heardBy.pick } : {}),
      ...(writer?.videoWrites ? { videoWrites: true } : {}),
    },
    ...(analyzes && analysis.sent ? { analyze: analysis.sent } : {}),
    ...(stepByStep ? { steps: steps.sent } : {}),
  });

  const go = async () => {
    const content = contentInput();
    if (!content) return;
    const retry: Overlay = {
      kind: "new",
      ...(initialFolder !== undefined ? { folderId: initialFolder } : {}),
      prefill: formNow(),
    };
    const fileId = await startNewContent(
      {
        agent: writes,
        input: content,
        name,
        description,
        folderId,
        prompt,
        ...(inNote ? {} : { keep: level }),
        storage: !inNote && level === "arquivo" ? chosen : "none",
        litterboxTime,
        ...(choosesParts
          ? ataModel
            ? { ataParts: [], ataModel }
            : { ataParts: PART_ORDER.filter((part) => ataParts.includes(part)) }
          : {}),
        models: {
          write: writer?.model || null,
          transcription: media ? heardBy.model || null : null,
          ...(writer?.videoWrites ? { everyStep: true } : {}),
          ...(stepByStep ? { steps: steps.sent } : {}),
        },
        ...(analyzes && analysis.sent ? { analyze: analysis.sent } : {}),
      },
      setJobId,
      retry,
    );
    if (!fileId) return;
    // with a note or an entrada open, she stays there: the window closes and a notice offers the new note
    if (readingAt(pathname)) ui.close();
    goToNew(paths.file(fileId), WRITTEN_LABEL[writes], pathname, (to) => {
      ui.set({ handoffFileId: fileId });
      navigate(to);
    });
  };

  // back to the window as it was: the failed line leaves the corner
  const back = () => {
    if (jobId) dismiss(jobId);
    setJobId(null);
  };

  if (jobId)
    return <GenerationProgress jobId={jobId} onHide={ui.close} onBack={back} />;

  const canGo =
    Boolean(contentInput()) &&
    !(choosesParts && !ataModel && !ataParts.length) &&
    (!writer || writer.ready) &&
    (!media || heardBy.ready);
  const tabButton = (
    id: Tab,
    icon: Parameters<typeof Icon>[0]["name"],
    label: string,
  ) => (
    <button aria-pressed={tab === id} onClick={() => setTab(id)}>
      <Icon name={icon} />
      {label}
    </button>
  );

  return (
    <Dialog
      title="Novo conteúdo"
      onClose={ui.close}
      footer={
        <>
          <button className="btn quiet" onClick={ui.close}>
            Cancelar
          </button>
          <button
            className="btn primary"
            disabled={!canGo}
            onClick={() => void go()}
          >
            {agent === "reading"
              ? "Guardar"
              : agent === "meeting"
                ? "Gerar ata"
                : agent === "explanation" || tab === "topic"
                  ? "Gerar explicação"
                  : "Gerar aula"}
          </button>
        </>
      }
    >
      <div className="tabs">
        {tabButton("link", "link", "Link")}
        {tabButton("file", "upload", "Arquivo")}
        {tabButton("text", "text", "Texto")}
        {tabButton("topic", "bulb", "Tema")}
        <button onClick={() => ui.open({ kind: "record" })}>
          <Icon name="rec" />
          Gravar reunião
        </button>
      </div>
      <div className="db" style={{ paddingTop: 14 }}>
        {tab === "link" && (
          <>
            <div className="field">
              <label htmlFor="nc-url">Link</label>
              <input
                className="input"
                id="nc-url"
                autoFocus
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://"
              />
            </div>
            {url.trim() &&
              (isYoutube ? (
                <div className="banner info">
                  <Icon name="info" />
                  <span>
                    Vídeo do YouTube: lido por{" "}
                    {settings.youtube.reader === "gemini"
                      ? "Gemini (até 8 h de vídeo por dia, só vídeo público)"
                      : "youtube-transcript.ai (uso justo, sem garantia)"}
                    .{" "}
                    <button
                      style={{ color: "var(--acc1)" }}
                      onClick={() =>
                        ui.open({ kind: "settings", tab: "links" })
                      }
                    >
                      Trocar
                    </button>
                  </span>
                </div>
              ) : (
                <div className="banner info">
                  <Icon name="info" />
                  <span>
                    A página é lida pelo Jina Reader (grátis, 20 pedidos por
                    minuto).
                  </span>
                </div>
              ))}
          </>
        )}
        {tab === "file" && (
          <>
            <label
              className="drop"
              htmlFor="nc-file"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => (
                event.preventDefault(),
                void pickFile(event.dataTransfer.files[0] ?? null)
              )}
            >
              <Icon name="upload" />
              <b>{file ? file.name : "Escolher arquivo"}</b>
              <span style={{ fontSize: 12.5 }}>
                {file
                  ? `${formatBytes(file.size)} · ${file.type || "arquivo"}`
                  : "PDF, docx, áudio, vídeo, legenda, .md ou .txt"}
              </span>
            </label>
            <input
              ref={input}
              type="file"
              id="nc-file"
              hidden
              accept={ACCEPT}
              onChange={(event) =>
                void pickFile(event.target.files?.[0] ?? null)
              }
            />
            {media && <ModelPick choice={heardBy} label="Transcrição" />}
          </>
        )}
        {tab === "text" && (
          <div className="field">
            <label htmlFor="nc-text">Texto</label>
            <textarea
              className="input"
              id="nc-text"
              rows={7}
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Cole aqui o texto, a ata ou as anotações"
            />
          </div>
        )}
        {tab === "topic" && (
          <>
            <div className="field">
              <label htmlFor="nc-topic">Tema</label>
              <input
                className="input"
                id="nc-topic"
                autoFocus
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="Ex.: juros compostos para iniciantes"
              />
            </div>
            <span className="faint" style={{ fontSize: 12.5 }}>
              Um tema vira uma explicação a fundo.
            </span>
          </>
        )}
        {tab !== "topic" && (
          <div className="field">
            <span className="lab">O que gerar</span>
            <div className="opts" role="radiogroup">
              {AGENTS.filter(
                (item) =>
                  !(item.id === "reading" && tab === "link" && isYoutube),
              ).map((item) => (
                <button
                  key={item.id}
                  className="opt"
                  role="radio"
                  aria-checked={agent === item.id}
                  onClick={() => setAgent(item.id)}
                >
                  <span className="radio" />
                  <span>
                    <b>{item.label}</b>
                    <span>{item.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {writer && <ModelPick choice={writer} />}
        {analyzes && <MediaAnalysisField analysis={analysis} />}
        {stepByStep && <AtaStepsField steps={steps} />}
        {choosesParts && (
          <AtaPartsFields
            parts={ataParts}
            onToggle={(part) =>
              setAtaParts((current) => toggledPart(current, part))
            }
            model={ataModel}
            onModel={setAtaModel}
          />
        )}
        {inNote ? (
          <span className="faint" style={{ fontSize: 12.5 }}>
            {KEPT_IN_NOTE[tab]}
          </span>
        ) : (
          (tab !== "file" || file) && (
            <KeepLevelPicker
              level={level}
              onLevel={setKeep}
              traceless={writes !== "meeting"}
              fileReason={fileReason}
            >
              {file && (
                <SourceStoragePicker
                  label="Onde guardar o arquivo"
                  sizeBytes={file.size}
                  options={places}
                  chosen={chosen}
                  onChoose={setStorage}
                  litterboxTime={litterboxTime}
                  onLitterboxTime={setLitterboxTime}
                  names={
                    isMedia
                      ? {
                          none: {
                            name: "Só neste computador",
                            description:
                              "Fica em Mídias, neste navegador. A nota toca o vídeo ou o áudio daqui.",
                          },
                        }
                      : undefined
                  }
                />
              )}
            </KeepLevelPicker>
          )
        )}
        <div className="two-col">
          <div className="field">
            <label htmlFor="nc-name">Nome (opcional)</label>
            <input
              className="input"
              id="nc-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Vem da fonte se ficar vazio"
            />
          </div>
          <div className="field">
            <span className="lab">Pasta</span>
            <FolderField value={folderId} onChange={setFolderId} />
          </div>
        </div>
        <MoreDetails filled={Boolean(prompt.trim() || description.trim())}>
          <summary
            className="muted"
            style={{ fontSize: 13, cursor: "pointer" }}
          >
            Mais opções
          </summary>
          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            <div className="field">
              <label htmlFor="nc-desc">Descrição (opcional)</label>
              <input
                className="input"
                id="nc-desc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            {agent !== "reading" && (
              <div className="field">
                <label htmlFor="nc-prompt">
                  Instrução extra para a IA (opcional)
                </label>
                <textarea
                  className="input"
                  id="nc-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Ex.: foque na parte prática"
                />
              </div>
            )}
          </div>
        </MoreDetails>
      </div>
    </Dialog>
  );
}
