import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'
import { OutputPanel } from '../../pages/OutputPanel'
import { ExamModal } from '../../pages/ExamModal'
import { ResultModal } from '../../pages/ResultModal'

/**
 * End-to-end flow test for taking an exam and viewing results.
 *
 * Tests the complete cycle:
 *   1. Create a lesson file + 3 questions via API (setup) inside a test folder
 *   2. Load the file through the File Manager UI (which also loads persisted questions)
 *   3. Click "Fazer Avaliação" from the Provas dock group
 *   4. Answer 2 questions correctly and 1 incorrectly (deterministic)
 *   5. Submit the exam
 *   6. Verify the ResultModal shows the correct score: 2/3
 *   7. Close the ResultModal
 *   8. Verify the app returns to normal state (no modal open)
 *
 * @see .issues/20260516-002-e2e-playwright-tests/023-flow-exam-and-results.md
 */
test.describe('Flow: exam and results', () => {
  let folderId: string
  let fileId: string

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('full pipeline: API setup → load file with questions → take exam → verify score → close results', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder + file with lesson content via API ──────────
    const folder = await apiHelpers.createFolder('Matemática')
    folderId = folder.id

    const file = await apiHelpers.createFile({
      name: 'algebra-linear.md',
      folderId,
      content: `# Álgebra Linear

## Vetores

Um vetor é uma entidade matemática que possui magnitude e direção.

## Matrizes

Matrizes são arranjos retangulares de números dispostos em linhas e colunas.

## Determinantes

O determinante é um valor escalar associado a uma matriz quadrada.

## Sistemas Lineares

Um sistema linear é um conjunto de equações lineares que compartilham as mesmas variáveis.`,
      file_type: 'class',
    })
    fileId = file.id

    // Create 3 questions with deterministic correct answers
    // correctIndex: 0 = A, 1 = B, 2 = C
    await apiHelpers.createQuestionsBulk(fileId, [
      {
        question: 'O que é um vetor?',
        options: [
          'Entidade matemática com magnitude e direção',
          'Um número inteiro',
          'Uma matriz quadrada',
          'Um sistema linear',
          'Uma equação diferencial',
        ],
        correctIndex: 0, // A is correct
      },
      {
        question: 'O que são matrizes?',
        options: [
          'Vetores com magnitude',
          'Arranjos retangulares de números em linhas e colunas',
          'Equações lineares',
          'Determinantes',
          'Espaços vetoriais',
        ],
        correctIndex: 1, // B is correct
      },
      {
        question: 'O que é um determinante?',
        options: [
          'Um sistema linear',
          'Um vetor unitário',
          'Valor escalar associado a uma matriz quadrada',
          'Uma equação linear',
          'Uma matriz identidade',
        ],
        correctIndex: 2, // C is correct
      },
    ])

    // ── 2. Load file via File Manager UI (also loads persisted questions) ───
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()

    await fileManager.openFolder('Matemática')
    await fileManager.expectFileExists('algebra-linear.md')
    await fileManager.selectFile('algebra-linear.md')

    // Wait for the file manager to close (handleSelectFileFromManager
    // loads content + questions into state and closes the modal)
    await expect(page.getByTestId('file-manager-modal')).not.toBeVisible({
      timeout: 10_000,
    })

    // ── 3. Verify content loaded in OutputPanel ───────────────────────────
    const outputPanel = new OutputPanel(page)
    await outputPanel.expectContentContains('Álgebra Linear')
    await outputPanel.expectContentContains('Vetores')
    await outputPanel.expectContentContains('Matrizes')

    // ── 4. Start exam via "Provas" dock group ─────────────────────────────
    // Clicks "Provas" then "Fazer Avaliação"
    await outputPanel.clickStartExam()

    // ── 5. ExamModal should open with questions loaded ────────────────────
    const examModal = new ExamModal(page)
    await examModal.expectVisible()

    // Wait for questions to render (progress testid appears)
    await expect(page.getByTestId('exam-progress')).toBeVisible({ timeout: 10_000 })

    const totalQuestions = await examModal.getTotalQuestions()
    expect(totalQuestions).toBe(3)

    // ── 6. Answer questions deterministically ─────────────────────────────
    // Question 1: correctIndex=0 → A is correct → selectOption(0) ✓
    await examModal.selectOption(0)
    await examModal.expectOptionSelected(0)
    await examModal.goToNextQuestion()

    // Question 2: correctIndex=1 → B is correct → selectOption(1) ✓
    await examModal.selectOption(1)
    await examModal.expectOptionSelected(1)
    await examModal.goToNextQuestion()

    // Question 3: correctIndex=2 → C is correct → selectOption(0) ✗ (intentionally wrong)
    await examModal.selectOption(0)
    await examModal.expectOptionSelected(0)

    // ── 7. Submit exam ────────────────────────────────────────────────────
    // On the last question, the button is "Finalizar" (exam-finish)
    await examModal.submit()

    // ── 8. ResultModal appears with correct score ─────────────────────────
    const resultModal = new ResultModal(page)
    await resultModal.expectVisible()

    // Score should reflect 2 correct out of 3
    await resultModal.expectScore(2, 3)

    // ── 9. Close ResultModal ──────────────────────────────────────────────
    await resultModal.close()

    // Wait for the modal to fully close
    await expect(page.getByTestId('result-modal')).not.toBeVisible({
      timeout: 5_000,
    })

    // ── 10. Verify no modal is open ───────────────────────────────────────
    await expect(page.getByTestId('exam-modal')).not.toBeVisible()
    await expect(page.getByTestId('result-modal')).not.toBeVisible()
  })

  test.afterEach(async ({ apiHelpers }) => {
    // Cleanup: delete questions, file, and folder (in order)
    if (fileId) {
      await apiHelpers.deleteQuestion(fileId).catch(() => {})
      await apiHelpers.deleteFile(fileId).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })
})
