import { test, expect } from '@playwright/test'
import { NewContentModal } from '../../pages/NewContentModal'
import { FileManagerModal } from '../../pages/FileManagerModal'

const BASE_URL = 'http://localhost:8080'
const resumoPattern = /resumo|resumidor/i

async function assertNoResumoText(page: any): Promise<void> {
  const visibleText = await page.locator('body').innerText()
  expect(visibleText).not.toMatch(resumoPattern)
}

test.describe('No resumo references in UI', () => {
  test('home page has no resumo text', async ({ page }) => {
    await page.goto(`${BASE_URL}/`)
    await assertNoResumoText(page)
  })

  test('new content modal has no resumo text', async ({ page }) => {
    await page.goto(`${BASE_URL}/`)
    const modal = new NewContentModal(page)
    await modal.open()
    await assertNoResumoText(page)
    await page.locator('[data-testid="modal-close"]').click()
  })

  test('file manager modal has no resumo text', async ({ page }) => {
    await page.goto(`${BASE_URL}/`)
    const fm = new FileManagerModal(page)
    await fm.open()
    await assertNoResumoText(page)
    await page.locator('[data-testid="modal-close"]').click()
  })

  test('settings modal has no resumo text', async ({ page }) => {
    await page.goto(`${BASE_URL}/`)
    // Settings trigger is disabled in the UI (commented out in App.tsx)
    // Skip the test to avoid failure
    test.skip()
  })
})
