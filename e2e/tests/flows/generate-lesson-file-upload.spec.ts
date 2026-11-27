import { test, expect } from '@playwright/test'
import path from 'path'
import { NewContentModal } from '../../pages/NewContentModal'
import { OutputPanel } from '../../pages/OutputPanel'

test.describe('Flow: generate lesson from file upload', () => {
  test('full flow: open modal → upload file → submit → see lesson content + diagram', async ({ page }) => {
    // 1. Open the application
    await page.goto('/')

    const modal = new NewContentModal(page)
    const outputPanel = new OutputPanel(page)

    // 2. Open NewContentModal
    await modal.open()
    await modal.expectVisible()

    // 3. Select file upload mode
    await modal.selectAgent('aula')
    await modal.selectMode('file')

    // 4. Verify submit is disabled before uploading a file
    await modal.expectNextDisabled()

    // 5. Upload a text file fixture (~200 words, Portuguese)
    const filePath = path.resolve(__dirname, '../../fixtures/sample-upload.txt')
    await modal.uploadFile(filePath)

    // 6. Verify submit becomes enabled after file upload
    await modal.next()
    await modal.expectSubmitEnabled()

    // 8. Submit the form
    await modal.submit()

    // 9. Verify the input modal closed after submit
    await modal.expectHidden()

    // 10. Wait for content to be generated and visible (30s timeout for VCR processing)
    //     First, wait for the empty-state placeholder to disappear, signaling
    //     that streamed content has arrived.
    await expect(
      page.getByText('O resultado aparecerá aqui após o processamento.'),
    ).not.toBeVisible({ timeout: 30_000 })

    // 11. Verify the generated content is non-empty (avoids fixture-text dependency)
    const content = await outputPanel.getContent()
    expect(content).not.toBe('')

    // 12. Verify a Mermaid diagram was rendered (the `aula` fixture contains a
    //     flowchart diagram generated from the aula_response_01.json fixture)
    await outputPanel.expectMermaidDiagramVisible()
  })
})
