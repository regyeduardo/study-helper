import { test, expect } from '@playwright/test'
import { NewContentModal } from '../../pages/NewContentModal'
import { OutputPanel } from '../../pages/OutputPanel'

test.describe('Flow: generate lesson from YouTube URL', () => {
  test('full flow: open modal → fill YouTube URL → submit → see lesson content + diagram', async ({ page }) => {
    // 1. Open the application
    await page.goto('/')

    const modal = new NewContentModal(page)
    const outputPanel = new OutputPanel(page)

    // 2. Open NewContentModal
    await modal.open()
    await modal.expectVisible()

    // 3. Tipo aula (avança para a origem) → link → URL → ajustes → gerar
    await modal.selectAgent('aula')
    await modal.selectMode('url')
    await modal.fillUrl('https://www.youtube.com/watch?v=example')
    await modal.next()
    await modal.submit()

    // 7. Verify the input modal closed after submit
    await modal.expectHidden()

    // 8. Wait for content to be generated and visible (30s timeout for VCR processing)
    //    First, wait for the empty-state placeholder to disappear, signaling
    //    that streamed content has arrived.
    await expect(
      page.getByText('O resultado aparecerá aqui após o processamento.'),
    ).not.toBeVisible({ timeout: 30_000 })

    // 9. Verify the generated content is non-empty (avoids fixture-text dependency)
    const content = await outputPanel.getContent()
    expect(content).not.toBe('')

    // 10. Verify a Mermaid diagram was rendered (the `aula` fixture contains a
    //     flowchart diagram generated from the aula_response_01.json fixture)
    await outputPanel.expectMermaidDiagramVisible()
  })
})
