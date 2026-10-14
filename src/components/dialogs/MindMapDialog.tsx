import { useEffect, useState } from 'react'

import type { MindNode } from '@/types/domain'
import { noteText } from '@/components/dialogs/CardsDialog'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { generateMindmap } from '@/lib/generation/mindmap'
import { GenerationSession } from '@/lib/generation/session'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

function Branch({ node }: { node: MindNode }) {
  return (
    <li>
      <span className="mm-node">{node.title}</span>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child, index) => (
            <Branch key={index} node={child} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function MindMapView({ map }: { map: MindNode }) {
  return (
    <div className="mindmap" role="tree" aria-label="Mapa mental">
      <div className="mm-center">{map.title}</div>
      <ul className="mm-branches">
        {map.children.map((branch, index) => (
          <Branch key={index} node={branch} />
        ))}
      </ul>
    </div>
  )
}

export function MindMapDialog({ fileId }: { fileId: string }) {
  const close = useUiStore(state => state.close)
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const settings = useLibraryStore(state => state.index.settings.ai)
  const [map, setMap] = useState<MindNode | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void useLibraryStore
      .getState()
      .openFile(fileId)
      .then(({ sidecar }) => setMap(sidecar.mindmap ?? null))
  }, [fileId])

  const make = async () => {
    setBusy(true)
    setError('')
    try {
      const made = await generateMindmap(await noteText(fileId), new GenerationSession(settings))
      if (!made) throw new Error('A IA não devolveu um mapa. Tente de novo.')
      await useLibraryStore.getState().updateSidecar(fileId, sidecar => ({ ...sidecar, mindmap: made }))
      await useLibraryStore.getState().updateFile(fileId, { hasMindmap: true })
      setMap(made)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={`Mapa mental${meta ? `: ${meta.name}` : ''}`} onClose={close}>
      <div className="db">
        {error && <div className="banner">{error}</div>}
        {busy ? (
          <div className="reader-live" role="status">
            <Icon name="sync" className="spinning" />
            <span>Desenhando o mapa da nota…</span>
          </div>
        ) : map === undefined ? (
          <div className="muted">Abrindo…</div>
        ) : map ? (
          <>
            <MindMapView map={map} />
            <button className="btn quiet" onClick={() => void make()}>
              Fazer o mapa de novo
            </button>
          </>
        ) : (
          <div className="cards-empty">
            <p>Esta nota ainda não tem mapa mental.</p>
            <button className="btn primary" onClick={() => void make()}>
              Fazer o mapa mental
            </button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
