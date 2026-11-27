import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { NewContentModal } from '../../pages/NewContentModal'
import { LiveModeView } from '../../pages/LiveModeView'
import { FileManagerModal } from '../../pages/FileManagerModal'

/**
 * End-to-end flow test for saving content after live mode (SSE streaming).
 *
 * Tests the complete cycle:
 *   1. Create a folder via API (setup)
 *   2. Execute the live mode flow (upload → submit → realtime → stream until complete)
 *   3. With streaming complete, click "Salvar aula" on the LiveModeView
 *   4. The save modal appears — fill file name and select the folder
 *   5. Confirm the save
 *   6. Verify the save modal closes
 *   7. Open File Manager, navigate to the folder, verify a file row is visible
 *   8. Verify via API (GET /files) that the file was persisted with:
 *      - Correct folder_id
 *      - Non-empty content
 *   9. Teardown: delete the file and folder
 *
 * @see .issues/20260516-002-e2e-playwright-tests/029-flow-save-after-live-mode.md
 */
test.describe('Flow: save content after live mode streaming', () => {
  let folderId: string
  let savedFileId: string | undefined

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('live mode stream → save → verify persistence via dock and API', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder via API ──────────────────────────────
    const folder = await apiHelpers.createFolder('Química')
    folderId = folder.id

    // ── 2. Execute live mode flow until streaming completes ──────────
    const modal = new NewContentModal(page)
    await modal.open()
    await modal.expectVisible()
    // NOTE: escolher o tipo primeiro — isso avança o passo e reseta a origem
    // and clears selectedFile, so uploading after avoids state loss
    await modal.selectAgent('aula')
    await modal.uploadFile('fixtures/sample-upload.txt')
    await modal.next()
    await modal.submit()
    await modal.expectHidden()

    // Choose real-time streaming option (GenerationModeModal)
    await page.getByTestId('realtime-option').click()

    // Wait for streaming to complete
    const liveView = new LiveModeView(page)
    await liveView.expectVisible()
    await liveView.waitForStreamingToComplete()

    // Verify content is non-empty before saving
    const content = await liveView.getPartialContent()
    expect(content).not.toBe('')

    // ── 3. Click "Salvar aula" on LiveModeView ──────────────────────
    await liveView.clickSave()

    // ── 4. Save modal appears — fill file name ──────────────────────
    await liveView.expectSaveModalVisible()
    await liveView.fillSaveFileName('Aula de Química')

    // ── 5. Select the folder created in setup ───────────────────────
    await liveView.fillSaveFolderName('Química')

    // ── 6. Confirm save ─────────────────────────────────────────────
    await liveView.confirmSave()

    // ── 7. Verify save modal closes ─────────────────────────────────
    await expect(
      page.getByRole('heading', { name: /salvar aula/i }),
    ).not.toBeVisible({ timeout: 5_000 })

    // ── 8. Verify file appears in dock inside the folder ────────────
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()
    await fileManager.openFolder('Química')

    // Verify at least one file row is visible inside the folder
    await expect(page.locator('[data-testid="file-row"]').first()).toBeVisible()

    // ── 9. Verify via API that file was persisted ───────────────────
    savedFileId = await apiHelpers.expectFileSavedInFolder(folderId)

    // Close the File Manager
    await fileManager.close()
  })

  test.afterEach(async ({ apiHelpers }) => {
    // Teardown: delete file first, then folder
    if (savedFileId) {
      await apiHelpers.deleteFile(savedFileId).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })
})
