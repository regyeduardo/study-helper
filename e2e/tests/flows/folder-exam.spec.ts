import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'
import { ExamModal } from '../../pages/ExamModal'
import { ResultModal } from '../../pages/ResultModal'

/**
 * End-to-end flow test for the folder exam (aggregated questions across files).
 *
 * Tests the complete cycle:
 *   1. Create a folder + 2 files with 2 questions each via API (setup)
 *   2. Open the File Manager UI
 *   3. Click the "Prova da pasta" button on the folder row
 *   4. Verify FolderExamDialog shows 4 total questions
 *   5. Click "Todas (4)" to start the aggregated exam
 *   6. Verify ExamModal opens with "Questão 1 de 4" (confirms aggregation)
 *   7. Answer 3 questions correctly and 1 incorrectly (deterministic)
 *   8. Submit the exam
 *   9. Verify ResultModal shows score 3/4
 *  10. Close ResultModal
 *  11. Verify no modals remain open
 *
 * @see .issues/20260516-002-e2e-playwright-tests/031-flow-folder-exam.md
 */
test.describe('Flow: folder exam (aggregated questions)', () => {
  let folderId: string
  let file1Id: string
  let file2Id: string

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('full pipeline: API setup → folder exam with 4 aggregated questions → verify score 3/4 → close', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder + 2 files with 2 questions each ─────────
    const folder = await apiHelpers.createFolder('Pasta Exam Folder')
    folderId = folder.id

    const file1 = await apiHelpers.createFile({
      name: 'Aula 1',
      folderId,
      content: '# Aula 1\n\nConteúdo da aula 1 para estudo.',
      file_type: 'class',
    })
    file1Id = file1.id

    const file2 = await apiHelpers.createFile({
      name: 'Aula 2',
      folderId,
      content: '# Aula 2\n\nConteúdo da aula 2 para estudo.',
      file_type: 'class',
    })
    file2Id = file2.id

    // Create 2 questions per file (total: 4 questions across the folder)
    //   Aula 1: Q1 correctIndex=0 (A), Q2 correctIndex=1 (B)
    //   Aula 2: Q3 correctIndex=0 (A), Q4 correctIndex=1 (B)
    await apiHelpers.createQuestionsBulk(file1Id, [
      {
        question: 'Qual é a capital do Brasil?',
        options: [
          'Brasília',
          'Rio de Janeiro',
          'São Paulo',
          'Salvador',
          'Fortaleza',
        ],
        correctIndex: 0, // A is correct
      },
      {
        question: 'Quanto é 2 + 2?',
        options: [
          '3',
          '4',
          '5',
          '6',
          '7',
        ],
        correctIndex: 1, // B is correct
      },
    ])
    await apiHelpers.createQuestionsBulk(file2Id, [
      {
        question: 'Qual a cor do céu?',
        options: [
          'Verde',
          'Vermelho',
          'Azul',
          'Amarelo',
          'Preto',
        ],
        correctIndex: 0, // A is correct (but labeled as "Verde" — this is just for deterministic testing)
      },
      {
        question: 'Quantos lados tem um quadrado?',
        options: [
          '3',
          '4',
          '5',
          '6',
          '8',
        ],
        correctIndex: 1, // B is correct
      },
    ])

    // ── 2. Open File Manager ────────────────────────────────────────────
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()

    // ── 3. Click "Prova da pasta" on the folder row ─────────────────────
    // The button only appears on hover (group-hover:flex). Playwright's
    // click does an implicit hover, but we hover explicitly for reliability.
    const folderRow = page
      .locator('[data-testid="folder-row"]')
      .filter({ hasText: 'Pasta Exam Folder' })
    await folderRow.hover()
    await page.getByTitle('Prova da pasta').click()

    // ── 4. FolderExamDialog appears with total count ────────────────────
    await expect(page.getByText(/4 questão/)).toBeVisible({ timeout: 5_000 })

    // ── 5. Click "Todas (4)" to start exam with all aggregated questions ─
    await page.getByRole('button', { name: /Todas.*4/ }).click()

    // ── 6. ExamModal opens with 4 questions ─────────────────────────────
    const examModal = new ExamModal(page)
    await examModal.expectVisible()

    // Wait for questions to render (progress testid appears)
    await expect(page.getByTestId('exam-progress')).toBeVisible({ timeout: 10_000 })

    // Confirm total is 4 (aggregation across both files)
    const totalQuestions = await examModal.getTotalQuestions()
    expect(totalQuestions).toBe(4)

    // Confirm progress starts at "Questão 1 de 4"
    const currentNum = await examModal.getCurrentQuestionNumber()
    expect(currentNum).toBe(1)

    // ── 7. Answer questions: 3 correct (Q1, Q2, Q3), 1 wrong (Q4) ──────
    // Question 1: correctIndex=0 → selectOption(0) ✓
    await examModal.selectOption(0)
    await examModal.expectOptionSelected(0)
    await examModal.goToNextQuestion()

    // Question 2: correctIndex=1 → selectOption(1) ✓
    await examModal.selectOption(1)
    await examModal.expectOptionSelected(1)
    await examModal.goToNextQuestion()

    // Question 3: correctIndex=0 → selectOption(0) ✓
    await examModal.selectOption(0)
    await examModal.expectOptionSelected(0)
    await examModal.goToNextQuestion()

    // Question 4: correctIndex=1 → selectOption(0) ✗ (intentionally wrong)
    await examModal.selectOption(0)
    await examModal.expectOptionSelected(0)

    // ── 8. Submit exam ──────────────────────────────────────────────────
    // On the last question, the button is "Finalizar" (exam-finish)
    await examModal.submit()

    // ── 9. ResultModal appears with score 3/4 ───────────────────────────
    const resultModal = new ResultModal(page)
    await resultModal.expectVisible()

    // 3 correct out of 4
    await resultModal.expectScore(3, 4)

    // ── 10. Close ResultModal ───────────────────────────────────────────
    await resultModal.close()

    // ── 11. Verify no modal is open ─────────────────────────────────────
    await expect(page.getByTestId('result-modal')).not.toBeVisible({
      timeout: 5_000,
    })
    await expect(page.getByTestId('exam-modal')).not.toBeVisible()
    await expect(page.getByTestId('result-modal')).not.toBeVisible()
  })

  test.afterEach(async ({ apiHelpers }) => {
    // Cleanup: delete questions, files, and folder (in order)
    // Questions must be deleted before files, files before the folder.
    if (file1Id) {
      await apiHelpers.deleteQuestion(file1Id).catch(() => {})
      await apiHelpers.deleteFile(file1Id).catch(() => {})
    }
    if (file2Id) {
      await apiHelpers.deleteQuestion(file2Id).catch(() => {})
      await apiHelpers.deleteFile(file2Id).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })
})
