import { type Page, expect } from '@playwright/test'

/**
 * Page Object for the output panel — the main content display area
 * and its associated action bar.
 *
 * Encapsulates the rendered markdown content, Mermaid diagrams,
 * and the action bar buttons (save, export, exam, regenerate).
 *
 * All selectors use `data-testid`, `getByRole`, or text-based locators.
 * No CSS class selectors are used.
 */
export class OutputPanel {
  constructor(private page: Page) {}

  // ── Content ────────────────────────────────────────────────────────

  /**
   * Returns the visible text of the rendered markdown content.
   * Strips all HTML tags — returns pure text only.
   */
  async getContent(): Promise<string> {
    const content = this.page.locator('#output-content')
    return await content.innerText()
  }

  /**
   * Asserts the rendered markdown content contains the given text.
   */
  async expectContentContains(text: string): Promise<void> {
    const content = this.page.locator('#output-content')
    await expect(content).toContainText(text)
  }

  /**
   * Asserts the output content area is visible in the DOM.
   */
  async expectContentVisible(): Promise<void> {
    await expect(this.page.locator('#output-content')).toBeVisible()
  }

  /**
   * Asserts the output panel shows the empty state
   * (no content loaded yet).
   */
  async expectEmpty(): Promise<void> {
    await expect(
      this.page.getByText('O resultado aparecerá aqui após o processamento.'),
    ).toBeVisible()
  }

  // ── Action bar ─────────────────────────────────────────────────────

  /**
   * Exports the current content as a ZIP file with questions.
   *
   * Opens the "Exportar" dock group and clicks
   * "Baixar aula + questões (.zip)".
   */
  async clickExportZip(): Promise<void> {
    await this.page.getByRole('button', { name: 'Exportar' }).click()
    await this.page
      .getByRole('button', { name: 'Baixar aula + questões (.zip)' })
      .click()
  }

  /**
   * Starts an exam for the currently loaded content.
   *
   * Opens the "Provas" dock group and clicks "Fazer Avaliação".
   * Requires questions to exist.
   */
  async clickStartExam(): Promise<void> {
    await this.page.getByRole('button', { name: 'Provas' }).click()
    await this.page.getByRole('button', { name: 'Fazer Avaliação' }).click()
  }

  /**
   * Generates new questions for the currently loaded content.
   *
   * Opens the "Provas" dock group and clicks "Gerar Prova".
   */
  async clickGenerateQuestions(): Promise<void> {
    await this.page.getByRole('button', { name: 'Provas' }).click()
    await this.page.getByRole('button', { name: 'Gerar Prova' }).click()
  }

  /**
   * Saves the current content to a file.
   *
   * Clicks the "Salvar em..." button in the ActionBar and
   * selects the root folder ("Raiz") by default.
   */
  async clickSaveToFile(): Promise<void> {
    await this.page.getByRole('button', { name: /Salvar em/i }).click()
    // Select "Raiz" as the target folder by default
    await this.page.getByRole('button', { name: 'Raiz' }).first().click()
  }

  /**
   * Clicks the "Regenerar" button in the ActionBar (content regeneration).
   *
   * This button appears when viewing a saved file. It triggers the content
   * regeneration flow that sends the current content through the generation
   * pipeline again and updates the saved file.
   */
  async clickRegenerateContent(): Promise<void> {
    await this.page.getByTestId('regenerate-content').click()
  }

  /**
   * Confirms question regeneration when the RegenerateDialog is shown.
   *
   * Clicks "Gerar novas questões" in the regeneration confirmation dialog.
   */
  async clickRegenerate(): Promise<void> {
    await this.page.getByRole('button', { name: /Gerar novas questões/i }).click()
  }

  // ── Diagrams ───────────────────────────────────────────────────────

  /**
   * Asserts at least one Mermaid diagram is visible in the output content.
   *
   * A rendered Mermaid diagram produces an SVG element inside the
   * output content area. First ensures content is loaded (empty state
   * is gone), then checks for a rendered SVG.
   */
  async expectMermaidDiagramVisible(): Promise<void> {
    // First ensure we have content (empty state is gone)
    await expect(
      this.page.getByText('O resultado aparecerá aqui após o processamento.'),
    ).not.toBeVisible()
    // Then check for rendered SVG diagram inside the output area
    await expect(
      this.page.locator('#output-content svg').first(),
    ).toBeVisible()
  }
}
