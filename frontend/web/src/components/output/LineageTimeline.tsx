import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react'
import { api } from '@/api/client'
import type { LineageStep } from '@/types'

interface LineageTimelineProps {
  fileId: string | null
  onOpenFile: (fileId: string, fileName: string) => void
}

export default function LineageTimeline({ fileId, onOpenFile }: LineageTimelineProps) {
  const [steps, setSteps] = useState<LineageStep[]>([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setExpanded(false)

    if (!fileId) {
      setSteps([])
      return
    }

    api
      .getLineage(fileId)
      .then((result) => {
        if (!cancelled) setSteps(result)
      })
      .catch(() => {
        if (!cancelled) setSteps([])
      })

    return () => {
      cancelled = true
    }
  }, [fileId])

  if (steps.length === 0) return null

  const lastParent = steps[steps.length - 1]

  return (
    <div data-testid="lineage-timeline" className="px-4 pt-2">
      <button
        data-testid="lineage-toggle"
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Veio de:</span>
        <span className="text-slate-300">{lastParent.name}</span>
        {steps.length > 1 && !expanded && (
          <span className="text-slate-500">(+{steps.length - 1})</span>
        )}
      </button>

      {expanded && (
        <ol className="mt-2 space-y-1 border-l border-white/10 pl-3">
          {steps.map((step, index) => (
            <li key={step.id} className="flex items-start gap-1.5">
              <CornerDownRight size={12} className="text-slate-600 mt-1 shrink-0" />
              <div className="min-w-0">
                <button
                  onClick={() => onOpenFile(step.id, step.name)}
                  className="text-xs text-violet-300 hover:text-violet-200 transition-colors text-left truncate"
                >
                  {index + 1}. {step.name}
                </button>
                {step.source_excerpt && (
                  <p className="text-[11px] text-slate-500 truncate">“{step.source_excerpt}”</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
