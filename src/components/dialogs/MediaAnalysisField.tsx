import { useEffect, useMemo, useState } from 'react'

import type { MediaAnalysis } from '@/types/domain'
import type { ModelChoice } from '@/components/dialogs/ModelPick'
import { Icon } from '@/components/ui/Icon'
import { aiConfigOf, modelByUid } from '@/lib/ai/config'
import { useLibraryStore } from '@/stores/library'
import { mediaOfModel, useModelsStore } from '@/stores/models'

const ANALYSES: { id: MediaAnalysis; label: string; hint: string }[] = [
  { id: 'video', label: 'Só o vídeo', hint: 'A mídia vai direto ao modelo.' },
  { id: 'transcricao', label: 'Só a transcrição', hint: 'Só o texto; se faltar, ela é feita antes.' },
  { id: 'ambos', label: 'Transcrição + vídeo', hint: 'Os dois na mesma chamada.' },
]

const NOT_HEARD = 'O modelo escolhido não ouve a mídia.'

/** The Ata of a video has two ways (FR-072): step by step, where each step has its model and a text-only writer works, or all in one call (the media straight to the writer, as the Ata did with a writer that hears), which needs a writer that sees video. */
const ATA_ANALYSES: { id: MediaAnalysis; label: string; tag?: string; hint(writer: string | undefined): string; recommended?: boolean }[] = [
  { id: 'transcricao', label: 'Transcrição + quadros do vídeo', tag: 'passo a passo', hint: writer => `Cada passo usa o seu modelo e funciona com ${writer ? `o ${writer}` : 'um modelo que só lê texto'}.`, recommended: true },
  { id: 'video', label: 'Tudo numa chamada', hint: () => 'O modelo da escrita vê o vídeo, sem passos.' },
]

export interface MediaAnalysisOptions {
  /** The Ata of a video: step by step or all in one call. */
  ata?: boolean
  /** What the last Ata analyzed ("Gerar de novo"). */
  initial?: MediaAnalysis
}

/** "O que a IA analisa" (FR-046): comes with the media when the model hears it, else the transcription. `unavailable`: why the media cannot go. `sent`: only what the person marked, so that untouched the request stays as today; in the Ata of a video it is always the choice shown. */
export function useMediaAnalysis(choice: ModelChoice | null, on: boolean, unavailable: string | null = null, { ata = false, initial }: MediaAnalysisOptions = {}) {
  const settings = useLibraryStore(state => state.index.settings)
  const live = useModelsStore(state => state.live)
  const probes = useModelsStore(state => state.probes)
  const readStale = useModelsStore(state => state.readStale)
  const config = useMemo(() => aiConfigOf(settings), [settings])
  // in the Ata the media and the transcription in the same call is "Tudo numa chamada" too
  const [picked, setPicked] = useState<MediaAnalysis | null>(ata && initial === 'ambos' ? 'video' : (initial ?? null))
  useEffect(() => {
    if (on) readStale(config.providers.filter(provider => config.models.some(model => model.pid === provider.id)))
  }, [config, on, readStale])
  const media = choice?.model ? mediaOfModel(config, live, probes, choice.model) : null
  const writer = choice?.model ? modelByUid(config, choice.model)?.name : undefined
  const hears = media?.audio === true && (!ata || media.video !== false)
  const reason = unavailable ?? (hears ? null : ata ? `Só abre com um modelo que veja vídeo: o ${writer ?? 'modelo escolhido'} não vê vídeo.` : NOT_HEARD)
  const value: MediaAnalysis = ata ? (picked === 'video' && !reason ? 'video' : 'transcricao') : picked && (picked === 'transcricao' || !reason) ? picked : reason ? 'transcricao' : 'video'
  return { value, reason, pick: setPicked, sent: ata || picked === value ? value : undefined, ata, writer }
}

/** Options the model or the entrada cannot do stay visible, disabled, saying why. */
export function MediaAnalysisField({ analysis }: { analysis: ReturnType<typeof useMediaAnalysis> }) {
  const items = analysis.ata ? ATA_ANALYSES : ANALYSES.map(item => ({ ...item, tag: undefined, hint: () => item.hint, recommended: false }))
  return (
    <div className="field">
      <span className="lab">O que a IA analisa</span>
      <div className={`opts says-why${analysis.ata ? ' ata-opts' : ''}`} role="radiogroup" aria-label="O que a IA analisa">
        {items.map(item => {
          const blocked = item.id === 'transcricao' ? null : analysis.reason
          return (
            <button key={item.id} className="opt" role="radio" aria-checked={analysis.value === item.id} aria-disabled={Boolean(blocked)} onClick={() => !blocked && analysis.pick(item.id)}>
              <span className="radio" />
              <span>
                <b>{item.label}</b>
                {item.tag && <span className="opt-tag">{` · ${item.tag}`}</span>}
                <span>
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
