import { expect } from '@playwright/test'
import { test, BASE_URL } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'

/**
 * End-to-end flow tests for file and folder CRUD operations.
 *
 * Covers 7 scenarios: create/rename/delete folder, rename/delete file,
 * and move file between folders.
 *
 * All data is created via API (when possible) and destroyed after each
 * test. No content generation is needed.
 *
 * @see .issues/20260516-002-e2e-playwright-tests/025-flow-file-folder-crud.md
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

test.describe('Flow: file and folder CRUD', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  // ── 1. Create folder via UI ──────────────────────────────────────────

  test('1. create folder via UI — open file manager, create folder, verify it appears', async ({
    page,
    apiHelpers,
  }) => {
    const folderName = `Pasta Teste ${Date.now()}`
    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()
    await modal.createFolder(folderName)
    await modal.expectFolderExists(folderName)

    await modal.close()

    // Cleanup: find and delete the created folder via API
    const folders = await safeFetchJson<Array<{ id: string; name: string }>>(
      `${BASE_URL}/api/v1/folders`,
    )
    const created = folders?.find((f) => f.name === folderName)
    if (created) {
      await apiHelpers.deleteFolder(created.id).catch(() => {})
    }
  })

  // ── 2. Rename folder via UI ──────────────────────────────────────────

  test('2. rename folder via UI — create folder via API, rename, verify new name in UI and API', async ({
    page,
    apiHelpers,
  }) => {
    const folder = await apiHelpers.createFolder('Pasta Antiga')
    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()
    await modal.expectFolderExists('Pasta Antiga')

    // Hover the folder row first to reveal the hidden rename button
    const row = page
      .locator('[data-testid="folder-row"]')
      .filter({ hasText: 'Pasta Antiga' })
      .first()
    await row.hover()
    await modal.renameFolder('Pasta Antiga', 'Pasta Renomeada')
    await modal.expectFolderExists('Pasta Renomeada')

    // Verify via API: folder name changed
    const data = await safeFetchJson<{ name: string }>(
      `${BASE_URL}/api/v1/folders/${folder.id}`,
    )
    expect(data?.name).toBe('Pasta Renomeada')

    await modal.close()

    // Cleanup
    await apiHelpers.deleteFolder(folder.id).catch(() => {})
  })

  // ── 3. Delete folder via UI ──────────────────────────────────────────

  test('3. delete folder via UI — create folder via API, delete, verify gone from UI and API', async ({
    page,
    apiHelpers,
  }) => {
    const folder = await apiHelpers.createFolder('Pasta Para Deletar')
    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()
    await modal.expectFolderExists('Pasta Para Deletar')

    // Hover the folder row first to reveal the hidden delete button
    const row = page
      .locator('[data-testid="folder-row"]')
      .filter({ hasText: 'Pasta Para Deletar' })
      .first()
    await row.hover()
    await modal.deleteFolder('Pasta Para Deletar')

    // Verify from UI: folder no longer visible
    await expect(
      page
        .locator('[data-testid="folder-row"]')
        .filter({ hasText: 'Pasta Para Deletar' }),
    ).not.toBeVisible()

    // Verify via API: GET returns null (folder is gone)
    const data = await safeFetchJson<{ name: string }>(
      `${BASE_URL}/api/v1/folders/${folder.id}`,
    )
    expect(data).toBeNull()

    await modal.close()
  })

  // ── 4. Move file to another folder via UI (drag-and-drop) ────────────

  test('4. move file to another folder via UI — create two folders + file at root, drag file to target folder, verify UI and API', async ({
    page,
    apiHelpers,
  }) => {
    // Setup: create 2 folders at root + 1 file at root (no folder_id)
    const folder1 = await apiHelpers.createFolder('Origem')
    const folder2 = await apiHelpers.createFolder('Destino')

    // Create a file at root level by using a direct API call
    const fileRes = await fetch(`${BASE_URL}/api/v1/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'movel.md',
        content: '# Arquivo para mover',
      }),
    })
    const file = (await fileRes.json()) as { id: string }

    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()

    // Both folders and the file are visible at root level
    await modal.expectFolderExists('Origem')
    await modal.expectFolderExists('Destino')
    await modal.expectFileExists('movel.md')

    // Drag the file from root onto the target folder
    await modal.moveFile('movel.md', 'Destino')

    // After the move, the file should no longer be visible at root level
    await expect(
      page
        .locator('[data-testid="file-row"]')
        .filter({ hasText: 'movel.md' }),
    ).not.toBeVisible()

    // Navigate into the target folder and verify the file is there
    await modal.openFolder('Destino')
    await modal.expectFileExists('movel.md')

    // Verify via API: file's folder_id should now point to folder2
    const fileData = await safeFetchJson<{ folder_id: string | null }>(
      `${BASE_URL}/api/v1/files/${file.id}`,
    )
    expect(fileData?.folder_id).toBe(folder2.id)

    // Navigate back to root for cleanup access
    await page.getByRole('button', { name: 'Subir' }).click()

    // Cleanup
    await modal.close()
    await apiHelpers.deleteFile(file.id).catch(() => {})
    await apiHelpers.deleteFolder(folder2.id).catch(() => {})
    await apiHelpers.deleteFolder(folder1.id).catch(() => {})
  })

  // ── 5. Rename file via UI ────────────────────────────────────────────

  test('5. rename file via UI — create folder + file via API, rename, verify new name in UI and API', async ({
    page,
    apiHelpers,
  }) => {
    const folder = await apiHelpers.createFolder('Textos')
    const file = await apiHelpers.createFile({
      name: 'antigo.md',
      folderId: folder.id,
      content: '# Conteúdo antigo',
      file_type: 'class',
    })
    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()
    await modal.openFolder('Textos')
    await modal.expectFileExists('antigo.md')

    await modal.renameFile('antigo.md', 'novo.md')
    await modal.expectFileExists('novo.md')

    // Verify via API: file name changed
    const data = await safeFetchJson<{ name: string }>(
      `${BASE_URL}/api/v1/files/${file.id}`,
    )
    expect(data?.name).toBe('novo.md')

    await modal.close()

    // Cleanup
    await apiHelpers.deleteFile(file.id).catch(() => {})
    await apiHelpers.deleteFolder(folder.id).catch(() => {})
  })

  // ── 6. Delete file via UI ────────────────────────────────────────────

  test('6. delete file via UI — create folder + file via API, delete, verify gone from UI and API', async ({
    page,
    apiHelpers,
  }) => {
    const folder = await apiHelpers.createFolder('Física')
    const file = await apiHelpers.createFile({
      name: 'newton.md',
      folderId: folder.id,
      content: '# Leis de Newton',
      file_type: 'class',
    })
    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()
    await modal.openFolder('Física')
    await modal.expectFileExists('newton.md')

    // Hover the file row first to reveal the hidden delete button
    const fileRow = page
      .locator('[data-testid="file-row"]')
      .filter({ hasText: 'newton.md' })
      .first()
    await fileRow.hover()
    await modal.deleteFile('newton.md')

    // Verify from UI: file no longer visible
    await expect(
      page
        .locator('[data-testid="file-row"]')
        .filter({ hasText: 'newton.md' }),
    ).not.toBeVisible()

    // Verify via API: GET returns null (file is gone)
    const fileData = await safeFetchJson<{ name: string }>(
      `${BASE_URL}/api/v1/files/${file.id}`,
    )
    expect(fileData).toBeNull()

    await modal.close()

    // Cleanup: only the folder remains
    await apiHelpers.deleteFolder(folder.id).catch(() => {})
  })

  // ── 7. Move file between folders via UI (bulk move) ──────────────────

  test('7. move file between folders via UI — create two folders + file in folder1, select and bulk-move to folder2, verify final position', async ({
    page,
    apiHelpers,
  }) => {
    // Setup: create 2 folders + 1 file inside folder1
    const folder1 = await apiHelpers.createFolder('Pasta A')
    const folder2 = await apiHelpers.createFolder('Pasta B')
    const file = await apiHelpers.createFile({
      name: 'notas.md',
      folderId: folder1.id,
      content: '# Notas importantes',
      file_type: 'class',
    })

    const modal = new FileManagerModal(page)

    await modal.open()
    await modal.expectVisible()

    // Navigate into folder A to see the file, then select it
    await modal.openFolder('Pasta A')
    await modal.expectFileExists('notas.md')
    await modal.selectItem('notas.md')

    // Use bulk move to move the selected file to Pasta B
    await modal.bulkMove('Pasta B')

    // Wait for the move picker to close and tree to reload
    await expect(
      page.getByTestId('fm-move-picker'),
    ).not.toBeVisible({ timeout: 10_000 })

    // The view is still inside folder A — file should be gone now
    await expect(
      page
        .locator('[data-testid="file-row"]')
        .filter({ hasText: 'notas.md' }),
    ).not.toBeVisible()

    // Navigate to root, then into Pasta B
    await page.getByRole('button', { name: 'Subir' }).click()

    // Open Pasta B and verify the file is there
    await modal.openFolder('Pasta B')
    await modal.expectFileExists('notas.md')

    // Verify via API: file's folder_id now points to folder2
    const fileData = await safeFetchJson<{ folder_id: string | null }>(
      `${BASE_URL}/api/v1/files/${file.id}`,
    )
    expect(fileData?.folder_id).toBe(folder2.id)

    // Navigate back to root for cleanup
    await page.getByRole('button', { name: 'Subir' }).click()
    await modal.close()

    // Cleanup
    await apiHelpers.deleteFile(file.id).catch(() => {})
    await apiHelpers.deleteFolder(folder2.id).catch(() => {})
    await apiHelpers.deleteFolder(folder1.id).catch(() => {})
  })
})
