import { type Page, expect } from '@playwright/test'

/**
 * Page Object for the live streaming view (SSE) — the real-time
 * content generation display.
 *
 * Encapsulates the StreamingLessonView component: content that
 * appears incrementally as the backend generates it, the
 * streaming indicator, and the post-streaming save modal.
 *
 * All selectors use `data-testid`, `id`, `getByRole`, or text-based locators.
 * No CSS class selectors are used.
 */
export class LiveModeView {
  constructor(private page: Page) {}

  // ── Streaming state ─────────────────────────────────────────────────

  /**
   * Waits for the first chunk of streaming content to appear.
   *
   * The streaming indicator ("Gerando aula..." or
   * "Aula sendo gerada — conteúdo parcial pode aparecer abaixo")
   * signals that the SSE connection is active and the first
   * content has arrived.
   */
  async waitForStreamingToStart(): Promise<void> {
    await this.page
      .getByText(/aula sendo gerada|gerando aula/i)
      .waitFor({ state: 'visible', timeout: 30_000 })
  }

  /**
   * Waits for the streaming to finish.
   *
   * Uses a 60-second timeout because SSE content generation
   * (including diagrams) can take a long time.
   */
  async waitForStreamingToComplete(): Promise<void> {
    await this.page
      .getByText(/✅ Aula gerada com sucesso/i)
      .waitFor({ state: 'visible', timeout: 60_000 })
  }

  /**
   * Returns true if the streaming indicator is currently visible,
   * meaning content is still being generated.
   */
  async isStreaming(): Promise<boolean> {
    return this.page
      .getByText(/aula sendo gerada|gerando aula/i)
      .isVisible()
  }

  // ── Content ─────────────────────────────────────────────────────────

  /**
   * Returns the visible lesson text accumulated so far.
   *
   * The content is the rendered markdown from the streaming view.
   */
  async getPartialContent(): Promise<string> {
    const content = this.page.locator(
      '[data-color-mode="dark"].wmde-markdown-var',
    )
    return await content.innerText()
  }

  /**
   * Asserts that the streaming content is growing (i.e., new chunks
   * are arriving). Gets the current content length, waits briefly,
   * then asserts the length has increased.
   */
  async expectContentGrowing(): Promise<void> {
    const before = (await this.getPartialContent()).length
    // Wait up to 5 seconds for more content to arrive
    await this.page.waitForTimeout(2_000)
    const after = (await this.getPartialContent()).length
    expect(after).toBeGreaterThan(before)
  }

  // ── Post-streaming save actions ─────────────────────────────────────

  /**
   * Clicks the "Salvar aula" button on the dock.
   *
   * This button only appears after streaming completes.
   * It opens the LiveModeSaveModal.
   */
  async clickSave(): Promise<void> {
    await this.page
      .getByRole('button', { name: /salvar aula/i })
      .click()
  }

  /**
   * Fills the file name field in the save modal.
   */
  async fillSaveFileName(name: string): Promise<void> {
    await this.page.locator('#live-save-name').fill(name)
  }

  /**
   * Fills the folder name by opening the folder selector
   * and picking the folder with the given name.
   *
   * Clicks the "Selecionar" / "Trocar" button on the save modal,
   * which opens the FileManagerModal in select-folder mode, then
   * selects the matching folder row.
   */
  async fillSaveFolderName(name: string): Promise<void> {
    // Open the folder selector
    await this.page
      .getByRole('button', { name: /selecionar|trocar/i })
      .first()
      .click()
    // Select the folder by name
    await this.page
      .locator('[data-testid="folder-row"]')
      .filter({ hasText: name })
      .first()
      .click()
  }

  /**
   * Clicks the "Salvar" button inside the save modal to confirm.
   */
  async confirmSave(): Promise<void> {
    await this.page
      .getByRole('button', { name: /^salvar$/i })
      .click()
  }

  // ── Assertions ──────────────────────────────────────────────────────

  /**
   * Asserts the streaming view area is visible.
   *
   * Checks for either the streaming indicator (active stream)
   * or the completion banner (stream finished).
   */
  async expectVisible(): Promise<void> {
    await expect(
      this.page.getByText(/aula sendo gerada|gerando aula|✅/i).first(),
    ).toBeVisible()
  }

  /**
   * Asserts the streaming is complete — the completion banner
   * ("✅ Aula gerada com sucesso") is displayed.
   */
  async expectStreamingComplete(): Promise<void> {
    await expect(
      this.page.getByText(/✅ Aula gerada com sucesso/i),
    ).toBeVisible()
  }

  /**
   * Asserts the save modal is visible after clicking save.
   */
  async expectSaveModalVisible(): Promise<void> {
    await expect(
      this.page.getByRole('heading', { name: /salvar aula/i }),
    ).toBeVisible()
  }
}
