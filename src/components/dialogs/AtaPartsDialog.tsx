import { useId, useState } from 'react'

import type { AtaModelId, AtaPart } from '@/types/domain'
import { FolderWindow, lastModel, madeLine, MoreOptions, ReplaceOrNew, SaveIn, useNoteFolder } from '@/components/dialogs/FromNoteFields'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { Dialog } from '@/components/ui/Dialog'
import { mediaOf } from '@/lib/file-types'
import { ATA_MODELS, PART_LABEL, PART_ORDER } from '@/lib/generation/ata'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export const toggledPart = (parts: AtaPart[], part: AtaPart): AtaPart[] => (parts.includes(part) ? parts.filter(item => item !== part) : [...parts, part])

/**
 * "Modelo da ata" (Padrão = the parts) and the checkboxes of the parts that go into the ONE Ata document (Resumo checked by default).
 * The Ata is a note of its own; `again`: the Ata note made before, whose choices and instruction come back (Gerar de novo).
 */
export function AtaPartsDialog({ fileId, again }: { fileId: string; again?: string }) {
  const close = useUiStore(state => state.close)
  const generateAta = useJobsStore(state => state.generateAta)
  const file = useLibraryStore(state => state.files.find(item => item.id === fileId))
  const before = useLibraryStore(state => state.files.find(item => item.id === again))
  const settings = useLibraryStore(state => state.index.settings)
  const [parts, setParts] = useState<AtaPart[]>(before?.made?.parts ?? ['resumo'])
  const [model, setModel] = useState<AtaModelId | null>(before?.made?.ataModel ?? null)
  const choice = useModelChoice('ata', Boolean(file) && mediaOf(file!) !== 'text', lastModel(before, settings))
  const folder = useNoteFolder(fileId)
  const [replace, setReplace] = useState(Boolean(before))
  const [instruction, setInstruction] = useState(before?.made?.instruction ?? '')
  const toggle = (part: AtaPart) => setParts(current => toggledPart(current, part))
  const ready = (Boolean(model) || parts.length > 0) && choice.ready
  const start = () => {
    if (!ready) return
    close()
    const ai = { model: choice.model || null, everyStep: choice.videoWrites }
    const place = replace && before ? { replace: before.id } : folder.place
    // the instruction goes only when there is one
    const said = instruction.trim() ? ([instruction] as const) : []
    if (model) void generateAta(fileId, [], model, ai, place, ...said)
    else void generateAta(fileId, PART_ORDER.filter(part => parts.includes(part)), undefined, ai, place, ...said)
  }
  return (
    <>
      <Dialog
        title={before ? 'Gerar de novo a Ata' : 'Gerar a Ata'}
        size="narrow"
        onClose={folder.open ? undefined : close}
        footer={
          <>
            <button className="btn quiet" onClick={close}>
              Cancelar
            </button>
            <button className="btn primary" disabled={!ready} onClick={start}>
              Gerar
            </button>
          </>
        }
      >
        <div className="db">
          <p className="muted" style={{ marginTop: 0 }}>
            {model ? `Sai um documento só${file ? ` de "${file.name}"` : ''}, no esqueleto do modelo ${ATA_MODELS[model].name}.` : `Marque o que entra na ata${file ? ` de "${file.name}"` : ''}. Sai um documento só, com as partes nesta ordem.`}
          </p>
          {before && (
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              {`Da última vez: ${madeLine(before, settings)}`}
            </p>
          )}
          <AtaPartsFields parts={parts} onToggle={toggle} model={model} onModel={setModel} />
          <ModelPick choice={choice} />
          {before && <ReplaceOrNew replace={replace} onReplace={choice => (setReplace(choice), choice || folder.setOpen(true))} />}
          {!replace && <SaveIn folder={folder} />}
          <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder="Ex.: foque nas decisões e nas tarefas" open={Boolean(before?.made?.instruction)} />
        </div>
      </Dialog>
      {folder.open && <FolderWindow folder={folder} noteName={`Ata: ${file?.name ?? ''}`} />}
    </>
  )
}

/** A model hides the parts: the Ata comes out in that model's skeleton. */
export function AtaPartsFields({ parts, onToggle, model, onModel }: { parts: AtaPart[]; onToggle(part: AtaPart): void; model: AtaModelId | null; onModel(model: AtaModelId | null): void }) {
  const id = useId()
  return (
    <>
      <div className="field">
        <label className="lab" htmlFor={id}>
          Modelo da ata
        </label>
        <select className="input" id={id} value={model ?? ''} onChange={event => onModel((event.target.value || null) as AtaModelId | null)}>
          <option value="">Padrão</option>
          {(Object.keys(ATA_MODELS) as AtaModelId[]).map(key => (
            <option key={key} value={key}>
              {ATA_MODELS[key].name}
            </option>
          ))}
        </select>
      </div>
      {!model && (
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          <legend className="lab">Partes da ata</legend>
          {PART_ORDER.map(part => (
            <label key={part} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={parts.includes(part)} onChange={() => onToggle(part)} />
              {PART_LABEL[part]}
            </label>
          ))}
        </fieldset>
      )}
      {!model && !parts.length && (
        <p className="faint" role="status" style={{ fontSize: 13 }}>
          Marque ao menos uma parte.
        </p>
      )}
    </>
  )
}
