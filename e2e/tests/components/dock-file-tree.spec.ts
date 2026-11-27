import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'
import { OutputPanel } from '../../pages/OutputPanel'

/**
 * Component-level tests for the dock file tree.
 *
 * Verifies folder/file navigation, tree expand/collapse, and the
 * interaction between the file tree and the OutputPanel (loading
 * file content by clicking a tree item).
 *
 * Each test creates and deletes its own data via the API helpers,
 * ensuring a clean state between scenarios.
 */
test.describe('Dock file tree — component tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
  })

  // ── 1. Empty dock with clean database ─────────────────────────────────

  test('1. empty dock — with clean database, dock shows empty state', async ({ page }) => {
    const modal = new FileManagerModal(page)
    await modal.open()
    await modal.expectVisible()

    // The root level should be empty — show "Esta pasta está vazia."
    await expect(page.getByText(/esta pasta está vazia/i)).toBeVisible()
  })

  // ── 2. Folder appears after API creation ──────────────────────────────

  test('2. folder appears — folder created via API shows in dock', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Matemática')

    const modal = new FileManagerModal(page)
    await modal.open()
    await modal.expectVisible()
    await modal.expectFolderExists('Matemática')

    // Cleanup
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 3. File appears inside folder after API creation ──────────────────

  test('3. file appears — file created via API inside folder shows when navigating', async ({ page, apiHelpers }) => {
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

    // Navigate into the folder to reveal the file
    await modal.openFolder('Física')
    await modal.expectFileExists('newton.md')

    // Cleanup
    await apiHelpers.deleteFile(file.id)
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 4. Expand and collapse folder ─────────────────────────────────────

  test('4. expand and collapse folder — clicking folder navigates in and Subir navigates out', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Química')
    const file = await apiHelpers.createFile({
      name: 'atomos.md',
      folderId: folder.id,
      content: '# Átomos',
      file_type: 'class',
    })

    const modal = new FileManagerModal(page)
    await modal.open()
    await modal.expectVisible()
    await modal.expectFolderExists('Química')

    // Expand: click the folder to navigate into it
    await modal.openFolder('Química')

    // The folder row is no longer visible at root — file inside is visible
    await modal.expectFileExists('atomos.md')
    await expect(
      page.locator('[data-testid="folder-row"]').filter({ hasText: 'Química' }),
    ).not.toBeVisible()

    // Collapse: click "Subir" (Go Up) to navigate back to root
    await page.getByRole('button', { name: 'Subir' }).click()

    // The folder is visible again at root; file is no longer shown
    await modal.expectFolderExists('Química')
    await expect(
      page.locator('[data-testid="file-row"]').filter({ hasText: 'atomos.md' }),
    ).not.toBeVisible()

    // Cleanup
    await apiHelpers.deleteFile(file.id)
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 5. Click file loads content in OutputPanel ────────────────────────

  test('5. click file loads content in output panel', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Biologia')
    const file = await apiHelpers.createFile({
      name: 'celulas.md',
      folderId: folder.id,
      content: '# Células\n\nAs células são a unidade básica da vida.\n\nExistem células procariontes e eucariontes.',
      file_type: 'class',
    })

    const modal = new FileManagerModal(page)
    const outputPanel = new OutputPanel(page)

    await modal.open()
    await modal.expectVisible()
    await modal.openFolder('Biologia')
    await modal.expectFileExists('celulas.md')

    // Click the file in the tree — triggers handleSelectFileFromManager
    // which loads content into OutputPanel and closes the modal
    await modal.selectFile('celulas.md')

    // Verify content appears in the output panel
    await outputPanel.expectContentContains('Células')
    await outputPanel.expectContentContains('procariontes')
    await outputPanel.expectContentContains('eucariontes')

    // Cleanup
    await apiHelpers.deleteFile(file.id)
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 6. Multiple folders listed in correct order ──────────────────────

  test('6. multiple folders — all folders appear in the dock', async ({ page, apiHelpers }) => {
    const folderNames = ['Álgebra', 'Geometria', 'Trigonometria']
    const folders = await Promise.all(
      folderNames.map((name) => apiHelpers.createFolder(name)),
    )

    const modal = new FileManagerModal(page)
    await modal.open()
    await modal.expectVisible()

    // All three folders should be visible at root level
    for (const name of folderNames) {
      await modal.expectFolderExists(name)
    }

    // Cleanup
    for (const f of folders) {
      await apiHelpers.deleteFolder(f.id)
    }
  })
})
