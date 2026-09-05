import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'
import { OutputPanel } from '../../pages/OutputPanel'

/**
 * End-to-end flow test for exporting a single file as ZIP download
 * via the OutputPanel's action bar.
 *
 * Tests the complete cycle:
 *   1. Create a folder and a file with markdown content via API (setup)
 *   2. Create questions for the file so the "Baixar aula + questões (.zip)"
 *      button is enabled
 *   3. Open the file in the OutputPanel via File Manager
 *   4. Click "Exportar" → "Baixar aula + questões (.zip)" in the dock
 *   5. Intercept the download and verify:
 *      - The file extension is .zip
 *      - The filename contains the original file's name
 *   6. Clean up (teardown): delete file, questions, and folder
 *
 * @see .issues/20260516-002-e2e-playwright-tests/027-flow-export-zip-download.md
 */
test.describe('Flow: export single file as ZIP download', () => {
  let folderId: string
  let fileId: string
  let fileName: string

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('create file → open in OutputPanel → export ZIP → verify download', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder + file with content ────────────────────
    const folder = await apiHelpers.createFolder('Export Zip Test')
    folderId = folder.id

    fileName = 'Fotossíntese'
    const file = await apiHelpers.createFile({
      name: `${fileName}.md`,
      folderId,
      content: `# ${fileName}\n\nA fotossíntese é o processo pelo qual plantas convertem luz solar em energia química.\n\n## Etapas\n\n1. Fase clara (fotoquímica)\n2. Fase escura (Calvin)`,
      file_type: 'class',
    })
    fileId = file.id

    // Create questions so the "Baixar aula + questões (.zip)" button is enabled
    await apiHelpers.createQuestionsBulk(fileId, [
      {
        question: 'O que é fotossíntese?',
        options: [
          'Processo de respiração celular',
          'Processo de conversão de luz em energia química',
          'Processo de fermentação',
          'Processo de decomposição',
          'Processo de transpiração',
        ],
        correctIndex: 1,
      },
      {
        question: 'Qual gás é liberado na fotossíntese?',
        options: [
          'Gás carbônico',
          'Nitrogênio',
          'Oxigênio',
          'Hidrogênio',
          'Metano',
        ],
        correctIndex: 2,
      },
    ])

    // ── 2. Open file in OutputPanel via File Manager ───────────────────
    const fileManager = new FileManagerModal(page)
    const outputPanel = new OutputPanel(page)

    await fileManager.open()
    await fileManager.expectVisible()

    // Navigate into the folder
    await fileManager.openFolder(folder.name)

    // Click the file to load it in the OutputPanel
    // This triggers onSelectFile → handleSelectFileFromManager → loads content + closes modal
    await fileManager.selectFile(`${fileName}.md`)

    // Wait for File Manager to close and content to appear
    await expect(
      page.getByText('O resultado aparecerá aqui após o processamento.'),
    ).not.toBeVisible({ timeout: 10_000 })

    // Verify content is loaded
    await outputPanel.expectContentContains('Fotossíntese')

    // ── 3. Export ZIP via dock ─────────────────────────────────────────
    // The "Baixar aula + questões (.zip)" button is inside the "Exportar"
    // dock group popover. It's enabled because we created questions above.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      outputPanel.clickExportZip(),
    ])

    // ── 4. Verify the download ─────────────────────────────────────────
    const suggestedFilename = download.suggestedFilename()
    expect(suggestedFilename).toMatch(/\.zip$/)
    // Case-insensitive check: the server lowercases the filename
    expect(suggestedFilename.toLowerCase()).toContain(fileName.toLowerCase())
  })

  test.afterEach(async ({ apiHelpers }) => {
    // Cleanup: delete questions, file, then folder
    if (fileId) {
      await apiHelpers.deleteQuestion(fileId).catch(() => {})
      await apiHelpers.deleteFile(fileId).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })
})
