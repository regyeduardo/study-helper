import { useAppAiStore } from '@/lib/ai/app-ai'
import { useEffect, useId, useMemo, useState } from 'react'

import type { MediaAnalysis } from '@/types/domain'
import type { ModelChoice } from '@/components/dialogs/ModelPick'
import { Icon } from '@/components/ui/Icon'
import { aiConfigOf, modelByUid } from '@/lib/ai/config'
import { cannotWatch } from '@/lib/generation/youtube-video'
import { useLibraryStore } from '@/stores/library'
import { mediaOfModel, useModelsStore } from '@/stores/models'

interface Choice {
  id: MediaAnalysis
  label: string
  tag?: string
  hint(writer: string | undefined): string
  recommended?: boolean
}

/**
 * Of a video file every note (Ata, Aula, Explicação) asks the same three, in the same order (T177, the owner's "B" of 25/11): step by
 * step, where the screen is read by the frames of the video and each step has its model (a writer that only reads text works); only the
 * transcription; or all in one call, the audio of the video straight to the writer (of a video file the model gets its audio, T176).
 */
const VIDEO_ANALYSES: Choice[] = [
  { id: 'quadros', label: 'Transcrição + quadros do vídeo', tag: 'passo a passo', hint: writer => `Cada passo usa o seu modelo e funciona com ${writer ? `o ${writer}` : 'um modelo que só lê texto'}.`, recommended: true },
  { id: 'transcricao', label: 'Só a transcrição', hint: () => 'Só o texto, sem ler a tela: sai mais rápido.' },
  { id: 'video', label: 'Tudo numa chamada', hint: () => 'O modelo da escrita ouve o áudio do vídeo, sem passos.' },
]

/** A YouTube link: the model watches it by the link (the speech and the screen), or reads its legenda as before. */
const YOUTUBE_ANALYSES: Choice[] = [
  { id: 'video', label: 'Só o vídeo', hint: () => 'O modelo assiste o vídeo pelo link: a fala e a tela (slides, código, diagramas). Só vídeo público.' },
  { id: 'transcricao', label: 'Só a transcrição', hint: () => 'Só o texto da legenda do vídeo.' },
  { id: 'ambos', label: 'Transcrição + vídeo', hint: () => 'O vídeo e a legenda na mesma chamada.' },
]

/** Transcribing a video (T187): the screen read by its frames, by the model of the Vídeo step, or only the speech. */
const TRANSCRIPTION_ANALYSES: Choice[] = [
  { id: 'quadros', label: 'Transcrição + quadros do vídeo', hint: () => 'Lê a tela pelos quadros do vídeo: nomes, siglas e termos saem como aparecem escritos.', recommended: true },
  { id: 'transcricao', label: 'Só a transcrição', hint: () => 'Só a fala, sem ler a tela: sai mais rápido.' },
]

/** What a note made before analyzed: an Ata of before T177 went step by step as "transcricao" (it kept the models of its steps). */
export const analyzedBefore = (made: { analyze?: MediaAnalysis; steps?: object } | undefined): MediaAnalysis | undefined => (made?.analyze === 'transcricao' && made.steps ? 'quadros' : made?.analyze)

/** One verdict, in the same words, whatever the note (T176): the audio of the video goes only to a writer that hears it. */
const notHeard = (writer: string | undefined) => `O ${writer ?? 'modelo escolhido'} não ouve áudio.`

export interface MediaAnalysisOptions {
  /** The Ata of a video: step by step or all in one call. */
  ata?: boolean
  /** What the last Ata analyzed ("Gerar de novo"). */
  initial?: MediaAnalysis
  /** A YouTube link: the video goes only to a model that watches it, and "Só a transcrição" comes chosen, as before. */
  youtube?: boolean
  /** The transcription of a video (T187): read the screen by its frames or not; nothing there depends on a writer. */
  transcription?: boolean
}

/**
 * "O que a IA analisa" (FR-046). Of a video file it comes step by step (the frames of the video), or only the transcription when the media
 * is not kept (`unavailable` says why); "Tudo numa chamada" needs a writer that hears audio. `sent`: always what the window shows (T177).
 * A YouTube link stays as before: only the transcription unless the person marks the video, which needs a model that watches it.
 */
