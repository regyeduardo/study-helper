import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExplainFromLessonModal } from './ExplainFromLessonModal'

const baseProps = {
  lessonName: 'Aula de Biologia',
  lessonFileId: 'file-123',
  onSubmit: vi.fn(),
  onClose: vi.fn(),
}

describe('ExplainFromLessonModal', () => {
  it('renders lesson name as context', () => {
    render(<ExplainFromLessonModal {...baseProps} />)
    expect(screen.getByText(/Aula de Biologia/)).toBeInTheDocument()
  })

  it('renders optional focus textarea', () => {
    render(<ExplainFromLessonModal {...baseProps} />)
    expect(screen.getByLabelText(/O que você quer explicado melhor/i)).toBeInTheDocument()
  })

  it('calls onClose when Cancelar is clicked', async () => {
    const user = userEvent.setup()
    render(<ExplainFromLessonModal {...baseProps} />)
    await user.click(screen.getByRole('button', { name: /Cancelar/i }))
    expect(baseProps.onClose).toHaveBeenCalledOnce()
  })

  it('submits with empty focus when textarea is blank', async () => {
    const user = userEvent.setup()
    render(<ExplainFromLessonModal {...baseProps} />)
    await user.click(screen.getByRole('button', { name: /Gerar Explicação/i }))
    expect(baseProps.onSubmit).toHaveBeenCalledWith({ fileId: 'file-123', focus: '' })
  })

  it('submits with focus text when textarea is filled', async () => {
    const user = userEvent.setup()
    render(<ExplainFromLessonModal {...baseProps} />)
    await user.type(screen.getByLabelText(/O que você quer explicado melhor/i), 'Explique a mitose')
    await user.click(screen.getByRole('button', { name: /Gerar Explicação/i }))
    expect(baseProps.onSubmit).toHaveBeenCalledWith({ fileId: 'file-123', focus: 'Explique a mitose' })
  })
})
