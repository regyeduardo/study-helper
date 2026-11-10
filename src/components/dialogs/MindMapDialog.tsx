import { useEffect, useMemo, useState } from 'react'

import type { MapArtifact } from '@/types/domain'
import { noteText } from '@/components/dialogs/CardsDialog'
import { MapChat } from '@/components/dialogs/MapChat'
import { MoreOptions } from '@/components/dialogs/FromNoteFields'
import { ModelPick, useModelChoice } from '@/components/dialogs/ModelPick'
import { MapView } from '@/components/reader/MapView'
import { Dialog } from '@/components/ui/Dialog'
import { Icon } from '@/components/ui/Icon'
import { Popover } from '@/components/ui/Popover'
import { useIsNarrow } from '@/hooks/use-is-narrow'
import { targetFor } from '@/lib/ai/config'
import { artifactsOf, latestOf, newMapArtifact } from '@/lib/artifacts'
import { copyMapCode, downloadMap } from '@/lib/exports/map-export'
import { undo } from '@/lib/generation/map-chat'
import { generateMap } from '@/lib/generation/mindmap'
import { GenerationSession } from '@/lib/generation/session'
import { nowIso } from '@/lib/ids'
import { useLibraryStore } from '@/stores/library'
import { useUiStore } from '@/stores/ui'

type Menu = { kind: 'maps' | 'export' | 'more'; x: number; y: number }

const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))
const isMap = (item: { kind: string }): item is MapArtifact => item.kind === 'mapa'
const dayOf = (at: string) => new Date(at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })

/** The first map of a note: the model and the button. "Gerar de novo" goes to the generate window shared with the decks. */
function FirstMap({ onMake }: { onMake(model: string, instruction: string): void }) {
  const choice = useModelChoice('mapa')
  const [instruction, setInstruction] = useState('')
  return (
    <>
      <ModelPick choice={choice} />
      <MoreOptions instruction={instruction} onInstruction={setInstruction} placeholder="Ex.: só as decisões de preço e prazo" />
      <button className="btn primary" disabled={!choice.ready} onClick={() => onMake(choice.model, instruction)}>
        Fazer o mapa mental
      </button>
    </>
  )
}

function Rename({ name, onDone }: { name: string; onDone(name: string | null): void }) {
  return (
    <input
      className="input map-rename"
      aria-label="Nome do mapa"
      defaultValue={name}
      autoFocus
      onFocus={event => event.currentTarget.select()}
      onBlur={event => onDone(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key === 'Enter') onDone(event.currentTarget.value)
        if (event.key === 'Escape') {
          event.preventDefault()
          onDone(null)
        }
      }}
    />
  )
}

/**
 * The map screen: the drawing in the middle and its conversation on the right (on the phone, a sheet from the bottom).
 * `mapId` opens that map; without it, the one changed last. Opened from a share link it only shows and exports.
 */
