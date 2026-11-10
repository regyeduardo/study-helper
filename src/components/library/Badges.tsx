import { Link } from 'react-router-dom'

import type { FileMeta, FileType } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { familyCount, motherOf } from '@/lib/family'
import { typeInfo } from '@/lib/file-types'
import { paths } from '@/lib/paths'
import { useLibraryStore } from '@/stores/library'
import '@/styles/family.css'

export function TypeDot({ type }: { type: FileType }) {
  const info = typeInfo(type)
  return <span className={`tdot ${info.tone}`}>{info.label}</span>
}

export function FileIcon({ type }: { type: FileType }) {
  return (
    <span className={`fic2 ${typeInfo(type).tone}`}>
      <Icon name="file" />
    </span>
  )
}

function masteryTone(value: number): string {
  return value < 50 ? 'm-bad' : value < 70 ? 'm-warn' : 'm-ok'
}

export function MasteryMeter({ value }: { value: number | null }) {
  if (value === null) return <span className="meter faint">sem prova</span>
  return (
    <span className={`meter ${masteryTone(value)}`} title={`Domínio ${value}%`}>
      <i style={{ '--v': `${value}%` } as React.CSSProperties} />
      {value}%
    </span>
  )
}

export function Tags({ tags }: { tags: string[] }) {
  return (
    <>
      {tags.map(tag => (
        <span key={tag} className="tag">
          {tag}
        </span>
      ))}
    </>
  )
}

export function PendingBadge({ generating }: { generating?: boolean }) {
  const shared = useLibraryStore(state => Boolean(state.sharedView))
  return <span className="pending">{generating ? 'gerando…' : shared ? 'pendente' : 'pendente · gerar agora'}</span>
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** How many notes and artifacts were born of the item, in any folder: "2 notas · 1 artefato"; nothing without descendants. */
export function FamilyCount({ file }: { file: FileMeta }) {
  const files = useLibraryStore(state => state.files)
  const { notes, artifacts } = familyCount(files, file.id)
  if (!notes && !artifacts) return null
  return <span className="fam-count">{[notes && plural(notes, 'nota', 'notas'), artifacts && plural(artifacts, 'artefato', 'artefatos')].filter(Boolean).join(' · ')}</span>
}

/** "de: <mãe>", a link to the mother note or the entrada; "mãe apagada" when she is in the Lixeira or gone. A row nested under its mother does not need it. */
export function MotherBadge({ file, className = '' }: { file: FileMeta; className?: string }) {
  const files = useLibraryStore(state => state.files)
  const shared = useLibraryStore(state => Boolean(state.sharedView))
  if (!file.parentFileId) return null
  const mother = motherOf(files, file)
  // A shared link carries only part of the library: a mother left out of it was not deleted.
  if (!mother) return shared ? null : <span className={`fam-selo off ${className}`}>mãe apagada</span>
  if (mother.deletedAt) return <span className={`fam-selo off ${className}`}>{`de: ${mother.name} · mãe apagada`}</span>
  return (
    <Link className={`fam-selo ${className}`} to={paths.file(mother.id)} title={mother.name} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      de: {mother.name}
      <span aria-hidden="true"> ↗</span>
    </Link>
  )
}
