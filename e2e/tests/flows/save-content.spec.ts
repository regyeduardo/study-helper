import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { NewContentModal } from '../../pages/NewContentModal'
import { OutputPanel } from '../../pages/OutputPanel'
import { FileManagerModal } from '../../pages/FileManagerModal'

/**
 * End-to-end flow test for saving generated content to a file inside a folder.
 *
 * Tests the complete cycle:
 *   1. Create a folder via API (setup)
 *   2. Gera uma explicação a partir de um tema
 *   3. With content visible in OutputPanel, click "Salvar em..."
 *   4. Select the folder created in setup
 *   5. Verify the save indicator appears (instead of "Não salvo")
 *   6. Open File Manager, navigate to the folder, verify the file appears
 *   7. Verify via API (GET /files) that the file was persisted with:
 *      - Correct folder_id
 *      - Non-empty content
 *   8. Teardown: delete the file and folder
 *
 * @see .issues/20260516-002-e2e-playwright-tests/024-flow-save-content-to-file-folder.md
 */
test.describe('Flow: save content to file/folder', () => {
  let folderId: string
  let savedFileId: string | undefined

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('generate lesson → save to folder → verify save indicator → verify file in dock → verify via API', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder via API ──────────────────────────────
    const folder = await apiHelpers.createFolder('Biologia')
    folderId = folder.id

    // ── 2. Gera explicação a partir de um tema ───────────────────────
    const modal = new NewContentModal(page)
    const outputPanel = new OutputPanel(page)

    await modal.open()
    await modal.expectVisible()
    await modal.selectAgent('explicacao')
    await modal.selectMode('topic')
    await modal.fillTopic('Fotossíntese')
    await modal.next()
    await modal.submit()
    await modal.expectHidden()

    // Wait for content to be generated and visible (30s timeout for VCR processing)
    await expect(
      page.getByText('O resultado aparecerá aqui após o processamento.'),
    ).not.toBeVisible({ timeout: 30_000 })

    // Verify content is non-empty
    const content = await outputPanel.getContent()
    expect(content).not.toBe('')

    // ── 3. Save to folder ────────────────────────────────────────────
    // Click "Salvar em..." in the ActionBar's SaveFolderSelector
    await page.getByRole('button', { name: /Salvar em/i }).click()
    // Select the "Biologia" folder from the dropdown
    await page.getByRole('button', { name: 'Biologia' }).click()

    // ── 4. Verify the save indicator appears ─────────────────────────
    // After saving, the "Salvar em..." button is replaced by a folder
    // indicator showing the folder name. The "Não salvo" text disappears.
    await expect(page.getByText('Não salvo')).not.toBeVisible({ timeout: 10_000 })

    // ── 5. Verify file appears in File Manager inside the folder ─────
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()

    await fileManager.openFolder('Biologia')

    // Verify at least one file row is visible inside the folder
    await expect(page.locator('[data-testid="file-row"]').first()).toBeVisible()

    // ── 6. Verify via API that the file was persisted ────────────────
    savedFileId = await apiHelpers.expectFileSavedInFolder(folderId)

    // Close the File Manager
    await fileManager.close()
  })

  test.afterEach(async ({ apiHelpers }) => {
    // Cleanup: delete file first, then folder
    if (savedFileId) {
      await apiHelpers.deleteFile(savedFileId).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })
})