export function useMediaAnalysis(choice: ModelChoice | null, on: boolean, unavailable: string | null = null, { ata = false, initial, youtube = false, transcription = false }: MediaAnalysisOptions = {}) {
  const settings = useLibraryStore(state => state.index.settings)
  const live = useModelsStore(state => state.live)
  const probes = useModelsStore(state => state.probes)
  const readStale = useModelsStore(state => state.readStale)
  const appAi = useAppAiStore(state => state.config)
  const config = useMemo(() => aiConfigOf(settings), [settings, appAi])
  // what the person picked; until then what was made before, read on every render (the note may still be opening)
  const [own, setPicked] = useState<MediaAnalysis | null>(null)
  // "Transcrição + áudio" of before went all in one call: it comes back as "Tudo numa chamada"
  const picked = own ?? (!youtube && initial === 'ambos' ? 'video' : (initial ?? null))
  useEffect(() => {
    if (on) readStale(config.providers.filter(provider => config.models.some(model => model.pid === provider.id)))
  }, [config, on, readStale])
  const media = choice?.model ? mediaOfModel(config, live, probes, choice.model) : null
  const writer = choice?.model ? modelByUid(config, choice.model)?.name : undefined
  if (transcription) {
    const value: MediaAnalysis = picked === 'transcricao' ? 'transcricao' : 'quadros'
    return { value, reason: null, blocked: () => null, pick: setPicked, sent: on ? value : undefined, ata, writer, youtube, transcription }
  }
  if (youtube) {
    const reason = unavailable ?? cannotWatch(config, choice?.model, media)
    const value: MediaAnalysis = picked && (picked === 'transcricao' || !reason) ? picked : 'transcricao'
    return { value, reason, blocked: (id: MediaAnalysis) => (id === 'transcricao' ? null : reason), pick: setPicked, sent: picked === value ? value : undefined, ata, writer, youtube, transcription }
  }
  const deaf = media?.audio === true ? null : notHeard(writer)
  const blocked = (id: MediaAnalysis): string | null => (id === 'transcricao' ? null : id === 'quadros' ? unavailable : (unavailable ?? deaf))
  const value: MediaAnalysis = picked && !blocked(picked) ? picked : unavailable ? 'transcricao' : 'quadros'
  return { value, reason: blocked('video'), blocked, pick: setPicked, sent: on ? value : undefined, ata, writer, youtube, transcription }
}

/** Options the model or the entrada cannot do stay visible, disabled, saying why. `compact`: the choices side by side, with what the
 * chosen one does under them ("Gravação pronta", spec 007, mocks/gravar-reuniao); `label` names it when there are two. */
export function MediaAnalysisField({ analysis, compact = false, label = 'O que a IA analisa' }: { analysis: ReturnType<typeof useMediaAnalysis>; compact?: boolean; label?: string }) {
  const id = useId()
  const items = analysis.transcription ? TRANSCRIPTION_ANALYSES : analysis.youtube ? YOUTUBE_ANALYSES : VIDEO_ANALYSES
  if (compact) {
    const chosen = items.find(item => item.id === analysis.value)
    return (
      <div className="field">
        <span className="lab">{label}</span>
        <div className="rd-seg" role="radiogroup" aria-label={label}>
          {items.map(item => {
            const blocked = analysis.blocked(item.id)
            return (
              <button key={item.id} className="rd-segb" role="radio" aria-checked={analysis.value === item.id} aria-disabled={blocked ? true : undefined} title={blocked ?? undefined} onClick={() => !blocked && analysis.pick(item.id)}>
                <b>{item.label}</b>
              </button>
            )
          })}
        </div>
        {chosen && <span className="rd-about">{chosen.hint(analysis.writer)}</span>}
        {analysis.reason && <span className="rd-about">{analysis.reason}</span>}
      </div>
    )
  }
  return (
    <div className="field">
      <span className="lab">{label}</span>
      <div className={`opts says-why${analysis.youtube ? '' : ' ata-opts'}`} role="radiogroup" aria-label={label}>
        {items.map(item => {
          const blocked = analysis.blocked(item.id)
          return (
            // the name is the choice; what it does (and why it is off) is its description
            <button key={item.id} className="opt" role="radio" aria-checked={analysis.value === item.id} aria-disabled={Boolean(blocked)} aria-label={item.tag ? `${item.label} · ${item.tag}` : item.label} aria-describedby={`${id}-${item.id}`} onClick={() => !blocked && analysis.pick(item.id)}>
              <span className="radio" />
              <span>
                <b>{item.label}</b>
                {/* the space outside the tag: inside its inline-block it vanished ("vídeo· passo a passo") */}
                {item.tag && (
                  <>
                    {' '}
                    <span className="opt-tag">{`· ${item.tag}`}</span>
                  </>
                )}
                <span id={`${id}-${item.id}`}>
                  {item.hint(analysis.writer)}
                  {blocked && <> <span className="lim">{blocked}</span></>}
                </span>
                {item.recommended && (
                  <span className="opt-rec">
                    <Icon name="star" /> recomendado
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
