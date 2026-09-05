import { test, expect } from '@playwright/test'
import { NewContentModal } from '../../pages/NewContentModal'
import { OutputPanel } from '../../pages/OutputPanel'

test.describe('Flow: generate lesson from topic', () => {
  /**
   * Fills the NewContentModal in topic mode and submits it.
   * Extracted as a local helper to avoid repetition between the
   * cenários de aula e explicação.
   *
   * @returns The OutputPanel instance for further assertions.
   */
  async function generateLessonFromTopic(
    page: import('@playwright/test').Page,
    topic: string,
    agent: 'aula' | 'explicacao',
  ): Promise<{ outputPanel: OutputPanel }> {
    const modal = new NewContentModal(page)
    const outputPanel = new OutputPanel(page)

    // Open modal and select topic mode
    await modal.open()
    await modal.expectVisible()
    // Passo 1: tipo (avança sozinho) · Passo 2: tema · Passo 3: ajustes
    await modal.selectAgent(agent)
    await modal.selectMode('topic')
    await modal.fillTopic(topic)
    await modal.next()

    // Submit the form
    await modal.submit()

    // Verify the input modal closed after submit
    await modal.expectHidden()

    // Wait for content to be generated and visible (30s timeout for VCR processing)
    await expect(
      page.getByText('O resultado aparecerá aqui após o processamento.'),
    ).not.toBeVisible({ timeout: 30_000 })

    return { outputPanel }
  }

  test('explicacao agent: open modal → fill topic → submit → see explanation content', async ({ page }) => {
    // 1. Open the application
    await page.goto('/')

    // 2-6. Open modal → select topic mode → fill topic → select explicacao → submit
    const { outputPanel } = await generateLessonFromTopic(
      page,
      'Recursão',
      'explicacao',
    )

    // 7. Verify the generated content is non-empty
    const content = await outputPanel.getContent()
    expect(content).not.toBe('')
  })
})
