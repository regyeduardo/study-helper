import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NewContentModal from './NewContentModal'

function renderModal(overrides: Partial<Parameters<typeof NewContentModal>[0]> = {}) {
  const defaults = {
    open: true,
    onClose: vi.fn(),
    mode: 'file' as const,
    setMode: vi.fn(),
    selectedFile: null,
    setSelectedFile: vi.fn(),
    inputUrl: '',
    setInputUrl: vi.fn(),
    inputUrlValid: false,
    setInputUrlValid: vi.fn(),
    agent: 'aula' as const,
    setAgent: vi.fn(),
    topic: '',
    setTopic: vi.fn(),
    prompt: '',
    setPrompt: vi.fn(),
    generationName: '',
    setGenerationName: vi.fn(),
    generationDescription: '',
    setGenerationDescription: vi.fn(),
    language: 'pt-BR',
    setLanguage: vi.fn(),
    loadingOperation: null,
    onProcess: vi.fn(),
    readingText: '',
    setReadingText: vi.fn(),
    readingName: '',
    setReadingName: vi.fn(),
    readingLoading: false,
    readingError: '',
    setReadingError: vi.fn(),
    onCreateReading: vi.fn(),
  }
  const props = { ...defaults, ...overrides }
  return { ...render(<NewContentModal {...props} />), props }
}

async function goToSource(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('step-next'))
}

describe('NewContentModal — estrutura em passos', () => {
  it('abre no passo 1 (Tipo) mostrando só a escolha de agente', () => {
    renderModal()

    expect(screen.getByTestId('step-indicator')).toHaveTextContent('Passo 1 de 3')
    expect(screen.getByTestId('agent-card-aula')).toBeInTheDocument()
    expect(screen.queryByTestId('source-selector')).not.toBeInTheDocument()
    expect(screen.queryByTestId('lesson-size-medium')).not.toBeInTheDocument()
  })

  it('mostra os três tipos de conteúdo no passo 1', () => {
    renderModal()

    expect(screen.getByTestId('agent-card-aula')).toBeInTheDocument()
    expect(screen.getByTestId('agent-card-explicacao')).toBeInTheDocument()
    expect(screen.getByTestId('agent-card-leitura')).toBeInTheDocument()
  })

  it('avança para o passo de origem ao clicar em Continuar', async () => {
    const user = userEvent.setup()
    renderModal()

    await goToSource(user)

    expect(screen.getByTestId('step-indicator')).toHaveTextContent('Passo 2 de 3')
    expect(screen.getByTestId('source-selector')).toBeInTheDocument()
  })

  it('escolher outro tipo avança direto para a origem', async () => {
    const user = userEvent.setup()
    const { props } = renderModal()

    await user.click(screen.getByTestId('agent-card-explicacao'))

    expect(props.setAgent).toHaveBeenCalledWith('explicacao')
    expect(screen.getByTestId('step-indicator')).toHaveTextContent('Passo 2 de 3')
  })

  it('volta para o passo anterior pelo botão Voltar', async () => {
    const user = userEvent.setup()
    renderModal()

    await goToSource(user)
    await user.click(screen.getByTestId('step-back'))

    expect(screen.getByTestId('step-indicator')).toHaveTextContent('Passo 1 de 3')
  })

  it('mostra o resumo das escolhas anteriores e volta ao clicar nele', async () => {
    const user = userEvent.setup()
    renderModal()

    await goToSource(user)
    const chip = screen.getByTestId('summary-chip-agent')
    expect(chip).toHaveTextContent('Aula')

    await user.click(chip)
    expect(screen.getByTestId('step-indicator')).toHaveTextContent('Passo 1 de 3')
  })

  it('leitura tem apenas dois passos', async () => {
    const user = userEvent.setup()
    renderModal({ agent: 'leitura', mode: 'text' })

    await goToSource(user)

    expect(screen.getByTestId('step-indicator')).toHaveTextContent('Passo 2 de 2')
    expect(screen.getByTestId('step-submit')).toBeInTheDocument()
  })

  it('fecha no Escape', async () => {
    const user = userEvent.setup()
    const { props } = renderModal()

    await user.keyboard('{Escape}')

    expect(props.onClose).toHaveBeenCalled()
  })

  it('cancela pelo rodapé no primeiro passo', async () => {
    const user = userEvent.setup()
    const { props } = renderModal()

    await user.click(screen.getByTestId('modal-cancel'))

    expect(props.onClose).toHaveBeenCalled()
  })
})

