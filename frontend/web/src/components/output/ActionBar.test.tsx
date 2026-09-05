import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import ActionBar from './ActionBar'

const minimalProps = {
  hasContent: true,
  isViewingStream: false,
  savedFileId: null,
  savedFileName: null,
  savedFolderId: null,
  savedFolderName: null,
  onSaveToFolder: () => {},
  onOpenFileManager: () => {},
}

describe('ActionBar — dropdown removal', () => {
  it('does not render any Ações button', () => {
    render(<ActionBar {...minimalProps} />)
    expect(screen.queryByText(/Ações/i)).not.toBeInTheDocument()
  })

  it('does not accept onDownloadMd prop (type safety)', () => {
    // This is enforced at the TypeScript level — document the intent:
    // @ts-expect-error onDownloadMd should not exist
    render(<ActionBar {...minimalProps} onDownloadMd={() => {}} />)
  })

  it('renders Novo conteúdo button', () => {
    render(<ActionBar {...minimalProps} />)
    expect(screen.getByRole('button', { name: /Novo conteúdo/i })).toBeInTheDocument()
  })

  it('renders SaveFolderSelector', () => {
    render(<ActionBar {...minimalProps} />)
    expect(screen.getByText('Salvar em...')).toBeInTheDocument()
  })
})

describe('ActionBar — isViewingStream=true', () => {
  it('does not render Ações when streaming', () => {
    render(<ActionBar {...minimalProps} isViewingStream={true} />)
    expect(screen.queryByText(/Ações/i)).not.toBeInTheDocument()
  })

  it('hides filename label when isViewingStream is true and savedFileName is set', () => {
    render(<ActionBar {...minimalProps} isViewingStream={true} savedFileName="my-file.md" currentFileName="my-file.md" />)
    expect(screen.queryByText('my-file.md')).not.toBeInTheDocument()
  })
})

describe('ActionBar — isViewingStream=false, hasContent=true', () => {
  it('shows filename label when isViewingStream is false and savedFileName is set', () => {
    render(<ActionBar {...minimalProps} isViewingStream={false} savedFileName="Aula de Biologia" currentFileName="Aula de Biologia" />)
    expect(screen.getByText('Aula de Biologia')).toBeInTheDocument()
  })
})

describe('ActionBar — filename label visibility', () => {
  it('hides filename label when savedFileName is null and isViewingStream is false', () => {
    render(<ActionBar {...minimalProps} savedFileName={null} isViewingStream={false} />)
    // currentFileName is also not passed, so no label
    expect(screen.queryByText('my-file.md')).not.toBeInTheDocument()
  })

  it('hides filename label when isViewingStream is true even with savedFileName set', () => {
    render(<ActionBar {...minimalProps} isViewingStream={true} savedFileName="Algum Nome" currentFileName="Algum Nome" />)
    expect(screen.queryByText('Algum Nome')).not.toBeInTheDocument()
  })
})

describe('ActionBar — filename truncation', () => {
  it('shows full filename when ≤ 25 chars', () => {
    render(<ActionBar {...minimalProps} currentFileName="Aula de Física" />)
    expect(screen.getByText('Aula de Física')).toBeInTheDocument()
  })

  it('truncates filename when > 25 chars', () => {
    render(
      <ActionBar
        {...minimalProps}
        currentFileName="Desenvolvimento Web Avançado"
      />,
    )
    expect(screen.getByText('Desenvolvimento Web…')).toBeInTheDocument()
  })
})

describe('ActionBar — Novo conteúdo during stream', () => {
  it('mantém Novo conteúdo habilitado durante o streaming', () => {
    render(<ActionBar {...minimalProps} isViewingStream={true} />)
    expect(
      screen.getByRole('button', { name: /Novo conteúdo/i })
    ).not.toBeDisabled()
  })

  it('enables Novo conteúdo button when isViewingStream is false', () => {
    render(<ActionBar {...minimalProps} isViewingStream={false} />)
    expect(
      screen.getByRole('button', { name: /Novo conteúdo/i })
    ).not.toBeDisabled()
  })

  it('chama onNewContent mesmo com uma geração na tela', async () => {
    const user = userEvent.setup()
    const onNewContent = vi.fn()
    render(<ActionBar {...minimalProps} isViewingStream={true} onNewContent={onNewContent} />)
    await user.click(screen.getByRole('button', { name: /Novo conteúdo/i }))
    expect(onNewContent).toHaveBeenCalled()
  })

  it('continua desabilitado enquanto processa', () => {
    render(<ActionBar {...minimalProps} loadingOperation="process" />)
    expect(
      screen.getByRole('button', { name: /Processando/i })
    ).toBeDisabled()
  })
})
