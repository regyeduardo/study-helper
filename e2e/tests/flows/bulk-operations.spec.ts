import { expect } from '@playwright/test'
import { test, BASE_URL } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'

/**
 * End-to-end flow tests for bulk operations on files.
 *
 * Covers 3 scenarios: bulk delete, bulk move, and bulk export (ZIP).
 *
 * All data is created via API helpers within each test and cleaned up
 * in `afterEach`. No content generation is needed.
 *
 * @see .issues/20260516-002-e2e-playwright-tests/026-flow-bulk-operations.md
 */

// ── Helper: safe JSON fetch (handles empty/204/404 responses) ─────────

async function safeFetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
  })
  if (res.status === 204) return null
  if (res.status === 404) return null
  const text = await res.text()
  if (!text || !text.trim()) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// ── Helper: select multiple items by name ────────────────────────────

async function selectItems(modal: FileManagerModal, names: string[]) {
  for (const name of names) {
    await modal.selectItem(name)
  }
}

// ── Test suite ────────────────────────────────────────────────────────

test.describe('Flow: bulk operations', () => {
  let cleanupFolders: string[] = []
  let cleanupFiles: string[] = []

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
    cleanupFolders = []
    cleanupFiles = []
  })

  test.afterEach(async ({ apiHelpers }) => {
    // Cleanup in reverse creation order: files first, then folders.
    for (const id of cleanupFiles.reverse()) {
      await apiHelpers.deleteFile(id).catch(() => {})
    }
    for (const id of cleanupFolders.reverse()) {
      await apiHelpers.deleteFolder(id).catch(() => {})
    }
  })

  // ── 1. Bulk delete ──────────────────────────────────────────────────

  test('1. bulk delete — create 3 files in a folder, select all, delete, verify gone from UI and API', async ({
    page,
    apiHelpers,
  }) => {
    // Setup: create a folder and 3 files inside it
    const folder = await apiHelpers.createFolder(`Bulk Delete Folder ${Date.now()}`)
    cleanupFolders.push(folder.id)

    const fileNames = ['alpha.md', 'beta.md', 'gamma.md']
    const fileIds: string[] = []

    for (const name of fileNames) {
      const file = await apiHelpers.createFile({
        name,
        folderId: folder.id,
        content: `# ${name}`,
        file_type: 'class',
      })
      fileIds.push(file.id)
      cleanupFiles.push(file.id)
    }

    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()

    // Navigate into folder and verify files are visible
    await modal.openFolder(folder.name)
    for (const name of fileNames) {
      await modal.expectFileExists(name)
    }

    // Select all visible items and bulk delete
    await modal.selectAll()
    await modal.bulkDelete()

    // Verify from UI: files are no longer visible
    for (const name of fileNames) {
      await expect(
        page
          .locator('[data-testid="file-row"]')
          .filter({ hasText: name }),
      ).not.toBeVisible()
    }

    // Verify via API: each file returns 404 (null)
    for (const id of fileIds) {
      const data = await safeFetchJson<{ name: string }>(
        `${BASE_URL}/api/v1/files/${id}`,
      )
      expect(data).toBeNull()
    }

    await modal.close()
  })

  // ── 2. Bulk move ────────────────────────────────────────────────────

  test('2. bulk move — create 2 files in folder A, select and move to folder B, verify final position', async ({
    page,
    apiHelpers,
  }) => {
    // Setup: create 2 folders and 2 files inside folder A
    const folderA = await apiHelpers.createFolder(`Pasta A ${Date.now()}`)
    const folderB = await apiHelpers.createFolder(`Pasta B ${Date.now()}`)
    cleanupFolders.push(folderA.id, folderB.id)

    const fileNames = ['doc1.md', 'doc2.md']
    const fileIds: string[] = []

    for (const name of fileNames) {
      const file = await apiHelpers.createFile({
        name,
        folderId: folderA.id,
        content: `# ${name}`,
        file_type: 'class',
      })
      fileIds.push(file.id)
      cleanupFiles.push(file.id)
    }

    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()

    // Navigate into folder A and verify files are visible
    await modal.openFolder(folderA.name)
    for (const name of fileNames) {
      await modal.expectFileExists(name)
    }

    // Select both files and bulk-move to folder B
    await selectItems(modal, fileNames)
    await modal.bulkMove(folderB.name)

    // Wait for the move picker to close and tree to reload
    await expect(
      page.getByTestId('fm-move-picker'),
    ).not.toBeVisible({ timeout: 10_000 })

    // The view is still inside folder A — files should be gone now
    for (const name of fileNames) {
      await expect(
        page
          .locator('[data-testid="file-row"]')
          .filter({ hasText: name }),
      ).not.toBeVisible()
    }

    // Navigate to root, then into folder B
    await page.getByRole('button', { name: 'Subir' }).click()
    await modal.openFolder(folderB.name)

    // Verify files are now visible inside folder B
    for (const name of fileNames) {
      await modal.expectFileExists(name)
    }

    // Verify via API: each file's folder_id now points to folder B
    for (const id of fileIds) {
      const data = await safeFetchJson<{ folder_id: string | null }>(
        `${BASE_URL}/api/v1/files/${id}`,
      )
      expect(data?.folder_id).toBe(folderB.id)
    }

    // Navigate back to root for clean teardown
    await page.getByRole('button', { name: 'Subir' }).click()
    await modal.close()
  })

  // ── 3. Bulk export ZIP ──────────────────────────────────────────────

  test('3. bulk export ZIP — create 2 files with content, select both, export ZIP, verify download', async ({
    page,
    apiHelpers,
  }) => {
    // Setup: create a folder and 2 files with meaningful content
    const folder = await apiHelpers.createFolder(`Bulk Export Folder ${Date.now()}`)
    cleanupFolders.push(folder.id)

    const fileNames = ['relatorio.md', 'resumo.md']
    const fileIds: string[] = []

    for (const name of fileNames) {
      const file = await apiHelpers.createFile({
        name,
        folderId: folder.id,
        content: `# ${name}\n\nConteúdo do arquivo ${name} para exportação.`,
        file_type: 'class',
      })
      fileIds.push(file.id)
      cleanupFiles.push(file.id)
    }

    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()

    // Navigate into folder and verify files are visible
    await modal.openFolder(folder.name)
    for (const name of fileNames) {
      await modal.expectFileExists(name)
    }

    // Select both files
    await selectItems(modal, fileNames)

    // Trigger ZIP download and intercept it
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      modal.bulkExportZip(),
    ])

    // Verify the downloaded file is a ZIP archive
    expect(download.suggestedFilename()).toMatch(/\.zip$/)

    await modal.close()
  })
})
