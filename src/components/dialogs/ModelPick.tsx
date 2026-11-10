import { useEffect, useId, useMemo, useState } from 'react'

import type { AiUse } from '@/types/domain'
import { aiConfigOf, compatible, modelByUid, providerById, uidFor, useInfo } from '@/lib/ai/config'
import { useLibraryStore } from '@/stores/library'
import { mediaOfModel, useModelsStore } from '@/stores/models'

/** What a generation dialog sends: who writes (or transcribes) and whether the video model writes the document. */
export interface ModelChoice {
  use: AiUse
  /** The model picked: the default comes preselected. */
  pick: string
  /** `null` goes back to the default coming preselected. */
  setPick(uid: string | null): void
  /** The person (or the last time) chose a model, instead of the default coming preselected. */
  touched: boolean
  /** The Vídeo e áudio model, offered only when the source is a video or an audio. */
  video: string | undefined
  videoWrites: boolean
  setVideoWrites(on: boolean): void
  /** Who writes: the video model when it also writes, else the pick (or nothing when it is no longer one of "Meus modelos"). */
  model: string
  options: string[]
  /** False while there are models to choose and none is chosen. */
  ready: boolean
}

/** State of the model selector of a generation dialog, for one use. `media`: the source is a video or an audio (the Ata does not ask: each step has its model); `last`: what comes chosen instead of the default ("Gerar de novo"). */
export function useModelChoice(use: AiUse, media = false, last: { pick?: string; videoWrites?: boolean } = {}): ModelChoice {
  const settings = useLibraryStore(state => state.index.settings)
  const live = useModelsStore(state => state.live)
  const probes = useModelsStore(state => state.probes)
  const readStale = useModelsStore(state => state.readStale)
  const config = useMemo(() => aiConfigOf(settings), [settings])
  const [pick, setPick] = useState<string | null>(last.pick ?? null)
  const [videoWrites, setVideoWrites] = useState(Boolean(last.videoWrites))

  const needs = useInfo(use).id === 'aula' ? ['texto' as const] : useInfo(use).needs
  // Only media uses need to know what each model takes; the lists are read live, never stored.
  const readsLive = needs.some(need => need !== 'texto')
  useEffect(() => {
    if (readsLive) readStale(config.providers.filter(provider => config.models.some(model => model.pid === provider.id)))
  }, [config, readsLive, readStale])
  const fallback = uidFor(config, use) ?? ''
  const chosen = pick ?? fallback
  const options = config.models.filter(model => model.uid === chosen || compatible(mediaOfModel(config, live, probes, model.uid), needs)).map(model => model.uid)
  const video = media && use !== 'transcricao' ? uidFor(config, 'midia') : undefined
  const model = videoWrites && video ? video : modelByUid(config, chosen) ? chosen : ''
  return { use, pick: chosen, setPick, touched: pick !== null, video, videoWrites: Boolean(videoWrites && video), setVideoWrites, model, options, ready: Boolean(model) || options.length === 0 }
}

/** The selector itself ("Modelo"), always there at generation time; the video option only for media sources. */
export function ModelPick({ choice, label = 'Modelo da IA' }: { choice: ModelChoice; label?: string }) {
  const settings = useLibraryStore(state => state.index.settings)
  const config = useMemo(() => aiConfigOf(settings), [settings])
  const id = useId()
  const name = (uid: string) => {
    const model = modelByUid(config, uid)
    const provider = providerById(config, model?.pid)
    return model ? (provider ? `${model.name} · ${provider.name}` : model.name) : ''
  }
  return (
    <div className="field">
      <label className="lab" htmlFor={id}>
        {label}
      </label>
      <select className="input" id={id} value={choice.videoWrites ? '' : choice.pick} disabled={choice.videoWrites} onChange={event => choice.setPick(event.target.value)}>
        <option value="">{choice.videoWrites ? name(choice.video!) : choice.options.length ? 'escolha um modelo' : 'nenhum modelo: adicione em Configurações › Inteligência artificial'}</option>
        {choice.options.map(uid => (
          <option key={uid} value={uid}>
            {name(uid)}
          </option>
        ))}
      </select>
      {choice.video && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={choice.videoWrites} onChange={event => choice.setVideoWrites(event.target.checked)} />
          {`O modelo de vídeo (${name(choice.video)}) também escreve o documento`}
        </label>
      )}
      {!choice.ready && (
        <span className="faint" role="status" style={{ fontSize: 12.5 }}>
          Sem modelo padrão para {useInfo(choice.use).label}: escolha um aqui.
        </span>
      )}
    </div>
  )
}
