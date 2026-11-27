import { useEffect, useMemo, useRef } from 'react'

import type { AtaStepModels, MediaAnalysis, TranscriptionChoice } from '@/types/domain'
import { AtaStepsField, useAtaSteps } from '@/components/dialogs/AtaSteps'
import { MediaAnalysisField, useMediaAnalysis } from '@/components/dialogs/MediaAnalysisField'
import type { ModelChoice } from '@/components/dialogs/ModelPick'
import { aiConfigOf, modelByUid } from '@/lib/ai/config'
import type { ScreenChoice } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'

/**
 * Transcribing a video (again), with the choices of "Novo conteúdo" (T187, dono 27/11): "Transcrição + quadros do vídeo" reads the
 * screen, by the model of the Vídeo step; "Só a transcrição" does not. `choice`: the Transcrição. `on`: a video that can be heard.
 * `heard`: what the last transcription used, which comes chosen (its Transcrição too), unless `prefill` (the window after a failure).
 */
export function useTranscriptionScreen(choice: ModelChoice, on: boolean, heard: TranscriptionChoice | undefined, prefill?: { analyze?: MediaAnalysis; steps?: AtaStepModels }) {
  const settings = useLibraryStore(state => state.index.settings)
  const config = useMemo(() => aiConfigOf(settings), [settings])
  const analysis = useMediaAnalysis(choice, on, null, { transcription: true, initial: prefill ? prefill.analyze : heard && (heard.screen ? 'quadros' : 'transcricao') })
  const reads = on && analysis.value === 'quadros'
  const steps = useAtaSteps(choice, reads, prefill?.steps ?? {}, undefined, 'transcricao')
  // the note may still be opening: what the last transcription used comes chosen once it is known, unless something was chosen already
  const applied = useRef(false)
  useEffect(() => {
    if (applied.current || !heard || prefill) return
    applied.current = true
    if (heard.model && !choice.touched && modelByUid(config, heard.model)) choice.setPick(heard.model)
    if (heard.vision && !steps.sent.video) steps.rows[0]?.pick(heard.vision)
  }, [heard])
  const sent: ScreenChoice | undefined = on ? { read: reads, ...(reads && steps.sent.video ? { model: steps.sent.video } : {}) } : undefined
  return { analysis, steps, reads, on, sent }
}

/** "O que a IA analisa" with its two choices and, reading the screen, "Modelos por passo" with the Vídeo step alone. */
export function TranscriptionScreenField({ screen }: { screen: ReturnType<typeof useTranscriptionScreen> }) {
  if (!screen.on) return null
  return (
    <>
      <MediaAnalysisField analysis={screen.analysis} />
      {screen.reads && <AtaStepsField steps={screen.steps} />}
    </>
  )
}
