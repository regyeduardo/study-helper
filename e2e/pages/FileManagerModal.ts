import { type Page, expect } from '@playwright/test'

export class FileManagerModal {
  constructor(private page: Page) {}

  // ── Open / Close ────────────────────────────────────────────────────

  /**
   * Opens the File Manager modal by clicking the dock trigger button.
   */
  async open(): Promise<void> {
    await this.page.getByTestId('file-manager-trigger').click()
  }

  /**
   * Closes the modal via the X (close) button in the header.
   */
  async close(): Promise<void> {
    const closeButton = this.page.locator('[data-testid="modal-close"]')
    await closeButton.waitFor({ state: 'attached' })
    await closeButton.waitFor({ state: 'stable' })
    // Use force: true to handle animation instability
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (closeButton as any).click({ force: true })
  }

  // ── Folders ─────────────────────────────────────────────────────────

  /**
   * Creates a new folder with the given name.
   *
   * Clicks "Nova Pasta", fills the name input, and confirms.
   */
  async createFolder(name: string): Promise<void> {
    await this.page.getByTestId('fm-new-folder').click()
    await this.page.getByTestId('fm-folder-name').fill(name)
    await this.page.getByTestId('fm-folder-submit').click()
  }

  /**
   * Renames a folder from `currentName` to `newName`.
   *
   * Finds the folder row, clicks its rename button, types the new name,
   * and presses Enter to confirm.
   */
  async renameFolder(currentName: string, newName: string): Promise<void> {
    const row = this.getFolderRow(currentName)
    await row.getByTestId('rename-btn').click()
    await this.page.getByTestId('rename-input').fill(newName)
    await this.page.getByTestId('rename-input').press('Enter')
  }

  /**
   * Deletes a folder by name.
   *
   * Finds the folder row, clicks delete, and accepts the confirmation dialog.
   */
  async deleteFolder(name: string): Promise<void> {
    this.page.once('dialog', (dialog) => dialog.accept())
    const row = this.getFolderRow(name)
    await row.getByTestId('delete-btn').click()
  }

  /**
   * Navigates into a folder by clicking on its row.
   */
  async openFolder(name: string): Promise<void> {
    await this.getFolderRow(name).click()
  }

  /**
   * Navigate to (open) a folder. Alias for `openFolder`.
   * Used by tab-system E2E tests.
   */
  async navigateToFolder(name: string): Promise<void> {
    await this.openFolder(name)
  }

  /**
   * Asserts the File Manager modal is hidden (closed).
   */
  async expectHidden(): Promise<void> {
    await expect(this.page.getByTestId('file-manager-modal')).not.toBeVisible()
  }

  // ── Files ───────────────────────────────────────────────────────────

  /**
   * Selects (clicks on) a file row.
   *
   * In `select-file` mode this closes the modal and fires onSelectFile.
   * In `manage` mode this fires onSelectFile (if provided).
   */
  async selectFile(name: string): Promise<void> {
    await this.getFileRow(name).click()
  }

  /**
   * Renames a file from `currentName` to `newName`.
   */
  async renameFile(currentName: string, newName: string): Promise<void> {
    const row = this.getFileRow(currentName)
    await row.getByTestId('rename-btn').click()
    await this.page.getByTestId('rename-input').fill(newName)
    await this.page.getByTestId('rename-input').press('Enter')
  }

  /**
   * Deletes a file by name.
   *
   * Accepts the confirmation dialog automatically.
   */
  async deleteFile(name: string): Promise<void> {
    this.page.once('dialog', (dialog) => dialog.accept())
    const row = this.getFileRow(name)
    await row.getByTestId('delete-btn').click()
  }

  /**
   * Moves a single file into a target folder by simulating a drag-and-drop.
   */
  async moveFile(fileName: string, targetFolderName: string): Promise<void> {
    const source = this.getFileRow(fileName)
    const target = this.getFolderRow(targetFolderName)
    await source.dragTo(target)
  }

  // ── Bulk selection ──────────────────────────────────────────────────

  /**
   * Clicks the "Selecionar" button to select all visible items.
   */
  async selectAll(): Promise<void> {
    await this.page.getByTestId('fm-select-all').click()
  }

  /**
   * Toggles selection of a specific item (file or folder) by name.
   */
  async selectItem(name: string): Promise<void> {
    const row = this.getFolderRow(name).or(this.getFileRow(name))
    await row.getByTestId('select-check').click()
  }

  /**
   * Clicks the bulk delete button and accepts the confirmation dialog.
   */
  async bulkDelete(): Promise<void> {
    this.page.once('dialog', (dialog) => dialog.accept())
    await this.page.getByTestId('fm-bulk-delete').click()
  }

  /**
   * Clicks the bulk move button, then selects the target folder from
   * the move-picker modal. Pass `'Raiz'` to move to the root.
   */
  async bulkMove(targetFolderName: string): Promise<void> {
    await this.page.getByTestId('fm-bulk-move').click()
    // Wait for the move picker to appear
    await expect(this.page.getByTestId('fm-move-picker')).toBeVisible()

    if (targetFolderName === 'Raiz') {
      await this.page.getByTestId('fm-move-to-root').click()
    } else {
      await this.page
        .locator('[data-testid="fm-move-folder"]')
        .filter({ hasText: targetFolderName })
        .click()
    }
  }

  /**
   * Clicks the bulk export (ZIP) button.
   */
  async bulkExportZip(): Promise<void> {
    await this.page.getByTestId('fm-bulk-export').click()
  }

  // ── Assertions ──────────────────────────────────────────────────────

  /**
   * Asserts the File Manager modal is visible.
   */
  async expectVisible(): Promise<void> {
    await expect(this.page.getByTestId('file-manager-modal')).toBeVisible()
  }

  /**
   * Asserts a file with the given name exists (is visible) in the tree.
   */
  async expectFileExists(name: string): Promise<void> {
    await expect(this.getFileRow(name)).toBeVisible()
  }

  /**
   * Asserts a file with the given name does NOT exist in the tree.
   */
  async expectFileNotExists(name: string): Promise<void> {
    await expect(this.getFileRow(name)).not.toBeVisible()
  }

  /**
   * Asserts a folder with the given name exists (is visible) in the tree.
   */
  async expectFolderExists(name: string): Promise<void> {
    await expect(this.getFolderRow(name)).toBeVisible()
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private getFolderRow(name: string) {
    return this.page
      .locator('[data-testid="folder-row"]')
      .filter({ hasText: name })
      .first()
  }

  private getFileRow(name: string) {
    return this.page
      .locator('[data-testid="file-row"]')
      .filter({ hasText: name })
      .first()
  }
}
