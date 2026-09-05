import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LiveModeSaveModal from './LiveModeSaveModal'
import type { LiveModeSaveModalProps } from './LiveModeSaveModal'

// Mock FileManagerModal since it's a complex component with API calls
vi.mock('@/components/io/FileManagerModal', () => ({
  default: ({ open, onSelectFolder }: { open: boolean; onSelectFolder?: (folder: any) => void }) =>
    open ? (
      <div data-testid="folder-modal">
        <button
          onClick={() => onSelectFolder?.({ id: 'folder-1', name: 'Biologia', kind: 'folder' })}
        >
          Selecionar Biologia
        </button>
        <button onClick={() => onSelectFolder?.({ id: 'folder-2', name: 'Matemática', kind: 'folder' })}>
          Selecionar Matemática
        </button>
      </div>
    ) : null,
}))

const defaultProps: LiveModeSaveModalProps = {
  open: true,
  lessonText: '# Biologia Celular\n\nConteúdo da aula...',
  tempFileId: 'temp-123',
  savedFolderId: null,
  savedFolderName: null,
  onSave: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
  originalTitle: 'Biologia Celular',
}

function renderModal(overrides: Partial<LiveModeSaveModalProps> = {}) {
  return render(<LiveModeSaveModal {...defaultProps} {...overrides} />)
}

