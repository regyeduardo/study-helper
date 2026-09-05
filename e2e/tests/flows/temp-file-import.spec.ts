import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'

/**
 * End-to-end flow test for importing a file as temporary content and saving it as permanent.
 *
 * ── Discovery ────────────────────────────────────────────────────────────────────
 *
 * The app has TWO import mechanisms from the dock's "Importar" group:
 *
 *   1. "Carregar conteúdo" → handleLoadContent() → api.loadContentFile(file)
 *      → POST /api/v1/imports/preview  (NestJS file-management, no DB persistence)
 *      The backend extracts markdown from .md or .zip and returns { markdown: "..." }
 *      WITHOUT saving to DB. The content appears in the OutputPanel with savedFileId=null
 *      (ephemeral / "temporary" state).
 *
 *   2. "Importar (.md/.zip)" → handleImport() → api.importFile(file)
 *      → POST /api/import  (Go generate-content, no DB persistence)
 *      Same behavior: returns markdown without persisting.
 *
 * After either import, the ActionBar shows "Não salvo" (not saved) and a "Salvar em..."
 * button. The user can then select a folder and permanently persist via:
 *      handleSaveToFolder() → api.createFile() → POST /api/v1/files  (NestJS)
 *
 * This test uses path #1 ("Carregar conteúdo").
 *
 * ── API endpoints involved ────────────────────────────────────────────────────────
 *
 *   POST /api/v1/imports/preview   — upload .md/.zip, returns markdown (no persist)
 *   GET  /api/folders               — list folders (for "Salvar em..." dropdown)
 *   POST /api/v1/files             — create permanent file
 *   GET  /api/v1/files             — verify file was persisted
 *   GET  /api/v1/temp-files        — (not used here; temp_file is a different concept)
 *
 * ── Test plan ─────────────────────────────────────────────────────────────────────
 *
 *   1. Create a folder via API (setup)
 *   2. Navigate to the app
 *   3. Open the dock "Importar" group
 *   4. Click "Carregar conteúdo"
 *   5. Upload sample-import.md via the file chooser
 *   6. Verify the markdown content appears in the OutputPanel
 *   7. Verify the UI shows "Não salvo" (temporary state indicator)
 *   8. Click "Salvar em..." and select the folder created in step 1
 *   9. Open File Manager, navigate to the folder, verify a file row is visible
 *  10. Verify via API (GET /files) that the file was persisted with correct folder_id
 *  11. Teardown: delete the file and folder
 *
 * @see .issues/20260516-002-e2e-playwright-tests/030-flow-temp-file-import-restore.md
 */
test.describe('Flow: temp file import and restore', () => {
  let folderId: string
  let savedFileId: string | undefined

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  test('import .md via "Carregar conteúdo" → verify temp state → save permanently → verify via dock and API', async ({
    page,
    apiHelpers,
  }) => {
    // ── 1. Setup: create folder via API ──────────────────────────────
    const folder = await apiHelpers.createFolder('Import Test')
    folderId = folder.id

    // ── 2. Open dock "Importar" group popover ────────────────────────
    // The dock "Importar" group button has aria-label "Importar"
    const importButton = page.getByRole('button', { name: 'Importar' })
    await importButton.click()

    // ── 3. Click "Carregar conteúdo" in the popover ──────────────────
    // This triggers a hidden <input type="file"> click
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: /carregar conteúdo/i }).click()
    const fileChooser = await fileChooserPromise

    // ── 4. Upload the sample-import.md fixture ───────────────────────
    await fileChooser.setFiles('fixtures/sample-import.md')

    // ── 5. Wait for the loading overlay to appear and disappear ──────
    // The app shows "Carregando conteúdo..." during the API call
    // Use .first() because the text may appear both in the NotificationBar and
    // the LoadingOverlay simultaneously
    await expect(page.getByText(/carregando conteúdo/i).first()).not.toBeVisible({ timeout: 15_000 })

    // ── 6. Verify markdown content appeared in OutputPanel ───────────
    // The OutputPanel renders the markdown via the MarkdownViewer component.
    // We look for a heading/text that comes from the fixture.
    await expect(
      page.locator('[data-color-mode="dark"].wmde-markdown-var'),
    ).toBeVisible({ timeout: 5_000 })

    // Verify the content includes the first heading from sample-import.md
    await expect(page.getByText('Introdução à Programação')).toBeVisible()

    // ── 7. Verify "Não salvo" indicator is visible ───────────────────
    // When content is loaded without being saved, the ActionBar shows "Não salvo".
    // This confirms the content is in temporary (ephemeral) state.
    await expect(page.getByText('Não salvo')).toBeVisible()

    // ── 8. Click "Salvar em..." and select the folder ────────────────
    // The "Salvar em..." button appears because hasContent && !savedFileId
    await page.getByRole('button', { name: /salvar em/i }).click()

    // The dropdown should now be visible with the folder list
    await expect(page.getByRole('button', { name: 'Import Test' })).toBeVisible()

    // Select the "Import Test" folder
    await page.getByRole('button', { name: 'Import Test' }).click()

    // Wait for save to complete — the "Salvar em..." button disappears
    // and the file indicator changes to "Import Test" folder
    await expect(
      page.getByRole('button', { name: /salvar em/i }),
    ).not.toBeVisible({ timeout: 10_000 })

    // ── 9. Verify file appears in dock File Manager ──────────────────
    const fileManager = new FileManagerModal(page)
    await fileManager.open()
    await fileManager.expectVisible()
    await fileManager.openFolder('Import Test')

    // Verify at least one file row is visible inside the folder
    await expect(page.locator('[data-testid="file-row"]').first()).toBeVisible()

    // ── 10. Verify via API that file was persisted ───────────────────
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
