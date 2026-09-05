import { Loader2 } from 'lucide-react'
import MDEditor from '@uiw/react-md-editor'
import MermaidRenderer from '@/components/output/MermaidRenderer'
import type { SSELessonState } from '@/hooks/useSSELesson'

interface StreamingLessonViewProps {
  lesson: SSELessonState
  /** Name of the agent running, so the banner does not always say "Aula". */
  agentLabel?: string
}

/**
 * DiagramPlaceholder regex — matches <!-- diagram:N --> comments.
 * N is the diagram slot index.
 */
const DIAGRAM_PLACEHOLDER_RE = /<!--\s*diagram:\s*(\d+)\s*-->/g

/**
 * StreamingLessonView — renders lesson text from `phase1_complete` immediately.
 *
 * Diagram slots (`<!-- diagram:N -->`) are rendered as a loading spinner
 * until the corresponding `diagram_ready`/`diagram_fallback` event arrives,
 * then replaced in-place without full re-render of lesson text.
 *
 * Uses a stable list-based approach: splits the lesson text into segments
 * around diagram placeholders, and renders each segment with a key that
 * only changes when the diagram resolves.
 */
export default function StreamingLessonView({ lesson, agentLabel = 'Aula' }: StreamingLessonViewProps) {
  if (!lesson.lessonText) {
    return (
      <div data-testid="streaming-lesson-skeleton" className="text-center py-12 text-slate-500">
        <Loader2 size={24} className="text-violet-400 animate-spin mx-auto mb-3" />
        <p className="text-sm text-slate-400">Aguardando conteúdo da aula...</p>
      </div>
    )
  }

  // Split text into segments around diagram placeholders
  const segments: Array<{ type: 'text'; content: string } | { type: 'diagram'; index: number }> = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  DIAGRAM_PLACEHOLDER_RE.lastIndex = 0

  while ((match = DIAGRAM_PLACEHOLDER_RE.exec(lesson.lessonText)) !== null) {
    // Text before this placeholder
    const before = lesson.lessonText.slice(lastIndex, match.index)
    if (before) {
      segments.push({ type: 'text', content: before })
    }

    // Diagram slot
    const diagramIndex = parseInt(match[1], 10)
    segments.push({ type: 'diagram', index: diagramIndex })

    lastIndex = match.index + match[0].length
  }

  // Remaining text after last placeholder
  const after = lesson.lessonText.slice(lastIndex)
  if (after) {
    segments.push({ type: 'text', content: after })
  }

  // Build renderable items with stable keys
  // Text segments use a content-hash-like key based on their position,
  // diagram segments use `diagram-<index>` which is stable across renders.
  // When a diagram resolves, only that segment re-renders (in-place replacement).
  const items = segments.map((seg, i) => {
    if (seg.type === 'text') {
      return (
        <div key={`text-${i}`} className="inline">
          <MDEditor.Markdown source={seg.content} />
        </div>
      )
    }

    // Diagram slot
    const resolved = lesson.diagrams[seg.index]
    if (!resolved) {
      return (
        <div key={`diagram-${seg.index}`} className="flex items-center gap-2 my-3 py-3 px-4 rounded-lg bg-white/5 border border-white/10">
          <Loader2 size={16} className="text-cyan-400 animate-spin shrink-0" />
          <span className="text-xs text-slate-400">
            Gerando diagrama {seg.index + 1}...
          </span>
        </div>
      )
    }

    // Resolved diagram: render as MermaidRenderer (mermaid) or MDEditor.Markdown (table fallback)
    return (
      <div key={`diagram-${seg.index}`} className="my-3">
        {resolved.startsWith('|') ? (
          <div data-color-mode="dark" className="wmde-markdown-var text-[15px] leading-relaxed">
            <MDEditor.Markdown source={resolved} />
          </div>
        ) : (
          <MermaidRenderer code={resolved} />
        )}
      </div>
    )
  })

  return (
    <div className="relative">
      {/* Streaming indicator */}
      {!lesson.complete && (
        <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-2 mb-2 rounded-lg bg-violet-500/10 border border-violet-500/20">
          <Loader2 size={14} className="text-violet-400 animate-spin shrink-0" />
          <span className="text-xs text-violet-300">
            {lesson.lessonText && !lesson.complete
              ? `${agentLabel} sendo gerada — conteúdo parcial pode aparecer abaixo`
              : `Gerando ${agentLabel.toLowerCase()}...`}
          </span>
        </div>
      )}

      {/* Error banner */}
      {lesson.error && (
        <div className="flex items-start gap-2 px-3 py-2 mb-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <span className="text-xs text-red-300 flex-1">{lesson.error}</span>
        </div>
      )}

      {/* Rendered content */}
      {items.length > 0 ? (
        <div data-color-mode="dark" className="wmde-markdown-var text-[15px] leading-relaxed">
          {items}
        </div>
      ) : null}

      {/* Completion banner */}
      {lesson.complete && items.length > 0 && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <p className="text-xs text-emerald-300 font-medium">
            ✅ Aula gerada com sucesso — salve usando o botão na dock
          </p>
        </div>
      )}
    </div>
  )
}
