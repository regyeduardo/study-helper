import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import StreamingLessonView from './StreamingLessonView'

// Mock MDEditor.Markdown to render plain text (avoids full markdown parsing in test env)
vi.mock('@uiw/react-md-editor', () => ({
  default: {
    Markdown: ({ source }: { source: string }) => (
      <div data-testid="markdown-content" data-source={source}>{source}</div>
    ),
  },
}))

// Mock MermaidRenderer to avoid depending on mermaid.js in tests
vi.mock('@/components/output/MermaidRenderer', () => ({
  default: ({ code }: { code: string }) => (
    <div data-testid="mermaid-renderer" data-code={code} />
  ),
}))

function createLessonState(overrides: Partial<ReturnType<typeof import('@/hooks/useSSELesson').useSSELesson>> = {}) {
  return {
    lessonText: '',
    originalTitle: '',
    originalDescription: '',
    diagrams: {},
    finalMarkdown: '',
    suggestion: null,
    complete: false,
    tempFileId: null,
    error: null,
    connecting: false,
    active: false,
    start: vi.fn(),
    abort: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  }
}

describe('StreamingLessonView', () => {
  it('shows waiting message when no lesson text yet', () => {
    const lesson = createLessonState({ lessonText: '' })
    render(<StreamingLessonView lesson={lesson} />)
    expect(screen.getByText('Aguardando conteúdo da aula...')).toBeInTheDocument()
  })

  it('shows lesson text immediately after phase1_complete', () => {
    const lesson = createLessonState({
      lessonText: '# Minha Aula\n\nConteúdo da aula aqui.',
    })
    const { container } = render(<StreamingLessonView lesson={lesson} />)
    expect(container.textContent).toContain('# Minha Aula')
    expect(container.textContent).toContain('Conteúdo da aula aqui.')
  })

  it('shows spinner for unresolved diagram slots', () => {
    const lesson = createLessonState({
      lessonText: '# Aula\n\n<!-- diagram:0 -->\n\nTexto após diagrama.',
    })
    render(<StreamingLessonView lesson={lesson} />)
    expect(screen.getByText(/Gerando diagrama 1/)).toBeInTheDocument()
  })

  it('replaces spinner with diagram content on diagram_ready', () => {
    const lesson = createLessonState({
      lessonText: '# Aula\n\n<!-- diagram:0 -->',
      diagrams: { 0: 'graph TD\nA-->B' },
    })
    render(<StreamingLessonView lesson={lesson} />)
    expect(screen.queryByText(/Gerando diagrama/)).not.toBeInTheDocument()
    expect(screen.getByTestId('mermaid-renderer')).toBeInTheDocument()
    expect(screen.getByTestId('mermaid-renderer')).toHaveAttribute(
      'data-code',
      'graph TD\nA-->B',
    )
  })

  it('shows multiple diagram slots with independent resolution', () => {
    const lesson = createLessonState({
      lessonText: '# Aula\n\n<!-- diagram:0 -->\n\n<!-- diagram:1 -->',
      diagrams: { 0: 'graph TD\nA-->B' },
    })
    render(<StreamingLessonView lesson={lesson} />)
    // Diagram 0 (index 0) is resolved — spinner for "diagrama 1" should NOT exist
    expect(screen.queryByText(/Gerando diagrama 1/)).not.toBeInTheDocument()
    // Diagram 1 (index 1) is unresolved — spinner shows "diagrama 2"
    expect(screen.getByText(/Gerando diagrama 2/)).toBeInTheDocument()
  })

  it('shows streaming indicator when not complete', () => {
    const lesson = createLessonState({
      lessonText: '# Aula',
      complete: false,
    })
    render(<StreamingLessonView lesson={lesson} />)
    expect(screen.getByText(/Aula sendo gerada/)).toBeInTheDocument()
  })

  it('shows completion indicator when complete', () => {
    const lesson = createLessonState({
      lessonText: '# Aula finalizada',
      complete: true,
    })
    render(<StreamingLessonView lesson={lesson} />)
    expect(screen.getByText(/Aula gerada com sucesso/)).toBeInTheDocument()
  })

  it('shows error banner when error is present', () => {
    const lesson = createLessonState({
      lessonText: '# Aula',
      error: 'Erro de conexão',
    })
    render(<StreamingLessonView lesson={lesson} />)
    expect(screen.getByText('Erro de conexão')).toBeInTheDocument()
  })

  // ── New tests for mermaid-slots + banner + button removal ──

  it('renders MermaidRenderer for resolved mermaid diagram slots', () => {
    const lesson = createLessonState({
      lessonText: '# Aula\n\n<!-- diagram:0 -->',
      diagrams: { 0: 'graph TD\nA-->B' },
    })
    render(<StreamingLessonView lesson={lesson} />)
    // The slot should contain MermaidRenderer, not a mermaid code block
    expect(screen.getByTestId('mermaid-renderer')).toBeInTheDocument()
    expect(screen.getByTestId('mermaid-renderer')).toHaveAttribute(
      'data-code',
      'graph TD\nA-->B',
    )
    // No mermaid code fence should appear
    expect(screen.queryByText(/```mermaid/)).not.toBeInTheDocument()
  })

  it('renders MDEditor.Markdown for table-fallback diagram slots', () => {
    const lesson = createLessonState({
      lessonText: '# Aula\n\n<!-- diagram:0 -->',
      diagrams: { 0: '| Col1 | Col2 |\n|------|------|' },
    })
    render(<StreamingLessonView lesson={lesson} />)
    // One markdown block for the text segment, another for the table fallback
    const markdownBlocks = screen.getAllByTestId('markdown-content')
    expect(markdownBlocks).toHaveLength(2)
    // The second block is the table fallback
    expect(markdownBlocks[1]).toHaveAttribute(
      'data-source',
      '| Col1 | Col2 |\n|------|------|',
    )
    expect(screen.queryByTestId('mermaid-renderer')).not.toBeInTheDocument()
  })

  it('completion banner references dock button and has green styling', () => {
    const lesson = createLessonState({
      lessonText: '# Aula finalizada',
      complete: true,
    })
    const { container } = render(<StreamingLessonView lesson={lesson} />)
    const banner = container.querySelector('.bg-emerald-500\\/10')
    expect(banner).toBeInTheDocument()
    expect(banner).toHaveClass('border-emerald-500/20')
    expect(screen.getByText(/botão na dock/)).toBeInTheDocument()
  })

  it('does not render "Finalizar e visualizar" button in any state', () => {
    // State: not complete
    const { rerender } = render(
      <StreamingLessonView
        lesson={createLessonState({ lessonText: '# Aula', complete: false })}
      />,
    )
    expect(screen.queryByText(/Finalizar e visualizar/i)).not.toBeInTheDocument()

    // State: complete
    rerender(
      <StreamingLessonView
        lesson={createLessonState({ lessonText: '# Aula finalizada', complete: true })}
      />,
    )
    expect(screen.queryByText(/Finalizar e visualizar/i)).not.toBeInTheDocument()
  })
})
