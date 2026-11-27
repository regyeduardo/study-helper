import { type Page, expect } from '@playwright/test'

/**
 * Page Object for the exam result modal.
 *
 * All selectors use `data-testid` and text-based locators.
 * No CSS class selectors are used.
 */
export class ResultModal {
  constructor(private page: Page) {}

  // ── Score ───────────────────────────────────────────────────────────

  /**
   * Parses the score text (e.g. "3/5 corretas") and returns the result.
   */
  async getScore(): Promise<{ correct: number; total: number }> {
    const text = await this.page.getByTestId('result-score').innerText()
    const match = text.match(/(\d+)\s*\/\s*(\d+)/)
    if (!match) return { correct: 0, total: 0 }
    return { correct: parseInt(match[1], 10), total: parseInt(match[2], 10) }
  }

  /**
   * Returns the score percentage (e.g. 60 for 3/5).
   * Calculated from `getScore()`.
   */
  async getScorePercentage(): Promise<number> {
    const { correct, total } = await this.getScore()
    if (total === 0) return 0
    return Math.round((correct / total) * 100)
  }

  // ── Question review ─────────────────────────────────────────────────

  /**
   * Returns detailed info about a specific question by its 0-based index.
   *
   * @param index - 0-based question index
   */
  async getQuestionResult(index: number): Promise<{
    question: string
    selectedAnswer: string
    correctAnswer: string
    isCorrect: boolean
  }> {
    const card = this.page.getByTestId(`result-question-${index}`)

    // Determine if the answer was correct via the "Correta" / "Incorreta" badge
    const isCorrect = await card.getByText('Correta').isVisible()

    // The question text is inside the card, before the alternatives.
    // Alternatives each start with a letter followed by ")".
    // Collect all text, extract the question portion before alternatives.
    const allText = await card.innerText()
    const lines = allText.split('\n')

    // Find where alternatives start (first line matching "A)" or similar)
    const altStart = lines.findIndex((l) => /^[A-E]\)/.test(l.trim()))
    // Question text is everything between line 1 (header) and altStart
    const question = lines.slice(1, altStart).join('\n').trim()

    // Find the correct answer line (has "✓" at the end)
    const correctLine = lines.find((l) => l.includes('✓')) ?? ''
    const correctAnswer = correctLine.replace('✓', '').trim()

    // Find the user's selected answer
    let selectedAnswer: string
    if (isCorrect) {
      selectedAnswer = correctAnswer
    } else {
      // Wrong answer line has "✗" at the end
      const wrongLine = lines.find((l) => l.includes('✗')) ?? ''
      selectedAnswer = wrongLine.replace('✗', '').trim()
    }

    return { question, selectedAnswer, correctAnswer, isCorrect }
  }

  // ── Close ───────────────────────────────────────────────────────────

  /**
   * Closes the result modal by clicking the close button in the header (X)
   * or the "Fechar" button in the footer.
   */
  async close(): Promise<void> {
    // Prefer the X button; fall back to "Fechar"
    const xBtn = this.page.getByTestId('modal-close')
    if (await xBtn.isVisible()) {
      await xBtn.click()
    } else {
      await this.page.getByTestId('result-close').click()
    }
  }

  // ── Assertions ──────────────────────────────────────────────────────

  /**
   * Asserts the result modal is visible.
   */
  async expectVisible(): Promise<void> {
    await expect(this.page.getByTestId('result-modal')).toBeVisible()
  }

  /**
   * Asserts the displayed score matches the expected values.
   */
  async expectScore(correct: number, total: number): Promise<void> {
    const score = await this.getScore()
    expect(score.correct).toBe(correct)
    expect(score.total).toBe(total)
  }
}
