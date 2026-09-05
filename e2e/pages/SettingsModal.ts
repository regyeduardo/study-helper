import { type Page, expect } from '@playwright/test'

/**
 * Page Object for the Settings modal — provider and model configuration
 * for the LLM backend.
 *
 * Encapsulates opening the settings modal, selecting provider/model,
 * saving configuration, and asserting current values.
 *
 * All selectors use `data-testid`, `getByRole`, `getByLabel`, or
 * text-based locators. No CSS class selectors are used.
 */
export class SettingsModal {
  constructor(private page: Page) {}

  // ── Open / Close ────────────────────────────────────────────────────

  /**
   * Opens the Settings modal by clicking the settings trigger button.
   *
   * The trigger is a dock button with `data-testid="settings-trigger"`.
   */
  async open(): Promise<void> {
    await this.page.getByTestId('settings-trigger').click()
  }

  /**
   * Closes the Settings modal by clicking the X (close) button
   * in the modal header.
   */
  async close(): Promise<void> {
    await this.page.getByTestId('settings-close').click()
  }

  // ── Provider / Model selection ──────────────────────────────────────

  /**
   * Selects an LLM provider by clicking the matching option.
   *
   * Uses a `data-testid="provider-option"` locator filtered by text.
   * Does not fail if the provider option is not found — this handles
   * the case where no providers are configured (initial state).
   */
  async selectProvider(provider: string): Promise<void> {
    const option = this.page
      .getByTestId('provider-option')
      .filter({ hasText: provider })
    if (await option.isVisible()) {
      await option.click()
    }
    // Gracefully no-op if provider not available
  }

  /**
   * Selects an LLM model by clicking the matching option.
   *
   * Uses a `data-testid="model-option"` locator filtered by text.
   * Does not fail if the model option is not found — this handles
   * the case where no models are listed (initial state).
   */
  async selectModel(model: string): Promise<void> {
    const option = this.page
      .getByTestId('model-option')
      .filter({ hasText: model })
    if (await option.isVisible()) {
      await option.click()
    }
    // Gracefully no-op if model not available
  }

  /**
   * Clicks the save button to persist the current settings.
   *
   * The save button is identified by `data-testid="settings-save"`.
   */
  async save(): Promise<void> {
    await this.page.getByTestId('settings-save').click()
  }

  // ── Assertions ──────────────────────────────────────────────────────

  /**
   * Asserts the Settings modal is visible.
   *
   * Checks for the heading "Configurações" inside the modal.
   */
  async expectVisible(): Promise<void> {
    await expect(
      this.page.getByRole('heading', { name: /configurações/i }),
    ).toBeVisible()
  }

  /**
   * Asserts that a given provider is currently selected.
   *
   * Uses a `data-testid="current-provider"` element to check
   * the displayed provider name.
   */
  async expectCurrentProvider(provider: string): Promise<void> {
    await expect(
      this.page.getByTestId('current-provider'),
    ).toHaveText(provider)
  }

  /**
   * Asserts that a given model is currently selected.
   *
   * Uses a `data-testid="current-model"` element to check
   * the displayed model name.
   */
  async expectCurrentModel(model: string): Promise<void> {
    await expect(
      this.page.getByTestId('current-model'),
    ).toHaveText(model)
  }
}
