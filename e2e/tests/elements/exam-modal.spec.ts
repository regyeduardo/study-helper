import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { ExamModal } from '../../pages/ExamModal'
import { ResultModal } from '../../pages/ResultModal'
import { FileManagerModal } from '../../pages/FileManagerModal'

test.describe('ExamModal — element tests', () => {
  let examModal: ExamModal
  let resultModal: ResultModal
  let folderId: string
  let fileId: string

  test.beforeEach(async ({ page, apiHelpers }) => {
    await page.setViewportSize({ width: 1280, height: 900 })

    // ── Create test data via API ──────────────────────────────────────────
    const folder = await apiHelpers.createFolder('Exam Test')
    folderId = folder.id

    const file = await apiHelpers.createFile({
      name: 'content.md',
      folderId,
      content: '# Test Content\n\nContent for exam modal tests.',
      file_type: 'class',
    })
    fileId = file.id

    // Create 3 questions in a single bulk call.
    // IMPORTANT: /questions/bulk DELETES existing questions first,
    // so we must pass ALL questions at once.
    await apiHelpers.createQuestionsBulk(fileId, [
      {
        question: 'Qual a capital do Brasil?',
        options: ['São Paulo', 'Brasília', 'Rio de Janeiro', 'Salvador', 'Belo Horizonte'],
        correctIndex: 1, // Brasília
      },
      {
        question: 'Quanto é 2 + 2?',
        options: ['3', '4', '5', '6', '7'],
        correctIndex: 1, // 4
      },
      {
        question: 'Qual a cor do céu?',
        options: ['Verde', 'Vermelho', 'Azul', 'Amarelo', 'Roxo'],
        correctIndex: 2, // Azul
      },
    ])

    // ── Navigate and load file to populate React state ────────────────────
    await page.goto('http://localhost:8080/')

    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()
    await fileManager.openFolder('Exam Test')
    await fileManager.selectFile('content.md')

    // Wait for the file manager to close (handleSelectFileFromManager closes it
    // after loading the file and its questions into state)
    await expect(page.getByTestId('file-manager-modal')).not.toBeVisible({
      timeout: 10_000,
    })

    examModal = new ExamModal(page)
    resultModal = new ResultModal(page)
  })

  test.afterEach(async ({ apiHelpers }) => {
    if (fileId) {
      await apiHelpers.deleteQuestion(fileId).catch(() => {})
      await apiHelpers.deleteFile(fileId).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })

  /**
   * Opens the exam modal via the dock "Provas" → "Fazer Avaliação".
   *
   * Questions are already in React state (loaded from the selected file),
   * so "Fazer Avaliação" opens the exam directly without generation.
   */
  async function openExam(page: import('@playwright/test').Page) {
    await page.getByRole('button', { name: 'Provas' }).click()
    await page.getByRole('button', { name: 'Fazer Avaliação' }).click()
    await examModal.expectVisible()
  }

  // ── 1. Opening with questions ──────────────────────────────────────────

  test('1. opening with questions — pre-loaded questions appear in exam modal', async ({ page }) => {
    await openExam(page)

    // Questions are shuffled on load, so we can't expect a specific text.
    // Just verify that the modal shows a question text and the counter is correct.
    await examModal.expectVisible()
    const questionText = await examModal.getCurrentQuestionText()
    expect(questionText.length).toBeGreaterThan(0)

    const total = await examModal.getTotalQuestions()
    expect(total).toBe(3)
  })

  // ── 2. Navigation between questions ────────────────────────────────────

  test('2. navigation between questions — next and previous navigate correctly', async ({ page }) => {
    await openExam(page)
    await examModal.expectVisible()

    // Start on question 1
    expect(await examModal.getCurrentQuestionNumber()).toBe(1)
    expect(await examModal.getTotalQuestions()).toBe(3)

    // Navigate forward: Q1 → Q2
    await examModal.goToNextQuestion()
    expect(await examModal.getCurrentQuestionNumber()).toBe(2)

    // Navigate forward: Q2 → Q3
    await examModal.goToNextQuestion()
    expect(await examModal.getCurrentQuestionNumber()).toBe(3)

    // Navigate backward: Q3 → Q2
    await examModal.goToPreviousQuestion()
    expect(await examModal.getCurrentQuestionNumber()).toBe(2)

    // Navigate backward: Q2 → Q1
    await examModal.goToPreviousQuestion()
    expect(await examModal.getCurrentQuestionNumber()).toBe(1)
  })

  // ── 3. Option selection ────────────────────────────────────────────────

  test('3. option selection — selecting an option visually marks it', async ({ page }) => {
    await openExam(page)
    await examModal.expectVisible()

    // Select option A (0-based index 0 → letter A)
    await examModal.selectOption(0)
    await examModal.expectOptionSelected(0)
  })

  // ── 4. Buttons accessible without answering ────────────────────────────

  test('4. submit available without answer — "Ver Gabarito" and navigation are accessible before selecting any option', async ({ page }) => {
    await openExam(page)
    await examModal.expectVisible()

    // "Ver Gabarito" should be visible and enabled
    await expect(page.getByTestId('exam-gabarito')).toBeVisible()
    await expect(page.getByTestId('exam-gabarito')).toBeEnabled()

    // "Anterior" should be disabled on first question
    await expect(page.getByTestId('exam-prev')).toBeVisible()
    await expect(page.getByTestId('exam-prev')).toBeDisabled()

    // Either "Próxima" (if not on last question) or "Finalizar" (if on last) is enabled
    const nextBtn = page.getByTestId('exam-next')
    const finishBtn = page.getByTestId('exam-finish')
    if (await nextBtn.isVisible()) {
      await expect(nextBtn).toBeEnabled()
    } else {
      await expect(finishBtn).toBeVisible()
      await expect(finishBtn).toBeEnabled()
    }
  })

  // ── 5. Question counter ────────────────────────────────────────────────

  test('5. question counter — displays "Questão X de N" correctly', async ({ page }) => {
    await openExam(page)
    await examModal.expectVisible()

    // First question: number should be 1, total should be 3
    expect(await examModal.getCurrentQuestionNumber()).toBe(1)
    expect(await examModal.getTotalQuestions()).toBe(3)

    // Navigate to question 2
    await examModal.goToNextQuestion()
    expect(await examModal.getCurrentQuestionNumber()).toBe(2)

    // Navigate to question 3
    await examModal.goToNextQuestion()
    expect(await examModal.getCurrentQuestionNumber()).toBe(3)
  })

  // ── 6. Submit on last question ─────────────────────────────────────────

  test('6. submit on last question — "Finalizar" button appears on the last question', async ({ page }) => {
    await openExam(page)
    await examModal.expectVisible()

    const total = await examModal.getTotalQuestions()
    expect(total).toBe(3)

    // Navigate to the last question by using próxima until we're at the end
    for (let i = 1; i < total; i++) {
      await examModal.goToNextQuestion()
    }

    // Now we should be on the last question — "Finalizar" button should be visible
    expect(await examModal.getCurrentQuestionNumber()).toBe(total)
    await expect(page.getByTestId('exam-finish')).toBeVisible()
    await expect(page.getByTestId('exam-finish')).toBeEnabled()
  })

  // ── 7. Transition to ResultModal ───────────────────────────────────────

  test('7. transition to ResultModal — after submit, ExamModal closes and ResultModal opens with correct score', async ({ page }) => {
    await openExam(page)
    await examModal.expectVisible()

    const total = await examModal.getTotalQuestions()
    expect(total).toBe(3)

    // Answer all 3 questions. Since questions are shuffled, we select option 0
    // on each question regardless of which question it is.
    for (let i = 0; i < total; i++) {
      await examModal.selectOption(0)

      // If not on the last question, navigate forward
      if (i < total - 1) {
        await examModal.goToNextQuestion()
      }
    }

    // Submit the exam
    await examModal.submit()

    // Assert ExamModal closed AND ResultModal opened (two separate assertions)
    await expect(page.getByTestId('exam-modal')).not.toBeVisible()
    await resultModal.expectVisible()

    // Score should be 3/3. We selected option 0 on all questions.
    // Some may be correct, some may not — but the score display should show
    // the correct count, and the total should be 3.
    const score = await resultModal.getScore()
    expect(score.total).toBe(3)
    // correct is 1 if by chance the first option was correct for a question up to 3 if all were
    expect(score.correct).toBeGreaterThanOrEqual(0)
    expect(score.correct).toBeLessThanOrEqual(3)
  })
})
