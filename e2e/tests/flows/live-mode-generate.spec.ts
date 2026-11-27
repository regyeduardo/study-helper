import { test, expect } from '@playwright/test'
import { NewContentModal } from '../../pages/NewContentModal'
import { LiveModeView } from '../../pages/LiveModeView'

test.describe('Flow: live mode generation (SSE streaming)', () => {
  /**
   * NOTE on TEST_MODE behavior:
   *
   * When TEST_MODE=true, the backend's `callDeepSeekChat` reads the fixture
   * file (e.g. `aula_response_01.json`) in a single call — the content
   * is not chunked. However, the two-phase pipeline
   * (`GenerateLessonTwoPhase`) still emits proper SSE events:
   *
   *   1. `phase1_complete` — full lesson markdown (with diagram placeholders)
   *   2. `diagram_ready` / `diagram_fallback` — one per diagram slot
   *   3. `lesson_complete` — signals the end
   *
   * Because the fixture resolves instantly, the "streaming" appears as a
   * single large content delivery rather than incremental chunks. The test
   * therefore verifies:
   *   - The streaming view becomes visible
   *   - The streaming indicator appears and then disappears
   *   - The completion banner appears
   *   - Final content is non-empty
   *
   * We do NOT assert that content "grew progressively" (expectContentGrowing)
   * because chunks may arrive instantly in TEST_MODE.
   */

  test('aula agent with file upload: open → upload → submit → streaming view → complete', async ({ page }) => {
    // 1. Open the application
    await page.goto('/')

    // 2. Open NewContentModal
    const modal = new NewContentModal(page)
    await modal.open()
    await modal.expectVisible()

    // 3. Tipo aula → origem arquivo → upload → ajustes
    await modal.selectAgent('aula')
    await modal.selectMode('file')
    await modal.uploadFile('fixtures/sample-upload.txt')
    await modal.next()

    // 5. Submit the form — this triggers handleProcess which opens GenerationModeModal
    await modal.submit()
    await modal.expectHidden()

    // 6. GenerationModeModal appears — choose "Acompanhar em tempo real"
    await page.getByTestId('realtime-option').click()

    // 7. Verify LiveModeView (streaming view) is visible
    const liveView = new LiveModeView(page)
    await liveView.expectVisible()

    // 8. Wait for streaming to complete (60s timeout for SSE pipeline)
    await liveView.waitForStreamingToComplete()

    // 9. Verify the final content is non-empty
    const content = await liveView.getPartialContent()
    expect(content).not.toBe('')

    // 10. Verify the streaming indicator is gone
    const stillStreaming = await liveView.isStreaming()
    expect(stillStreaming).toBe(false)
  })
})