describe('NewContentModal — passo de origem', () => {
  it('mostra Arquivo e Link para aula', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToSource(user)

    expect(screen.getByTestId('source-option-file')).toBeInTheDocument()
    expect(screen.getByTestId('source-option-url')).toBeInTheDocument()
    expect(screen.queryByTestId('source-option-topic')).not.toBeInTheDocument()
  })

  it('mostra Tema, Arquivo e Link para explicação', async () => {
    const user = userEvent.setup()
    renderModal({ agent: 'explicacao', mode: 'topic' })
    await goToSource(user)

    expect(screen.getByTestId('source-option-topic')).toBeInTheDocument()
    expect(screen.getByTestId('source-option-file')).toBeInTheDocument()
    expect(screen.getByTestId('source-option-url')).toBeInTheDocument()
  })

  it('mostra Texto, Link e PDF para leitura', async () => {
    const user = userEvent.setup()
    renderModal({ agent: 'leitura', mode: 'text' })
    await goToSource(user)

    expect(screen.getByTestId('source-option-text')).toBeInTheDocument()
    expect(screen.getByTestId('source-option-url')).toBeInTheDocument()
    expect(screen.getByTestId('source-option-file')).toBeInTheDocument()
  })

  it('troca o modo de entrada ao escolher outra origem', async () => {
    const user = userEvent.setup()
    const { props } = renderModal()
    await goToSource(user)

    await user.click(screen.getByTestId('source-option-url'))

    expect(props.setMode).toHaveBeenCalledWith('url')
  })

  it('mostra o campo de texto da leitura e o nome do arquivo', async () => {
    const user = userEvent.setup()
    renderModal({ agent: 'leitura', mode: 'text' })
    await goToSource(user)

    expect(screen.getByLabelText(/Cole o texto/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Nome do arquivo/i)).toBeInTheDocument()
  })

  it('bloqueia Continuar enquanto a entrada estiver vazia', async () => {
    const user = userEvent.setup()
    renderModal()
    await goToSource(user)

    expect(screen.getByTestId('step-next')).toBeDisabled()
  })

  it('libera Continuar quando há arquivo selecionado', async () => {
    const user = userEvent.setup()
    renderModal({ selectedFile: new File(['x'], 'aula.pdf') })
    await goToSource(user)

    expect(screen.getByTestId('step-next')).toBeEnabled()
  })
})

describe('NewContentModal — passo de ajustes', () => {
  async function goToSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('step-next'))
  }

  it('mostra o campo de instruções adicionais', async () => {
    const user = userEvent.setup()
    renderModal({ selectedFile: new File(['x'], 'aula.pdf') })
    await goToSettings(user)

    expect(screen.getByLabelText(/Instruções adicionais/i)).toBeInTheDocument()
  })

  it('mostra o idioma quando a origem precisa de transcrição', async () => {
    const user = userEvent.setup()
    renderModal({ selectedFile: new File(['x'], 'aula.mp3') })
    await goToSettings(user)

    expect(screen.getByTestId('language-selector')).toBeInTheDocument()
  })

  it('mostra o idioma para arquivo de áudio, que precisa de transcrição', async () => {
    const user = userEvent.setup()
    renderModal({ selectedFile: new File(['x'], 'aula.mp3') })
    await goToSettings(user)

    expect(screen.getByTestId('language-selector')).toBeInTheDocument()
  })

  it('gera e fecha ao clicar em Gerar', async () => {
    const user = userEvent.setup()
    const { props } = renderModal({ selectedFile: new File(['x'], 'aula.pdf') })
    await goToSettings(user)

    await user.click(screen.getByTestId('step-submit'))

    expect(props.onProcess).toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalled()
  })

  it('mostra estado de processamento no botão final', async () => {
    const user = userEvent.setup()
    const { rerender, props } = renderModal({ selectedFile: new File(['x'], 'aula.pdf') })
    await goToSettings(user)

    rerender(<NewContentModal {...props} loadingOperation="process" />)

    expect(screen.getByTestId('step-submit')).toBeDisabled()
    expect(screen.getByTestId('step-submit')).toHaveTextContent(/Processando/i)
  })
})

