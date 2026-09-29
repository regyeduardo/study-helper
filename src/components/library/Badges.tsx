import type { FileType } from '@/types/domain'
import { Icon } from '@/components/ui/Icon'
import { typeInfo } from '@/lib/file-types'
import { useLibraryStore } from '@/stores/library'

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
