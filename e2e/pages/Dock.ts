import { type Page, expect } from '@playwright/test'

/**
 * Page Object for the file tree navigation (inside the File Manager).
 *
 * Encapsulates folder/file tree navigation: opening folders,
 * clicking files, and asserting tree visibility.
 *
 * The File Manager modal must be open for these operations to work.
 *
 * All selectors use `data-testid` attributes for reliability.
 * No CSS class selectors are used.
 */
export class Dock {
  constructor(private page: Page) {}

  // ── Navigation ─────────────────────────────────────────────────────

  /**
   * Opens (navigates into) a folder by its display name.
   *
   * Clicks on the folder row with the matching name. The tree
   * will then show the folder's children.
   */
  async openFolder(name: string): Promise<void> {
    await this.getFolderRow(name).click()
  }

  /**
   * Closes (navigates up from) the current folder.
   *
   * Clicks the "Subir" (Go Up) button in the File Manager toolbar.
   * This moves the view up one level in the tree.
   */
  async closeFolder(name: string): Promise<void> {
    await this.page.getByRole('button', { name: 'Subir' }).click()
  }

  /**
   * Clicks on a file by its display name to select/load it.
   *
   * Triggers the file selection callback in the File Manager.
   */
  async clickFile(name: string): Promise<void> {
    await this.getFileRow(name).click()
  }

  // ── Assertions ─────────────────────────────────────────────────────

  /**
   * Asserts a file with the given name is visible in the current tree view.
   */
  async expectFileVisible(name: string): Promise<void> {
    await expect(this.getFileRow(name)).toBeVisible()
  }

  /**
   * Asserts a folder with the given name is visible
   * in the current tree view (i.e., the folder is expanded/open).
   */
  async expectFolderExpanded(name: string): Promise<void> {
    await expect(this.getFolderRow(name)).toBeVisible()
  }

  /**
   * Asserts a folder with the given name is NOT visible
   * in the current view (i.e., the folder is collapsed/not navigated into).
   */
  async expectFolderCollapsed(name: string): Promise<void> {
    // The folder is not visible because we're not inside it
    await expect(this.getFolderRow(name)).not.toBeVisible()
  }

  /**
   * Asserts a file with the given name is NOT visible
   * in the current tree view.
   */
  async expectFileNotVisible(name: string): Promise<void> {
    await expect(this.getFileRow(name)).not.toBeVisible()
  }

  // ── Helpers ────────────────────────────────────────────────────────

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
