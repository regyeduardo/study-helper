import type { ReactNode } from 'react'

interface CardProps {
  title: string
  badge?: string
  badgeColor?: string
  children: ReactNode
  className?: string
}

export default function Card({ title, badge, badgeColor = 'bg-violet-600', children, className = '' }: CardProps) {
  return (
    <div className={`bg-white/5 backdrop-blur-xl rounded-2xl border border-white/10 shadow-xl ${className}`}>
      <div className="p-5">
        {title && (
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            {badge && (
              <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${badgeColor} text-white`}>
                {badge}
              </span>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
