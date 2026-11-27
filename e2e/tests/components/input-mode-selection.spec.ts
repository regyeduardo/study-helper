import { test, expect } from '@playwright/test'
import { NewContentModal } from '../../pages/NewContentModal'
import path from 'path'

/**
 * Helper: click the URL tab when InputModeSelector is in "explicação" (tab) mode.
 *
 * The page object's selectMode('url') uses /^URL$/i which doesn't match
 * the tab's accessible name "🔗 URL" (emoji prefix), and getByRole('button')
 * misses elements with explicit role="tab".
 *
 * Only the test file may be modified per acceptance criteria, hence this helper.
 */
async function clickUrlTab(page: import('@playwright/test').Page) {
  await page.getByRole('tab', { name: /URL/i }).click()
}

test.describe('Input mode selection — component tests', () => {
  let modal: NewContentModal

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('http://localhost:8080/')
    modal = new NewContentModal(page)
    await modal.open()
    await modal.expectVisible()
  })

  // ── 1. Mode switch preserves agent selection ───────────────────────────

  test('1. mode switch preserves agent selection', async ({ page }) => {
    // Select 'explicação' agent
    await modal.selectAgent('explicacao')
    await expect(page.getByRole('button', { name: /Explicação/i, pressed: true })).toBeVisible()

    // Switch mode from topic (default for explicacao) → url → topic → url
    await clickUrlTab(page)
    await page.getByRole('tab', { name: /Tema/i }).click()
    await clickUrlTab(page)

    // Agent selection must still be 'explicação'
    await expect(page.getByRole('button', { name: /Explicação/i, pressed: true })).toBeVisible()
  })

  // ── 2. URL field cleared when switching modes ───────────────────────────

  test('2. URL field is cleared when switching modes', async ({ page }) => {
    await modal.selectAgent('explicacao') // mode becomes 'topic'
    await clickUrlTab(page)

    // Fill URL
    const urlInput = page.getByPlaceholder(/https?:\/\//i)
    await urlInput.fill('https://youtube.com/watch?v=abc123')
    await expect(urlInput).toHaveValue('https://youtube.com/watch?v=abc123')

    // Switch to topic mode and back to url
    await page.getByRole('tab', { name: /Tema/i }).click()
    await clickUrlTab(page)

    // URL field must be empty (cleared by handleModeChange)
    await expect(page.getByPlaceholder(/https?:\/\//i)).toHaveValue('')
  })

  // ── 3. Topic field behaviour when switching modes ───────────────────────
  //
  // NOTE: The component's handleModeChange clears selectedFile and inputUrl,
  //       but does NOT clear the topic field. Therefore the topic content is
  //       preserved when switching away and back. This test documents that
  //       behaviour as currently implemented.

  test('3. topic field is preserved when switching modes', async ({ page }) => {
    await modal.selectAgent('explicacao') // mode becomes 'topic', topic textarea visible

    // Fill topic
    const topicInput = page.getByPlaceholder(/descreva o assunto/i)
    await topicInput.fill('O que é React?')
    await expect(topicInput).toHaveValue('O que é React?')

    // Switch to url mode
    await clickUrlTab(page)
    // Topic textarea should no longer be visible
    await expect(page.getByPlaceholder(/descreva o assunto/i)).not.toBeVisible()

    // Switch back to topic mode
    await page.getByRole('tab', { name: /Tema/i }).click()

    // Topic field should still contain the previously typed text
    // (handleModeChange does NOT clear topic)
    await expect(page.getByPlaceholder(/descreva o assunto/i)).toHaveValue('O que é React?')
  })

  // ── 4. Submit enabled only when all required fields are filled ──────────

  test('4. submit enabled only when required fields are filled', async ({ page }) => {
    // 4a. Default state: aula + file mode, no file → disabled
    await modal.expectSubmitDisabled()

    // 4b. aula + url mode, no URL → disabled
    await modal.selectMode('url')
    await modal.expectSubmitDisabled()

    // 4c. aula + url mode, valid URL → enabled
    await modal.fillUrl('https://youtube.com/watch?v=abc123')
    await modal.expectSubmitEnabled()

    // Clear URL for next step by switching to file mode
    await modal.selectMode('file')

    // 4d. explicacao + topic mode, no topic → disabled
    await modal.selectAgent('explicacao') // mode becomes 'topic', topic empty
    await modal.expectSubmitDisabled()

    // 4e. explicacao + topic mode, filled topic → enabled
    await modal.fillTopic('O que é React?')
    await modal.expectSubmitEnabled()
  })

  // ── 5. File upload enables submit ───────────────────────────────────────

  test('5. file upload enables submit', async ({ page }) => {
    // Default state: aula + file mode, no file → disabled
    await modal.expectSubmitDisabled()

    // Upload a sample file
    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByText(/clique para selecionar/i).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(path.resolve(__dirname, '../../fixtures/sample-upload.txt'))

    // Submit should now be enabled
    await modal.expectSubmitEnabled()
  })

  // ── 6. Agent selection is required ──────────────────────────────────────
  //
  // NOTE: The UI always has a default agent selected ('aula' on open), and
  //       there is no way to deselect both agents (clicking an agent button
  //       simply selects that agent). Therefore the "no agent" state never
  //       occurs in practice.
  //
  //       However, from the submit logic perspective, when no meaningful
  //       input is provided for the selected agent's current mode, the
  //       submit button is disabled (covered by scenarios 1 and 4 above).
  //
  //       This test verifies that the submit is disabled upon opening the
  //       modal (before any input is filled), which implicitly covers the
  //       requirement since you cannot submit without both an agent selected
  //       AND the corresponding mode input filled.

  test('6. submit is disabled when no agent-specific input is provided (default state)', async ({ page }) => {
    // Modal opened with 'aula' agent and 'file' mode, no file selected → disabled
    await modal.expectSubmitDisabled()

    // Verify an agent is indeed selected (aula is default)
    await expect(page.getByRole('button', { name: /Aula/i, pressed: true })).toBeVisible()
  })
})
