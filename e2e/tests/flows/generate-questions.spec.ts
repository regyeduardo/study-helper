import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'
import { OutputPanel } from '../../pages/OutputPanel'
import { ExamModal } from '../../pages/ExamModal'

/**
 * End-to-end flow test for the question generation pipeline.
 *
 * Tests the complete cycle:
 *   1. Create a lesson file via API (setup) inside a test folder
 *   2. Load it through the File Manager UI
 *   3. Click "Gerar Prova" from the Provas dock group
 *   4. Wait for the ExamModal to appear with generated questions
 *   5. Verify that questions have been persisted via the question API
 *   6. Interact with a question (select an option)
 *
 * Runs with TEST_MODE=true so the generate-content backend uses
 * fixture responses instead of real DeepSeek calls.
 *
 * @see .issues/20260516-002-e2e-playwright-tests/022-flow-generate-questions.md
 */
test.describe('Flow: generate questions from lesson content', () => {
  let folderId: string
  let fileId: string

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('full pipeline: API setup → load file → generate questions → verify UI + API', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder + file with lesson content via API ──────
    const folder = await apiHelpers.createFolder('Programação')
    folderId = folder.id

    const file = await apiHelpers.createFile({
      name: 'programacao-js.md',
      folderId,
      content: `# Introdução à Programação com JavaScript

## Variáveis

Em JavaScript, usamos \`let\`, \`const\` e \`var\` para declarar variáveis.

- \`let\`: permite reatribuição, escopo de bloco
- \`const\`: não permite reatribuição, escopo de bloco
- \`var\`: escopo de função (menos usado modernamente)

## Tipos de Dados

JavaScript possui tipos primitivos: string, number, boolean, null, undefined, symbol, bigint.

## Estruturas de Controle

Usamos \`if\`, \`else\`, \`for\`, \`while\` para controlar o fluxo do programa.

## Funções

Funções são blocos de código reutilizáveis. Podem ser declaradas com \`function\` ou como arrow functions.

## Operadores

Operadores aritméticos: +, -, *, /, %.
Operadores de comparação: ===, !==, >, <, >=, <=.
Operadores lógicos: &&, ||, !.`,
      file_type: 'class',
    })
    fileId = file.id

    // ── 2. Load file via File Manager UI ─────────────────────────────────
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()

    // Navigate into the folder and select the file
    await fileManager.openFolder('Programação')
    await fileManager.expectFileExists('programacao-js.md')
    await fileManager.selectFile('programacao-js.md')

    // Wait for the file manager to close (handleSelectFileFromManager
    // loads content into OutputPanel and closes the modal)
    await expect(page.getByTestId('file-manager-modal')).not.toBeVisible({
      timeout: 10_000,
    })

    // ── 3. Verify content loaded in OutputPanel ──────────────────────────
    const outputPanel = new OutputPanel(page)
    await outputPanel.expectContentContains('Introdução à Programação')
    await outputPanel.expectContentContains('Variáveis')
    await outputPanel.expectContentContains('Funções')

    // ── 4. Trigger question generation via "Provas" dock group ───────────
    // Clicks "Provas" then "Gerar Prova" button via the OutputPanel page object
    await outputPanel.clickGenerateQuestions()

    // ── 5. ExamModal should open and load questions ──────────────────────
    const examModal = new ExamModal(page)
    await examModal.expectVisible()

    // Wait for questions to finish loading — the progress testid
    // (e.g. "Questão 1 de 5") appears once questions are rendered.
    // Allow up to 60s for the two-step DeepSeek pipeline to complete.
    await expect(page.getByTestId('exam-progress')).toBeVisible({ timeout: 60000 })

    const totalQuestions = await examModal.getTotalQuestions()
    expect(totalQuestions).toBeGreaterThan(0)
    expect(totalQuestions).toBeLessThanOrEqual(10)

    // Verify question text renders with a non-empty statement
    const questionText = await examModal.getCurrentQuestionText()
    expect(questionText.length).toBeGreaterThan(0)

    // ── 6. Verify questions were persisted via API ───────────────────────
    // The backend persists questions in a goroutine after returning,
    // so we poll until they appear or timeout.
    await expect(async () => {
      const questions = await apiHelpers.getQuestions(fileId)
      expect(questions.length).toBe(totalQuestions)
    }).toPass({ timeout: 15000 })

    // Verify first question has the expected shape
    const questions = await apiHelpers.getQuestions(fileId)
    const first = questions[0]
    expect(first.statement).toBeTruthy()
    expect(first.alternative_a).toBeTruthy()
    expect(first.right_alternative).toMatch(/^[A-E]$/)

    // ── 7. Interact with a question ──────────────────────────────────────
    // Select the first option (A) and verify it's visually selected
    await examModal.selectOption(0)
    await examModal.expectOptionSelected(0)

    // ── 8. Cleanup ───────────────────────────────────────────────────────
  })

  test.afterEach(async ({ apiHelpers }) => {
    if (fileId) {
      await apiHelpers.deleteFile(fileId).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })
})
