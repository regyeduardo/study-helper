import { Icon } from '@/components/ui/Icon'

interface CheckProps {
  on: boolean
  label: string
  onToggle(): void
  round?: boolean
}

export function Check({ on, label, onToggle, round = false }: CheckProps) {
  return (
    <button
      className={`check ${on ? 'on' : ''}`}
      style={round ? { borderRadius: '50%' } : undefined}
      aria-label={label}
      aria-pressed={on}
      onClick={event => {
        event.stopPropagation()
        onToggle()
      }}
    >
      {on && <Icon name="check" />}
    </button>
  )
}
