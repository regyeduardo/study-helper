import { useEffect, useId, useMemo, useState } from 'react'

import type { AtaStepModels } from '@/types/domain'
import type { ModelChoice } from '@/components/dialogs/ModelPick'
import { Icon } from '@/components/ui/Icon'
import { aiConfigOf, compatible, type Media, modelByUid, providerById, uidFor } from '@/lib/ai/config'
import { ATA_STEP_IDS, type AtaStepId, recommendedPair, scoreOfStep, type StepScore, STEP_SCORES_SOURCE } from '@/lib/ai/ata-step-scores'
import { useLibraryStore } from '@/stores/library'
import { mediaOfModel, useModelsStore } from '@/stores/models'
import '@/styles/ata-steps.css'

// "Modelos por passo" (FR-072): the Ata of a video step by step, a model for each step, with the score measured for it.

const LABEL: Record<AtaStepId, string> = { video: 'Vídeo', context: 'Contexto', write: 'Escrita' }
const NEEDS: Record<AtaStepId, Media[]> = { video: ['imagem'], context: ['texto'], write: ['texto'] }

export interface StepRow {
  id: AtaStepId
  label: string
  hint: string
  uid: string
  /** The name of the model of the step, as "Meus modelos" calls it. */
  name: string
  options: { uid: string; label: string }[]
  score: StepScore
  pick(uid: string): void
}

export interface AtaSteps {
  rows: StepRow[]
  open: boolean
  toggle(): void
  /** Every step with a recommended model in "Meus modelos" is on it. */
  atRecommended: boolean
  /** "Usar recomendados": every step goes to the recommended model (`ATA_STEPS`). */
  useRecommended(): void
  /** Right after "Usar recomendados", until a step is changed: "Desfazer" can put back the models that were there. */
  canUndo: boolean
  undo(): void
  /** Only what the person picked, to go to the generation: Escrita is the "Modelo da IA" (`write`). */
  sent: AtaStepModels & { write?: string }
}

/** State of "Modelos por passo". `writer`: the "Modelo da IA" of the window, which is the Escrita; `last`: what comes chosen instead of the default ("Gerar de novo"); `format`: the "Modelo da ata" in the hint of the Escrita. */
export function useAtaSteps(writer: ModelChoice, on: boolean, last: AtaStepModels = {}, format?: string): AtaSteps {
  const settings = useLibraryStore(state => state.index.settings)
  const live = useModelsStore(state => state.live)
  const probes = useModelsStore(state => state.probes)
  const readStale = useModelsStore(state => state.readStale)
  const config = useMemo(() => aiConfigOf(settings), [settings])
  const [picked, setPicked] = useState<AtaStepModels>(last)
  const [asked, setAsked] = useState<boolean | null>(null)
  // "Usar recomendados": the models there were before (what was picked for Vídeo and Contexto, and the writer, default or picked) and the ones it left
  const [before, setBefore] = useState<{ picked: AtaStepModels; write: string | null; left: Record<AtaStepId, string> } | null>(null)
  useEffect(() => {
    if (on) readStale(config.providers.filter(provider => config.models.some(model => model.pid === provider.id)))
  }, [config, on, readStale])

  const exists = (uid: string | undefined) => (uid && modelByUid(config, uid) ? uid : undefined)
  const label = (uid: string) => {
    const model = modelByUid(config, uid)
    const provider = providerById(config, model?.pid)
    return model ? (provider ? `${model.name} · ${provider.name}` : model.name) : ''
  }
  // a step without a pick of its own does what it did before: the screen goes to Leitura de tela; the context to its own model, else follows the writer
  const current: Record<AtaStepId, string> = { video: exists(picked.video) ?? uidFor(config, 'tela') ?? '', context: exists(picked.context) ?? exists(config.steps.contexto) ?? writer.pick, write: writer.pick }
  const recommendedUid = (id: AtaStepId) => {
    const pair = recommendedPair(id)
    return config.models.find(model => model.mid === pair.model && providerById(config, model.pid)?.type === pair.provider)?.uid
  }
  const hints: Record<AtaStepId, string> = {
    video: 'Lê a tela e diz quem fala, pelos quadros do vídeo.',
    context: 'O que mudou na reunião, como o prazo que caiu.',
    write: `Escreve a ata${format ? ` no formato ${format}` : ''}. Igual ao Modelo da IA.`,
  }
  const setters: Record<AtaStepId, (uid: string) => void> = {
    video: uid => setPicked(now => ({ ...now, video: uid || undefined })),
    context: uid => setPicked(now => ({ ...now, context: uid || undefined })),
    write: uid => writer.setPick(uid),
  }
  const rows: StepRow[] = ATA_STEP_IDS.map(id => {
    const uid = current[id]
    const model = modelByUid(config, uid)
    const type = providerById(config, model?.pid)?.type
    const uids = id === 'write' ? writer.options : config.models.filter(item => item.uid === uid || compatible(mediaOfModel(config, live, probes, item.uid), NEEDS[id])).map(item => item.uid)
    return { id, label: LABEL[id], hint: hints[id], uid, name: model?.name ?? '', options: uids.map(item => ({ uid: item, label: label(item) })), score: scoreOfStep(id, model && type ? { provider: type, model: model.mid } : null), pick: setters[id] }
  })
  const atRecommended = ATA_STEP_IDS.every(id => !recommendedUid(id) || current[id] === recommendedUid(id))
  // a step that starts below the line opens the section: the warning is not hidden
  const isOpen = asked ?? rows.some(row => row.score.low)
  // the section stays as it is while the models change under it, even if the warning that opened it goes away
  const useRecommended = () => {
    const [video, context, write] = ATA_STEP_IDS.map(recommendedUid)
    setAsked(isOpen)
    setBefore({ picked, write: writer.touched ? writer.pick : null, left: { video: video ?? current.video, context: context ?? current.context, write: write ?? current.write } })
    // a step with no recommended model in "Meus modelos" keeps the one it has
    setPicked(now => ({ ...now, ...(video ? { video } : {}), ...(context ? { context } : {}) }))
    if (write) writer.setPick(write)
  }
  // "Desfazer" is there while the steps are as "Usar recomendados" left them: a step changed after that, by hand or in the "Modelo da IA", is the person's
  const canUndo = before !== null && ATA_STEP_IDS.every(id => current[id] === before.left[id])
  const undo = () => {
    if (!canUndo || !before) return
    setAsked(isOpen)
    setPicked(before.picked)
    writer.setPick(before.write)
    setBefore(null)
  }
  const sent = { ...(exists(picked.video) ? { video: picked.video } : {}), ...(exists(picked.context) ? { context: picked.context } : {}), ...(writer.touched && writer.model ? { write: writer.model } : {}) }
  return { rows, open: isOpen, toggle: () => setAsked(!isOpen), atRecommended, useRecommended, canUndo, undo, sent }
}

