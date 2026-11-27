import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { OutputPanel } from '../../pages/OutputPanel'
import { FileManagerModal } from '../../pages/FileManagerModal'

/**
 * End-to-end flow test for regenerating content of an existing file.
 *
 * Tests the complete cycle:
 *   1. Create a folder + file with initial content via API (setup)
 *   2. Open the file in the dock to display content in OutputPanel
 *   3. Verify that the initial content is visible
 *   4. Click "Regenerar" in the action bar
 *   5. Wait for the new content to be generated (in TEST_MODE the fixture
 *      data is returned, so content may be identical — that's acceptable)
 *   6. Verify that OutputPanel displays content (non-empty)
 *   7. Verify via API (GET /files/:id) that updated_at changed
 *   8. Verify the file still exists in the same folder
 *
 * @see .issues/20260516-002-e2e-playwright-tests/032-flow-regenerate-content.md
 */
test.describe('Flow: regenerate content', () => {
  let folderId: string
  let fileId: string

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('file exists → click Regenerar → content regenerated → verify updated_at via API', async ({ page, apiHelpers }) => {
    // ── 1. Setup: create folder + file via API ─────────────────────────
    const folder = await apiHelpers.createFolder('Regen Test Folder')
    folderId = folder.id

    const initialContent = '# Conteúdo Inicial\n\nTexto original antes da regeneração.'
    const file = await apiHelpers.createFile({
      name: 'Artigo Regen',
      folderId,
      content: initialContent,
      file_type: 'class',
    })
    fileId = file.id

    // Fetch the file to get the initial updated_at timestamp
    const initialFile = await apiHelpers.getFileById(fileId)
    const initialUpdatedAt = initialFile.updated_at

    // ── 2. Open file via File Manager to load it in OutputPanel ────────
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()

    await fileManager.openFolder('Regen Test Folder')

    // Click the file row to load its content into OutputPanel.
    // handleSelectFileFromManager closes the modal automatically.
    const fileRow = page
      .locator('[data-testid="file-row"]')
      .filter({ hasText: 'Artigo Regen' })
    await fileRow.click()

    // ── 3. Verify initial content is visible in OutputPanel ─────────────
    const outputPanel = new OutputPanel(page)
    await outputPanel.expectContentVisible()
    await outputPanel.expectContentContains('Conteúdo Inicial')

    // ── 4. Click "Regenerar" button in the ActionBar ───────────────────
    await outputPanel.clickRegenerateContent()

    // ── 5. Wait for regeneration to complete ───────────────────────────
    // The button text changes to "Regenerando..." while processing.
    // Wait for "Regenerar" text to reappear, signalling completion.
    const regenerateBtn = page.getByTestId('regenerate-content')
    await expect(regenerateBtn).toBeVisible({ timeout: 15_000 })
    await expect(regenerateBtn).toContainText('Regenerar', { timeout: 15_000 })

    await outputPanel.expectContentVisible()

    // ── 6. Verify OutputPanel displays non-empty content ────────────────
    const content = await outputPanel.getContent()
    expect(content).not.toBe('')

    // ── 7. Verify via API that updated_at changed ──────────────────────
    const updatedFile = await apiHelpers.getFileById(fileId)
    expect(updatedFile.updated_at).not.toBe(initialUpdatedAt)

    // ── 8. Verify the file still exists in the same folder ─────────────
    expect(updatedFile.folder_id).toBe(folderId)
    expect(updatedFile.name).toBe('Artigo Regen')
  })

  test.afterEach(async ({ apiHelpers }) => {
    // Cleanup: delete file first, then folder
    if (fileId) {
      await apiHelpers.deleteFile(fileId).catch(() => {})
    }
    if (folderId) {
      await apiHelpers.deleteFolder(folderId).catch(() => {})
    }
  })
})
