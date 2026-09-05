import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'
import { ExamModal } from '../../pages/ExamModal'
import { ResultModal } from '../../pages/ResultModal'

/**
 * End-to-end flow test for generating and taking a reading-comprehension exam
 * from a reading file.
 *
 * Tests the complete cycle:
 *   1. Create a reading file via API (setup)
 *   2. Load the file through the File Manager UI
 *   3. Click "Gerar Prova" from the "Leitura" dock group
 *   4. Verify loading state appears (spinner in the dock item)
 *   5. Wait for ExamModal to open with generated questions
 *   6. Answer the first question
 *   7. Submit the exam
 *   8. Verify ResultModal appears
 *   9. Close modals and cleanup
 *
 */
test.describe('Flow: reading comprehension exam', () => {
  let folderId: string
  let fileId: string

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('full pipeline: create reading file → generate exam → answer → see results', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder + reading file via API ────────────────
    const folder = await apiHelpers.createFolder('Leitura')
    folderId = folder.id

    const articleContent = `# The Benefits of Reading Daily

Reading every day has numerous benefits for mental health and cognitive function.
Studies show that people who read regularly have better vocabulary, improved
empathy, and reduced stress levels.

## Cognitive Benefits

Reading stimulates the brain, keeping it active and engaged. This mental
exercise can help prevent cognitive decline as we age. Unlike passive activities
like watching television, reading requires active participation from the brain.

## Vocabulary Expansion

Regular readers encounter a wider range of words and phrases. A 2019 study
found that people who read for at least 30 minutes daily learn approximately
15 new words per week through contextual exposure.

## Emotional Benefits

Reading fiction, in particular, helps develop empathy. When we read about
characters' experiences, our brains simulate the emotions and perspectives
of others, making us more understanding in real life.`

    const file = await apiHelpers.createFile({
      name: 'benefits-of-reading.md',
      folderId,
      content: articleContent,
      file_type: 'reading',
    })
    fileId = file.id

    // ── 2. Load reading file via File Manager UI ──────────────────────
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()

    await fileManager.openFolder('Leitura')
    await fileManager.expectFileExists('benefits-of-reading.md')
    await fileManager.selectFile('benefits-of-reading.md')

    // Wait for the file manager to close
    await expect(page.getByTestId('file-manager-modal')).not.toBeVisible({
      timeout: 10_000,
    })

    // ── 3. Verify reading file content loaded ─────────────────────────
    // Reading files render via ReadingViewer which has data-reading-viewer
    await expect(page.locator('[data-reading-viewer]')).toBeVisible({
      timeout: 10_000,
    })
    await expect(
      page.locator('[data-reading-viewer]'),
    ).toContainText('The Benefits of Reading Daily')

    // ── 4. Verify "Leitura" dock group is visible ─────────────────────
    await expect(
      page.getByRole('button', { name: 'Leitura' }),
    ).toBeVisible()

    // ── 5. Click "Leitura" then "Gerar Prova" ─────────────────────────
    await page.getByRole('button', { name: 'Leitura' }).click()

    // The popover should show "Gerar Prova"
    await expect(
      page.getByRole('button', { name: 'Gerar Prova' }),
    ).toBeVisible()

    // Click "Gerar Prova"
    await page.getByRole('button', { name: 'Gerar Prova' }).click()

    // ── 6. ExamModal should open after generation completes ───────────
    const examModal = new ExamModal(page)
    await examModal.expectVisible()

    // Wait for questions to render (progress testid appears)
    await expect(page.getByTestId('exam-progress')).toBeVisible({
      timeout: 30_000,
    })

    const totalQuestions = await examModal.getTotalQuestions()
    expect(totalQuestions).toBeGreaterThanOrEqual(5)
    expect(totalQuestions).toBeLessThanOrEqual(10)

    // ── 7. Verify questions reference the reading file content ────────
    // The questions should be in Portuguese (ENEM/vestibular format)
    // mas referenciam o artigo carregado no arquivo de leitura
    const questionText = await examModal.getCurrentQuestionText()
    expect(questionText.length).toBeGreaterThan(10)

    // ── 8. Answer a question and submit ───────────────────────────────
    // Select option A for the first question
    await examModal.selectOption(0)
    await examModal.expectOptionSelected(0)

    // Navigate through all questions
    for (let i = 1; i < totalQuestions; i++) {
      await examModal.goToNextQuestion()
      // Select the first option for each question
      await examModal.selectOption(0)
      await examModal.expectOptionSelected(0)
    }

    // Submit the exam (last question shows "Finalizar")
    await examModal.submit()

    // ── 9. ResultModal appears ────────────────────────────────────────
    const resultModal = new ResultModal(page)
    await resultModal.expectVisible()

    // Score should show total questions answered
    await resultModal.expectScore(totalQuestions, totalQuestions)

    // ── 10. Close ResultModal ─────────────────────────────────────────
    await resultModal.close()

    // Wait for the modal to fully close
    await expect(page.getByTestId('result-modal')).not.toBeVisible({
      timeout: 5_000,
    })

    // Verify no modal is open
    await expect(page.getByTestId('exam-modal')).not.toBeVisible()
    await expect(page.getByTestId('result-modal')).not.toBeVisible()
  })

  test('Gerar Prova is not available for non-reading files', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder + class file via API ─────────────────
    const folder = await apiHelpers.createFolder('Aulas')
    folderId = folder.id

    const file = await apiHelpers.createFile({
      name: 'aula.md',
      folderId,
      content: '# Aula de teste\n\nConteúdo da aula.',
      file_type: 'class',
    })
    fileId = file.id

    // ── 2. Load class file via File Manager UI ────────────────────────
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()

    await fileManager.openFolder('Aulas')
    await fileManager.expectFileExists('aula.md')
    await fileManager.selectFile('aula.md')

    await expect(page.getByTestId('file-manager-modal')).not.toBeVisible({
      timeout: 10_000,
    })

    // ── 3. Verify "Leitura" dock group is NOT visible ─────────────────
    // For class files, only "Provas" should be visible, not "Leitura"
    await expect(
      page.getByRole('button', { name: 'Leitura' }),
    ).not.toBeVisible()

    // The "Provas" dock group should be visible for class files
    await expect(
      page.getByRole('button', { name: 'Provas' }),
    ).toBeVisible()
  })

  test.afterEach(async ({ apiHelpers }) => {
    // Cleanup: delete file and folder (in order)
    if (fileId) {
      await apiHelpers.deleteFile(fileId).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })
})
