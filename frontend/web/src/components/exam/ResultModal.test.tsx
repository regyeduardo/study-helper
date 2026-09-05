import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// Mock MermaidRenderer BEFORE imports so it's available for the component
vi.mock('@/components/output/MermaidRenderer', () => ({
  default: vi.fn(() => <div data-testid="mermaid-renderer">MermaidRenderer</div>),
}))

import MermaidRenderer from '@/components/output/MermaidRenderer'
import ResultModal from './ResultModal'

// Mock the context hooks
vi.mock('@/context/AppContext', () => ({
  useAppState: vi.fn(),
  useAppDispatch: vi.fn(),
}))

import { useAppState } from '@/context/AppContext'

const baseState = {
  generatedMarkdown: '',
  questionsData: {
    questions: [
      {
        id: 1,
        enunciado: 'What does this diagram represent?',
        alternativas: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D', E: 'Option E' },
        correta: 'A',
        explicacao: 'Because A is correct.',
        diagrama: 'graph TD\n  A-->B',
      },
    ],
  },
  userAnswers: { 1: 'A' },
  currentQuestionIndex: 0,
  isLoading: false,
  loadingMessage: '',
  loadingSubMessage: '',
  errorMessage: null,
  savedFileId: null,
  savedFileName: null,
  savedFolderId: null,
  savedFolderName: null,
  lastOpenedFolderId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(useAppState as Mock).mockReturnValue(baseState)
})

describe('ResultModal — diagram rendering', () => {
  it('renders MermaidRenderer with the diagram code prop', () => {
    render(<ResultModal onClose={() => {}} />)

    // MermaidRenderer should have been rendered
    expect(MermaidRenderer).toHaveBeenCalled()

    // Check it received the correct code prop
    const mockCalls = (MermaidRenderer as Mock).mock.calls
    const lastCallProps = mockCalls[mockCalls.length - 1][0]
    expect(lastCallProps.code).toBe('graph TD\n  A-->B')
  })
})
