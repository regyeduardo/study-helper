import { useState } from 'react'

import type { AtaPart } from '@/types/domain'
import { Dialog } from '@/components/ui/Dialog'
import { PART_LABEL, PART_ORDER } from '@/lib/generation/ata'
import { useJobsStore } from '@/stores/jobs'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

/** Checkboxes of the parts that go into the ONE Ata document (Resumo checked by default). */
export function AtaPartsDialog({ fileId }: { fileId: string }) {
  const close = useUiStore(state => state.close)
  const generateAta = useJobsStore(state => state.generateAta)
  const file = useLibraryStore(state => state.files.find(item => item.id === fileId))
  const [parts, setParts] = useState<AtaPart[]>(['resumo'])
  const toggle = (part: AtaPart) => setParts(current => (current.includes(part) ? current.filter(item => item !== part) : [...current, part]))
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
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          <legend className="lab">Partes da ata</legend>
          {PART_ORDER.map(part => (
            <label key={part} style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={parts.includes(part)} onChange={() => toggle(part)} />
              {PART_LABEL[part]}
            </label>
          ))}
        </fieldset>
        {!parts.length && (
          <p className="faint" role="status" style={{ fontSize: 13 }}>
            Marque ao menos uma parte.
          </p>
        )}
      </div>
    </Dialog>
  )
}
