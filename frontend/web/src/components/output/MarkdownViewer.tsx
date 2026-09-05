import { Fragment } from 'react'
import MDEditor from '@uiw/react-md-editor'
import MermaidRenderer from '@/components/output/MermaidRenderer'

interface MarkdownViewerProps {
  markdown: string
}

interface MarkdownSegment {
  type: 'markdown' | 'mermaid'
  content: string
}

/**
 * Split markdown string into segments of regular markdown and mermaid code blocks.
 * Each ```mermaid ... ``` block becomes a mermaid segment.
 * Everything else becomes a markdown segment.
 */
export function splitMarkdown(source: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  const mermaidRE = /```mermaid\r?\n([\s\S]*?)```/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = mermaidRE.exec(source)) !== null) {
    // Markdown before this mermaid block
    const before = source.slice(lastIndex, match.index)
    if (before.trim()) {
      segments.push({ type: 'markdown', content: before })
    }

    // RAW code — DO NOT format, DO NOT trim
    const code = match[1]
    if (code) {
      segments.push({ type: 'mermaid', content: code })
    }

    lastIndex = match.index + match[0].length
  }

  // Remaining markdown after last mermaid block
  const after = source.slice(lastIndex)
  if (after.trim()) {
    segments.push({ type: 'markdown', content: after })
  }

  return segments
}

/**
 * MarkdownViewer — renders markdown content using @uiw/react-md-editor.
 * Mermaid code blocks are extracted BEFORE rendering and replaced with
 * interactive SVG diagrams via MermaidRenderer.
 *
 * Styled with a custom theme in index.css that blends with the app's
 * #0a0a0f background + violet/cyan accent design.
 */
export default function MarkdownViewer({ markdown }: MarkdownViewerProps) {
  const segments = splitMarkdown(markdown)

  const wrapperClass = 'wmde-markdown-var text-[15px] leading-relaxed'

  // If there are no mermaid blocks, just render the full markdown directly
  if (!segments.some(s => s.type === 'mermaid')) {
    return (
      <div data-color-mode="dark" className={wrapperClass}>
        <MDEditor.Markdown source={markdown} />
      </div>
    )
  }

  // Mixed content: render each segment
  return (
    <div data-color-mode="dark" className={wrapperClass}>
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {seg.type === 'markdown' ? (
            <MDEditor.Markdown source={seg.content} />
          ) : (
            <MermaidRenderer code={seg.content} />
          )}
        </Fragment>
      ))}
    </div>
  )
}
