// "O que vai no link" de uma entrada (FR-066): a árvore da família com uma caixa por item.
import { type ReactNode, useId } from 'react'

import type { ArtifactKind } from '@/types/domain'
import { TypeDot } from '@/components/library/Badges'
import { Icon, type IconName } from '@/components/ui/Icon'
import { MEDIA_KEY, type ShareTreeNote } from '@/lib/share-entry'
import '@/styles/share-entry.css'

const ARTIFACT: Record<ArtifactKind, { icon: IconName; label: string }> = {
  mapa: { icon: 'layers', label: 'Mapa' },
  cartoes: { icon: 'text', label: 'Cartões' },
  tutor: { icon: 'bulb', label: 'Tutor' },
}

export interface EntryShareMedia {
  icon: IconName
  /** "vídeo de 1 h 08" */
  detail: string
  size: string
}

interface RowProps {
  name: string
  checked: boolean
  onToggle(): void
  icon: IconName
  detail?: string
  side?: ReactNode
  artifact?: boolean
}

function Row({ name, checked, onToggle, icon, detail, side, artifact = false }: RowProps) {
  return (
    <label className={`sh-row${artifact ? ' sh-art' : ''}${checked ? '' : ' sh-off'}`}>
      <input className="sh-box" type="checkbox" aria-label={name} checked={checked} onChange={onToggle} />
      <Icon name={icon} />
      <span className="sh-name">
        <span className="sh-title">{name}</span>
        {detail && <span className="sh-detail"> · {detail}</span>}
      </span>
      {side && <span className="sh-side">{side}</span>}
    </label>
  )
}

function Note({ node, chosen, onToggle }: { node: ShareTreeNote; chosen: Set<string>; onToggle(key: string): void }) {
  const inside = node.artifacts.length > 0 || node.children.length > 0
  return (
    <li>
      <Row name={node.file.name} icon="file" checked={chosen.has(node.key)} onToggle={() => onToggle(node.key)} side={<TypeDot type={node.file.type} />} />
      {inside && (
        <ul className="sh-kids">
          {node.artifacts.map(artifact => (
            <li key={artifact.key}>
              <Row name={artifact.name} icon={ARTIFACT[artifact.kind].icon} artifact checked={chosen.has(artifact.key)} onToggle={() => onToggle(artifact.key)} side={ARTIFACT[artifact.kind].label} />
            </li>
          ))}
          {node.children.map(child => (
            <Note key={child.key} node={child} chosen={chosen} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  )
}

interface EntryShareTreeProps {
  tree: ShareTreeNote[]
  chosen: Set<string>
  onToggle(key: string): void
  media: EntryShareMedia | null
  transcribed: boolean
}

export function EntryShareTree({ tree, chosen, onToggle, media, transcribed }: EntryShareTreeProps) {
  const title = useId()
  const sources = Boolean(media || transcribed)
  // the rule only matters when some note has something under it
  const nested = tree.some(node => node.children.length > 0 || node.artifacts.length > 0)
  return (
    <div className="sh-field">
      <div className="sh-head">
        <span className="sh-lab" id={title}>
          O que vai no link
        </span>
        {nested && <span className="sh-hint">Desmarcar uma nota tira as filhas e os artefatos dela</span>}
      </div>
      <div className="sh-tree" role="group" aria-labelledby={title}>
        {sources && (
          <div className={`sh-sources${tree.length ? ' sh-split' : ''}`}>
            {media && <Row name="Mídia" icon={media.icon} detail={media.detail} checked={chosen.has(MEDIA_KEY)} onToggle={() => onToggle(MEDIA_KEY)} side={media.size} />}
            {transcribed && (
              <div className="sh-row sh-always">
                <span className="sh-nobox" />
                <Icon name="mic" />
                <span className="sh-name">
                  <span className="sh-title">Transcrição</span>
                  <span className="sh-detail"> · vai sempre</span>
                </span>
              </div>
            )}
          </div>
        )}
        {tree.length > 0 ? (
          <ul className="sh-notes">
            {tree.map(node => (
              <Note key={node.key} node={node} chosen={chosen} onToggle={onToggle} />
            ))}
          </ul>
        ) : (
          !sources && <p className="sh-empty">Vai só a entrada: nada nasceu dela ainda.</p>
        )}
      </div>
    </div>
  )
}