describe('LiveModeSaveModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Renderização inicial ──

  describe('renderização inicial', () => {
    it('está visível quando open=true', () => {
      renderModal()
      expect(screen.getByText('Salvar aula')).toBeInTheDocument()
    })

    it('pré-preenche o campo nome com originalTitle', () => {
      renderModal()
      const input = screen.getByRole('textbox', { name: /nome/i })
      expect(input).toHaveValue('Biologia Celular')
    })

    it('deixa o campo descrição vazio', () => {
      renderModal()
      const textarea = screen.getByRole('textbox', { name: /descrição/i })
      expect(textarea).toHaveValue('')
    })

    it('exibe "Raiz" quando savedFolderName é null', () => {
      renderModal()
      expect(screen.getByText('Raiz')).toBeInTheDocument()
    })

    it('exibe o nome da pasta quando savedFolderName não é null', () => {
      renderModal({ savedFolderId: 'folder-1', savedFolderName: 'Biologia' })
      expect(screen.getByText('Biologia')).toBeInTheDocument()
    })

    it('não renderiza nada quando open=false', () => {
      renderModal({ open: false })
      expect(screen.queryByText('Salvar aula')).not.toBeInTheDocument()
    })
  })

  // ── Validação ──

  describe('validação', () => {
    it('exibe erro e não chama onSave quando o nome está vazio', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const user = userEvent.setup()
      renderModal({ onSave })

      const input = screen.getByRole('textbox', { name: /nome/i })
      await user.clear(input)

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      expect(screen.getByText('O nome não pode estar vazio.')).toBeInTheDocument()
      expect(onSave).not.toHaveBeenCalled()
    })

    it('chama onSave exatamente 1 vez quando o nome está preenchido', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const user = userEvent.setup()
      renderModal({ onSave })

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      expect(onSave).toHaveBeenCalledTimes(1)
    })
  })

  // ── Chamada de onSave ──

  describe('chamada de onSave', () => {
    it('chama onSave com valores padrão ao confirmar sem alterar campos', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const user = userEvent.setup()
      renderModal({ onSave })

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      expect(onSave).toHaveBeenCalledWith({
        name: 'Biologia Celular',
        description: '',
        folderId: null,
        folderName: null,
      })
    })

    it('chama onSave com o nome alterado', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const user = userEvent.setup()
      renderModal({ onSave })

      const input = screen.getByRole('textbox', { name: /nome/i })
      await user.clear(input)
      await user.type(input, 'Minha Aula')

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      expect(onSave).toHaveBeenCalledWith({
        name: 'Minha Aula',
        description: '',
        folderId: null,
        folderName: null,
      })
    })
  })

  // ── Estado de loading ──

  describe('estado de loading', () => {
    it('desabilita o botão de confirmar enquanto onSave está pendente', async () => {
      let resolvePromise!: () => void
      const onSave = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolvePromise = resolve }))
      const user = userEvent.setup()
      renderModal({ onSave })

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      // findByRole wraps in act() automatically
      const loadingButton = await screen.findByRole('button', { name: /salvando/i })
      expect(loadingButton).toBeDisabled()

      // Cleanup: resolve the promise so the test doesn't hang
      resolvePromise()
    })

    it('chama onClose após onSave resolver', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      const user = userEvent.setup()
      renderModal({ onSave, onClose })

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1)
      })
    })
  })

  // ── Estado de erro ──

  describe('estado de erro', () => {
    it('exibe mensagem de erro quando onSave rejeita', async () => {
      const onSave = vi.fn().mockRejectedValue(new Error('Erro de rede'))
      const user = userEvent.setup()
      renderModal({ onSave })

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      await waitFor(() => {
        expect(screen.getByText('Erro ao salvar. Tente novamente.')).toBeInTheDocument()
      })
    })

    it('não chama onClose quando onSave rejeita', async () => {
      const onSave = vi.fn().mockRejectedValue(new Error('Erro de rede'))
      const onClose = vi.fn()
      const user = userEvent.setup()
      renderModal({ onSave, onClose })

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      await waitFor(() => {
        expect(onClose).not.toHaveBeenCalled()
      })
    })

    it('reabilita o botão de confirmar quando onSave rejeita', async () => {
      const onSave = vi.fn().mockRejectedValue(new Error('Erro de rede'))
      const user = userEvent.setup()
      renderModal({ onSave })

      const saveButton = screen.getByRole('button', { name: /salvar/i })
      await user.click(saveButton)

      // Wait for the error to appear
      await screen.findByText('Erro ao salvar. Tente novamente.')

      // The button should be enabled again
      const retryButton = screen.getByRole('button', { name: /salvar/i })
      expect(retryButton).not.toBeDisabled()
    })
  })

  // ── Botão cancelar ──

  describe('botão cancelar', () => {
    it('chama onClose sem chamar onSave ao clicar em Cancelar', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      const user = userEvent.setup()
      renderModal({ onSave, onClose })

      const cancelButton = screen.getByRole('button', { name: /cancelar/i })
      await user.click(cancelButton)

      expect(onClose).toHaveBeenCalledTimes(1)
      expect(onSave).not.toHaveBeenCalled()
    })
  })

  // ── Regressão ──

  // ── originalTitle pre-fill ──

  describe('LiveModeSaveModal — originalTitle pre-fill', () => {
    it('pre-fills file name input with originalTitle', () => {
      renderModal({ originalTitle: 'Aula de Biologia Celular' })
      const input = screen.getByRole('textbox', { name: /nome/i })
      expect(input).toHaveValue('Aula de Biologia Celular')
    })

    it('falls back to extractTitle(lessonText) when originalTitle is not provided', () => {
      renderModal({ originalTitle: undefined })
      const input = screen.getByRole('textbox', { name: /nome/i })
      expect(input).toHaveValue('Biologia Celular')
    })

    it('shows fallback placeholder when both originalTitle and lessonText heading are missing', () => {
      renderModal({ originalTitle: undefined, lessonText: 'Conteúdo sem heading' })
      const input = screen.getByRole('textbox', { name: /nome/i })
      expect(input).toHaveValue('Aula sem título')
    })

    it('allows user to override the pre-filled name', async () => {
      const user = userEvent.setup()
      renderModal({ originalTitle: 'Nome Original' })
      const input = screen.getByRole('textbox', { name: /nome/i })
      await user.clear(input)
      await user.type(input, 'Nome Customizado')
      expect(input).toHaveValue('Nome Customizado')
    })
  })

  describe('regressão', () => {
    it('renderiza sem erros quando tempFileId=null', () => {
      // Suppress console.error to catch any unexpected errors
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      renderModal({ tempFileId: null })

      expect(screen.getByText('Salvar aula')).toBeInTheDocument()
      // No unexpected console errors
      expect(consoleError).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })
  })
})