function Badge({ score }: { score: StepScore }) {
  if (score.score === null || score.low) return null
  if (!score.recommended) return <span className="ata-badge">{`nota ${score.score}`}</span>
  return (
    <span className="ata-badge ok">
      <Icon name="star" />
      {` recomendado · nota ${score.score}`}
    </span>
  )
}

function Row({ row }: { row: StepRow }) {
  const id = useId()
  return (
    <div className="ata-step" role="group" aria-label={row.label}>
      <div className="ata-step-top">
        <label className="ata-step-name" htmlFor={id}>
          {row.label}
        </label>
        <Badge score={row.score} />
      </div>
      <p className="ata-step-hint">{row.hint}</p>
      <select className="input" id={id} value={row.uid} onChange={event => row.pick(event.target.value)}>
        {!row.uid && <option value="">{row.id === 'video' ? 'sem modelo de visão: só o texto da tela' : 'escolha um modelo'}</option>}
        {row.options.map(option => (
          <option key={option.uid} value={option.uid}>
            {option.label}
          </option>
        ))}
      </select>
      {row.score.low && (
        <div className="banner" role="status">
          <Icon name="warn" />
          <span>
            <b>{`${row.name}: nota ${row.score.score} neste passo`}</b>
            {` (${row.score.why}). Pode piorar a ata.`}
          </span>
        </div>
      )}
      {row.uid && row.score.score === null && <p className="ata-step-none">Sem nota medida neste passo.</p>}
    </div>
  )
}

/** The section of the window: closed it is one line; open, a model for each step. */
export function AtaStepsField({ steps }: { steps: AtaSteps }) {
  const body = useId()
  return (
    <div className="field ata-steps" role="group" aria-label="Modelos por passo">
      <div className="ata-steps-head">
        <button type="button" className="ata-steps-toggle" aria-expanded={steps.open} aria-controls={steps.open ? body : undefined} onClick={steps.toggle}>
          <Icon name={steps.open ? 'chev' : 'chevr'} />
          Modelos por passo
        </button>
        {steps.canUndo ? (
          <button type="button" className="btn quiet ata-steps-action" onClick={steps.undo}>
            Desfazer
          </button>
        ) : steps.atRecommended ? (
          <button type="button" className="btn quiet ata-steps-action" disabled>
            Já nos recomendados
          </button>
        ) : (
          <button type="button" className="btn ata-steps-action" onClick={steps.useRecommended}>
            Usar recomendados
          </button>
        )}
      </div>
      {steps.open && (
        <div id={body} className="ata-steps-body">
          {steps.rows.map(row => (
            <Row key={row.id} row={row} />
          ))}
          <p className="ata-steps-source">{STEP_SCORES_SOURCE}</p>
        </div>
      )}
    </div>
  )
}
