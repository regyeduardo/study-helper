import { type Page, expect } from '@playwright/test'

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const

/**
 * Page Object for the exam (multiple-choice test) modal.
 *
 * All selectors use `data-testid` attributes for reliability.
 * No CSS class selectors are used.
 */
export class ExamModal {
  constructor(private page: Page) {}

  // ── Open / Close ────────────────────────────────────────────────────

  /**
   * Opens the exam modal via the dock "Provas" group.
   *
   * Clicks the dock group labelled "Provas" and then the "Gerar Prova" item.
   */
  async open(): Promise<void> {
    await this.page.getByRole('button', { name: 'Provas' }).click()
    await this.page.getByRole('button', { name: 'Gerar Prova' }).click()
  }

  /**
   * Closes the modal via the X (close) button in the header.
   */
  async close(): Promise<void> {
    await this.page.getByTestId('modal-close').click()
  }

  // ── Question navigation ─────────────────────────────────────────────

  /**
   * Returns the text of the current question's statement (without alternatives).
   */
  async getCurrentQuestionText(): Promise<string> {
    return await this.page.getByTestId('exam-question-text').innerText()
  }

  /**
   * Returns the total number of questions from the progress text.
   */
  async getTotalQuestions(): Promise<number> {
    const text = await this.page.getByTestId('exam-progress').innerText()
    const match = text.match(/de\s+(\d+)/i)
    return match ? parseInt(match[1], 10) : 0
  }

  /**
   * Returns the current (1-based) question number from the progress text.
   */
  async getCurrentQuestionNumber(): Promise<number> {
    const text = await this.page.getByTestId('exam-progress').innerText()
    const match = text.match(/questão\s+(\d+)/i)
    return match ? parseInt(match[1], 10) : 0
  }

  // ── Answering ───────────────────────────────────────────────────────

  /**
   * Selects an alternative by 0-based index (0 → A, 1 → B, …).
   */
  async selectOption(optionIndex: number): Promise<void> {
    await this.page.getByTestId(`exam-option-${OPTION_LETTERS[optionIndex]}`).click()
  }

  /**
   * Selects an alternative option whose visible text contains the given string.
   */
  async selectOptionByText(text: string): Promise<void> {
    await this.page
      .locator('[data-testid^="exam-option-"]')
      .filter({ hasText: text })
      .first()
      .click()
  }

  /**
   * Navigates to the next question.
   */
  async goToNextQuestion(): Promise<void> {
    await this.page.getByTestId('exam-next').click()
  }

  /**
   * Navigates to the previous question.
   */
  async goToPreviousQuestion(): Promise<void> {
    await this.page.getByTestId('exam-prev').click()
  }

  // ── Submission ──────────────────────────────────────────────────────

  /**
   * Submits the exam.
   *
   * - On the last question, clicks "Finalizar".
   * - Otherwise, clicks "Ver Gabarito" (both trigger the same `onFinish` callback).
   */
  async submit(): Promise<void> {
    const finish = this.page.getByTestId('exam-finish')
    const gabarito = this.page.getByTestId('exam-gabarito')

    if (await finish.isVisible()) {
      await finish.click()
    } else {
      await gabarito.click()
    }
  }

  // ── Assertions ──────────────────────────────────────────────────────

  /**
   * Asserts the exam modal is visible.
   */
  async expectVisible(): Promise<void> {
    await expect(this.page.getByTestId('exam-modal')).toBeVisible()
  }

  /**
   * Asserts the current question text contains the given string.
   */
  async expectQuestion(text: string): Promise<void> {
    await expect(this.page.getByTestId('exam-question-text')).toContainText(text)
  }

  /**
   * Asserts an option (by 0-based index) is visually selected.
   *
   * Checks for the Tailwind `border-violet-500` class, which is applied
   * when the option is selected. This is more reliable than checking the
   * computed CSS color (which varies across browser engines / color spaces).
   */
  async expectOptionSelected(optionIndex: number): Promise<void> {
    const btn = this.page.getByTestId(`exam-option-${OPTION_LETTERS[optionIndex]}`)
    await expect(btn).toBeVisible()
    // Selected buttons get border-violet-500 class
    await expect(btn).toHaveClass(/border-violet-500/)
  }

  /**
   * Asserts the submit / finish button is enabled.
   */
  async expectSubmitEnabled(): Promise<void> {
    const finish = this.page.getByTestId('exam-finish')
    const gabarito = this.page.getByTestId('exam-gabarito')

    if (await finish.isVisible()) {
      await expect(finish).toBeEnabled()
    } else {
      await expect(gabarito).toBeEnabled()
    }
  }

  /**
   * Asserts the submit / finish button is disabled.
   */
  async expectSubmitDisabled(): Promise<void> {
    const finish = this.page.getByTestId('exam-finish')
    const gabarito = this.page.getByTestId('exam-gabarito')

    if (await finish.isVisible()) {
      await expect(finish).toBeDisabled()
    } else {
      await expect(gabarito).toBeDisabled()
    }
  }
}
