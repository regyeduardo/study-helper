import { useState } from 'react'

import type { AtaPart } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { PART_LABEL, PART_ORDER } from '@/lib/generation/ata'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

export const toggledPart = (parts: AtaPart[], part: AtaPart): AtaPart[] => (parts.includes(part) ? parts.filter(item => item !== part) : [...parts, part])

/** Checkboxes of the parts that go into the ONE Ata document (Resumo checked by default). */
export function AtaPartsDialog({ fileId }: { fileId: string }) {
  const close = useUiStore(state => state.close)
  const generateAta = useJobsStore(state => state.generateAta)
  const file = useLibraryStore(state => state.files.find(item => item.id === fileId))
  const [parts, setParts] = useState<AtaPart[]>(['resumo'])
  const toggle = (part: AtaPart) => setParts(current => toggledPart(current, part))
  const start = () => {
    if (!parts.length) return
    close()
    void generateAta(fileId, PART_ORDER.filter(part => parts.includes(part)))
  }
  return (
    <Dialog
      title="Gerar a Ata"
      size="narrow"
      onClose={close}
      footer={
        <>
          <button className="btn quiet" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!parts.length} onClick={start}>
            Gerar
          </button>
        </>
      }
    >
      <div className="db">
        <p className="muted" style={{ marginTop: 0 }}>
          Marque o que entra na ata{file ? ` de "${file.name}"` : ''}. Sai um documento só, com as partes nesta ordem.
        </p>
        <AtaPartsFields parts={parts} onToggle={toggle} />
      </div>
    </Dialog>
  )
}

export function AtaPartsFields({ parts, onToggle }: { parts: AtaPart[]; onToggle(part: AtaPart): void }) {
  return (
    <>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend className="lab">Partes da ata</legend>
        {PART_ORDER.map(part => (
          <label key={part} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={parts.includes(part)} onChange={() => onToggle(part)} />
            {PART_LABEL[part]}
          </label>
        ))}
      </fieldset>
      {!parts.length && (
        <p className="faint" role="status" style={{ fontSize: 13 }}>
          Marque ao menos uma parte.
        </p>
      )}
    </>
  )
}