export function MindMapDialog({ fileId, mapId }: { fileId: string; mapId?: string }) {
  const close = useUiStore(state => state.close)
  const toast = useUiStore(state => state.toast)
  const meta = useLibraryStore(state => state.files.find(file => file.id === fileId))
  const sidecar = useLibraryStore(state => state.opened[fileId]?.sidecar)
  const settings = useLibraryStore(state => state.index.settings)
  const readOnly = useLibraryStore(state => Boolean(state.sharedView))
  const narrow = useIsNarrow()
  const [currentId, setCurrentId] = useState(mapId)
  const [making, setMaking] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [columnOpen, setColumnOpen] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!sidecar)
      void useLibraryStore
        .getState()
        .openFile(fileId)
        .catch(failure => setError(messageOf(failure)))
  }, [fileId, sidecar])

  const maps = useMemo(() => (sidecar ? artifactsOf(sidecar).filter(isMap) : undefined), [sidecar])
  const map = maps && (maps.find(item => item.id === currentId) ?? latestOf(maps, 'mapa'))

  // The list of the note opens another map in the same screen.
  useEffect(() => {
    if (mapId) setCurrentId(mapId)
  }, [mapId])

  // Once shown, the map stays the one on screen, even when another of the note changes later.
  useEffect(() => {
    if (map && map.id !== currentId) setCurrentId(map.id)
  }, [map, currentId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !renaming && !menu) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, renaming, menu])

  const fail = (failure: unknown) => setError(messageOf(failure))
  const store = () => useLibraryStore.getState()

  const make = async (model: string, instruction: string) => {
    setMaking(true)
    setError('')
    try {
      const said = instruction.trim()
      const made = await generateMap(await noteText(fileId), new GenerationSession(targetFor(settings, 'mapa', model)), said)
      if (!made) throw new Error('A IA não devolveu um mapa. Tente de novo.')
      const artifact = newMapArtifact({ name: made.name, diagram: made.diagram, made: { ...(model ? { model } : {}), ...(said ? { instruction: said } : {}), at: nowIso() } })
      setCurrentId((await store().saveArtifact(fileId, artifact)).id)
    } catch (failure) {
      fail(failure)
    } finally {
      setMaking(false)
    }
  }

  const step = async (work: () => Promise<unknown>) => {
    setSaving(true)
    setError('')
    try {
      await work()
    } catch (failure) {
      fail(failure)
    } finally {
      setSaving(false)
    }
  }

  if (!map) {
    const title = `Mapa mental${meta ? `: ${meta.name}` : ''}`
    return (
      <Dialog title={title} onClose={close}>
        <div className="db">
          {error && <div className="banner">{error}</div>}
          {making ? (
            <div className="reader-live" role="status">
              <Icon name="sync" className="spinning" />
              <span>Desenhando o mapa da nota…</span>
            </div>
          ) : !maps ? (
            <div className="muted">Abrindo…</div>
          ) : readOnly ? (
            <p className="muted">Esta nota não tem mapa mental.</p>
          ) : (
            <div className="cards-empty">
              <p>Esta nota ainda não tem mapa mental.</p>
              <FirstMap onMake={(model, instruction) => void make(model, instruction)} />
            </div>
          )}
        </div>
      </Dialog>
    )
  }

  const undoLast = () => void step(() => store().saveArtifact(fileId, undo(map)))
  const saveAsAnother = () =>
    void step(async () => {
      const copy = newMapArtifact({ name: `${map.name} (cópia)`, diagram: map.diagram, ...(map.made ? { made: map.made } : {}) })
      await store().saveArtifact(fileId, copy)
      toast(`Salvei “${copy.name}” como outro mapa desta nota.`)
    })
  const rename = (name: string | null) => {
    setRenaming(false)
    const said = name?.trim()
    if (said && said !== map.name) void step(() => store().renameArtifact(fileId, map.id, said))
  }
  const exportAs = (format: 'png' | 'svg') => {
    setMenu(null)
    void downloadMap(map, format).catch(fail)
  }
  const copyCode = () => {
    setMenu(null)
    void copyMapCode(map).then(() => toast('Código Mermaid copiado.'), fail)
  }
  const openMenu = (kind: Menu['kind']) => (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ kind, x: rect.left, y: rect.bottom + 4 })
  }
  const pick = (id: string) => {
    setMenu(null)
    setCurrentId(id)
  }
  // The window shared with the decks, with the model and the instruction of the last time; it opens the new map here when done.
  const generateAgain = () => useUiStore.getState().open({ kind: 'generate-artifact', fileId, artifact: 'mapa', again: map.id })

  const many = maps!.length > 1
  const name = renaming ? (
    <Rename name={map.name} onDone={rename} />
  ) : narrow && many ? (
    <button className="map-name-btn" aria-haspopup="menu" aria-label={`${map.name}: Mapas desta nota (${maps!.length})`} onClick={openMenu('maps')}>
      <span className="map-name" title={map.name}>
        {map.name}
      </span>
      <Icon name="chev" />
    </button>
  ) : (
    <h2 className="map-name" title={map.name}>
      {map.name}
    </h2>
  )
  const renameButton = (
    <button className="ibtn" aria-label="Renomear o mapa" title="Renomear o mapa" onClick={() => setRenaming(true)}>
      <Icon name="pen" />
    </button>
  )
  const undoButton = (
    <button className="btn" disabled={!map.versions.length || chatBusy || saving} onClick={undoLast}>
      <Icon name="undo" />
      Desfazer
    </button>
  )
  const saveAsButton = (
    <button className="btn" disabled={saving} onClick={saveAsAnother}>
      Salvar como outro mapa
    </button>
  )

  return (
    <div className="scrim map-scrim" onMouseDown={event => event.target === event.currentTarget && close()}>
      <div className={`dialog map-dialog${narrow ? ' phone' : ''}`} role="dialog" aria-modal="true" aria-label={`Mapa mental: ${map.name}`}>
        {narrow ? (
          <header className="map-head">
            <button className="ibtn" aria-label="Fechar" onClick={close}>
              <Icon name="back" />
            </button>
            {name}
            {!readOnly && renameButton}
            <button className="ibtn" aria-label="Mais ações do mapa" aria-haspopup="menu" onClick={openMenu('more')}>
              <Icon name="dots" />
            </button>
          </header>
        ) : (
          <header className="map-head">
            <span className="map-kind">Mapa mental</span>
            {name}
            {!readOnly && renameButton}
            {many && (
              <button className="btn quiet" aria-haspopup="menu" onClick={openMenu('maps')}>
                Mapas desta nota ({maps!.length})
                <Icon name="chev" />
              </button>
            )}
            <span className="grow" />
            <button className="btn" aria-haspopup="menu" onClick={openMenu('export')}>
              <Icon name="download" />
              Exportar
              <Icon name="chev" />
            </button>
            {!readOnly && (
              <button className="btn" aria-haspopup="dialog" onClick={generateAgain}>
                <Icon name="sync" />
                Gerar de novo…
              </button>
            )}
            <button className="ibtn" aria-label="Fechar" onClick={close}>
              <Icon name="x" />
            </button>
          </header>
        )}
        <div className="map-body">
          <section className="map-main" aria-label="Mapa">
            {error && (
              <div className="banner" role="alert">
                <Icon name="warn" />
                <span>{error}</span>
              </div>
            )}
            <MapView
              diagram={map.diagram}
              highlight={map.highlight}
              tools={
                readOnly ? (
                  meta && !narrow && <span className="map-from faint">de “{meta.name}”</span>
                ) : narrow ? (
                  undoButton
                ) : (
                  <>
                    {undoButton}
                    {saveAsButton}
                    {meta && <span className="map-from faint">de “{meta.name}”</span>}
                  </>
                )
              }
            />
          </section>
          {!readOnly && (
            <MapChat
              key={map.id}
              fileId={fileId}
              map={map}
              layout={narrow ? 'sheet' : 'column'}
              open={narrow ? sheetOpen : columnOpen}
              onToggle={() => (narrow ? setSheetOpen(open => !open) : setColumnOpen(open => !open))}
              onBusy={setChatBusy}
              actions={narrow ? saveAsButton : undefined}
            />
          )}
        </div>
      </div>
      {menu?.kind === 'maps' && (
        <Popover x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="Mapas desta nota">
          <div className="mh">Mapas desta nota</div>
          {maps!.map(item => (
            <button key={item.id} className={`mi${item.id === map.id ? ' on' : ''}`} role="menuitemradio" aria-checked={item.id === map.id} onClick={() => pick(item.id)}>
              <Icon name={item.id === map.id ? 'check' : 'layers'} />
              <span className="map-mi-name">{item.name}</span>
              <span className="mi-hint">{dayOf(item.updatedAt)}</span>
            </button>
          ))}
        </Popover>
      )}
      {(menu?.kind === 'export' || menu?.kind === 'more') && (
        <Popover x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={menu.kind === 'more' ? 'Ações do mapa' : 'Exportar o mapa'}>
          {menu.kind === 'more' && !readOnly && (
            <>
              <button
                className="mi"
                role="menuitem"
                onClick={() => {
                  setMenu(null)
                  saveAsAnother()
                }}
              >
                <Icon name="layers" />
                Salvar como outro mapa
              </button>
              <button
                className="mi"
                role="menuitem"
                onClick={() => {
                  setMenu(null)
                  generateAgain()
                }}
              >
                <Icon name="sync" />
                Gerar de novo…
              </button>
              <div className="sep" />
            </>
          )}
          <button className="mi" role="menuitem" onClick={() => exportAs('png')}>
            <Icon name="download" />
            Baixar PNG
          </button>
          <button className="mi" role="menuitem" onClick={() => exportAs('svg')}>
            <Icon name="download" />
            Baixar SVG
          </button>
          <button className="mi" role="menuitem" onClick={copyCode}>
            <Icon name="text" />
            Copiar código Mermaid
          </button>
        </Popover>
      )}
    </div>
  )
}
