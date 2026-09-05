import { useState, type ReactNode } from 'react'
import { DockGroup, type DockGroupProps } from './DockGroup'

interface DockItem {
  icon: ReactNode
  label: string
  onClick: () => void
  active?: boolean
  color?: string
  testId?: string
}

interface DockProps {
  items: DockItem[]
  groups?: DockGroupProps[]
  children?: ReactNode
  className?: string
}

export default function Dock({ items, groups, children, className = '' }: DockProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  return (
    <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 ${className}`}>
      <div
        className="flex items-end gap-1 px-3 py-2 rounded-2xl
                   bg-white/5 backdrop-blur-xl border border-white/10
                   shadow-2xl shadow-black/50"
        onMouseLeave={() => setHoveredIndex(null)}
      >
        {items.map((item, i) => (
          <DockIcon
            key={i}
            icon={item.icon}
            label={item.label}
            active={item.active}
            color={item.color}
            testId={item.testId}
            isHovered={hoveredIndex === i}
            onMouseEnter={() => setHoveredIndex(i)}
            onClick={item.onClick}
          />
        ))}
        {groups && groups.length > 0 && (
          <>
            <span className="w-px h-6 bg-white/10 mx-1" />
            {groups.map((group, i) => (
              <DockGroup key={i} {...group} />
            ))}
          </>
        )}
        {children && (
          <>
            <span className="w-px h-6 bg-white/10 mx-1" />
            {children}
          </>
        )}
      </div>
    </div>
  )
}

function DockIcon({
  icon,
  label,
  active,
  color,
  testId,
  isHovered,
  onMouseEnter,
  onClick,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  color?: string
  testId?: string
  isHovered: boolean
  onMouseEnter: () => void
  onClick: () => void
}) {
  const iconColor = color || 'text-white/80'

  return (
    <button
      data-testid={testId}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={`relative flex flex-col items-center justify-center gap-1
                  min-w-11 min-h-11 px-2 py-1
                  rounded-xl transition-all duration-200 ease-out
                  hover:bg-white/10 group ${isHovered ? iconColor : 'text-white/60'}
                  ${active ? iconColor : ''}`}
      style={{
        transform: isHovered ? 'scale(1.2) translateY(-8px)' : 'scale(1) translateY(0)',
      }}
    >
      <span className="text-2xl transition-transform duration-200 flex items-center justify-center">{icon}</span>
      <span
        className="absolute -bottom-6 text-[10px] font-medium text-white/80
                   whitespace-nowrap opacity-0 group-hover:opacity-100
                   transition-opacity duration-200 bg-black/60 px-2 py-0.5
                   rounded-md pointer-events-none"
      >
        {label}
      </span>
      {active && (
        <span className="absolute -bottom-1 w-1 h-1 rounded-full bg-violet-400" />
      )}
    </button>
  )
}
