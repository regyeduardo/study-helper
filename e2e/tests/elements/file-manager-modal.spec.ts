import { expect } from '@playwright/test'
import { test } from '../../fixtures/api-helpers'
import { FileManagerModal } from '../../pages/FileManagerModal'

test.describe('FileManagerModal — element tests', () => {
  let modal: FileManagerModal

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
    modal = new FileManagerModal(page)
  })

  // ── 1. Opening and closing ───────────────────────────────────────────────

  test('1. opening and closing — modal opens and closes correctly', async ({ page }) => {
    await modal.open()
    await modal.expectVisible()

    await modal.close()
    await expect(page.getByTestId('file-manager-modal')).not.toBeVisible()

    // Reopen to confirm it works again
    await modal.open()
    await modal.expectVisible()
  })

  // ── 2. Empty list ────────────────────────────────────────────────────────

  test('2. empty list — with clean database, modal shows empty list state', async ({ page }) => {
    await modal.open()
    await modal.expectVisible()

    // The root level should be empty — show "Esta pasta está vazia."
    await expect(page.getByText(/esta pasta está vazia/i)).toBeVisible()
  })

  // ── 3. Folder appears after API creation ─────────────────────────────────

  test('3. folder appears — folder created via API shows in modal', async ({ apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Matemática')

    await modal.open()
    await modal.expectVisible()
    await modal.expectFolderExists('Matemática')

    // Cleanup
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 4. File appears after API creation ───────────────────────────────────

  test('4. file appears — file created via API inside folder shows when navigating', async ({ apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Física')
    const file = await apiHelpers.createFile({
      name: 'newton.md',
      folderId: folder.id,
      content: '# Leis de Newton',
      file_type: 'class',
    })

    await modal.open()
    await modal.expectVisible()

    // Navigate into the folder to reveal the file
    await modal.openFolder('Física')
    await modal.expectFileExists('newton.md')

    // Cleanup
    await apiHelpers.deleteFile(file.id)
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 5. Folder navigation ────────────────────────────────────────────────

  test('5. folder navigation — clicking a folder navigates into it and shows contents', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Química')
    const file = await apiHelpers.createFile({
      name: 'atomos.md',
      folderId: folder.id,
      content: '# Átomos',
      file_type: 'class',
    })

    await modal.open()
    await modal.expectVisible()
    await modal.expectFolderExists('Química')

    // Click the folder to navigate into it
    await modal.openFolder('Química')

    // Now we should see the file inside the folder
    await modal.expectFileExists('atomos.md')

    // The empty-state message should NOT be visible since the folder has content
    await expect(page.getByText(/esta pasta está vazia/i)).not.toBeVisible()

    // Cleanup
    await apiHelpers.deleteFile(file.id)
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 6. Item selection ───────────────────────────────────────────────────

  test('6. item selection — clicking a file checkbox selects it and reveals bulk actions', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('História')
    const file = await apiHelpers.createFile({
      name: 'revolucao.md',
      folderId: folder.id,
      content: '# Revolução Francesa',
      file_type: 'class',
    })

    await modal.open()
    await modal.expectVisible()
    await modal.openFolder('História')
    await modal.expectFileExists('revolucao.md')

    // Before selection: bulk actions should not be visible
    await expect(page.getByTestId('fm-bulk-delete')).not.toBeVisible()

    // Select the file by clicking its checkbox
    await modal.selectItem('revolucao.md')

    // After selection: bulk actions should appear
    await expect(page.getByTestId('fm-bulk-delete')).toBeVisible()
    await expect(page.getByTestId('fm-bulk-move')).toBeVisible()

    // Cleanup
    await apiHelpers.deleteFile(file.id)
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 7. Initial checkbox state ───────────────────────────────────────────

  test('7. initial checkbox state — no item selected when opening the modal', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Filosofia')
    const file = await apiHelpers.createFile({
      name: 'platao.md',
      folderId: folder.id,
      content: '# Platão',
      file_type: 'class',
    })

    await modal.open()
    await modal.expectVisible()
    await modal.openFolder('Filosofia')

    // Bulk actions should NOT be visible initially
    await expect(page.getByTestId('fm-bulk-delete')).not.toBeVisible()
    await expect(page.getByTestId('fm-bulk-move')).not.toBeVisible()

    // The "Selecionar" button should be visible (not the "Desmarcar" state)
    await expect(page.getByTestId('fm-select-all')).toBeVisible()

    // Cleanup
    await apiHelpers.deleteFile(file.id)
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 8. Multiple selection ───────────────────────────────────────────────

  test('8. multiple selection — selecting two items activates bulk action controls', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Geografia')
    const file1 = await apiHelpers.createFile({
      name: 'continentes.md',
      folderId: folder.id,
      content: '# Continentes',
      file_type: 'class',
    })
    const file2 = await apiHelpers.createFile({
      name: 'clima.md',
      folderId: folder.id,
      content: '# Clima',
      file_type: 'class',
    })

    await modal.open()
    await modal.expectVisible()
    await modal.openFolder('Geografia')

    // Select first item
    await modal.selectItem('continentes.md')
    await expect(page.getByTestId('fm-bulk-delete')).toBeVisible()

    // Select second item
    await modal.selectItem('clima.md')

    // Bulk actions should still be visible
    await expect(page.getByTestId('fm-bulk-delete')).toBeVisible()
    await expect(page.getByTestId('fm-bulk-move')).toBeVisible()
    await expect(page.getByTestId('fm-bulk-export')).toBeVisible()

    // The "Selecionar" button should be replaced by "Desmarcar (N)"
    await expect(page.getByTestId('fm-select-all')).not.toBeVisible()

    // Cleanup
    await apiHelpers.deleteFile(file1.id)
    await apiHelpers.deleteFile(file2.id)
    await apiHelpers.deleteFolder(folder.id)
  })

  // ── 9. Deselection via selectAll ────────────────────────────────────────

  test('9. deselection — selecting all and deselecting resets state', async ({ page, apiHelpers }) => {
    const folder = await apiHelpers.createFolder('Inglês')
    const file1 = await apiHelpers.createFile({
      name: 'verbs.md',
      folderId: folder.id,
      content: '# Verbs',
      file_type: 'class',
    })
    const file2 = await apiHelpers.createFile({
      name: 'nouns.md',
      folderId: folder.id,
      content: '# Nouns',
      file_type: 'class',
    })

    await modal.open()
    await modal.expectVisible()
    await modal.openFolder('Inglês')

    // Click "Selecionar" to select all visible items
    await modal.selectAll()

    // Bulk actions should be visible immediately after selecting all
    await expect(page.getByTestId('fm-bulk-delete')).toBeVisible()

    // The fm-select-all button should be gone (replaced by "Desmarcar")
    await expect(page.getByTestId('fm-select-all')).not.toBeVisible()

    // Click "Desmarcar (N)" button to deselect all
    await page.getByRole('button', { name: /desmarcar/i }).click()

    // After deselect, bulk actions should be hidden again
    await expect(page.getByTestId('fm-bulk-delete')).not.toBeVisible()

    // fm-select-all should be visible again
    await expect(page.getByTestId('fm-select-all')).toBeVisible()

    // Cleanup
    await apiHelpers.deleteFile(file1.id)
    await apiHelpers.deleteFile(file2.id)
    await apiHelpers.deleteFolder(folder.id)
  })
})