describe('NewContentModal — leitura', () => {
  it('salva a leitura com o texto colado', async () => {
    const user = userEvent.setup()
    const onCreateReading = vi.fn().mockResolvedValue(undefined)
    renderModal({
      agent: 'leitura',
      mode: 'text',
      readingText: 'Texto do artigo',
      readingName: 'Meu artigo',
      onCreateReading,
    })

    await goToSource(user)
    await user.click(screen.getByTestId('step-submit'))

    await waitFor(() =>
      expect(onCreateReading).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'text', content: 'Texto do artigo', name: 'Meu artigo' }),
      ),
    )
  })

  it('mostra o erro de criação da leitura', async () => {
    const user = userEvent.setup()
    renderModal({ agent: 'leitura', mode: 'text', readingError: 'Erro ao criar leitura: falhou' })
    await goToSource(user)

    expect(screen.getByText(/Erro ao criar leitura/i)).toBeInTheDocument()
  })

  it('mostra o estado de salvando', async () => {
    const user = userEvent.setup()
    renderModal({ agent: 'leitura', mode: 'text', readingText: 'x', readingLoading: true })
    await goToSource(user)

    expect(screen.getByTestId('step-submit')).toHaveTextContent(/Salvando/i)
  })
})

describe('NewContentModal — acessibilidade', () => {
  it('é um diálogo rotulado', () => {
    renderModal()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName(/Novo conteúdo/i)
  })

  it('marca o passo atual na barra de progresso', async () => {
    const user = userEvent.setup()
    renderModal()

    expect(screen.getByTestId('progress-dot-0')).toHaveAttribute('aria-current', 'step')

    await goToSource(user)
    expect(screen.getByTestId('progress-dot-1')).toHaveAttribute('aria-current', 'step')
  })

  it('não usa emoji como ícone dos tipos de conteúdo', () => {
    renderModal()

    const card = screen.getByTestId('agent-card-aula')
    expect(card.querySelector('svg')).toBeTruthy()
    expect(card.textContent ?? '').not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
  })
})

describe('NewContentModal — detecção de mídia', () => {
  async function goToSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('step-next'))
    await user.click(screen.getByTestId('step-next'))
  }

  it('mostra o idioma quando o arquivo é áudio', async () => {
    const user = userEvent.setup()
    renderModal({ selectedFile: new File(['x'], 'aula.mp3') })
    await goToSettings(user)

    expect(screen.getByTestId('language-selector')).toBeInTheDocument()
  })

  it('não mostra o idioma para legenda .srt', async () => {
    const user = userEvent.setup()
    renderModal({ selectedFile: new File(['x'], 'aula.srt') })
    await goToSettings(user)

    expect(screen.queryByTestId('language-selector')).not.toBeInTheDocument()
  })

  it('não mostra o idioma para PDF nem para texto', async () => {
    const user = userEvent.setup()
    const { unmount } = renderModal({ selectedFile: new File(['x'], 'aula.pdf') })
    await goToSettings(user)
    expect(screen.queryByTestId('language-selector')).not.toBeInTheDocument()
    unmount()

    renderModal({ selectedFile: new File(['x'], 'notas.txt') })
    await goToSettings(user)
    expect(screen.queryByTestId('language-selector')).not.toBeInTheDocument()
  })

  it('mostra o idioma no modo link (pode ser vídeo)', async () => {
    const user = userEvent.setup()
    renderModal({ mode: 'url', inputUrl: 'https://youtube.com/watch?v=x', inputUrlValid: true })
    await goToSettings(user)

    expect(screen.getByTestId('language-selector')).toBeInTheDocument()
  })

  it('aceita legendas no seletor de arquivo', async () => {
    const user = userEvent.setup()
    const { container } = renderModal()
    await user.click(screen.getByTestId('step-next'))

    const input = container.querySelector('input[type="file"]')
    expect(input?.getAttribute('accept')).toContain('.srt')
  })

  it('mostra o seletor de motor de transcrição para arquivo de áudio e permite selecionar', async () => {
    const user = userEvent.setup()
    const setTranscriptionProvider = vi.fn()
    renderModal({
      selectedFile: new File(['x'], 'gravacao.mp3', { type: 'audio/mp3' }),
      transcriptionProvider: 'local',
      setTranscriptionProvider,
      openaiAvailable: true,
    })
    await goToSettings(user)

    expect(screen.getByTestId('transcription-provider-selector')).toBeInTheDocument()
    const openaiBtn = screen.getByTestId('provider-option-openai')
    await user.click(openaiBtn)
    expect(setTranscriptionProvider).toHaveBeenCalledWith('openai')
  })

  it('não mostra o seletor de motor de transcrição para PDF', async () => {
    const user = userEvent.setup()
    renderModal({
      selectedFile: new File(['x'], 'documento.pdf', { type: 'application/pdf' }),
    })
    await goToSettings(user)

    expect(screen.queryByTestId('transcription-provider-selector')).not.toBeInTheDocument()
  })
})

