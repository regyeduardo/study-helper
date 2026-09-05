import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SaveFolderSelector from './SaveFolderSelector'

const defaultProps = {
  savedFileId: null,
  savedFileName: null,
  savedFolderId: null,
  savedFolderName: null,
  hasContent: true,
  onSave: vi.fn(),
  onOpenManager: vi.fn(),
  saving: false,
}

describe('SaveFolderSelector — folder name truncation', () => {
  it('shows full folder name when ≤ 25 chars', () => {
    render(
      <SaveFolderSelector
        {...defaultProps}
        savedFileId="file-1"
        savedFolderName="Biologia Celular"
      />,
    )
    expect(screen.getByText('Biologia Celular')).toBeInTheDocument()
  })

  it('truncates folder name when > 25 chars', () => {
    render(
      <SaveFolderSelector
        {...defaultProps}
        savedFileId="file-1"
        savedFolderName="Desenvolvimento Web Avançado"
      />,
    )
    expect(screen.getByText('Desenvolvimento Web…')).toBeInTheDocument()
  })
})
