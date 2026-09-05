import { type Page, expect } from '@playwright/test'

type Agent = 'aula' | 'explicacao' | 'leitura'
type Mode = 'file' | 'url' | 'topic' | 'text'

/**
 * Page object do modal "Novo conteúdo", que funciona em passos:
 * 1. Tipo → 2. Origem → 3. Ajustes (aula/explicação) ou 1. Tipo → 2. Conteúdo (leitura).
 */
export class NewContentModal {
  constructor(private page: Page) {}

  async open(): Promise<void> {
    await this.page.getByTestId('new-content-trigger').click()
  }

  async close(): Promise<void> {
    await this.page.getByTestId('modal-close').click()
  }

  /** Escolhe o tipo de conteúdo; o passo avança sozinho para a origem. */
  async selectAgent(agent: Agent): Promise<void> {
    await this.page.getByTestId(`agent-card-${agent}`).click()
  }

  async next(): Promise<void> {
    await this.page.getByTestId('step-next').click()
  }

  async back(): Promise<void> {
    await this.page.getByTestId('step-back').click()
  }

  async selectMode(mode: Mode): Promise<void> {
    await this.page.getByTestId(`source-option-${mode}`).click()
  }

  async fillUrl(url: string): Promise<void> {
    await this.page.getByPlaceholder(/https?:\/\//i).fill(url)
  }

  async uploadFile(filePath: string): Promise<void> {
    const fileChooserPromise = this.page.waitForEvent('filechooser')
    await this.page.getByText(/clique para selecionar/i).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(filePath)
  }

  async fillTopic(topic: string): Promise<void> {
    await this.page.getByLabel(/assunto ou dúvida/i).fill(topic)
  }

  async fillReadingText(text: string): Promise<void> {
    await this.page.getByLabel(/cole o texto/i).fill(text)
  }

  async fillReadingName(name: string): Promise<void> {
    await this.page.getByLabel(/nome do arquivo/i).fill(name)
  }

  async fillPrompt(prompt: string): Promise<void> {
    await this.page.getByLabel(/instruções adicionais/i).fill(prompt)
  }

  async selectSize(size: 'short' | 'medium' | 'deep'): Promise<void> {
    await this.page.getByTestId(`lesson-size-${size}`).click()
  }

  async submit(): Promise<void> {
    await this.page.getByTestId('step-submit').click()
  }

  /** Caminho completo: tipo → origem preenchida → ajustes → gerar. */
  async generateFromUrl(url: string, agent: Agent = 'aula'): Promise<void> {
    await this.selectAgent(agent)
    await this.selectMode('url')
    await this.fillUrl(url)
    await this.next()
    await this.submit()
  }

  async generateFromFile(filePath: string, agent: Agent = 'aula'): Promise<void> {
    await this.selectAgent(agent)
    await this.selectMode('file')
    await this.uploadFile(filePath)
    await this.next()
    await this.submit()
  }

  async expectVisible(): Promise<void> {
    await expect(this.page.getByTestId('new-content-modal')).toBeVisible()
  }

  async expectHidden(): Promise<void> {
    await expect(this.page.getByTestId('new-content-modal')).not.toBeVisible()
  }

  async expectStep(current: number, total: number): Promise<void> {
    await expect(this.page.getByTestId('step-indicator')).toContainText(`Passo ${current} de ${total}`)
  }

  async expectNextDisabled(): Promise<void> {
    await expect(this.page.getByTestId('step-next')).toBeDisabled()
  }

  async expectSubmitDisabled(): Promise<void> {
    await expect(this.page.getByTestId('step-submit')).toBeDisabled()
  }

  async expectSubmitEnabled(): Promise<void> {
    await expect(this.page.getByTestId('step-submit')).toBeEnabled()
  }
}
