import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import TranscriptionProviderSelector from './TranscriptionProviderSelector'

describe('TranscriptionProviderSelector', () => {
  it('renders both options with correct checked states', () => {
    render(
      <TranscriptionProviderSelector
        value="local"
        onChange={() => {}}
        openaiAvailable={true}
      />
    )

    const localBtn = screen.getByTestId('provider-option-local')
    const openaiBtn = screen.getByTestId('provider-option-openai')

    expect(localBtn).toHaveAttribute('aria-checked', 'true')
    expect(openaiBtn).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Local (Whisper)')).toBeInTheDocument()
    expect(screen.getByText('Nuvem (OpenAI)')).toBeInTheDocument()
  })

  it('calls onChange when clicking OpenAI option', () => {
    const onChange = vi.fn()
    render(
      <TranscriptionProviderSelector
        value="local"
        onChange={onChange}
        openaiAvailable={true}
      />
    )

    fireEvent.click(screen.getByTestId('provider-option-openai'))
    expect(onChange).toHaveBeenCalledWith('openai')
  })

  it('calls onChange when clicking Local option', () => {
    const onChange = vi.fn()
    render(
      <TranscriptionProviderSelector
        value="openai"
        onChange={onChange}
        openaiAvailable={true}
      />
    )

    fireEvent.click(screen.getByTestId('provider-option-local'))
    expect(onChange).toHaveBeenCalledWith('local')
  })

  it('disables OpenAI option when openaiAvailable is false', () => {
    const onChange = vi.fn()
    render(
      <TranscriptionProviderSelector
        value="local"
        onChange={onChange}
        openaiAvailable={false}
      />
    )

    const openaiBtn = screen.getByTestId('provider-option-openai')
    expect(openaiBtn).toBeDisabled()
    expect(screen.getByText(/OPENAI_API_KEY/i)).toBeInTheDocument()

    fireEvent.click(openaiBtn)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('returns null when visible is false', () => {
    const { container } = render(
      <TranscriptionProviderSelector
        value="local"
        onChange={() => {}}
        visible={false}
      />
    )

    expect(container.firstChild).toBeNull()
  })
})
