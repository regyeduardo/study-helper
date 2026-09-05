import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LineageTimeline from './LineageTimeline'

const getLineage = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  api: { getLineage },
}))

const chain = [
  { id: 'file-1', name: 'Aula de Python', type: 'class', source_excerpt: 'trecho da aula' },
  { id: 'file-2', name: 'Explicação de decorators', type: 'explanation', source_excerpt: 'trecho da explicação' },
]

describe('LineageTimeline', () => {
  beforeEach(() => {
    getLineage.mockReset()
  })

  it('renders nothing when the file has no parents', async () => {
    getLineage.mockResolvedValue([])
    const { container } = render(<LineageTimeline fileId="file-3" onOpenFile={vi.fn()} />)

    await waitFor(() => expect(getLineage).toHaveBeenCalledWith('file-3'))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when there is no open file', () => {
    const { container } = render(<LineageTimeline fileId={null} onOpenFile={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(getLineage).not.toHaveBeenCalled()
  })

  it('shows only the last parent when collapsed', async () => {
    getLineage.mockResolvedValue(chain)
    render(<LineageTimeline fileId="file-3" onOpenFile={vi.fn()} />)

    expect(await screen.findByText('Explicação de decorators')).toBeInTheDocument()
    expect(screen.queryByText('1. Aula de Python')).not.toBeInTheDocument()
    expect(screen.getByText('(+1)')).toBeInTheDocument()
  })

  it('shows the whole chain when expanded', async () => {
    const user = userEvent.setup()
    getLineage.mockResolvedValue(chain)
    render(<LineageTimeline fileId="file-3" onOpenFile={vi.fn()} />)

    await user.click(await screen.findByTestId('lineage-toggle'))

    expect(screen.getByText('1. Aula de Python')).toBeInTheDocument()
    expect(screen.getByText('2. Explicação de decorators')).toBeInTheDocument()
    expect(screen.getByText('“trecho da aula”')).toBeInTheDocument()
  })

  it('opens the parent file when a step is clicked', async () => {
    const user = userEvent.setup()
    const onOpenFile = vi.fn()
    getLineage.mockResolvedValue(chain)
    render(<LineageTimeline fileId="file-3" onOpenFile={onOpenFile} />)

    await user.click(await screen.findByTestId('lineage-toggle'))
    await user.click(screen.getByText('1. Aula de Python'))

    expect(onOpenFile).toHaveBeenCalledWith('file-1', 'Aula de Python')
  })

  it('stays silent when the lineage request fails', async () => {
    getLineage.mockRejectedValue(new Error('boom'))
    const { container } = render(<LineageTimeline fileId="file-3" onOpenFile={vi.fn()} />)

    await waitFor(() => expect(getLineage).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
