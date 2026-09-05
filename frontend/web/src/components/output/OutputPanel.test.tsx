import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import OutputPanel from './OutputPanel'

// Mock the context hooks
vi.mock('@/context/AppContext', () => ({
  useAppState: vi.fn(),
  useAppDispatch: vi.fn(),
}))

import { useAppState, useAppDispatch } from '@/context/AppContext'

const mockDispatch = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ;(useAppDispatch as Mock).mockReturnValue(mockDispatch)
  // Default: no content, not loading, no error
  ;(useAppState as Mock).mockReturnValue({
    generatedMarkdown: '',
    isLoading: false,
    loadingMessage: '',
    loadingSubMessage: '',
    errorMessage: null,
  })
})

// ── Empty state tests ──

describe('OutputPanel — empty state', () => {
  it('convida a criar conteúdo quando não há nada, sem carregamento nem erro', () => {
    render(<OutputPanel />)
    expect(screen.getByText('O que você quer estudar?')).toBeInTheDocument()
    expect(screen.getByText('Comece de um arquivo, um link ou um tema.')).toBeInTheDocument()
  })

  it('mostra o botão de criar apenas quando recebe a ação', () => {
    const onNewContent = vi.fn()
    const { unmount } = render(<OutputPanel onNewContent={onNewContent} />)
    screen.getByRole('button', { name: 'Novo conteúdo' }).click()
    expect(onNewContent).toHaveBeenCalled()
    unmount()

    render(<OutputPanel />)
    expect(screen.queryByRole('button', { name: 'Novo conteúdo' })).not.toBeInTheDocument()
  })

  it('shows spinner with loading message when isLoading and no content', () => {
    ;(useAppState as Mock).mockReturnValue({
      generatedMarkdown: '',
      isLoading: true,
      loadingMessage: 'Gerando conteúdo...',
      loadingSubMessage: 'Isso pode levar alguns segundos',
      errorMessage: null,
    })
    render(<OutputPanel />)
    expect(screen.getByText('Gerando conteúdo...')).toBeInTheDocument()
    expect(screen.getByText('Isso pode levar alguns segundos')).toBeInTheDocument()
    // Empty state message should NOT appear
    expect(screen.queryByText('O resultado aparecerá aqui após o processamento.')).not.toBeInTheDocument()
  })

  it('shows error when errorMessage is set and no content', () => {
    ;(useAppState as Mock).mockReturnValue({
      generatedMarkdown: '',
      isLoading: false,
      loadingMessage: '',
      loadingSubMessage: '',
      errorMessage: 'Erro ao processar: algo deu errado',
    })
    render(<OutputPanel />)
    expect(screen.getByText('Erro ao processar: algo deu errado')).toBeInTheDocument()
  })
})

// ── Content-always-visible tests ──

describe('OutputPanel — content always visible', () => {
  it('renders content when generatedMarkdown is set (happy path)', () => {
    ;(useAppState as Mock).mockReturnValue({
      generatedMarkdown: '# Hello World\nSome content here.',
      isLoading: false,
      loadingMessage: '',
      loadingSubMessage: '',
      errorMessage: null,
    })
    render(<OutputPanel />)
    // MarkdownViewer renders the content via MDEditor — look for the raw markdown text
    expect(screen.getByText('Hello World')).toBeInTheDocument()
    expect(screen.getByText('Some content here.')).toBeInTheDocument()
  })

  it('renders content even when isLoading is true', () => {
    ;(useAppState as Mock).mockReturnValue({
      generatedMarkdown: '# Content\nStill visible.',
      isLoading: true,
      loadingMessage: 'Processando...',
      loadingSubMessage: '',
      errorMessage: null,
    })
    render(<OutputPanel />)
    // Content is shown
    expect(screen.getByText('Content')).toBeInTheDocument()
    expect(screen.getByText('Still visible.')).toBeInTheDocument()
    // Inline loading banner was removed — NotificationBar handles loading
    expect(screen.queryByText('Processando...')).not.toBeInTheDocument()
  })

  it('renders content even when errorMessage is set', () => {
    ;(useAppState as Mock).mockReturnValue({
      generatedMarkdown: '# Content\nDespite error.',
      isLoading: false,
      loadingMessage: '',
      loadingSubMessage: '',
      errorMessage: 'Algo deu errado',
    })
    render(<OutputPanel />)
    // Content is shown
    expect(screen.getByText('Content')).toBeInTheDocument()
    expect(screen.getByText('Despite error.')).toBeInTheDocument()
    // Error banner is shown at top
    expect(screen.getByText('Algo deu errado')).toBeInTheDocument()
  })

  it('renders content when both isLoading and errorMessage are set simultaneously', () => {
    ;(useAppState as Mock).mockReturnValue({
      generatedMarkdown: '# Content\nStill here.',
      isLoading: true,
      loadingMessage: 'Processando...',
      loadingSubMessage: '',
      errorMessage: 'Algo deu errado',
    })
    render(<OutputPanel />)
    // Content is shown regardless
    expect(screen.getByText('Content')).toBeInTheDocument()
    expect(screen.getByText('Still here.')).toBeInTheDocument()
    // Inline loading banner was removed — only error banner appears
    expect(screen.queryByText('Processando...')).not.toBeInTheDocument()
    expect(screen.getByText('Algo deu errado')).toBeInTheDocument()
  })
})

// ── Error banner dismissible tests ──

describe('OutputPanel — error banner dismissible', () => {
  it('dispatches SET_ERROR null when dismiss button is clicked', async () => {
    const user = userEvent.setup()
    ;(useAppState as Mock).mockReturnValue({
      generatedMarkdown: '# Some content',
      isLoading: false,
      loadingMessage: '',
      loadingSubMessage: '',
      errorMessage: 'Some error message',
    })
    render(<OutputPanel />)

    // The error banner has a close button (X icon)
    const closeButton = screen.getByRole('button')
    await user.click(closeButton)

    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SET_ERROR', payload: null })
  })
})
